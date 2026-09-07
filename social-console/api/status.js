const { getRedis, listRunSummaries, getRunSummary, videoCapacity } = require('./_lib/store');
const { requireSession } = require('./_lib/auth');
const { status: acPointsStatus } = require('./_lib/ac-budget');
const CAMPAIGN_ID_PATTERN = /^campaign_[0-9]{8}_[a-f0-9]{10}$/;

function parseStored(value) {
  if (!value) return null;
  try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
}

/**
 * Load an exact campaign window from its immutable manifest. The ordinary
 * dashboard intentionally uses a small recent window, but a campaign audit
 * must never silently stop at the newest 12/50 runs.
 */
async function listCampaignSummaries(redis, campaignId) {
  if (!redis || !CAMPAIGN_ID_PATTERN.test(String(campaignId || ''))) return null;
  const manifest = parseStored(await redis.get(`nf_social:campaign:${campaignId}`));
  if (!manifest || !Array.isArray(manifest.runIds)) return null;
  const ids = [...new Set(manifest.runIds.map((id) => String(id || '').trim()).filter(Boolean))];
  const runs = await Promise.all(ids.map((id) => getRunSummary(redis, id)));
  return {
    campaignId: String(campaignId),
    expected: ids.length,
    runs: runs.filter(Boolean),
    missingRunIds: ids.filter((id, index) => !runs[index])
  };
}
function copyRuntime() {
  const baseUrl = 'https://tokendance.space/gateway/v1';
  let baseHost = '';
  try { baseHost = new URL(baseUrl).host; } catch { baseHost = 'invalid'; }
  return {
    configured: Boolean(process.env.NOVELFLOW_TOKENDANCE_API_KEY),
    baseHost,
    model: 'glm-5.3-flash',
    wireApi: 'chat_completions',
    routes: {
      lingFlash: Boolean(process.env.NOVELFLOW_TOKENDANCE_API_KEY),
      legacyDeepseek: Boolean(process.env.NOVELFLOW_LLM_API_KEY),
      premium: Boolean(process.env.NOVELFLOW_TOKENDANCE_API_KEY)
    }
  };
}
function discordRuntime() {
  const ocrKey = Boolean(process.env.NOVELFLOW_OCR_API_KEY || process.env.NOVELFLOW_COPY_LLM_API_KEY || process.env.NOVELFLOW_LLM_API_KEY);
  return {
    interactions: Boolean(process.env.DISCORD_PUBLIC_KEY),
    accessControl: Boolean(process.env.NOVELFLOW_DISCORD_ALLOWED_GUILD_IDS || process.env.NOVELFLOW_DISCORD_ALLOWED_ROLE_IDS),
    attribution: Boolean(process.env.NOVELFLOW_DISCORD_CHANNEL_NAME_ID && process.env.NOVELFLOW_DISCORD_PROMOTER),
    ocr: Boolean(process.env.NOVELFLOW_OCR_MODEL && ocrKey),
    audit: Boolean(process.env.NOVELFLOW_DISCORD_OPERATOR_TOKEN)
  };
}
function statusRunLimit(value) {
  return Math.max(12, Math.min(50, Number(value) || 12));
}
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireSession(req, res)) return;
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Social console storage is not configured' });
  try {
    const campaignId = String(req.query?.campaignId || '').trim();
    if (campaignId && !CAMPAIGN_ID_PATTERN.test(campaignId)) {
      return res.status(400).json({ error: 'campaignId must be a valid campaign identifier' });
    }
    const campaign = campaignId ? await listCampaignSummaries(redis, campaignId) : null;
    if (campaignId && !campaign) return res.status(404).json({ error: 'Campaign not found' });
    const runLimit = campaign ? campaign.runs.length : statusRunLimit(req.query?.limit);
    const [runs, videoLimit, pointsBudget] = await Promise.all([
      campaign ? Promise.resolve(campaign.runs) : listRunSummaries(redis, runLimit),
      videoCapacity(redis),
      acPointsStatus(redis)
    ]);
    const videoConfigured = Boolean(process.env.AC_TOKEN || process.env.NOVELFLOW_AC_TOKEN);
    const imageConfigured = Boolean(process.env.IIIT_IMAGE_API_KEY);
    const pipelineConfigured = Boolean(process.env.NOVELFLOW_OIDC_TOKEN
      || (process.env.NOVELFLOW_OIDC_USERNAME && process.env.NOVELFLOW_OIDC_PASSWORD));
    const llmConfigured = copyRuntime().configured;
    const publishingConfigured = Boolean(process.env.SOCIALECHO_API_KEY);
    const pauseSetting = String(process.env.SOCIAL_VIDEO_GENERATION_PAUSED || '').trim().toLowerCase();
    const videoGenerationPaused = Boolean(pauseSetting && !['0', 'false', 'off'].includes(pauseSetting));
    const imagePauseSetting = String(process.env.SOCIAL_IMAGE_GENERATION_PAUSED || '').trim().toLowerCase();
    const imageGenerationPaused = Boolean(imagePauseSetting && !['0', 'false', 'off'].includes(imagePauseSetting));
    return res.status(200).json({ runs, runLimit, totalRunCount: campaign ? campaign.expected : runs.length, ...(campaign ? {
      scope: { type: 'campaign', campaignId: campaign.campaignId, expected: campaign.expected, returned: campaign.runs.length, missingRunIds: campaign.missingRunIds }
    } : { scope: { type: 'recent', returned: runs.length } }), capabilities: {
      storage: true,
      pipeline: pipelineConfigured,
      video: videoConfigured,
      llm: llmConfigured,
      image: imageConfigured,
      publishing: publishingConfigured,
      videoGenerationPaused,
      imageGenerationPaused,
      // Poster generation is optional for video-only social campaigns. Image
      // pause/configuration remains exposed above and is enforced by the
      // image-specific worker, but must not block paid P0-P7 video work.
      paidMediaAvailable: pipelineConfigured && videoConfigured && llmConfigured && publishingConfigured && !videoGenerationPaused,
      report: Boolean(process.env.NOVELFLOW_REPORT_TOKEN || process.env.NOVELFLOW_OIDC_TOKEN || (process.env.NOVELFLOW_OIDC_USERNAME && process.env.NOVELFLOW_OIDC_PASSWORD)),
      metaAds: Boolean(process.env.META_MARKETING_ACCESS_TOKEN),
      beidouReport: Boolean(process.env.BEIDOU_REPORT_TOKEN),
      discord: discordRuntime()
    }, videoLimit, pointsBudget, copyRuntime: copyRuntime() });
  } catch (error) {
    console.error('[social/status]', error);
    return res.status(500).json({ error: 'Unable to load social console status' });
  }
};
module.exports.statusRunLimit = statusRunLimit;
module.exports.listCampaignSummaries = listCampaignSummaries;
module.exports.CAMPAIGN_ID_PATTERN = CAMPAIGN_ID_PATTERN;
