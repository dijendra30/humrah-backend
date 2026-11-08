// services/engagement/textSafety.js
// Shared character classes for notification text. Built from code points (not literal
// escapes) so every source file stays plain ASCII.
'use strict';

const ch = c => String.fromCharCode(c);
const range = (a, b) => `${ch(a)}-${ch(b)}`;

// C0/C1 controls, zero-width and bidi-override characters, word joiners, BOM.
const INVISIBLE_CLASS = range(0x0000, 0x001f) + range(0x007f, 0x009f) + range(0x200b, 0x200f)
  + range(0x2028, 0x202e) + range(0x2060, 0x2064) + ch(0xfeff);

const CONTROL_RE = new RegExp(`[${INVISIBLE_CLASS}]`);
// Characters that must never appear in a rendered value (markup, template syntax, controls).
// '&' is allowed: pushes are plain text and canonical Room topics use it ("Movies & Series").
const UNSAFE_VALUE_RE = new RegExp(`[<>"\`\\\\{}$%${INVISIBLE_CLASS}]`);

module.exports = { CONTROL_RE, UNSAFE_VALUE_RE, INVISIBLE_CLASS };
