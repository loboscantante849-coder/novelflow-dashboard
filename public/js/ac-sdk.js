/**
 * AC视频代理 - 前端SDK
 * 
 * 使用方式：
 * 1. 在ac.beidou.win浏览器Console获取Pinia token
 * 2. AC.setToken(token)
 * 3. AC.createVideo({ book_id, template, ... })
 * 
 * Token轮换：每次API调用后自动更新token（从响应头/响应体获取）
 */

const AC = (() => {
  const TOKEN_KEY = 'ac_api_token';
  const BASE = '/api/ac'; // 同域代理，或改为完整URL

  // ===== Token 管理 =====
  
  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  function setToken(token) {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    }
    return token;
  }

  function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
  }

  // 保存响应中的新token
  function saveNewToken(response) {
    // 优先从header取
    const headerToken = response.headers?.get?.('x-ac-token');
    if (headerToken) {
      setToken(headerToken);
      return;
    }
    // 备选从body取
    return response.clone().json().then(data => {
      if (data.newToken) {
        setToken(data.newToken);
      }
    }).catch(() => {});
  }

  // ===== 通用请求 =====

  async function request(path, options = {}) {
    const token = getToken();
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    
    // Token放header里
    if (token) {
      headers['x-ac-token'] = token;
    }

    const res = await fetch(`${BASE}${path}`, {
      ...options,
      headers,
    });

    // 自动保存新token
    await saveNewToken(res);

    const data = await res.json();
    
    if (!data.success && res.status === 401) {
      clearToken();
      console.warn('[AC] Token expired, please re-inject');
    }

    return data;
  }

  // ===== API 方法 =====

  /** 验证并注入token */
  async function validateToken(token) {
    setToken(token);
    const res = await request('/session/refresh', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    if (!res.success) {
      clearToken();
    }
    return res;
  }

  /** 创建视频任务 */
  async function createVideo({
    book_id,
    template = 'PPT_Porn',
    start_chapter = '1',
    end_chapter = '5',
    num = 3,
    language = 'English',
    country = 'US',
    ad_platform = 'Facebook',
    tts_audio_voice = 'Female_cur1',
    aspect_ratio = '9:16',
    copy_type = '原创',
    word_count = '200词',
    build_requirement = '',
    ad_copy = '',
    reference_picture_list = [],
    remark = '',
  }) {
    return request('/video/create', {
      method: 'POST',
      body: JSON.stringify({
        template,
        book_id,
        start_chapter,
        end_chapter,
        num,
        language,
        country,
        ad_platform,
        tts_audio_voice,
        aspect_ratio,
        copy_type,
        word_count,
        build_requirement,
        ad_copy,
        reference_picture_list,
        remark,
      }),
    });
  }

  /** 查询任务列表 */
  async function listVideos(pageSize = 10, pageIndex = 1) {
    return request(`/video/list?pageSize=${pageSize}&pageIndex=${pageIndex}`);
  }

  /** 查询任务结果 */
  async function getVideoResult(threadId) {
    return request(`/video/result?threadId=${threadId}`);
  }

  /** 中断任务 */
  async function interruptVideo(threadId) {
    return request('/video/interrupt', {
      method: 'POST',
      body: JSON.stringify({ threadId }),
    });
  }

  /** 重试任务 */
  async function retryVideo(threadId) {
    return request('/video/retry', {
      method: 'POST',
      body: JSON.stringify({ threadId }),
    });
  }

  /** 轮询任务状态直到完成 */
  async function waitForCompletion(threadId, intervalMs = 10000, maxAttempts = 120) {
    for (let i = 0; i < maxAttempts; i++) {
      const res = await getVideoResult(threadId);
      if (!res.success) return res;

      const status = res.data?.base_info?.status;
      if (status === 'completed' || status === 'failed' || status === 'interrupted') {
        return res;
      }

      await new Promise(r => setTimeout(r, intervalMs));
    }
    return { success: false, error: 'Polling timeout' };
  }

  return {
    getToken,
    setToken,
    clearToken,
    validateToken,
    createVideo,
    listVideos,
    getVideoResult,
    interruptVideo,
    retryVideo,
    waitForCompletion,
  };
})();

// 暴露到全局
if (typeof window !== 'undefined') {
  window.AC = AC;
}
