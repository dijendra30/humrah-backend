/**
 * scripts/cleanExistingProfiles.js
 *
 * One-time script to scan ALL existing users and flag/clean
 * bio, goodMeetupMeaning, vibeQuote fields that contain violations.
 *
 * Run with: node scripts/cleanExistingProfiles.js
 *
 * What it does:
 * - Finds all users with non-empty text profile fields
 * - Runs regex hard-block + auto-clean checks (no OpenAI to keep cost zero)
 * - If HARD_BLOCK: sets field to "" and marks user as flaggedForReview
 * - If AUTO_CLEAN: saves the cleaned version silently
 * - Writes a report: scripts/moderation_cleanup_report.json
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

// ── Paste the same patterns from profile.js ─────────────────

const LEET_MAP = {
  '@': 'a', '4': 'a', '3': 'e', '1': 'i', '!': 'i',
  '0': 'o', '5': 's', '$': 's', '7': 't', '+': 't',
  '8': 'b', '6': 'g', '9': 'g',
};

function normalizeText(text) {
  let t = text.toLowerCase();
  t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  t = t.replace(/[ａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  t = t.replace(/[@4310!5$78+69]/g, char => LEET_MAP[char] || char);
  t = t.replace(/\b(\w)([\s.\-_]+\w){2,}/g, match => match.replace(/[\s.\-_]+/g, ''));
  t = t.replace(/(\w)[.\-_](\w)/g, '$1$2');
  return t;
}

const AUTO_CLEAN_PATTERNS = [
  /(?:(?:\+|00)?91[\s\-.]?)?[6-9]\d{9}/g,
  /\b[6-9](?:[\s.\-]{1,3}\d){9}\b/g,
  /\b(whatsapp|whats\s*app|watsapp|wa\.me|telegram|t\.me|instagram|insta|snapchat|snap)\b/gi,
  /\b(upi|paytm|gpay|google\s*pay|phonepe|bhim)\b/gi,
  /[₹$€£]\s*\d+/g,
  /\b\d+\s*(?:rs|inr|rupees?)\b/gi,
  /\bper\s*(?:hour|hr|day|session|meet|visit|call)\b/gi,
  /\b(?:rate|charge|fee|cost)s?\s*[:=]?\s*\d+/gi,
  /https?:\/\/[^\s]*/gi,
  /www\.[^\s]*/gi,
  /[\w.+-]+@[\w-]+\.[a-z]{2,}/gi,
];

const HARD_BLOCK_ORIGINAL = [
  /\b(call\s*me|text\s*me|dm\s*me|message\s*me|contact\s*me)\b/i,
  /\b(reach\s*(me|out)|hit\s*me\s*up|ping\s*me)\b/i,
  /\b(my\s*(number|no\.?|num|contact|handle|id)\s*(?:is|:))/i,
  /\b(find\s*me\s*on|add\s*me\s*on|follow\s*me\s*on)\b/i,
  /\b(paid\s*(service|meet|session|companion)|escort|hookup|hook\s*up)\b/i,
  /\b(nsa|friends?\s*with\s*benefits|fwb|sugar\s*(daddy|mama|baby))\b/i,
  /\b(playboy|play\s*boy|gigolo|call\s*girl)\b/i,
  /\bfor\s*sex\b/i,
  /\bsex\s*(meet|chat|friend|partner|service)\b/i,
  /\b(available\s*for\s*(sex|hookup|fun|friendship\s*with\s*benefits))\b/i,
  /\b(kill\s*(my)?self|want\s*to\s*die|end\s*(my\s*)?life)\b/i,
];

const HARD_BLOCK_NORMALIZED = [
  /whatsapp/, /telegram/, /instagram/, /snapchat/,
  /[6-9]\d{9}/,
  /\b\d{10,}\b/,
  /playboy/, /gigolo/,
  /forsex/, /sexmeet/,
];

function autoCleanText(text) {
  let cleaned = text;
  for (const pattern of AUTO_CLEAN_PATTERNS) {
    pattern.lastIndex = 0;
    cleaned = cleaned.replace(pattern, '');
  }
  return cleaned.replace(/\s{2,}/g, ' ').trim();
}

function checkField(originalText) {
  if (!originalText || typeof originalText !== 'string') return { action: 'skip' };
  const trimmed = originalText.trim();
  if (!trimmed) return { action: 'skip' };

  const normalized = normalizeText(trimmed);

  for (const pattern of HARD_BLOCK_ORIGINAL) {
    if (pattern.test(trimmed)) return { action: 'hard_block', reason: pattern.source };
  }
  for (const pattern of HARD_BLOCK_NORMALIZED) {
    if (pattern.test(normalized)) return { action: 'hard_block', reason: `normalized: ${pattern.source}` };
  }

  const cleaned = autoCleanText(trimmed);
  if (cleaned !== trimmed) return { action: 'auto_clean', original: trimmed, cleaned };

  return { action: 'safe' };
}

// ── Main script ──────────────────────────────────────────────

const FIELDS = ['bio', 'goodMeetupMeaning', 'vibeQuote'];
const REPORT = [];
let totalScanned = 0;
let totalFlagged = 0;
let totalCleaned = 0;

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected to MongoDB');

  // Only fetch users who have at least one text field set
  const users = await User.find({
    $or: FIELDS.map(f => ({ [`questionnaire.${f}`]: { $exists: true, $ne: '' } }))
  }).select('_id questionnaire flaggedForReview');

  console.log(`🔍 Scanning ${users.length} users...`);

  for (const user of users) {
    totalScanned++;
    let userDirty = false;
    const userReport = { userId: user._id.toString(), actions: [] };

    for (const field of FIELDS) {
      const value = user.questionnaire?.[field];
      if (!value) continue;

      const result = checkField(value);

      if (result.action === 'hard_block') {
        // Wipe the field and flag user for manual review
        user.questionnaire[field] = '';
        user.flaggedForReview = true;
        userDirty = true;
        totalFlagged++;
        userReport.actions.push({ field, action: 'WIPED', originalValue: value, reason: result.reason });
        console.log(`🚨 FLAGGED user ${user._id} | field: ${field} | value: "${value}"`);

      } else if (result.action === 'auto_clean') {
        user.questionnaire[field] = result.cleaned;
        userDirty = true;
        totalCleaned++;
        userReport.actions.push({ field, action: 'CLEANED', from: result.original, to: result.cleaned });
        console.log(`🧹 CLEANED user ${user._id} | field: ${field}`);
      }
    }

    if (userDirty) {
      user.markModified('questionnaire');
      await user.save();
      REPORT.push(userReport);
    }
  }

  // Write report
  const fs = require('fs');
  const reportPath = './scripts/moderation_cleanup_report.json';
  fs.writeFileSync(reportPath, JSON.stringify(REPORT, null, 2));

  console.log('\n── Cleanup Complete ──────────────────────────────');
  console.log(`Total scanned : ${totalScanned}`);
  console.log(`Hard blocked  : ${totalFlagged} (fields wiped, user flagged)`);
  console.log(`Auto cleaned  : ${totalCleaned} (contact info stripped)`);
  console.log(`Report saved  : ${reportPath}`);

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
