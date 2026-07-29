'use strict';

const { setCORSHeaders } = require('../_lib/cors');
const { buildOAuthStateCookie, createOAuthState } = require('../_lib/oauth-state');

const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1504779503237333033';

function getRedirectUri() {
  return process.env.DISCORD_REDIRECT_URI || 'https://novelflow.top/api/auth/callback';
}

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const state = createOAuthState();
  const authorizeUrl = new URL('https://discord.com/api/oauth2/authorize');
  authorizeUrl.searchParams.set('client_id', CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', getRedirectUri());
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', 'identify');
  authorizeUrl.searchParams.set('state', state);

  res.setHeader('Set-Cookie', buildOAuthStateCookie(state));
  return res.redirect(302, authorizeUrl.href);
};
