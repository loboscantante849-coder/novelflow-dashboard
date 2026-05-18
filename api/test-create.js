module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({error: 'Method not allowed'});
  
  const HARDCODED_TOKEN = 'eyJhbGciOiJSUzI1NiIsImtpZCI6IkU4QzAzQjVGMzhENjQzRTE3OTQ4MEU1NkE2REI4QkQ5IiwidHlwIjoiYXQrand0In0.eyJuYmYiOjE3NzgyOTI3NjUsImV4cCI6MTc3OTU4ODc2NSwiaXNzIjoiaHR0cHM6Ly9zdHMuYW55c3Rvcmllcy5hcHAiLCJjbGllbnRfaWQiOiJBdXRoQ2xpZW50Iiwic3ViIjoiMTE2NCIsImF1dGhfdGltZSI6MTc3NzM0MDY2NCwiaWRwIjoibG9jYWwiLCJuaWNrbmFtZSI6IuW-kOaVrOa2myIsIm5hbWUiOiJ4dWp0Iiwic2lkIjoiRUU0MzJGRjNGRjMxOUZBOTZENUQzRUMxRkU4MTVFOTMiLCJpYXQiOjE3NzgyOTI3NjUsInNjb3BlIjpbIm9wZW5pZCIsInByb2ZpbGUiLCJyb2xlcyIsImVtYWlsIl0sImFtciI6WyJwd2QiXX0.ZZ31UyfAdexg5ShQEmdvvS4AkyXZt-3Sze7X779iIgduiW2eiFuVRkxOeUPenPccdQqa0kTJNWVOMY3jMJgdXsxME41eOZnolV4Fl-NvHkCVYJKgIb1BeI6I35_Dc9rFfIO809EpPQ7Ncu__6fTmzfvQFS-LaBPUH4ZsPFLouoLjfZw1pbUSYXA1fB5LRIFe0CmeqCBMkTRVh-GMOK9fz4sDLZnAYz-LftyeqdU8X-GSKJzNBCBLzO9XcTW8y9CQK9hMChmqhBzYWXOiX-u7Dn2GrMEXaiY5vZtp2_tQE9FqOm1NX05AF6DQqQh-yOFfQBUhyZeXr4SlU4gTZ_LpLw';
  const BOOKSTORE_API_BASE = 'https://admin.novelspa.app/api/v1/novelmanage';
  const BOOKSTORE_APP_ID = '642fc1ace309494378a774a6';
  
  const { bookId } = req.body || {};
  if (!bookId) return res.status(400).json({error: 'bookId required'});
  
  const logs = [];
  
  // Step 1: Create code
  let code = null;
  const STARTING_CODE = 4700;
  for (let tryCode = STARTING_CODE; tryCode < STARTING_CODE + 20; tryCode++) {
    try {
      const codeResp = await fetch(`${BOOKSTORE_API_BASE}/book/savebookpromotionkeywords`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${HARDCODED_TOKEN}`,
          'Content-Type': 'application/json;charset=UTF-8',
          'X-OS': 'web', 'X-AppName': 'web-admin', 'X-AppIdentifier': 'web', 'X-AppVersion': '1.0.0,1'
        },
        body: JSON.stringify({ applicationId: BOOKSTORE_APP_ID, keyword: String(tryCode), bookId, channel: 'FB', isEnable: true })
      });
      logs.push(`Code ${tryCode}: status=${codeResp.status}`);
      if (codeResp.ok) {
        const codeData = await codeResp.json();
        logs.push(`Code ${tryCode}: data=${JSON.stringify(codeData)}`);
        if (codeData.data) { code = tryCode; break; }
      } else {
        logs.push(`Code ${tryCode}: error=${await codeResp.text()}`);
      }
    } catch (e) {
      logs.push(`Code ${tryCode}: exception=${e.message}`);
    }
  }
  
  // Step 2: Create link if code succeeded
  let link = null;
  let linkId = null;
  if (code) {
    try {
      const linkResp = await fetch(`${BOOKSTORE_API_BASE}/SocialMediaLinkConfig`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${HARDCODED_TOKEN}`,
          'Content-Type': 'application/json',
          'X-OS': 'web', 'X-AppName': 'web-admin', 'X-AppIdentifier': 'web', 'X-AppVersion': '1.0.0,1'
        },
        body: JSON.stringify({
          linkName: `${code}-书籍详情页-FB`,
          applicationId: BOOKSTORE_APP_ID,
          mediaSource: 'SocialMedia',
          channelName: 'NovelFlow_SocialMedia_Facebook-grounp_Facebook_xujt',
          channelNameId: '699ef7b8194eb218db3c2270',
          contentType: 1, contentNameOrSku: bookId, contentName: 'Test Book',
          languageCode: 'en', redirectConfigId: '68fecf8b3a29f6eff435fd3b',
          redirectPosition: '书籍详情页', redirectProtocol: 'novelflow:///book',
          contentRedirectSequence: 1, operatorName: '徐敬涛',
          templateId: '6a01499261118c6285dff7dd', isEnabled: true,
          landingPageTemplates: [{templateId: '6a01499261118c6285dff7dd', templateName: `${code}-书籍详情页-FB`, templateWeight: 100, isDeleted: false}]
        })
      });
      logs.push(`Link: status=${linkResp.status}`);
      const linkData = await linkResp.json();
      logs.push(`Link: data=${JSON.stringify(linkData).substring(0, 200)}`);
      if (linkData.code === 200 && linkData.data) {
        linkId = linkData.data;
        // Get shortUrl
        const detailResp = await fetch(`${BOOKSTORE_API_BASE}/SocialMediaLinkConfig/${linkId}`, {
          headers: {'Authorization': `Bearer ${HARDCODED_TOKEN}`, 'Content-Type': 'application/json'}
        });
        if (detailResp.ok) {
          const detailData = await detailResp.json();
          if (detailData.data && detailData.data.shortUrl) {
            link = `https://${detailData.data.shortUrl}`;
          }
        }
      }
    } catch (e) {
      logs.push(`Link: exception=${e.message}`);
    }
  }
  
  res.status(200).json({ code, link, linkId, logs });
};
