/**
 * DEPRECATED 2026-07-06
 *
 * 旧版 Vercel cron（每2小时）：拉 putreport（仅6个硬编码campaign）→ 写 GitHub data.json
 * 现已被外部统一数据管道 pipeline_unified_push.py 取代（双源 putreport + code-funnel，
 * 全量 1060 个 ad_id，48 个推广者，支持 dn 收入/link&code 拆分）。
 *
 * 保留此空路由仅用于兼容旧调用；vercel.json 已不再调度它。
 * 实际数据更新由私有 novelflow-automation 仓库的 GitHub Actions 每 2 小时触发。
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
    docs: 'see loboscantante849-coder/novelflow-automation',
    ts: new Date().toISOString()
  });
};
