module.exports = async (req, res) => {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN not set in Vercel environment variables' });
  }

  const { bookName, discordUsername, promotionMethod, notes } = req.body || {};

  // Validation
  if (!bookName || !discordUsername) {
    return res.status(400).json({ error: 'bookName and discordUsername are required' });
  }

  const owner = 'loboscantante849-coder';
  const repo = 'novelflow-dashboard';
  const path = 'submissions.json';
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

  try {
    // Step 1: Get current file SHA
    const getResponse = await fetch(apiBase, {
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'NovelFlow-API'
      }
    });

    let sha = null;
    if (getResponse.ok) {
      const data = await getResponse.json();
      sha = data.sha;
    }

    // Step 2: Read existing submissions
    let existingData = [];
    if (getResponse.ok) {
      const data = await getResponse.json();
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      try {
        existingData = JSON.parse(content);
        if (!Array.isArray(existingData)) {
          existingData = [];
        }
      } catch (e) {
        existingData = [];
      }
    }

    // Step 3: Add new submission
    const newSubmission = {
      id: 'sub_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      bookName: bookName.trim(),
      discordUsername: discordUsername.trim(),
      promotionMethod: promotionMethod || '',
      notes: notes || '',
      submittedAt: new Date().toISOString()
    };

    existingData.push(newSubmission);

    // Step 4: Write updated content
    const content = Buffer.from(JSON.stringify(existingData, null, 2)).toString('base64');
    const putBody = {
      message: 'Add new book submission: ' + bookName,
      content: content
    };
    if (sha) {
      putBody.sha = sha;
    }

    const putResponse = await fetch(apiBase, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'NovelFlow-API'
      },
      body: JSON.stringify(putBody)
    });

    if (!putResponse.ok) {
      const error = await putResponse.json();
      console.error('GitHub API error:', error);
      return res.status(500).json({ error: 'Failed to save submission' });
    }

    return res.status(200).json({ 
      success: true, 
      submission: newSubmission 
    });

  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'Server error: ' + error.message, stack: error.stack });
  }
};
