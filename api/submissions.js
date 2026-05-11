module.exports = async (req, res) => {
  // Only allow GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const owner = 'loboscantante849-coder';
  const repo = 'novelflow-dashboard';
  const path = 'submissions.json';
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

  try {
    const response = await fetch(apiBase + '?ref=main', {
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'NovelFlow-API'
      }
    });

    if (!response.ok) {
      // If file doesn't exist on main, try master
      if (response.status === 404) {
        const masterResponse = await fetch(apiBase + '?ref=master', {
          headers: {
            'Authorization': `token ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'NovelFlow-API'
          }
        });
        
        if (!masterResponse.ok) {
          // File doesn't exist, return empty array
          return res.status(200).json([]);
        }
        
        const data = await masterResponse.json();
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        const submissions = JSON.parse(content);
        return res.status(200).json(Array.isArray(submissions) ? submissions : []);
      }
      
      return res.status(response.status).json({ error: 'Failed to fetch data' });
    }

    const data = await response.json();
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    const submissions = JSON.parse(content);
    
    return res.status(200).json(Array.isArray(submissions) ? submissions : []);

  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
