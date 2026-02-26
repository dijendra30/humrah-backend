/**
 * Two-stage regex filter:
 * Stage A: AUTO_CLEAN — strip the pattern, keep the text
 * Stage B: HARD_BLOCK — reject the entire submission
 *
 * All patterns run against the NORMALIZED text.
 * Cleaning (removal) is applied to the ORIGINAL text using equivalent patterns.
 */

// ─────────────────────────────────────────────────────────────
// STAGE A: Auto-clean patterns (applied to original text)
// ─────────────────────────────────────────────────────────────
const AUTO_CLEAN_PATTERNS = [

  // Indian mobile numbers (10-digit, with/without country code)
  // Matches: 9876543210, +91 98765 43210, 0091-9876543210, 91-9876543210
  /(?:(?:\+|00)?91[\s\-.]?)?[6-9]\d{9}/g,

  // Spaced-out numbers: "9 8 7 6 5 4 3 2 1 0" or "9.8.7.6"
  /\b[6-9][\s.\-]{1,3}\d[\s.\-]{1,3}\d[\s.\-]{1,3}\d[\s.\-]{1,3}\d[\s.\-]{1,3}\d[\s.\-]{1,3}\d[\s.\-]{1,3}\d[\s.\-]{1,3}\d\b/g,

  // WhatsApp / Telegram / Instagram / Snapchat references
  /\b(whatsapp|whats\s*app|watsapp|wa\.me|t\.me|telegram|tele\s*gram|instagram|insta\s*gram|snapchat|snap\s*chat)\b/gi,

  // UPI / payment references
  /\b(upi|paytm|gpay|google\s*pay|phonepe|bhim|@okaxis|@oksbi|@ybl|@paytm)\b/gi,

  // Currency + pricing patterns
  /[₹$€£]\s*\d+/g,
  /\b\d+\s*(?:rs|inr|rupees?|per\s*(?:hour|hr|day|session|meet|visit))\b/gi,
  /\brates?\s*[:=]?\s*\d+/gi,
  /\bcharges?\s*[:=]?\s*\d+/gi,
];

// ─────────────────────────────────────────────────────────────
// STAGE B: Hard-block patterns (checked on NORMALIZED text)
// Submission is rejected outright if any match.
// ─────────────────────────────────────────────────────────────
const HARD_BLOCK_PATTERNS = [

  // Solicitation language
  /\b(call\s*me|text\s*me|dm\s*me|message\s*me|contact\s*me|reach\s*(?:me|out))\b/i,
  /\b(paid\s*(?:service|meet|session|companion)|escort|hookup|hook\s*up|nsa|friends\s*with\s*benefits|fwb)\b/i,
  /\b(rate\s*card|available\s*for\s*(?:hire|booking)|book\s*me|hire\s*me)\b/i,

  // Explicit bypass: "my number is", "ping me on"
  /\b(my\s*(?:number|no|num|contact|handle|id)\s*(?:is|:))/i,
  /\b(ping\s*me|hit\s*me\s*up|slide\s*(?:into|in)\s*(?:my|the))\b/i,
  /\b(find\s*me\s*on|add\s*me\s*on|follow\s*me\s*on)\b/i,

  // Self-harm
  /\b(kill\s*(?:my)?self|suicide|end\s*(?:my\s*)?life|want\s*to\s*die)\b/i,
];

// ─────────────────────────────────────────────────────────────
// STAGE C: Post-normalization hard-block (leet-collapsed text)
// These catch bypass variants after normalization.
// ─────────────────────────────────────────────────────────────
const NORMALIZED_BLOCK_PATTERNS = [
  /whatsapp/i,
  /telegram/i,
  /instagram/i,
  /snapchat/i,
  // Collapsed spaced numbers (10+ consecutive digits after space removal)
  /[6-9]\d{9}/,
];

/**
 * Apply auto-clean to original text.
 * Returns cleaned text.
 */
function autoClean(originalText) {
  let cleaned = originalText;
  for (const pattern of AUTO_CLEAN_PATTERNS) {
    cleaned = cleaned.replace(pattern, '').trim();
  }
  // Collapse multiple spaces left by removals
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();
  return cleaned;
}

/**
 * Check hard-block against original text.
 */
function hardBlockCheck(originalText) {
  for (const pattern of HARD_BLOCK_PATTERNS) {
    if (pattern.test(originalText)) {
      return { blocked: true, reason: 'solicitation_or_harmful_content' };
    }
  }
  return { blocked: false };
}

/**
 * Check hard-block against normalized (leet-collapsed) text.
 */
function normalizedBlockCheck(normalizedText) {
  for (const pattern of NORMALIZED_BLOCK_PATTERNS) {
    if (pattern.test(normalizedText)) {
      return { blocked: true, reason: 'bypass_attempt_detected' };
    }
  }
  return { blocked: false };
}

module.exports = { autoClean, hardBlockCheck, normalizedBlockCheck };
