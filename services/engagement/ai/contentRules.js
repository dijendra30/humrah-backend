// services/engagement/ai/contentRules.js
// -----------------------------------------------------------------------------
// Prohibited-content rules for notification templates (English, Hindi, Hinglish).
// Deliberately conservative: a false rejection costs one template; a false acceptance
// reaches users' lock screens. Every rule has a reason code that is counted in the
// generation history. Matching is on a lower-cased, whitespace-normalised copy.
// -----------------------------------------------------------------------------
'use strict';

// word-ish boundary that also works next to Devanagari (\b does not).
const W = '(?:^|[^\\p{L}\\p{M}\\p{N}])';
const E = '(?=$|[^\\p{L}\\p{M}\\p{N}])';
const words = list => new RegExp(`${W}(?:${list.join('|')})${E}`, 'iu');

const RULES = Object.freeze([
  // Humrah is not a dating app.
  { code: 'DATING_OR_ROMANCE', re: words(['dat(?:e|es|ing)', 'romance', 'romantic', 'flirt\\w*', 'crush', 'soulmate', 'singles?', 'girlfriend', 'boyfriend', 'gf', 'bf', 'love life', 'hook ?up', 'pyaa?r', 'ishq', 'mohabbat', 'jaanu', 'प्यार', 'इश्क', 'मोहब्बत', 'डेट', 'रोमांस']) },
  { code: 'SEXUAL', re: words(['sexy', 'sex', 'nude\\w*', 'naughty', 'kiss\\w*', 'intimate', 'seductive', 'सेक्सी']) },
  // Manipulative pressure, guilt and loneliness framing.
  { code: 'EMOTIONAL_PRESSURE', re: words(['lonely', 'loneliness', 'alone', 'all alone', 'no friends', 'nobody', 'sad', 'depress\\w*', 'bored of life', 'miss(?:ing)? out', 'fomo', 'regret', 'guilt\\w*', 'akel[aie]', 'udaas', 'अकेल\\p{L}*', 'उदास', 'तन्हा']) },
  { code: 'FAKE_URGENCY', re: words(['hurry', 'last chance', 'act now', 'right now', 'immediately', 'before it\'?s too late', 'don\'?t miss', 'only today', 'limited time', 'expires?', 'ending soon', 'urgent', 'asap', 'jaldi', 'abhi turant', 'turant', 'जल्दी', 'तुरंत', 'आखिरी मौका']) },
  // Claims about specific people / the reader being wanted.
  { code: 'CLAIM_ABOUT_PEOPLE', re: words(['waiting for you', 'looking for you', 'wants to meet you', 'wants to talk', 'messaged you', 'liked you', 'likes you', 'viewed your profile', 'checked you out', 'someone special', 'your match', 'tumhara intezaar', 'aapka intezaar', 'आपका इंतज़ार', 'आपका इंतजार']) },
  // Sensitive inferences.
  { code: 'SENSITIVE_INFERENCE', re: words(['relig\\w*', 'caste', 'jaati', 'dharm', 'hindu', 'muslim', 'christian', 'sikh', 'gay', 'lesbian', 'transgender', 'sexuality', 'illness', 'disab\\w*', 'pregnan\\w*', 'income', 'salary', 'divorc\\w*', 'married', 'shaadi', 'शादी', 'धर्म', 'जाति']) },
  // Harassment / insults.
  { code: 'HARASSMENT', re: words(['stupid', 'idiot', 'loser', 'ugly', 'fat', 'dumb', 'pathetic', 'shut up', 'useless', 'bevakoof', 'bewakoof', 'pagal', 'gadha', 'nalayak', 'बेवकूफ', 'पागल', 'गधा']) },
  // Spam / exaggeration / false claims.
  { code: 'SPAM_OR_EXAGGERATION', re: words(['for free', 'free entry', 'winner', 'prize', 'reward', 'cash', 'click here', 'guarantee\\w*', 'best ever', 'the best', 'number one', 'everyone is', 'everybody is', 'all your friends', 'viral', 'exclusive', 'special offer', 'sabse best']) },
]);

// Text implying live activity — only allowed for categories backed by a real event.
const ACTIVITY_CLAIM = words(['near you', 'nearby', 'around you', 'joined', 'happening now', 'right now', 'going on', 'are chatting', 'are talking', 'people are', 'new people', 'is waiting', 'are waiting', 'open spots?', 'paas', 'aas ?paas', 'आसपास', 'पास में']);

const MARKUP = /<[^>]*>|[<>]|javascript:|data:|https?:|www\.|\.com\b|\.in\b|@\w|\[[^\]]*\]\(|```|\*\*|__|#\w/i;
const DIGIT = /[0-9०-९]/;   // Latin and Devanagari digits
const DEVANAGARI = /[ऀ-ॿ]/g;
const LATIN = /[A-Za-z]/g;
const EMOJI = /\p{Extended_Pictographic}/gu;

module.exports = { RULES, ACTIVITY_CLAIM, MARKUP, DIGIT, DEVANAGARI, LATIN, EMOJI };
