const providers = require('./providers');
const { selectedChapters } = require('./pipeline');
const { saveCreativePlan } = require('./store');

const PROFILE_OPTIONS = {
  copyStyle: ['system_best', 'revenge_comeback', 'forbidden_tension', 'dark_redemption'],
  ctaStyle: ['story_cliffhanger', 'identity_reveal', 'romantic_tension', 'revenge_payoff'],
  videoStyle: ['five_beat', 'reversal', 'slow_burn', 'revenge'],
  posterStyle: ['system_best', 'luminous_cinema', 'editorial_romance']
};
const LONG_RUNNING_MODELS = new Set(['deepseek', 'seed-2.1-turbo', 'qwen3.7-max', 'minimax-m2.7', 'kimi-k2.7-code']);

function profile(value) {
  return Object.fromEntries(Object.entries(PROFILE_OPTIONS).map(([key, allowed]) => [key, allowed.includes(String(value?.[key] || '')) ? String(value[key]) : allowed[0]]));
}

function setStage(plan, name, status, extra = {}) {
  const previous = plan.stages[name] || {};
  plan.stages[name] = { ...previous, ...extra, status, updatedAt: new Date().toISOString() };
  if (status === 'running' && !plan.stages[name].startedAt) plan.stages[name].startedAt = new Date().toISOString();
  if (status === 'done' && !plan.stages[name].completedAt) plan.stages[name].completedAt = new Date().toISOString();
}

function event(plan, type, message, data = undefined) {
  plan.events = [...(plan.events || []), { at: new Date().toISOString(), type, message, ...(data ? { data } : {}) }].slice(-80);
}

function cleanError(error) {
  return String(error?.message || error || 'Unknown planning failure').replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]').slice(0, 500);
}

function recoverableModelError(error) {
  const status = Number(error?.status || 0);
  const message = String(error?.message || error || '').toLowerCase();
  if ([400, 401, 403].includes(status)) return false;
  if (/not configured|api key|credential|unauthorized|forbidden|invalid key|missing token/.test(message)) return false;
  return true;
}

async function processCreativePlan(redis, plan) {
  if (plan.state === 'queued') {
    plan.state = 'running';
    event(plan, 'worker_started', 'Background planning worker started');
    await saveCreativePlan(redis, plan);
  }
  try {
    if (plan.stages.identity.status !== 'done') {
      setStage(plan, 'identity', 'running', { label: '正在核验书籍与全书章节结构', error: '' });
      await saveCreativePlan(redis, plan);
      const book = await providers.findExactBook(plan.input.title, plan.input.sku);
      const chapterList = await providers.listChapters(book.cityBookId);
      const candidates = selectedChapters(chapterList, book.payPoint);
      const refs = [...new Map([...candidates.slice(0, 2), ...candidates.slice(-2)].map((item) => [item.id, item])).values()];
      if (refs.length < 3) throw new providers.ProviderError('At least three source chapters are required for a reliable creative strategy');
      plan.input.title = book.title;
      plan.input.sku = book.bookSkuId;
      plan.artifacts.book = { ...book, chapterCount: chapterList.length };
      plan.artifacts.chapterList = chapterList;
      plan.artifacts.evidenceRefs = refs;
      setStage(plan, 'identity', 'done', { label: `已核验 ${book.title}，锁定 ${refs.length} 个策划证据点` });
      event(plan, 'book_ready', `${book.title} identity and chapter structure ready`);
      await saveCreativePlan(redis, plan);
      return plan;
    }
    const evidenceStage = plan.stages.evidence;
    const refs = plan.artifacts.evidenceRefs || [];
    if (evidenceStage.status !== 'done') {
      const cursor = Number(evidenceStage.cursor || 0);
      const ref = refs[cursor];
      if (ref) {
        setStage(plan, 'evidence', 'running', { label: `正在读取策划证据 ${cursor + 1}/${refs.length}`, cursor, total: refs.length, error: '' });
        await saveCreativePlan(redis, plan);
        const content = await providers.chapterContent(ref.id);
        plan.artifacts.evidence.push({ ...ref, content });
        const next = cursor + 1;
        setStage(plan, 'evidence', next >= refs.length ? 'done' : 'waiting', { label: next >= refs.length ? `${refs.length} 个策划证据已锁定` : `已保存策划证据 ${next}/${refs.length}`, cursor: next, total: refs.length });
        event(plan, 'evidence_saved', `Planning evidence ${next}/${refs.length} saved`);
        await saveCreativePlan(redis, plan);
        return plan;
      }
      setStage(plan, 'evidence', 'done', { label: `${refs.length} 个策划证据已锁定`, cursor: refs.length, total: refs.length });
      await saveCreativePlan(redis, plan);
      return plan;
    }
    const analysis = plan.stages.analysis;
    const retryAt = Date.parse(analysis.nextAttemptAt || '');
    if (analysis.status === 'waiting' && Number.isFinite(retryAt) && retryAt > Date.now()) return plan;
    const longTask = LONG_RUNNING_MODELS.has(String(plan.input.modelChoice || '').toLowerCase());
    setStage(plan, 'analysis', 'running', { label: longTask ? `${modelLabelForPlan(plan.input.modelChoice)} 正在后台长任务策划（可持续数分钟）` : `${plan.input.modelChoice || 'AI'} 正在形成创意策略`, executionMode: longTask ? 'background_long' : 'realtime', error: '', nextAttemptAt: '' });
    event(plan, 'analysis_started', `${plan.input.modelChoice || 'AI'} planning request started`);
    await saveCreativePlan(redis, plan);
    try {
      const result = await providers.analyzeCreativePlan(plan.artifacts.book, plan.artifacts.evidence, plan.artifacts.chapterList, plan.input.modelChoice);
      result.plan.recommendedProfile = { ...profile(result.plan.recommendedProfile), modelChoice: plan.input.modelChoice };
      plan.artifacts.plan = result.plan;
      plan.artifacts.evidenceScope = { chapterCount: plan.artifacts.chapterList.length, sampledChapters: plan.artifacts.evidence.map((item) => item.order) };
      plan.artifacts.usage = { model: result.model, ...result.usage };
      setStage(plan, 'analysis', 'done', { label: '智能策划已完成，可查看推荐方向', model: result.model });
      plan.state = 'completed';
      event(plan, 'plan_ready', 'Background creative plan completed');
      await saveCreativePlan(redis, plan);
      return plan;
    } catch (error) {
      if (!recoverableModelError(error)) throw error;
      const attempt = Number(analysis.attempt || 0) + 1;
      const preferred = plan.input.preferredModelChoice || plan.input.modelChoice || 'hy3';
      const currentModel = plan.input.modelChoice || preferred;
      const route = [...new Set([preferred, 'hy3', 'qwen3.7-max', 'seed-2.1-turbo', 'minimax-m2.7', 'kimi-k2.7-code'])];
      const currentIndex = Math.max(0, route.indexOf(currentModel));
      const nextModel = route[(currentIndex + 1) % route.length];
      const nextAttemptAt = new Date(Date.now() + (attempt === 1 ? 1000 : Math.min(300000, 15000 * attempt))).toISOString();
      plan.input.fallbackUsed = true;
      plan.input.modelHistory = [...new Set([...(plan.input.modelHistory || []), currentModel])];
      plan.input.modelChoice = nextModel;
      setStage(plan, 'analysis', 'waiting', { label: `${modelLabelForPlan(plan.input.modelChoice)} 将接管策划，后台继续恢复（第 ${attempt} 次）`, attempt, nextAttemptAt, error: cleanError(error), fallbackFrom: currentModel });
      event(plan, 'analysis_fallback_scheduled', 'Planning model request failed; the next configured model will continue from saved evidence', { error: cleanError(error), nextAttemptAt, nextModel });
      await saveCreativePlan(redis, plan);
      return plan;
      throw error;
    }
  } catch (error) {
    const message = cleanError(error);
    setStage(plan, Object.entries(plan.stages).find(([, stage]) => stage.status === 'running')?.[0] || 'analysis', 'failed', { label: '策划任务失败，可从断点重试', error: message });
    plan.state = 'failed';
    event(plan, 'plan_failed', message);
    await saveCreativePlan(redis, plan);
    return plan;
  }
}

function modelLabelForPlan(value) {
  return ({ deepseek: 'DeepSeek', hy3: 'HY3', 'qwen3.7-max': 'Qwen 3.7 Max', 'seed-2.1-turbo': 'Seed 2.1 Turbo', 'minimax-m2.7': 'MiniMax M2.7', 'kimi-k2.7-code': 'Kimi K2.7 Code' })[String(value)] || String(value || 'AI');
}

module.exports = { processCreativePlan };
