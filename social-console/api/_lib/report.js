function number(value) { return Number(value || 0); }

function validDate(value) {
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function inWindow(run, start) {
  const created = validDate(run.createdAt);
  const updated = validDate(run.updatedAt);
  return Boolean((created && created >= start) || (updated && updated >= start));
}

function assetCounts(runs) {
  return runs.reduce((total, run) => {
    const artifacts = run.artifacts || {};
    total.copy += Array.isArray(artifacts.posts) ? artifacts.posts.length : 0;
    total.posters += Array.isArray(artifacts.images) ? artifacts.images.filter((image) => image.url).length : 0;
    total.videos += artifacts.video?.videoUrls?.length || 0;
    total.videos += artifacts.referenceVideo?.videoUrls?.length || 0;
    return total;
  }, { copy: 0, posters: 0, videos: 0 });
}

function analyticsTotals(runs) {
  const totals = { pullUv: 0, activeUv: 0, newUv: 0, d7Income: 0, attributedRuns: 0, reliableRuns: 0 };
  for (const run of runs) {
    const summary = run.artifacts?.analytics?.summary;
    if (!summary || !number(summary.rowCount)) continue;
    totals.attributedRuns += 1;
    totals.pullUv += number(summary.pullUv);
    totals.activeUv += number(summary.activeUv);
    totals.newUv += number(summary.newUv);
    totals.d7Income += number(summary.d7Income);
    if (summary.sampleState === 'reliable') totals.reliableRuns += 1;
  }
  totals.activationRate = totals.pullUv ? Math.round(totals.activeUv / totals.pullUv * 10000) / 100 : null;
  totals.newUserRate = totals.activeUv ? Math.round(totals.newUv / totals.activeUv * 10000) / 100 : null;
  return totals;
}

function runRisk(run, reason, level = 'attention') {
  return { id: run.id, title: run.artifacts?.book?.title || run.input?.title || 'Untitled task', level, reason, state: run.state };
}

function collectRisks(runs) {
  const risks = [];
  for (const run of runs) {
    if (['failed', 'blocked'].includes(run.state)) {
      risks.push(runRisk(run, run.state === 'failed' ? '任务已失败，需要恢复或重新提交。' : '任务被阻塞，需要补齐前置条件。', 'critical'));
      continue;
    }
    const ambiguous = Object.values(run.stages || {}).find((stage) => stage?.status === 'ambiguous');
    if (ambiguous) {
      risks.push(runRisk(run, '付费素材提交结果存在歧义，系统未自动重试，等待人工核验。', 'critical'));
      continue;
    }
    if (run.state === 'completed' && (!run.artifacts?.code || !run.artifacts?.shortUrl)) {
      risks.push(runRisk(run, '素材已完成但追踪 Code 或短链缺失，无法可靠归因。'));
    }
  }
  return risks.slice(0, 8);
}

function formatDate(date) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date);
}

function buildHighlights(analytics, operations, risks) {
  const highlights = [];
  if (analytics.attributedRuns) {
    const rate = analytics.activationRate == null ? '--' : `${analytics.activationRate}%`;
    highlights.push({ tone: analytics.reliableRuns ? 'positive' : 'neutral', title: '归因已回传', detail: `${analytics.attributedRuns} 个任务有真实归因，累计拉起 ${analytics.pullUv.toLocaleString('zh-CN')} UV，激活率 ${rate}。` });
  } else {
    highlights.push({ tone: 'neutral', title: '归因样本仍在积累', detail: '当前尚无可汇总的归因样本，不对素材效果作结论。' });
  }
  if (operations.completed) highlights.push({ tone: 'positive', title: '可复用产能已形成', detail: `${operations.completed} 个任务已完成，后续可直接从素材库取用已有文案、海报和视频。` });
  if (risks.length) highlights.push({ tone: 'attention', title: '需要优先处理', detail: `${risks.length} 个任务存在阻塞、失败或归因缺口，已列入待决事项。` });
  return highlights.slice(0, 3);
}

function buildRecommendations(operations, assets, tracking, analytics, risks) {
  const recommendations = [];
  if (risks.length) recommendations.push('先清理待决任务：优先处理付费提交歧义、失败任务与追踪缺口，避免新增素材无法复盘。');
  if (analytics.reliableRuns && analytics.activationRate >= 35) recommendations.push('对已验证的高激活创意方向追加同题材变体，并保持同一追踪口径以验证可复制性。');
  else if (analytics.attributedRuns) recommendations.push('先用现有归因样本复核钩子与落地页承诺是否一致，再决定是否放大素材生产。');
  else recommendations.push('优先完成首批 Code 与短链可归因的发布，再进入效果放大阶段。');
  if (!assets.videos && operations.completed) recommendations.push('已完成任务尚未形成视频成片，可从已有海报与视频提示词中选择一条进入人工审核后的生成队列。');
  if (tracking.verified < operations.completed) recommendations.push('把每个完成任务的 Code 与短链核验作为交付门槛，保证后续经营数据能回流。');
  return recommendations.slice(0, 3);
}

function reportText(report) {
  const { period, operations, assets, tracking, analytics, risks, recommendations } = report;
  const lines = [
    `NovelFlow 社媒自动化周报（${period.label}）`,
    '',
    `一、本周交付`,
    `- 覆盖任务：${operations.total} 个；本周期新建：${operations.created} 个；当前完成：${operations.completed} 个；生产中：${operations.running} 个。`,
    `- 素材产出：文案 ${assets.copy} 份，海报 ${assets.posters} 张，视频 ${assets.videos} 条。`,
    `- 追踪闭环：${tracking.verified}/${operations.completed} 个完成任务已同时具备 Code 和短链。`,
    '',
    '二、真实归因',
    analytics.attributedRuns
      ? `- 已回传 ${analytics.attributedRuns} 个任务：累计拉起 ${analytics.pullUv} UV、激活 ${analytics.activeUv}、新用户 ${analytics.newUv}、D7 收入 ${analytics.d7Income}；激活率 ${analytics.activationRate ?? '--'}%。`
      : '- 当前尚无可汇总的归因样本，不对素材效果作结论。',
    '',
    '三、需要决策',
    ...(risks.length ? risks.map((risk) => `- ${risk.title}：${risk.reason}`) : ['- 当前没有阻塞、失败或归因缺口任务。']),
    '',
    '四、下周建议',
    ...recommendations.map((item) => `- ${item}`)
  ];
  return lines.join('\n');
}

function buildWeeklyReport(runs, videoLimit, days = 7, asOf = new Date()) {
  const range = [7, 30].includes(Number(days)) ? Number(days) : 7;
  const end = new Date(asOf);
  const start = new Date(end.getTime() - range * 24 * 60 * 60 * 1000);
  const scoped = runs.filter((run) => inWindow(run, start));
  const operations = {
    total: scoped.length,
    created: scoped.filter((run) => { const created = validDate(run.createdAt); return created && created >= start; }).length,
    completed: scoped.filter((run) => run.state === 'completed').length,
    running: scoped.filter((run) => ['queued', 'running'].includes(run.state)).length,
    attention: scoped.filter((run) => ['failed', 'blocked'].includes(run.state)).length
  };
  const assets = assetCounts(scoped);
  const tracking = { verified: scoped.filter((run) => run.state === 'completed' && run.artifacts?.code && run.artifacts?.shortUrl).length };
  const analytics = analyticsTotals(scoped);
  const risks = collectRisks(scoped);
  const period = { days: range, from: start.toISOString(), to: end.toISOString(), label: `${formatDate(start)} - ${formatDate(end)}` };
  const report = {
    period,
    operations,
    assets,
    tracking,
    analytics,
    videoCapacity: videoLimit,
    risks,
    highlights: buildHighlights(analytics, operations, risks),
    recommendations: buildRecommendations(operations, assets, tracking, analytics, risks)
  };
  return { ...report, reportText: reportText(report) };
}

module.exports = { buildWeeklyReport };
