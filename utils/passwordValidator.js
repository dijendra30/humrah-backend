// utils/passwordValidator.js
// ─────────────────────────────────────────────────────────────────────────────
// Humrah – Server-side password validation
// NEVER trust frontend validation alone. This runs on every register call.
// ─────────────────────────────────────────────────────────────────────────────

const COMMON_PASSWORDS = new Set([
  "123456", "password", "12345678", "qwerty", "111111",
  "123123", "abc123", "password1", "letmein", "welcome",
  "monkey", "dragon", "master", "sunshine", "princess",
  "admin", "login", "pass", "test123", "1234567890"
]);

/**
 * Validates that a password meets Humrah's strength requirements.
 *
 * Rules:
 *  ✔ Minimum 8 characters
 *  ✔ At least 1 letter  (A–Z or a–z)
 *  ✔ At least 1 digit   (0–9)
 *  ✔ At least 1 special character (@$!%*?&)
 *  ✔ Not in the common-password blocklist
 *
 * @param {string} password
 * @returns {{ valid: boolean, message?: string }}
 */
function isStrongPassword(password) {
  if (typeof password !== "string" || password.length === 0) {
    return { valid: false, message: "Password is required." };
  }

  if (password.length < 8) {
    return { valid: false, message: "Password must be at least 8 characters long." };
  }

  if (!/[A-Za-z]/.test(password)) {
    return { valid: false, message: "Password must contain at least one letter." };
  }

  if (!/\d/.test(password)) {
    return { valid: false, message: "Password must contain at least one number." };
  }

  if (!/[@$!%*?&]/.test(password)) {
    return {
      valid: false,
      message: "Password must contain at least one special character (@$!%*?&)."
    };
  }

  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return { valid: false, message: "This password is too common. Please choose a stronger one." };
  }

  return { valid: true };
}

module.exports = { isStrongPassword };
