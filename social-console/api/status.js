const { getRedis, listRuns } = require('./_lib/store');
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Social console storage is not configured' });
  try {
    const runs = await listRuns(redis);
    return res.status(200).json({ runs, capabilities: {
      storage: true,
      pipeline: Boolean(process.env.NOVELFLOW_OIDC_TOKEN),
      video: Boolean(process.env.NOVELFLOW_AC_TOKEN),
      llm: Boolean(process.env.NOVELFLOW_COPY_LLM_API_KEY),
      image: Boolean(process.env.NOVELFLOW_IMAGE_API_KEY),
      report: Boolean(process.env.NOVELFLOW_REPORT_TOKEN)
    }});
  } catch (error) {
    console.error('[social/status]', error);
    return res.status(500).json({ error: 'Unable to load social console status' });
  }
};
