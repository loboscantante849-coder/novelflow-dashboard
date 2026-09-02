'use strict';

const { setCORSHeaders } = require('../_lib/cors');
const { buildOAuthStateCookie, createOAuthState } = require('../_lib/oauth-state');
const { normalizeReferralCode } = require('../_lib/referrals');

const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1504779503237333033';
const REFERRAL_COOKIE = 'nf_referral_code';
// NovelFlow uses local username/password authentication.  Keep the legacy
// Discord OAuth implementation available only when explicitly enabled for a
// controlled migration; it must never become an accidental public login path.
function isDiscordAuthEnabled() {
  return process.env.ENABLE_DISCORD_AUTH === 'true';
}

function buildReferralCookie(code, maxAge = 600) {
  return `${REFERRAL_COOKIE}=${encodeURIComponent(code)}; HttpOnly; Secure; SameSite=Lax; Path=/api/auth/callback; Max-Age=${maxAge}`;
}

function getRedirectUri() {
  return process.env.DISCORD_REDIRECT_URI || 'https://novelflow.top/api/auth/callback';
}

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!isDiscordAuthEnabled()) {
    return res.status(404).json({
      error: 'Discord login is not enabled',
      message: 'Use your NovelFlow username and password to log in.',
    });
  }

  const state = createOAuthState();
  const authorizeUrl = new URL('https://discord.com/api/oauth2/authorize');
  authorizeUrl.searchParams.set('client_id', CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', getRedirectUri());
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', 'identify');
  authorizeUrl.searchParams.set('state', state);

  const cookies = [buildOAuthStateCookie(state)];
  const referralCode = normalizeReferralCode(req.query && req.query.ref);
  if (referralCode) cookies.push(buildReferralCookie(referralCode));
  res.setHeader('Set-Cookie', cookies);
  return res.redirect(302, authorizeUrl.href);
};
