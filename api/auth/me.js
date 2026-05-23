const { setCORSHeaders } = require('../_lib/cors');
const { verifyJWT } = require('../_lib/jwt');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const cookieHeader = req.headers.cookie || '';
    const cookies = {};
    cookieHeader.split(';').forEach(cookie => {
      const [name, ...rest] = cookie.split('=');
      if (name && rest.length > 0) {
        cookies[name.trim()] = rest.join('=').trim();
      }
    });

    const token = cookies['nf_token'];
    
    if (!token) {
      return res.status(200).json({ loggedIn: false });
    }

    const payload = verifyJWT(token);
    
    if (!payload) {
      res.setHeader('Set-Cookie', 'nf_token=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
      return res.status(200).json({ loggedIn: false });
    }

    if (payload.type === 'local') {
      return res.status(200).json({
        loggedIn: true,
        accountType: 'local',
        username: payload.username,
        novelFlowId: payload.novelFlowId,
      });
    } else {
      return res.status(200).json({
        loggedIn: true,
        accountType: 'discord',
        discordId: payload.discordId,
        username: payload.globalName || payload.username,
        avatar: payload.avatar,
        discriminator: payload.discriminator,
      });
    }
  } catch (error) {
    console.error('Auth check error:', error);
    return res.status(200).json({ loggedIn: false });
  }
};
