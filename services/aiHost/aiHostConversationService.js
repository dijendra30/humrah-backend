// services/aiHost/aiHostConversationService.js
// -----------------------------------------------------------------------------
// R6.2 — the AI Host conversation engine.
//
// One ordered pipeline, and the order is the safety property:
//
//   eligible? -> claim -> load context -> generate -> validate -> moderate
//             -> persist -> emit
//
// The provider is never called before eligibility passes and the Room is claimed,
// so a Room can never produce two concurrent AI calls. Nothing is emitted before
// it is persisted, so an AI message can never exist only in socket memory.
//
// ISOLATION: this is never called from the message-send path. It is invoked
// deliberately, per Room, by a caller that already decided to try. Every export
// resolves; nothing here can throw into chat, sockets, typing, reactions, read
// state, invitations or R5.
//
// R5/R6 BOUNDARY: R5 owns the OUT-of-room nudge (push notification to absent
// members). R6 owns the IN-room message. They share the same Room-quiet signal
// but act on different surfaces, and the AI Host consumes R5's engagement state
// rather than re-deriving it. An AI message is messageType AI_HOST, which every
// R5 query excludes, so an intervention can never look like human activity and
// re-trigger R5. See STEP 6 in the report.
// -----------------------------------------------------------------------------
'use strict';

const RoomMessage = require('../../models/RoomMessage');
const HumrahRoom = require('../../models/HumrahRoom');
const RoomMember = require('../../models/RoomMember');
const redisService = require('../redisService');
const { getUsersInsideRoom } = require('../roomPresenceService');
const { evaluateRoom } = require('../roomEngagementService');
const { AI_HOST_CONFIG, AI_HOST_IDENTITY } = require('./aiHostConfig');
const { assessRoom, prepareRequest, executePrepared, logAiHost, isAiHostEnabled } = require('./aiHostService');
const { validateAiHostResponse, REJECTION } = require('./aiHostResponseValidator');
const { emitAiHostEvent, AI_EVENT, newInterventionId, classifyError } = require('./aiHostTelemetry');
const aiHostBudget = require('./aiHostBudgetService');

/** Message types the AI Host is allowed to read as conversation. */
const HUMAN_MESSAGE_TYPE = 'TEXT';
/** The type an AI Host message is stored as. Never 'TEXT'. */
const AI_MESSAGE_TYPE = 'AI_HOST';

// ── Redis keys — namespaced so they cannot collide with R5's engagement keys ──
const claimKey = (roomId) => `lock:aihost:room:${roomId}`;
const cooldownKey = (roomId) => `aihost:cooldown:room:${roomId}`;

/** Every outcome this engine can produce. */
const OUTCOME = {
  DISABLED: 'AI_HOST_DISABLED',
  NOT_ELIGIBLE: 'NOT_ELIGIBLE',
  COOLDOWN: 'COOLDOWN',
  ALREADY_CLAIMED: 'ALREADY_CLAIMED',
  REDIS_UNAVAILABLE: 'REDIS_UNAVAILABLE',
  NO_CONTEXT: 'NO_CONTEXT',
  PROVIDER_FAILED: 'PROVIDER_FAILED',
  RESPONSE_REJECTED: 'RESPONSE_REJECTED',
  MODERATION_REJECTED: 'MODERATION_REJECTED',
  PERSIST_FAILED: 'PERSIST_FAILED',
  DRY_RUN: 'DRY_RUN',
  BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED',
  DELIVERED: 'DELIVERED',
  ERROR: 'ERROR',
};

/**
 * The single task given to the model. Deliberately small — R6.2 ships one
 * behaviour, not a personality system.
 */
const HOST_TASK = [
  'The conversation in this room has gone quiet.',
  'Write ONE short message that gives the group an easy, specific thing to respond to,',
  'grounded in the room topic and what was actually said above.',
  '',
  'Rules:',
  '- 1 to 2 sentences. Under 250 characters.',
  '- Ask one concrete question. Do not ask several.',
  '- Do not greet everyone, do not summarise the chat, do not lecture.',
  '- Do not claim feelings, memories or personal experiences.',
  '- Do not mention that you are an AI unless someone asks.',
  '- Plain text only. No markdown, no lists, no quotes, no emoji spam.',
].join('\n');

/** True only when a real Redis client exists — the in-process map is not one. */
function redisAvailable() {
  try { return Boolean(redisService.getClient && redisService.getClient()); } catch (_) { return false; }
}

/**
 * Attempts ONE AI Host intervention in one Room.
 *
 * Always resolves with { outcome, roomId, ... }. Never throws.
 *
 * @param {object} params
 * @param {string} params.roomId
 * @param {object} [params.io]        Socket.IO server — required to deliver
 * @param {object} [params.provider]  injectable for tests
 * @param {boolean} [params.force]    bypass DRY_RUN (tests / staging only)
 */
async function runAiHostIntervention(params = {}) {
  const { roomId, io = null, provider = null, force = false } = params;
  // R6.3 - one correlation id per attempt, threaded through every lifecycle
  // event so a single intervention is traceable end to end in the logs.
  const aiInterventionId = params.aiInterventionId || newInterventionId();
  const startedAt = Date.now();
  const result = {
    roomId: roomId ? String(roomId) : null,
    aiInterventionId,
    outcome: OUTCOME.ERROR,
    delivered: false,
  };
  if (!roomId) return result;

  // 1. Master switch. Nothing is read, claimed or called while disabled.
  if (!isAiHostEnabled()) return { ...result, outcome: OUTCOME.DISABLED };

  // 2. Idempotency and pacing both need Redis. Without it we cannot guarantee a
  //    single intervention, so we decline rather than risk duplicates.
  if (!redisAvailable()) {
    emitAiHostEvent(AI_EVENT.REDIS_UNAVAILABLE, { aiInterventionId, roomId: String(roomId), reason: 'claim_unavailable' });
    return { ...result, outcome: OUTCOME.REDIS_UNAVAILABLE };
  }

  let claimed = false;
  try {
    // 3. Room cooldown, checked before any work.
    const onCooldown = await redisService.get(cooldownKey(roomId));
    if (onCooldown) {
      emitAiHostEvent(AI_EVENT.COOLDOWN, { aiInterventionId, roomId: String(roomId) });
      return { ...result, outcome: OUTCOME.COOLDOWN };
    }

    // 4. Atomic claim (SET NX EX). Two workers cannot both win, so a Room can
    //    never receive two simultaneous interventions.
    claimed = await redisService.acquireLock(claimKey(roomId), AI_HOST_CONFIG.CLAIM_TTL_SECONDS);
    if (!claimed) {
      emitAiHostEvent(AI_EVENT.CLAIM_FAILED, { aiInterventionId, roomId: String(roomId) });
      return { ...result, outcome: OUTCOME.ALREADY_CLAIMED };
    }
    emitAiHostEvent(AI_EVENT.CLAIMED, { aiInterventionId, roomId: String(roomId) });

    const room = await HumrahRoom.findById(roomId).lean();
    if (!room) return { ...result, outcome: OUTCOME.NOT_ELIGIBLE };

    // 5. Eligibility — R5 engagement state consumed, never re-derived.
    const snapshot = await evaluateRoom(room, { skipCache: true });
    const joined = await RoomMember.find({ roomId, status: 'JOINED' }).select('userId').lean();
    const memberIds = joined.map(m => String(m.userId));
    const inside = await getUsersInsideRoom(io, roomId, memberIds);

    const decision = assessRoom({
      roomId,
      lifecycleStatus: room.status,
      engagementSnapshot: snapshot,
      joinedMemberCount: memberIds.length,
      presentMemberCount: inside.size,
      recentIntervention: false, // the cooldown check above is the authority
    });
    if (!decision.eligible) {
      emitAiHostEvent(AI_EVENT.SKIPPED, {
        aiInterventionId, roomId: String(roomId), reason: decision.reason,
        engagementState: snapshot ? snapshot.state : null, lifecycleStatus: room.status,
      });
      return { ...result, outcome: OUTCOME.NOT_ELIGIBLE, reason: decision.reason };
    }
    emitAiHostEvent(AI_EVENT.ELIGIBLE, {
      aiInterventionId, roomId: String(roomId),
      engagementState: snapshot ? snapshot.state : null, lifecycleStatus: room.status,
    });

    // 6. Context. ONLY human TEXT messages are read, so an AI message can never
    //    become input to another AI message (loop prevention, part 1).
    const history = await RoomMessage
      .find({ roomId, messageType: HUMAN_MESSAGE_TYPE })
      .sort({ createdAt: -1 })
      .limit(AI_HOST_CONFIG.MAX_MESSAGES)
      .select('senderId content messageType createdAt')
      .lean();
    if (history.length === 0) return { ...result, outcome: OUTCOME.NO_CONTEXT };

    const prepared = prepareRequest({
      room,
      engagementState: snapshot ? snapshot.state : null,
      messages: history.slice().reverse(), // oldest-first for the transcript
      participantCount: snapshot ? snapshot.participatingMemberCount : 0,
      task: HOST_TASK,
    });
    if (!prepared.ok) return { ...result, outcome: OUTCOME.DISABLED };

    // 7. DRY RUN stops here: evaluated and logged, but no provider call, no
    //    persistence, no delivery, no state change of any kind.
    if (AI_HOST_CONFIG.DRY_RUN && !force) {
      // R6.3 - dry-run consumes the SAME budget a real call would, so dry-run
      // capacity numbers are not optimistic fiction. It stops before the
      // provider, so no money is spent and nothing is persisted or emitted.
      const dryBudget = await aiHostBudget.consume({ aiInterventionId });
      if (!dryBudget.allowed) {
        return { ...result, outcome: OUTCOME.BUDGET_EXHAUSTED, reason: dryBudget.reason };
      }
      emitAiHostEvent(AI_EVENT.SKIPPED, {
        aiInterventionId, roomId: String(roomId), reason: 'dry_run',
        engagementState: snapshot ? snapshot.state : null,
        messagesInContext: prepared.stats.messagesIncluded,
        contextChars: prepared.stats.contextChars,
        callsThisHour: dryBudget.callsThisHour, callsToday: dryBudget.callsToday,
      });
      return { ...result, outcome: OUTCOME.DRY_RUN, stats: prepared.stats };
    }

    // 8. Budget, then generate. The budget is consumed BEFORE the request, so a
    //    provider that hangs or crashes has still counted against the ceiling.
    const budget = await aiHostBudget.consume({ aiInterventionId });
    if (!budget.allowed) {
      return { ...result, outcome: OUTCOME.BUDGET_EXHAUSTED, reason: budget.reason };
    }

    emitAiHostEvent(AI_EVENT.GENERATION_STARTED, {
      aiInterventionId, roomId: String(roomId),
      provider: AI_HOST_CONFIG.PROVIDER, model: AI_HOST_CONFIG.MODEL || 'provider_default',
      callsThisHour: budget.callsThisHour, callsToday: budget.callsToday,
    });

    const completion = await executePrepared(prepared, { provider, force: true });
    if (!completion.ok) {
      // No retry loop by design: the next scheduled attempt is the retry.
      emitAiHostEvent(AI_EVENT.GENERATION_FAILED, {
        aiInterventionId, roomId: String(roomId),
        provider: AI_HOST_CONFIG.PROVIDER,
        errorKind: completion.errorKind || 'unknown',
        // Classification only - raw provider text may echo the prompt.
        reason: classifyError(completion.error),
        providerLatencyMs: completion.latencyMs || 0,
      });
      return { ...result, outcome: OUTCOME.PROVIDER_FAILED, errorKind: completion.errorKind };
    }
    emitAiHostEvent(AI_EVENT.GENERATION_SUCCEEDED, {
      aiInterventionId, roomId: String(roomId),
      provider: AI_HOST_CONFIG.PROVIDER, providerLatencyMs: completion.latencyMs || 0,
    });

    // 9. Validate — nothing raw from a provider is ever persisted.
    const validated = validateAiHostResponse(completion.text);
    if (!validated.ok) {
      emitAiHostEvent(AI_EVENT.OUTPUT_REJECTED, { aiInterventionId, roomId: String(roomId), reason: validated.reason });
      return { ...result, outcome: OUTCOME.RESPONSE_REJECTED, reason: validated.reason };
    }

    // 10. Moderation — AI content passes the same safety boundary as user content.
    const moderated = await moderateHostMessage(validated.text);
    if (!moderated.ok) {
      emitAiHostEvent(AI_EVENT.MODERATION_REJECTED, { aiInterventionId, roomId: String(roomId), reason: moderated.reason });
      return { ...result, outcome: OUTCOME.MODERATION_REJECTED, reason: moderated.reason };
    }

    // 11. Persist BEFORE emitting. A failed save means nothing is delivered and
    //     nothing is claimed as sent.
    let saved;
    try {
      saved = await new RoomMessage({
        roomId,
        senderId: null,               // the AI Host is not a user
        messageType: AI_MESSAGE_TYPE, // and not human conversation
        content: moderated.text,
        clientMessageId: null,
      }).save();
    } catch (persistErr) {
      emitAiHostEvent(AI_EVENT.PERSIST_FAILED, { aiInterventionId, roomId: String(roomId), reason: 'mongo_write_failed' });
      console.error('[AI_HOST] persist failed:', persistErr.message);
      return { ...result, outcome: OUTCOME.PERSIST_FAILED };
    }

    // 12. Burn the Room cooldown only after a real message exists.
    await redisService.set(
      cooldownKey(roomId),
      { at: Date.now(), messageId: String(saved._id) },
      AI_HOST_CONFIG.ROOM_COOLDOWN_HOURS * 3600
    ).catch(() => {});

    // 13. Deliver over the EXISTING room_message channel, same payload shape.
    const payload = buildAiHostEmitPayload(saved, roomId, aiInterventionId);
    let emitted = false;
    if (io && typeof io.to === 'function') {
      try { io.to(`room:${roomId}`).emit('room_message', payload); emitted = true; }
      catch (emitErr) { console.error('[AI_HOST] emit failed:', emitErr.message); }
    }

    emitAiHostEvent(AI_EVENT.PERSISTED, {
      aiInterventionId, roomId: String(roomId), messageId: String(saved._id),
      messageLength: moderated.text.length,
    });
    emitAiHostEvent(AI_EVENT.DELIVERED, {
      aiInterventionId, roomId: String(roomId), messageId: String(saved._id),
      engagementState: snapshot ? snapshot.state : null,
      participantsAtIntervention: snapshot ? snapshot.participatingMemberCount : 0,
      messageLength: moderated.text.length,
      providerLatencyMs: completion.latencyMs || 0,
      totalLatencyMs: Date.now() - startedAt,
      emitted,
    });

    return { ...result, outcome: OUTCOME.DELIVERED, delivered: true, messageId: String(saved._id), emitted, message: payload };
  } catch (err) {
    console.error('[AI_HOST] intervention failed:', err.message);
    return { ...result, outcome: OUTCOME.ERROR };
  } finally {
    // Release the claim either way. On success the separate 24h cooldown key
    // holds the Room; on failure the Room stays retryable next cycle.
    if (claimed) {
      try { await redisService.releaseLock(claimKey(roomId)); } catch (_) { /* TTL clears it */ }
    }
  }
}

/**
 * Runs AI output through the project's existing moderation rather than inventing
 * a second safety system. Fails CLOSED — if moderation cannot run, the message
 * is not published.
 */
async function moderateHostMessage(text) {
  try {
    const { moderateQuestionnaireSync } = require('../../middleware/moderation');
    const { cleanedQuestionnaire, errors } = moderateQuestionnaireSync({ bio: text });
    if (errors && errors.length > 0) return { ok: false, reason: 'moderation_error' };
    const cleaned = cleanedQuestionnaire && typeof cleanedQuestionnaire.bio === 'string'
      ? cleanedQuestionnaire.bio.trim() : '';
    if (!cleaned) return { ok: false, reason: 'moderation_emptied' };
    return { ok: true, text: cleaned };
  } catch (err) {
    console.error('[AI_HOST] moderation unavailable:', err.message);
    return { ok: false, reason: 'moderation_unavailable' };
  }
}

/**
 * The emitted payload. Same `room_message` event and same field names as a human
 * message, so existing clients parse it without changes; `messageType` is what
 * distinguishes it. senderId is null and senderName is the explicit AI identity —
 * never a human name.
 */
function buildAiHostEmitPayload(saved, roomId, aiInterventionId = null) {
  return {
    // R6.3 — correlation id, so the client's "message seen" event can be joined
    // to the server-side intervention lifecycle. Opaque and non-identifying:
    // it names an intervention, not a user. Additive, so older clients ignore it.
    aiInterventionId,
    _id: String(saved._id),
    roomId: String(roomId),
    senderId: null,
    senderName: AI_HOST_IDENTITY.displayName,
    content: saved.content,
    messageType: AI_MESSAGE_TYPE,
    createdAt: saved.createdAt.toISOString(),
    clientMessageId: null,
    reactions: [],
    isAiHost: true,
  };
}

module.exports = {
  runAiHostIntervention,
  buildAiHostEmitPayload,
  moderateHostMessage,
  OUTCOME,
  HOST_TASK,
  AI_MESSAGE_TYPE,
  HUMAN_MESSAGE_TYPE,
  claimKey,
  cooldownKey,
  redisAvailable,
};
