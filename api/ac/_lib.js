/**
 * AC API 代理 - 共享工具模块
 * 
 * 认证机制：JWT token轮换，每次AC响应header `accesstoken` 返回新token
 * 本模块：转发请求 → 捕获新token → 附加到响应
 */

const AC_BASE = 'https://ac.beidou.win/api/v1';
const AC_HEADERS = {
  'x-client': 'beidou-web',
  'X-Project-Id': '1006',
  'Content-Type': 'application/json',
};

/**
 * 代理请求到AC API
 * @param {string} path - API路径（如 /creative/by-user）
 * @param {object} options - fetch选项
 * @param {string} token - 当前JWT token
 * @returns {Promise<{status, data, newToken}>}
 */
async function proxyRequest(path, options = {}, token) {
  if (!token) {
    return { status: 401, data: { error: 'No token provided' }, newToken: null };
  }

  const url = `${AC_BASE}${path}`;
  const headers = {
    ...AC_HEADERS,
    'Authorization': `Bearer ${token}`,
  };

  // GET请求不需要Content-Type
  if (options.method === 'GET' || !options.method) {
    delete headers['Content-Type'];
  }

  const fetchOptions = {
    ...options,
    headers,
  };

  try {
    const res = await fetch(url, fetchOptions);
    const newToken = res.headers.get('accesstoken') || null;
    
    let data;
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      data = await res.json();
    } else {
      data = await res.text();
    }

    return { status: res.status, data, newToken };
  } catch (err) {
    return { status: 502, data: { error: 'AC API unreachable', detail: err.message }, newToken: null };
  }
}

/**
 * 构建代理响应 - 包含AC原始数据 + 新token
 */
function buildResponse(status, data, newToken) {
  return {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      // 前端用这个header拿新token
      'x-ac-token': newToken || '',
    },
    body: JSON.stringify({
      success: status >= 200 && status < 300,
      data,
      // 也放body里方便读取
      newToken: newToken || undefined,
    }),
  };
}

/**
 * 从请求中提取token（优先header，其次body）
 */
function extractToken(req) {
  // 1. 从自定义header取
  const headerToken = req.headers['x-ac-token'] || req.headers['authorization']?.replace('Bearer ', '');
  if (headerToken) return headerToken;
  
  // 2. 从body取
  if (req.body && req.body.token) return req.body.token;
  
  return null;
}

module.exports = { proxyRequest, buildResponse, extractToken, AC_BASE, AC_HEADERS };
