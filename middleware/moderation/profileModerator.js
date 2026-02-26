const { normalizeForCheck } = require('./normalize');
const { autoClean, hardBlockCheck, normalizedBlockCheck } = require('./regexFilters');
const { checkWithOpenAI } = require('./openaiModerator');

/**
 * Fields to moderate in the questionnaire.
 * Keys must match the MongoDB questionnaire sub-document field names.
 */
const MODERATED_FIELDS = ['bio', 'goodMeetupMeaning', 'vibeQuote'];

/**
 * Minimum length to bother calling OpenAI (cost optimization).
 * Very short strings are either safe or already caught by regex.
 */
const MIN_LENGTH_FOR_AI_CHECK = 10;

/**
 * Express middleware: moderates MODERATED_FIELDS in req.body.questionnaire.
 *
 * On success: req.body.questionnaire fields are replaced with cleaned versions.
 * On failure: responds with 400/422 and structured error — does NOT call next().
 */
async function moderateProfileFields(req, res, next) {
  const questionnaire = req.body?.questionnaire;
  if (!questionnaire) return next(); // nothing to moderate

  const errors = [];
  const cleaned = { ...questionnaire };

  for (const field of MODERATED_FIELDS) {
    const originalValue = questionnaire[field];
    if (!originalValue || typeof originalValue !== 'string') continue;

    const trimmed = originalValue.trim();
    if (trimmed.length === 0) continue;

    // ── STEP 1: Hard-block on original text ──────────────────
    const hardBlock = hardBlockCheck(trimmed);
    if (hardBlock.blocked) {
      errors.push({
        field,
        code: 'HARD_BLOCK',
        reason: hardBlock.reason,
        message: getHardBlockMessage(hardBlock.reason),
      });
      continue; // skip further checks for this field
    }

    // ── STEP 2: Auto-clean (strip contact info, pricing, etc.) ─
    const autoCleanedText = autoClean(trimmed);

    // ── STEP 3: Normalize for bypass detection ────────────────
    const normalizedText = normalizeForCheck(autoCleanedText);

    // ── STEP 4: Hard-block on normalized text ─────────────────
    const normalizedBlock = normalizedBlockCheck(normalizedText);
    if (normalizedBlock.blocked) {
      errors.push({
        field,
        code: 'BYPASS_DETECTED',
        reason: normalizedBlock.reason,
        message: 'Please don\'t include contact handles or platform references.',
      });
      continue;
    }

    // ── STEP 5: OpenAI moderation (only if text is long enough) ─
    if (normalizedText.length >= MIN_LENGTH_FOR_AI_CHECK) {
      try {
        const aiResult = await checkWithOpenAI(normalizedText);
        if (!aiResult.safe) {
          errors.push({
            field,
            code: 'AI_FLAGGED',
            categories: aiResult.flaggedCategories,
            message: getAIFlagMessage(aiResult.flaggedCategories),
          });
          continue;
        }
      } catch (err) {
        console.error(`[MODERATION] OpenAI call failed for field "${field}":`, err.message);
        // Fail-open: log and continue (don't block user due to API downtime)
        // Swap to fail-closed in highly sensitive contexts.
      }
    }

    // ── STEP 6: Store cleaned version ─────────────────────────
    cleaned[field] = autoCleanedText;
  }

  if (errors.length > 0) {
    return res.status(422).json({
      success: false,
      code: 'MODERATION_FAILED',
      message: 'Some fields contain content that isn\'t allowed.',
      errors, // structured per-field errors for the Android client
    });
  }

  // Replace questionnaire in request body with cleaned version
  req.body.questionnaire = cleaned;
  next();
}

// ─────────────────────────────────────────────────────────────
// Human-readable error messages (shown to user in Android app)
// ─────────────────────────────────────────────────────────────
function getHardBlockMessage(reason) {
  const messages = {
    solicitation_or_harmful_content:
      'Please keep your profile about who you are — not contact details or service offers.',
    bypass_attempt_detected:
      'Please don\'t include contact handles or platform references.',
  };
  return messages[reason] || 'This content isn\'t allowed in your profile.';
}

function getAIFlagMessage(categories) {
  if (categories.some(c => c.startsWith('sexual')))
    return 'Please keep your profile respectful and appropriate.';
  if (categories.some(c => c.startsWith('hate')))
    return 'Hateful language isn\'t allowed in profiles.';
  if (categories.some(c => c.startsWith('harassment')))
    return 'Please keep your profile friendly and welcoming.';
  if (categories.some(c => c.startsWith('self-harm')))
    return 'If you\'re struggling, please reach out for support. We\'re here too.';
  return 'This content doesn\'t meet our community guidelines.';
}

module.exports = { moderateProfileFields };
