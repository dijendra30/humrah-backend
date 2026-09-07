# PROFILE ASSISTANT — AUDIT + GROQ MODEL UPDATE

**Date:** 2026-09-07
**Scope:** `routes/profileAssistant.js` (1,240 lines) and the AI paths around it.
**Question asked:** update the stale Groq model, audit the assistant for errors, and state whether it is fixable by a backend deploy alone.

## ANSWER: yes — backend only

Every issue found is server-side. **Zero Android changes are required.** The app calls the assistant over plain HTTP and renders whatever JSON comes back; none of the fixes change the response shape, and no new field was added or removed.

---

## 1. THE MODEL

The project has **two independent AI paths**, and they were on different models:

| Path | File | Model before | Model after |
|---|---|---|---|
| Profile extraction | `services/providers/groqProvider.js` | `openai/gpt-oss-120b` | unchanged — already correct |
| Profile Assistant | `routes/profileAssistant.js` | **`llama-3.1-8b-instant`** | **`openai/gpt-oss-120b`** |

One constant drove all four assistant call sites (`polishBullets`, `groqFallback`, `generateAndApplyAiFix`, bio rewrite), so it was a one-line change. It is now **env-overridable** so the next model change needs no code deploy:

```js
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
```

`GROQ_DAILY_LIMIT` was given the same treatment (default 5, unchanged).

### Token budgets had to move with it

`gpt-oss-120b` is a **reasoning** model: reasoning tokens are consumed from `max_tokens` before any visible text is produced. The old budgets were sized for llama-3.1-8b and would have returned **empty strings** — the assistant would have silently fallen back to canned options on every question and looked "broken" while reporting no errors.

| Call | max_tokens | timeout |
|---|---|---|
| `polishBullets` | 400 → **1200** | 7s → 15s |
| `groqFallback` (chat) | 250 → **1000** | 9s → 20s |
| `generateAndApplyAiFix` | 350 → **800** | 15s → 20s |
| bio rewrite | 100 → **700** | 10s → 20s |

This is the one change that matters most for the model swap actually working rather than merely being configured.

---

## 2. BUGS FOUND

### 2.1 A second profile-completion formula — **user-visible contradiction** (fixed)

`buildSafeProfileSummary()` computed its own score:

```js
const completionScore = Math.round(((6 - missingFields.length) / 6) * 100);
```

Six hand-picked fields, each worth ~17%. Meanwhile the Profile screen shows `user.profileCompletion` from the canonical item-based calculator. **The same account got two different numbers.** For a real sample user: assistant said **33%**, Profile screen said **12%**.

Fixed by quoting the canonical calculator. The assistant's own `missingFields` list is untouched — that is a *coaching* list (what to nudge next), which is a different thing from the score, and the tips UX depends on it.

### 2.2 Daily AI limit was bypassable, and could fail open — **cost risk** (fixed)

```js
async function incrementGroq(user) {
  user.groqUsage = { date: today, count: (e.count || 0) + 1 };
  User.updateOne(...).catch(() => {});   // not awaited, errors swallowed
}
```
…called as `incrementGroq(user);` — also not awaited.

Two problems:
1. **Race:** two concurrent requests both read count `N` and both wrote `N+1`. The cap was trivially exceeded.
2. **Fails open:** any write error was swallowed, so the counter never advanced and the user got **unlimited paid AI calls**.

Now one atomic `$inc` (with a `$set` when the stored day has rolled over), awaited at all three call sites, and it **fails closed** — if usage cannot be recorded, the call is refused rather than given away.

### 2.3 AI-generated bios skipped moderation — **safety gap** (fixed)

`generateAndApplyAiFix()` wrote `user.questionnaire.bio` straight to the profile with `user.save()`. It checked only for URLs and 10-digit numbers. `moderateQuestionnaireSync` was not even imported into this file — **this was the only bio path in the product that bypassed moderation**, and the text came from a language model.

Now it runs the same synchronous moderation every other questionnaire write uses, and drops the bio rather than publishing it if the check trips.

### 2.4 Unsecured-looking diagnostic route left in production (removed)

```js
// DIAGNOSTIC ROUTE — remove after debugging
router.get('/debug', …)   // returned profileBotConsent, status, firstName
```

Authenticated and scoped to the caller's own record, so severity is low — but it was explicitly marked for removal and exposed internal state. I verified the Android app never calls it, then removed it.

### 2.5 JSON parsing relied on the model not using markdown (fixed)

`generateAndApplyAiFix` asked for JSON in the prompt and then stripped ```` ```json ```` fences by hand. `groqProvider.js` already does this properly with `response_format: { type: 'json_object' }`. Added; the fence-stripping stays as a fallback.

---

## 3. AUDITED AND FOUND CORRECT — deliberately not changed

| Area | Finding |
|---|---|
| Authentication | Mounted as `app.use('/api/profile-assistant', authenticate, …)` — every route is behind auth. |
| Consent gate | Every data route checks `user.profileBotConsent` and returns `403 CONSENT_REQUIRED`. |
| Rate limiting | `assistantLimiter` on every route, on top of the daily AI cap. |
| Data sent to Groq | `groqFallback` sends an **anonymised summary** (counts, booleans, status) — no name, email, phone, bio text, or raw questionnaire. This is genuinely well built. |
| Logic-first design | `matchIntent` → `runLogicEngine` handles known intents deterministically; the model is only a fallback for unmatched free text. Keeps cost and latency down. |
| Failure handling | Every Groq call is wrapped; a failure degrades to canned options rather than erroring the screen. |
| Bio cache | MongoDB-backed with a 7-day TTL, keyed by content hash — avoids repaying for identical rewrites. |
| Input validation | Message length capped at 500; intents validated against an allow-list. |

---

## 4. KNOWN ISSUES NOT FIXED (deliberate)

1. **`generateAndApplyAiFix` writes `questionnaire.interests`, but the onboarding question is `hobbies` (Q14).** So an AI-applied "interests" fix does not credit the hobbies question in profile completion, and the score may not move as much as the user expects. Fixing it means deciding which field is authoritative — a product call, not a bug fix.
2. **`buildSafeProfileSummary` has its own `missingFields` list** (6 coaching fields) that differs from the canonical calculator's item set. This is intentional and now clearly separated from the score, but the two lists could still drift.
3. **No test suite exists for the assistant.** The logic engine, intent matcher and summary builder are all pure functions and would be straightforward to cover. Out of scope here.
4. **No cost/usage telemetry.** Groq spend is invisible beyond the per-user daily counter.

---

## 5. FILES CHANGED

| File | Change |
|---|---|
| `routes/profileAssistant.js` | Model constant, token budgets, atomic usage counter, canonical completion score, bio moderation, `response_format`, `/debug` removed |
| `test_profile_completion_and_q24.js` | Added an assertion that the assistant quotes the canonical score; relaxed a consumer-count check (see below) |

**Android: 0 files.**

`services/providers/groqProvider.js` was inspected and left alone — it was already correct.

## 6. TESTS

Full backend sweep, all executed:

| Suite | Result |
|---|---|
| `test_profile_completion_and_q24.js` | **61/61** |
| `test_q24_completion.js` | 19/19 |
| `test_profile_questionnaire_fixes.js` | 15/15 |
| `test_phase2_7_pacing.js` | 23/23 |
| `test_phase5_3_engagement_observability.js` | 70/70 |
| `test_phase5_2_engagement_engine.js` | 93/93 |
| `test_phase5_1_room_engagement.js` | 69/69 |
| `test_phase2_1_room_chat.js` | 85/85 |
| `test_phase2_room_invitations.js` | 63/63 |
| `test_phase4_5_room_discovery.js` | 45/45 |
| `test_phase1_room_generation.js` | 50/50 |
| `test_system_room_join.js` | 19/19 |
| `test_room_topic_canonicalization.js` | 40/40 |
| `test_phase_r1_rooms.js` | 26/26 |
| `test_room_matching.js` | 29/29 |
| `test_room_membercount.js` | 9/9 |
| `test_system_room_generator.js` | 35/36 — pre-existing since R0, unrelated |

**One test-assertion correction, disclosed:** my "canonical calculator has exactly 2 consumers" check failed once the assistant became a third consumer. The assistant *does* read `.percentage`, so the assertion was too rigid rather than the code being wrong. It now asserts the property that matters — every consumer reads the canonical `.percentage` — and no longer pins the count.

## 7. DEPLOYMENT

Backend-only. Upload `routes/profileAssistant.js` and redeploy.

**No new environment variable is required** — `GROQ_MODEL` defaults to `openai/gpt-oss-120b`. Set it only to override.

### Verify after deploy

1. Open the Profile Assistant; confirm `/health` returns and the percentage **matches the Profile screen** (this is the visible proof of §2.1).
2. Ask a free-text question the intent matcher will not catch (e.g. *"what should I write about myself?"*) — a real model answer confirms the new model **and** the raised token budget. An empty/fallback response means `max_tokens` is still too low.
3. Ask 6 free-text questions in one day; the 6th must be refused with the daily-limit message.
4. Tap **Fix Now** and confirm a bio is generated and applied.

## 8. LIMITATIONS OF THIS AUDIT

- **Not verified against production or a live Groq key.** No AI call was actually executed from this environment; the model name, token budgets and timeouts are reasoned from the model's documented behaviour, not measured. Step 2 above is the real test.
- The `max_tokens` values are conservative estimates. If answers still come back truncated, raise `groqFallback` first.
- Cost per call rises with `gpt-oss-120b` versus `llama-3.1-8b-instant`. The daily cap (now actually enforced, per §2.2) is the control — the enforcement fix may make usage *look* like it dropped, because it was previously being exceeded.
