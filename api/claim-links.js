/**
 * POST /api/claim-links
 * 
 * Legacy anonymous-code claiming is retired. Promotion creation now requires
 * authentication, so accepting client-supplied code lists would only preserve
 * a guessable cross-account ownership path.
 */
const { setCORSHeaders } = require('./_lib/cors');
const { verifyAccessToken } = require('./_lib/jwt');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify auth
  const cookieHeader = req.headers.cookie || '';
  const cookieMatch = cookieHeader.match(/nf_token=([^;]+)/);
  const authHeader = req.headers.authorization;
  let username = null;

  if (cookieMatch) { const p = verifyAccessToken(cookieMatch[1]); if (p?.username) username = p.username; }
  if (!username && authHeader?.startsWith('Bearer ')) { const p = verifyAccessToken(authHeader.slice(7)); if (p?.username) username = p.username; }

  if (!username) return res.status(401).json({ error: 'Not authenticated' });

  return res.status(410).json({ error: 'Legacy link claiming is no longer available' });
};
