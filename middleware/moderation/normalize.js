/**
 * Normalizes text to prevent bypass attempts like:
 * "w h a t s a p p", "wh@tsapp", "9 8 7 6 5 4 3 2 1 0"
 */

const LEET_MAP = {
  '@': 'a', '4': 'a', '3': 'e', '1': 'i', '!': 'i',
  '0': 'o', '5': 's', '$': 's', '7': 't', '+': 't',
  '8': 'b', '6': 'g', '9': 'g',
};

function normalizeLeetSpeak(text) {
  return text.replace(/[@4310!5$78+69]/g, (char) => LEET_MAP[char] || char);
}

function collapseSpaces(text) {
  // "w h a t s a p p" → "whatsapp"
  // "9 8 7 6" → "9876"
  // Only collapse single-char tokens separated by spaces/dots/underscores
  return text
    .replace(/\b(\S)\s+(?=(\S\s+){1,}\S\b)/g, '$1') // multi-spaced chars
    .replace(/(\w)[.\-_](\w)/g, '$1$2');              // w.h.a.t → what
}

function removeDiacritics(text) {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeUnicode(text) {
  // Replace lookalike unicode chars (fullwidth, circled, etc.)
  return text
    .replace(/[ａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[Ａ-Ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

/**
 * Returns both normalized text (for checking) and
 * the original text (for saving after cleaning).
 */
function normalizeForCheck(text) {
  let normalized = text.toLowerCase();
  normalized = removeD iacritics(normalized);
  normalized = normalizeUnicode(normalized);
  normalized = normalizeLeetSpeak(normalized);
  normalized = collapseSpaces(normalized);
  return normalized;
}

module.exports = { normalizeForCheck };
