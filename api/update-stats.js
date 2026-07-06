/**
 * DEPRECATED 2026-07-06
 *
 * 旧版 Vercel cron（每2小时）：拉 putreport（仅6个硬编码campaign）→ 写 GitHub data.json
 * 现已被外部统一数据管道 pipeline_unified_push.py 取代（双源 putreport + code-funnel，
 * 全量 1060 个 ad_id，48 个推广者，支持 dn 收入/link&code 拆分）。
 *
 * 保留此空路由是为了避免 vercel.json 中 cron 配置调用 404 触发告警。
 * 实际数据更新由沙箱日程每 2 小时触发 pipeline_unified_push.py → git push → Vercel 自动部署。
 */

const { setCORSHeaders } = require('./_lib/cors');

module.exports = async (req, res) => {
  setCORSHeaders(req, res, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  res.status(200).json({
    deprecated: true,
    message: 'update-stats cron is deprecated as of 2026-07-06. Data pipeline now runs externally via pipeline_unified_push.py.',
    dataSource: 'unified_funnel_v1',
    repo: 'loboscantante849-coder/novelflow-dashboard',
    docs: 'see codeact/scripts/pipeline_unified_push.py',
    ts: new Date().toISOString()
  });
};
