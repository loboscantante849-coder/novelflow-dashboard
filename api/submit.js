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

  // Bookstore API config
  const BOOKSTORE_API_BASE = 'https://admin.novelspa.app/api/v1/novelmanage';
  const BOOKSTORE_APP_ID = '642fc1ace309494378a774a6';
  const BOOKSTORE_TOKEN = process.env.BOOKSTORE_TOKEN;
  const STARTING_CODE = 4545; // Next available code after 4544 (The Luna Warrior)

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
    let existingData = [];
    if (getResponse.ok) {
      const data = await getResponse.json();
      sha = data.sha;
      // Read content from the same response
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

    // Step 2: Add new submission
    const newSubmission = {
      id: 'sub_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      bookName: bookName.trim(),
      discordUsername: discordUsername.trim(),
      promotionMethod: promotionMethod || '',
      notes: notes || '',
      submittedAt: new Date().toISOString()
    };

    existingData.push(newSubmission);

    // Step 3: Write updated content to GitHub
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

    // Step 4: Auto-create code and link if BOOKSTORE_TOKEN is available
    if (BOOKSTORE_TOKEN) {
      try {
        // 4a: Search for book by name to get bookId
        const searchResponse = await fetch(
          `${BOOKSTORE_API_BASE}/book/search?keyword=${encodeURIComponent(bookName.trim())}&pageSize=5`,
          {
            headers: {
              'Authorization': `Bearer ${BOOKSTORE_TOKEN}`,
              'Content-Type': 'application/json'
            }
          }
        );

        let bookId = null;
        let matchedBookName = null;

        if (searchResponse.ok) {
          const searchData = await searchResponse.json();
          if (searchData.code === 200 && searchData.data?.data?.length > 0) {
            // Take the first match
            const book = searchData.data.data[0];
            bookId = book.id || book.bookId || book.skuId;
            matchedBookName = book.bookName || book.name;
            console.log(`Book found: ${matchedBookName}, ID: ${bookId}`);
          }
        }

        if (!bookId) {
          console.warn(`Book not found for: ${bookName}, skipping code/link creation`);
          return res.status(200).json({ 
            success: true, 
            submission: newSubmission,
            warning: 'Book not found in bookstore, code/link not created'
          });
        }

        // 4b: Get existing codes to find next available code
        const listResponse = await fetch(
          `${BOOKSTORE_API_BASE}/book/savebookpromotionkeywords?pageNum=1&pageSize=1&applicationId=${BOOKSTORE_APP_ID}`,
          {
            headers: {
              'Authorization': `Bearer ${BOOKSTORE_TOKEN}`,
              'Content-Type': 'application/json'
            }
          }
        );

        let nextCode = STARTING_CODE;
        
        // Try to get max existing code from list
        // Note: The list API might return codes, parse from the response
        // For now, we'll try codes incrementally until success
        // This is a fallback - ideally we should query the existing codes
        
        // 4c: Create the search code
        const codeResponse = await fetch(`${BOOKSTORE_API_BASE}/book/savebookpromotionkeywords`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${BOOKSTORE_TOKEN}`,
            'Content-Type': 'application/json;charset=UTF-8',
            'X-OS': 'web',
            'X-AppName': 'web-admin',
            'X-AppIdentifier': 'web',
            'X-AppVersion': '1.0.0,1'
          },
          body: JSON.stringify({
            applicationId: BOOKSTORE_APP_ID,
            keyword: String(STARTING_CODE),
            bookId: bookId,
            channel: 'FB'
          })
        });

        let codeResult = null;
        let shortUrl = null;
        let finalCode = STARTING_CODE;

        if (codeResponse.ok) {
          const codeData = await codeResponse.json();
          if (codeData.code === 200 && codeData.data) {
            codeResult = codeData.data;
            finalCode = codeData.data.keywordId || STARTING_CODE;
            console.log(`Search code created: ${finalCode}`);
          }
        }

        // If code creation failed (duplicate), try incrementally
        if (!codeResult) {
          for (let tryCode = STARTING_CODE + 1; tryCode < STARTING_CODE + 100; tryCode++) {
            const retryResponse = await fetch(`${BOOKSTORE_API_BASE}/book/savebookpromotionkeywords`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${BOOKSTORE_TOKEN}`,
                'Content-Type': 'application/json;charset=UTF-8',
                'X-OS': 'web',
                'X-AppName': 'web-admin',
                'X-AppIdentifier': 'web',
                'X-AppVersion': '1.0.0,1'
              },
              body: JSON.stringify({
                applicationId: BOOKSTORE_APP_ID,
                keyword: String(tryCode),
                bookId: bookId,
                channel: 'FB'
              })
            });

            if (retryResponse.ok) {
              const retryData = await retryResponse.json();
              if (retryData.code === 200 && retryData.data) {
                codeResult = retryData.data;
                finalCode = retryData.data.keywordId || tryCode;
                console.log(`Search code created: ${finalCode}`);
                break;
              }
            }
          }
        }

        // 4d: Create the short link
        // Note: Not passing channelCode to avoid adGroupName duplication
        const linkName = `${finalCode}${matchedBookName || bookName}-书籍详情页-FB`;
        const adGroupName = `${BOOKSTORE_APP_ID}_Android_SocialMedia_NovelFlow_SocialMedia_KOC__${linkName}_novelflow`;

        const linkResponse = await fetch(`${BOOKSTORE_API_BASE}/SocialMediaLinkConfig`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${BOOKSTORE_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            linkName: linkName,
            applicationId: BOOKSTORE_APP_ID,
            mediaSource: 'SocialMedia',
            channelName: 'KOC',
            contentType: 1,
            contentTypeName: '小说',
            contentNameOrSku: `${matchedBookName || bookName} (${bookId})`,
            languageCode: 'en',
            redirectPosition: '书籍详情页',
            contentRedirectSequence: 1,
            operatorName: 'novelflow',
            adGroupName: adGroupName,
            channelSource: 'SocialMedia(KOC)',
            isEnabled: true,
            probability: 100,
            isAutoRedirect: 0
          })
        });

        if (linkResponse.ok) {
          const linkData = await linkResponse.json();
          if (linkData.code === 200 && linkData.data) {
            shortUrl = linkData.data.shortUrl || linkData.shortUrl;
            console.log(`Short link created: ${shortUrl}`);
          }
        }

        // 4e: Update submission with code and link
        // Re-fetch the file to get latest SHA
        const refreshResponse = await fetch(apiBase, {
          headers: {
            'Authorization': `token ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'NovelFlow-API'
          }
        });

        if (refreshResponse.ok) {
          const refreshData = await refreshResponse.json();
          const latestSha = refreshData.sha;
          
          // Find and update the submission we just created
          const latestContent = Buffer.from(refreshData.content, 'base64').toString('utf-8');
          let latestData = JSON.parse(latestContent);
          
          // Find the submission by ID
          const submissionIndex = latestData.findIndex(s => s.id === newSubmission.id);
          if (submissionIndex !== -1) {
            latestData[submissionIndex].code = String(finalCode);
            latestData[submissionIndex].bookId = bookId;
            if (shortUrl) {
              latestData[submissionIndex].link = shortUrl;
              latestData[submissionIndex].shortUrl = shortUrl;
            }
            
            // Update the file
            const updateContent = Buffer.from(JSON.stringify(latestData, null, 2)).toString('base64');
            await fetch(apiBase, {
              method: 'PUT',
              headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
                'User-Agent': 'NovelFlow-API'
              },
              body: JSON.stringify({
                message: 'Update submission with code and link: ' + bookName,
                content: updateContent,
                sha: latestSha
              })
            });
            
            // Update the response object
            newSubmission.code = String(finalCode);
            newSubmission.bookId = bookId;
            if (shortUrl) {
              newSubmission.link = shortUrl;
              newSubmission.shortUrl = shortUrl;
            }
          }
        }

        console.log(`Submission completed: ${newSubmission.id}, code: ${finalCode}`);

      } catch (autoCreateError) {
        // Auto-create failed, but submission itself was saved
        console.error('Auto-create code/link failed:', autoCreateError.message);
        return res.status(200).json({ 
          success: true, 
          submission: newSubmission,
          warning: 'Auto-create code/link failed: ' + autoCreateError.message
        });
      }
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
