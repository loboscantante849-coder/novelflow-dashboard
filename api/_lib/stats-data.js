/**
 * Shared data loader for my-stats.js and per-link-stats.js.
 *
 * Primary data source: GitHub pre-aggregated ad_id_details.json (updated every 2 hours).
 * Fallback: Redis submissions + (best-effort) old data.json/link-stats.json caches (no OIDC/putreport
 * by default — eliminates the cold-start timeout path entirely).
 *
 * Module-level in-memory cache (5 min TTL) for the 1.5 MB JSON — useful within a warm
 * Vercel Serverless instance; cold starts always re-fetch.
 */
const { Redis } = require('@upstash/redis');

const AD_ID_DETAILS_URL =
  'https://raw.githubusercontent.com/loboscantante849-coder/novelflow-dashboard/main/ad_id_details.json';
const DATA_JSON_URL =
  'https://raw.githubusercontent.com/loboscantante849-coder/novelflow-dashboard/main/data.json';
const LINK_STATS_URL =
  'https://raw.githubusercontent.com/loboscantante849-coder/novelflow-dashboard/main/link-stats.json';

const CACHE_TTL_MS = 5 * 60 * 1000;          // 5 minutes
const FETCH_TIMEOUT_MS = 8000;               // 8s per attempt
const FETCH_RETRIES = 1;                     // retry once on failure
const ADMIN_USERNAMES = ['xujt', 'admin'];

/**
 * Known username aliases that don't canonize to the same key the pipeline uses.
 *
 * The pipeline canonicalizes display names with canonize() below; when an app login
 * comes in with a handle that differs (e.g. "Eliza_Star" → canon "eliza_star", but
 * the pipeline mapped that promoter as "eliza_stellar"), this table maps the
 * username-as-passed-in (case-insensitive, canonicalized) to the pipeline's key.
 *
 * This list is NOT exhaustive — additional fallbacks in buildAdIdLookup handle the
 * general case by cross-referencing username/username_canon inside ad_ids records.
 */
const PROMOTER_ALIASES = {
  eliza_star: 'eliza_stellar',
};

/**
 * Reverse map used to recognise any incoming variant of a known alias.
 * We also add the raw spellings below so e.g. "Eliza_Star" is recognized regardless
 * of whether the caller pre-canonized it.
 */
const ALIAS_VARIANTS = {
  eliza_star: 'eliza_stellar',
  eliza_stellar: 'eliza_stellar',
  'eliza stellar': 'eliza_stellar',
  cons_espher: 'cons_espher',
  'cons espher': 'cons_espher',
  '@cons espher': 'cons_espher',
};

// Module-level caches
let AD_CACHE = { data: null, expires: 0 };
let DATA_JSON_CACHE = { data: null, expires: 0 };
let LINK_STATS_CACHE = { data: null, expires: 0 };

function getRedis() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try {
    return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  } catch (_e) {
    return null;
  }
}

/**
 * Canonicalize a promoter username the same way the pipeline does.
 */
function canonize(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Resolve an incoming username string to the pipeline's by_promoter key.
 *
 * Resolution order:
 *   1. Exact canonical match in by_promoter.
 *   2. Known alias map (handles "Eliza_Star" → eliza_stellar, etc.).
 *   3. Last-resort: scan ad_ids for any record whose username canon-matches and return that
 *      record's username_canon (covers new/one-off mappings not in the hardcoded table).
 */
function resolvePromoterKey(rawName, adData) {
  const canon = canonize(rawName);
  if (!canon) return null;
  if (adData?.by_promoter?.[canon]) return canon;
  if (ALIAS_VARIANTS[canon]) {
    const target = ALIAS_VARIANTS[canon];
    if (adData?.by_promoter?.[target]) return target;
  }
  // Scan ad_ids for any username that canonizes to the same key
  if (adData?.ad_ids) {
    for (const entry of Object.values(adData.ad_ids)) {
      if (entry.username_canon && canonize(entry.username) === canon) {
        if (adData.by_promoter[entry.username_canon]) return entry.username_canon;
      }
    }
  }
  return canon; // fallback: return canon even if no by_promoter entry exists
}

function isAdmin(username) {
  return ADMIN_USERNAMES.includes(String(username || '').toLowerCase());
}

async function fetchJsonWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'NovelFlow-API/1.0' }
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch ad_id_details.json with in-memory cache and one retry.
 */
async function getAdIdDetails(debugLog) {
  const now = Date.now();
  if (AD_CACHE.data && AD_CACHE.expires > now) {
    debugLog?.push(`ad_id_details: cache hit (${Object.keys(AD_CACHE.data.ad_ids || {}).length} ad_ids)`);
    return AD_CACHE.data;
  }
  let lastErr = null;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    try {
      const data = await fetchJsonWithTimeout(AD_ID_DETAILS_URL);
      if (!data || !data.ad_ids || !data.by_promoter) {
        throw new Error('ad_id_details response missing required keys');
      }
      AD_CACHE = { data, expires: Date.now() + CACHE_TTL_MS };
      debugLog?.push(`ad_id_details: fetched ok (${Object.keys(data.ad_ids).length} ad_ids, ${Object.keys(data.by_promoter).length} promoters, last_updated=${data.last_updated})`);
      return data;
    } catch (e) {
      lastErr = e;
      debugLog?.push(`ad_id_details: fetch attempt ${attempt + 1} failed: ${e.message}`);
    }
  }
  // Return stale cache if available, else null
  if (AD_CACHE.data) {
    debugLog?.push('ad_id_details: returning stale cache after fetch failures');
    return AD_CACHE.data;
  }
  debugLog?.push(`ad_id_details: all fetches failed: ${lastErr?.message}`);
  return null;
}

async function getLegacyDataJson(debugLog) {
  const now = Date.now();
  if (DATA_JSON_CACHE.data && DATA_JSON_CACHE.expires > now) return DATA_JSON_CACHE.data;
  try {
    const data = await fetchJsonWithTimeout(DATA_JSON_URL, 5000);
    DATA_JSON_CACHE = { data, expires: Date.now() + CACHE_TTL_MS };
    debugLog?.push('data.json (legacy fallback): fetched ok');
    return data;
  } catch (e) {
    debugLog?.push(`data.json fallback fetch failed: ${e.message}`);
    return DATA_JSON_CACHE.data || { users: {} };
  }
}

async function getLegacyLinkStats(debugLog) {
  const now = Date.now();
  if (LINK_STATS_CACHE.data && LINK_STATS_CACHE.expires > now) return LINK_STATS_CACHE.data;
  try {
    const data = await fetchJsonWithTimeout(LINK_STATS_URL, 5000);
    LINK_STATS_CACHE = { data, expires: Date.now() + CACHE_TTL_MS };
    debugLog?.push('link-stats.json (legacy fallback): fetched ok');
    return data;
  } catch (e) {
    debugLog?.push(`link-stats.json fallback fetch failed: ${e.message}`);
    return LINK_STATS_CACHE.data || { links: {} };
  }
}

/**
 * Load all submissions for a given user from Redis.
 *
 * For admins: returns every non-pending entry from nf_subs hash.
 * For regular users: returns the union of nf_user_subs:<lowercase> set +
 *                    nf_user_data:<username>.myBooks (CloudSync).
 *
 * Returns an array of submission objects, de-duplicated by linkId + code.
 */
async function loadSubmissions(redis, username, admin, debugLog) {
  const subs = [];
  if (!redis) return subs;

  try {
    let subKeys = [];
    if (admin) {
      const allEntries = await redis.hgetall('nf_subs');
      if (allEntries && typeof allEntries === 'object') {
        subKeys = Object.keys(allEntries).filter(k => !k.startsWith('_pending_'));
      }
      debugLog?.push(`admin: ${subKeys.length} keys from nf_subs`);
    } else {
      subKeys = await redis.smembers(`nf_user_subs:${username.toLowerCase()}`);
      if (!Array.isArray(subKeys)) subKeys = [];
      debugLog?.push(`user ${username}: ${subKeys.length} keys from nf_user_subs set`);
    }

    // Batch hget
    const BATCH = 50;
    for (let i = 0; i < subKeys.length; i += BATCH) {
      const batch = subKeys.slice(i, i + BATCH);
      const values = await Promise.all(batch.map(k => redis.hget('nf_subs', k)));
      for (const v of values) {
        if (!v) continue;
        try {
          const sub = typeof v === 'string' ? JSON.parse(v) : v;
          if (sub.linkId || sub.code) subs.push(sub);
        } catch (_e) { /* corrupt */ }
      }
    }
  } catch (e) {
    debugLog?.push(`nf_subs read error: ${e.message}`);
  }

  // Merge nf_user_data:<username>.myBooks (CloudSync books not yet in nf_subs)
  if (!admin) {
    const existingLinkIds = new Set(subs.map(s => s.linkId).filter(Boolean));
    const existingCodes = new Set(
      subs.map(s => String(s.code)).filter(c => c && c !== 'undefined')
    );
    try {
      const kvData = await redis.get(`nf_user_data:${username}`);
      const myBooks = kvData && typeof kvData === 'string' ? JSON.parse(kvData)?.myBooks : kvData?.myBooks;
      if (Array.isArray(myBooks)) {
        let added = 0;
        for (const book of myBooks) {
          const bookCode = book.code ? String(book.code) : null;
          const bookLinkId = book.linkId || null;
          const isDup =
            (bookLinkId && existingLinkIds.has(bookLinkId)) ||
            (bookCode && existingCodes.has(bookCode));
          if (!isDup && (bookLinkId || bookCode)) {
            subs.push({
              discordUsername: username,
              status: 'completed',
              code: book.code || bookCode,
              linkId: bookLinkId,
              bookId: book.bookId || null,
              matchedBookName: book.title || book.bookName || 'Unknown',
              bookName: book.title || book.bookName || 'Unknown',
              link: book.link || null,
              submittedAt: book.createdAt ? new Date(book.createdAt).toISOString() : null
            });
            if (bookLinkId) existingLinkIds.add(bookLinkId);
            if (bookCode) existingCodes.add(bookCode);
            added++;
          }
        }
        if (added) debugLog?.push(`merged ${added} books from nf_user_data:${username}`);
      }
    } catch (e) {
      debugLog?.push(`nf_user_data merge skipped: ${e.message}`);
    }
  }

  debugLog?.push(`total submissions loaded: ${subs.length}`);
  return subs;
}

/**
 * Batch fetch book cover URLs from nf_book_covers hash.
 */
async function loadCovers(redis, bookIds, debugLog) {
  const covers = {};
  if (!redis || !bookIds.length) return covers;
  try {
    const uniq = [...new Set(bookIds.map(String).filter(Boolean))];
    const values = await Promise.all(uniq.map(bid => redis.hget('nf_book_covers', bid)));
    for (let i = 0; i < uniq.length; i++) {
      if (values[i]) covers[uniq[i]] = values[i];
    }
    debugLog?.push(`covers: ${Object.keys(covers).length}/${uniq.length} found`);
  } catch (e) {
    debugLog?.push(`cover lookup failed: ${e.message}`);
  }
  return covers;
}

/**
 * Build a per-ad_id stats lookup from the primary ad_id_details.json.
 *
 * Returns an object { byAdId: {<ad_id>: {channel, username_canon, book_name, pull_uv, new_uv,
 * dn_income, d14_income, daily:{dt:{pull_uv,new_uv,dn_income}}}}, promoterEntry: <by_promoter entry or null> }.
 *
 * Daily is normalized into a date-keyed object for easy aggregation.
 */
function buildAdIdLookup(adData, usernameCanon, admin) {
  const byAdId = {};
  if (!adData || !adData.ad_ids) return { byAdId, promoterEntry: null, promoterEntries: null };

  // Determine which promoter(s) we care about
  let promoterEntry = null;
  let promoterEntries = null;
  if (admin) {
    promoterEntries = adData.by_promoter || {};
  } else if (usernameCanon && adData.by_promoter) {
    promoterEntry = adData.by_promoter[usernameCanon] || null;
  }

  // Build the ad_id lookup — for admin include all, for normal user restrict to their ad_ids
  const allowedAdIds = admin
    ? null
    : (() => {
        if (!promoterEntry) return new Set();
        const s = new Set();
        (promoterEntry.links || []).forEach(a => s.add(String(a)));
        (promoterEntry.codes || []).forEach(a => s.add(String(a)));
        return s;
      })();

  for (const [adId, entry] of Object.entries(adData.ad_ids)) {
    if (allowedAdIds && !allowedAdIds.has(adId)) {
      // For normal users we still want to include the ad_id if the user's Redis submission points
      // to it even if pipeline mapping missed it (username_canon can differ) — fall back to matching
      // by username_canon == canon.
      if (entry.username_canon !== usernameCanon) continue;
    }
    const stats = entry.stats || {};
    const dailyObj = {};
    if (Array.isArray(entry.daily)) {
      for (const d of entry.daily) {
        if (!d || !d.dt) continue;
        dailyObj[d.dt] = {
          pull_uv: +d.pull_uv || 0,
          new_uv: +d.new_uv || 0,
          dn_income: +d.dn_income || 0,
          d14_income: +d.d14_income || 0,
        };
      }
    } else if (entry.daily && typeof entry.daily === 'object') {
      for (const [dt, v] of Object.entries(entry.daily)) {
        dailyObj[dt] = {
          pull_uv: +v.pull_uv || 0,
          new_uv: +v.new_uv || 0,
          dn_income: +v.dn_income || 0,
          d14_income: +v.d14_income || 0,
        };
      }
    }
    byAdId[adId] = {
      channel: entry.channel || 'link',
      username_canon: entry.username_canon || null,
      book_name: entry.book_name || null,
      pull_uv: +stats.pull_uv || 0,
      active_uv: +stats.active_uv || 0,
      new_uv: +stats.new_uv || 0,
      dn_income: +stats.dn_income || 0,
      d14_income: +stats.d14_income || 0,
      daily: dailyObj
    };
  }
  return { byAdId, promoterEntry, promoterEntries };
}

/**
 * Zero-placeholder stats for ad_ids not yet in pipeline output.
 */
function zeroStats() {
  return { pull_uv: 0, active_uv: 0, new_uv: 0, dn_income: 0, d14_income: 0, daily: {} };
}

/**
 * Round currency to 2 decimals.
 */
function r2(n) {
  return Math.round((+n || 0) * 100) / 100;
}

module.exports = {
  getRedis,
  canonize,
  resolvePromoterKey,
  isAdmin,
  getAdIdDetails,
  getLegacyDataJson,
  getLegacyLinkStats,
  loadSubmissions,
  loadCovers,
  buildAdIdLookup,
  zeroStats,
  r2,
  ADMIN_USERNAMES,
};
