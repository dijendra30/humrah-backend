// services/googleAuthService.js
// =============================================
// SECURE GOOGLE ID TOKEN VERIFICATION SERVICE
// =============================================
// Verifies Google ID tokens server-side using google-auth-library.
// Backend NEVER trusts client-sent email/name/googleId.
// Only payload fields returned by Google's servers are trusted.
//
// Required env var: GOOGLE_CLIENT_ID (your Android OAuth2 client_id)
// =============================================

const { OAuth2Client } = require('google-auth-library');

// Instantiate once at module load — OAuth2Client is stateless, safe to reuse.
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

/**
 * Verifies a Google ID token and returns the verified payload.
 *
 * @param {string} idToken  - The ID token sent from the Android client.
 * @returns {Promise<{
 *   sub:            string,   // Google's stable unique user ID (use as googleId)
 *   email:          string,
 *   email_verified: boolean,
 *   name:           string,
 *   picture:        string | undefined
 * }>}
 * @throws {Error} with a user-safe message if verification fails for any reason.
 */
async function verifyGoogleIdToken(idToken) {
  if (!process.env.GOOGLE_CLIENT_ID) {
    // Config error — do not expose internals to the client.
    console.error('[googleAuthService] GOOGLE_CLIENT_ID env var is not set.');
    throw Object.assign(new Error('Server authentication configuration error.'), { statusCode: 500 });
  }

  let ticket;
  try {
    ticket = await client.verifyIdToken({
      idToken,
      // audience must match the client_id used in the Android app.
      audience: process.env.GOOGLE_CLIENT_ID,
    });
  } catch (err) {
    // google-auth-library throws on:
    //   - expired token
    //   - invalid signature
    //   - wrong audience
    //   - revoked token
    console.warn('[googleAuthService] Token verification failed:', err.message);
    throw Object.assign(
      new Error('Google authentication failed. Please sign in again.'),
      { statusCode: 401 }
    );
  }

  const payload = ticket.getPayload();

  // Issuer check — must be accounts.google.com or https://accounts.google.com.
  // google-auth-library already validates this internally, but we double-check.
  const validIssuers = ['accounts.google.com', 'https://accounts.google.com'];
  if (!validIssuers.includes(payload.iss)) {
    console.warn('[googleAuthService] Invalid issuer:', payload.iss);
    throw Object.assign(
      new Error('Google authentication failed. Invalid token issuer.'),
      { statusCode: 401 }
    );
  }

  // email_verified must be true.
  // Unverified Google emails are rare but possible (e.g. legacy accounts).
  if (!payload.email_verified) {
    console.warn('[googleAuthService] email_verified=false for sub:', payload.sub);
    throw Object.assign(
      new Error('Your Google email address is not verified. Please verify it with Google first.'),
      { statusCode: 403 }
    );
  }

  // Return ONLY the fields we trust from Google's verified payload.
  return {
    sub:            payload.sub,            // stable unique Google user ID
    email:          payload.email,          // verified email
    email_verified: payload.email_verified, // always true at this point
    name:           payload.name || '',     // display name (may be empty)
    picture:        payload.picture,        // profile photo URL (may be undefined)
  };
}

module.exports = { verifyGoogleIdToken };
