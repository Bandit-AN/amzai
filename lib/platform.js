import { createHash, createHmac, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import axios from 'axios';
import * as cheerio from 'cheerio';
import { GoogleGenAI } from '@google/genai';

const integer = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const number = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const boolean = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};
const list = (value = '') => (Array.isArray(value) ? value : String(value).split(/[\n,]/))
  .map((item) => String(item).trim()).filter(Boolean);
const pbkdf2Async = promisify(pbkdf2);
const defaultWalmartExcludedBrands = [
  'No Boundaries', 'Time and Tru', 'Wonder Nation', 'Scoop', 'Mainstays',
  'Great Value', 'Equate', 'onn', 'Ozark Trail', 'Athletic Works', 'George',
  "Parent's Choice", 'Pen+Gear', 'Hyper Tough', 'Vibrant Life', "Ol' Roy",
  'Special Kitty', 'Marketside', "Sam's Choice",
];
const mandatoryBlockedBrands = ['LEGO', 'Barbie', 'Monster High', 'Apple', 'Bissell'];

export const config = Object.freeze({
  airtablePat: process.env.AIRTABLE_PAT,
  airtableBaseId: process.env.AIRTABLE_BASE_ID,
  airtableStudentsTable: process.env.AIRTABLE_STUDENTS_TABLE || 'Students',
  walmartScraperApiKey: process.env.WALMART_SCRAPER_API_KEY,
  walmartScraperUrl: process.env.WALMART_SCRAPER_API_URL || 'https://app.scrapingbee.com/api/v1/',
  scraperApiKey: process.env.SCRAPERAPI_KEY,
  scraperApiUrl: process.env.SCRAPERAPI_URL || 'https://api.scraperapi.com/',
  scraperApiRenderJs: boolean(process.env.SCRAPERAPI_RENDER_JS, false),
  scrapingAntApiKey: process.env.SCRAPINGANT_API_KEY,
  scrapingAntApiUrl: process.env.SCRAPINGANT_API_URL || 'https://api.scrapingant.com/v2/general',
  walmartTargetUrls: list(process.env.WALMART_TARGET_URLS || process.env.WALMART_TARGET_URL),
  walmartRenderJs: boolean(process.env.WALMART_RENDER_JS, true),
  walmartPremiumProxy: boolean(process.env.WALMART_PREMIUM_PROXY, false),
  walmartPagesPerRun: integer(process.env.WALMART_PAGES_PER_RUN, 6),
  walmartDiscoveryMultiplier: Math.min(integer(process.env.WALMART_DISCOVERY_MULTIPLIER, 5), 10),
  walmartExcludedBrands: list(process.env.WALMART_EXCLUDED_BRANDS
    || defaultWalmartExcludedBrands.join(',')).map((brand) => brand.toLowerCase()),
  geminiKey: process.env.GEMINI_KEY,
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
  keepaApiKey: process.env.KEEPA_API_KEY,
  keepaDomain: integer(process.env.KEEPA_DOMAIN, 1),
  qstashToken: process.env.QSTASH_TOKEN,
  qstashUrl: (process.env.QSTASH_URL || 'https://qstash.upstash.io').replace(/\/$/, ''),
  redisUrl: process.env.UPSTASH_REDIS_REST_URL,
  redisToken: process.env.UPSTASH_REDIS_REST_TOKEN,
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  workerSecret: process.env.WORKER_SECRET,
  cronSecret: process.env.CRON_SECRET,
  portalSessionSecret: process.env.PORTAL_SESSION_SECRET,
  onboardingVideoUrl: process.env.ONBOARDING_VIDEO_URL || '',
  maxStudents: Math.min(integer(process.env.MAX_ACTIVE_STUDENTS, 10), 10),
  maxCandidates: integer(process.env.MAX_CANDIDATES_PER_RUN, 1000),
  walmartDetailLookupLimit: Math.min(integer(process.env.WALMART_DETAIL_LOOKUP_LIMIT, 50), 100),
  targetDealsPerStudent: integer(process.env.TARGET_DEALS_PER_STUDENT, 10),
  deliverAllQualified: boolean(process.env.DELIVER_ALL_QUALIFIED, true),
  keepaTokensPerMinute: integer(process.env.KEEPA_TOKENS_PER_MINUTE, 1),
  keepaSearchResults: Math.min(integer(process.env.KEEPA_SEARCH_RESULTS, 5), 10),
  keepaTokensPerCandidate: Math.max(number(process.env.KEEPA_ESTIMATED_TOKENS_PER_CANDIDATE, 15), 15),
  // Keepa's UPC/EAN index does not cover every Amazon listing. When enabled, a
  // title-based Product Finder search recovers ASINs the code lookup misses;
  // those ASINs must still expose the same UPC/EAN before a deal can qualify,
  // so this only widens ASIN discovery and never loosens the match itself.
  keepaTitleSearchFallback: boolean(process.env.KEEPA_TITLE_SEARCH_FALLBACK, false),
  keepaTitleSearchResults: Math.min(Math.max(integer(process.env.KEEPA_TITLE_SEARCH_RESULTS, 5), 1), 10),
  minimumRoi: Math.max(60, number(process.env.MINIMUM_ROI, 60)),
  minimumMonthlySales: number(process.env.MINIMUM_MONTHLY_SALES, 200),
  maximumWalmartBuyCost: number(process.env.MAXIMUM_WALMART_BUY_COST, 150),
  feeBuffer: number(process.env.PER_ITEM_FEE_BUFFER, 1.5),
  minimumEstimatedProfit: number(process.env.MINIMUM_ESTIMATED_PROFIT, 1),
  blockedBrands: [...new Set([
    ...mandatoryBlockedBrands,
    ...list(process.env.BLOCKED_BRANDS),
  ].map((brand) => brand.toLowerCase()))],
  requestTimeoutMs: integer(process.env.REQUEST_TIMEOUT_MS, 8000),
  runTtlSeconds: Math.max(integer(process.env.RUN_TTL_SECONDS, 604800), 604800),
  studentCacheSeconds: integer(process.env.STUDENT_CACHE_SECONDS, 900),
  productCooldownSeconds: integer(process.env.PRODUCT_COOLDOWN_SECONDS, 2592000),
});

let aiClient;
const ai = () => {
  aiClient ||= new GoogleGenAI({ apiKey: config.geminiKey });
  return aiClient;
};

export function requireEnvironment(names) {
  const missing = names.filter((name) => {
    if (name === 'WALMART_TARGET_URLS') return config.walmartTargetUrls.length === 0;
    return !process.env[name]?.trim();
  });
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

export function jsonResponse(response, status, body) {
  if (typeof response.status === 'function') return response.status(status).json(body);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}

export async function readJsonBody(request) {
  if (request.body && typeof request.body === 'object') return request.body;
  if (typeof request.body === 'string') return JSON.parse(request.body);
  let raw = '';
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

export function workerAuthorized(request) {
  return Boolean(config.workerSecret) && request.headers['x-worker-secret'] === config.workerSecret;
}

export function isRetryableProviderError(error) {
  // Explicit per-call override: a 403 from a scraper or Keepa's code lookup
  // has been observed today to mean a genuinely exhausted monthly quota
  // (permanent, should degrade to manual review immediately), but a 403 from
  // the Gemini SDK (gaxios) has been observed to be transient under a valid,
  // working key. Since both surface as the same status code, callers that
  // have positively identified a transient 403 tag it with `retryable: true`
  // rather than this function guessing from the status code alone.
  if (error?.retryable === true) return true;
  const status = Number(error?.response?.status);
  return [408, 425, 429, 500, 502, 503, 504].includes(status)
    || ['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error?.code);
}

export function sanitizedRetryError(error, context = 'Provider request') {
  const status = Number(error?.response?.status);
  const wrapped = new Error(`${context} temporarily failed${status ? ` (${status})` : ''}`);
  if (status) wrapped.response = { status };
  if (error?.code) wrapped.code = error.code;
  return wrapped;
}

const base64url = (value) => Buffer.from(value).toString('base64url');

export async function hashStudentPassword(password, salt = randomBytes(16).toString('hex')) {
  if (String(password).length < 10) throw new Error('Student passwords must be at least 10 characters');
  const iterations = 210000;
  const derived = await pbkdf2Async(String(password), salt, iterations, 32, 'sha256');
  return `pbkdf2$${iterations}$${salt}$${derived.toString('hex')}`;
}

export async function verifyStudentPassword(password, encoded) {
  const [algorithm, iterationText, salt, expectedHex] = String(encoded || '').split('$');
  if (algorithm !== 'pbkdf2' || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = await pbkdf2Async(String(password), salt, Number(iterationText), expected.length, 'sha256');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createStudentSession(student) {
  if (!config.portalSessionSecret) throw new Error('PORTAL_SESSION_SECRET is not configured');
  const payload = base64url(JSON.stringify({ sub: student.id, name: student.name, exp: Date.now() + 12 * 60 * 60 * 1000 }));
  const signature = createHmac('sha256', config.portalSessionSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function readStudentSession(request) {
  if (!config.portalSessionSecret) return null;
  const cookie = String(request.headers.cookie || '').split(';').map((item) => item.trim())
    .find((item) => item.startsWith('syndicate_session='));
  const token = cookie?.slice('syndicate_session='.length);
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return null;
  const expected = createHmac('sha256', config.portalSessionSecret).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return session.exp > Date.now() ? session : null;
  } catch { return null; }
}

const redisCommand = async (command) => {
  if (!config.redisUrl || !config.redisToken) throw new Error('Redis is not configured');
  const response = await axios.post(config.redisUrl, command, {
    headers: { Authorization: `Bearer ${config.redisToken}` },
    timeout: config.requestTimeoutMs,
  });
  if (response.data?.error) throw new Error(`Redis: ${response.data.error}`);
  return response.data?.result;
};

const decodeJson = (value) => {
  if (value === null || value === undefined) return null;
  try { return JSON.parse(value); } catch { return value; }
};

export const redis = Object.freeze({
  async get(key) { return decodeJson(await redisCommand(['GET', key])); },
  async mget(keys) {
    if (!Array.isArray(keys) || keys.length === 0) return [];
    const values = await redisCommand(['MGET', ...keys]);
    return Array.isArray(values) ? values.map(decodeJson) : [];
  },
  async set(key, value, options = {}) {
    const command = ['SET', key, JSON.stringify(value)];
    if (options.nx) command.push('NX');
    if (options.ex) command.push('EX', String(options.ex));
    return (await redisCommand(command)) === 'OK';
  },
  async rpush(key, value) {
    return Number(await redisCommand(['RPUSH', key, JSON.stringify(value)]));
  },
  async lpush(key, value) {
    return Number(await redisCommand(['LPUSH', key, JSON.stringify(value)]));
  },
  async ltrim(key, start, stop) {
    return (await redisCommand(['LTRIM', key, String(start), String(stop)])) === 'OK';
  },
  async lrange(key, start, stop) {
    const values = await redisCommand(['LRANGE', key, String(start), String(stop)]);
    return Array.isArray(values) ? values.map(decodeJson) : [];
  },
  async incr(key) { return Number(await redisCommand(['INCR', key])); },
  async incrby(key, amount) { return Number(await redisCommand(['INCRBY', key, String(amount)])); },
  async del(key) { return Number(await redisCommand(['DEL', key])); },
});

export const discordDeliveryLockKey = (runId, studentId) =>
  `run:${runId}:deliveryLock:${studentId}`;

export async function claimDiscordDelivery(redisClient, runId, studentId, ttlSeconds = config.runTtlSeconds) {
  if (await redisClient.get(`run:${runId}:delivered:${studentId}`)) return 'delivered';
  const claimed = await redisClient.set(
    discordDeliveryLockKey(runId, studentId), true,
    { nx: true, ex: ttlSeconds },
  );
  return claimed ? 'claimed' : 'in_progress';
}

export async function cachedValue(key, ttlSeconds, loader) {
  const cached = await redis.get(key);
  if (cached !== null && cached !== undefined) return cached;
  const value = await loader();
  await redis.set(key, value, { ex: ttlSeconds });
  return value;
}

function qstashHeaders() {
  return {
    Authorization: `Bearer ${config.qstashToken}`,
    'Content-Type': 'application/json',
  };
}

function qstashMessage(job) {
  const delaySeconds = Math.max(0, Math.floor(Number(job.delaySeconds) || 0));
  return {
    destination: job.url,
    body: JSON.stringify(job.body),
    headers: {
      'Content-Type': 'application/json',
      'Upstash-Forward-x-worker-secret': config.workerSecret,
      'Upstash-Retries': '3',
      'Upstash-Deduplication-Id': job.deduplicationId,
      'Upstash-Redact-Fields': 'body,header[x-worker-secret]',
      ...(delaySeconds > 0 ? { 'Upstash-Delay': `${delaySeconds}s` } : {}),
    },
  };
}

export function analysisDelaySeconds(index, tokensPerMinute = config.keepaTokensPerMinute,
  tokensPerCandidate = config.keepaTokensPerCandidate, initialDelaySeconds = 0,
  tokensAvailable = null) {
  if (tokensAvailable === null) {
    const spacingSeconds = Math.ceil((tokensPerCandidate / tokensPerMinute) * 60);
    return Math.max(0, initialDelaySeconds + index * spacingSeconds);
  }
  const tokenDeficit = Math.max(0, (index + 1) * tokensPerCandidate - Number(tokensAvailable || 0));
  const refillDelay = Math.ceil((tokenDeficit / tokensPerMinute) * 60);
  // Five seconds keeps Gemini and Keepa HTTP concurrency modest while using
  // already accumulated Keepa tokens instead of waiting for needless refills.
  return Math.max(0, initialDelaySeconds, index * 5, refillDelay);
}

export function keepaInitialDelaySeconds(tokensLeft, tokensPerMinute = config.keepaTokensPerMinute,
  tokensPerCandidate = config.keepaTokensPerCandidate) {
  const deficit = Math.max(0, tokensPerCandidate - Number(tokensLeft || 0));
  return Math.ceil((deficit / tokensPerMinute) * 60);
}

export async function fetchKeepaTokenStatus() {
  const response = await axios.get('https://api.keepa.com/token', {
    params: { key: config.keepaApiKey },
    timeout: config.requestTimeoutMs,
  });
  return {
    tokensLeft: Number(response.data?.tokensLeft || 0),
    refillRate: integer(response.data?.refillRate, config.keepaTokensPerMinute),
  };
}

export async function getRunSummary(runId) {
  const [state, deals, errors, rejections, manualReview, funnelState] = await Promise.all([
    redis.mget([
      `run:${runId}:meta`,
      `run:${runId}:completedChunks`,
      `run:${runId}:finalized`,
      `run:${runId}:cancelled`,
    ]),
    redis.lrange(`run:${runId}:qualified`, 0, -1),
    redis.lrange(`run:${runId}:errors`, 0, -1),
    redis.lrange(`run:${runId}:rejections`, 0, -1),
    redis.lrange(`run:${runId}:manualReview`, 0, 19),
    redis.mget([
      `run:${runId}:funnel:detailPagesChecked`,
      `run:${runId}:funnel:upcConfirmed`,
      `run:${runId}:funnel:amazonUpcMatchFound`,
      `run:${runId}:funnel:exactAmazonMatchFound`,
      `run:${runId}:funnel:economicsPassed`,
      `run:${runId}:funnel:stockConfirmed`,
      `run:${runId}:funnel:automaticallyQualified`,
      `run:${runId}:funnel:automaticDelivered`,
      `run:${runId}:funnel:manualReview`,
      `run:${runId}:funnel:titleSearchFallbackMatches`,
    ]),
  ]);
  const [meta, completedChunks, finalized, cancelled] = state;
  if (!meta) return null;
  const delivery = [];
  const students = meta.students || [];
  const deliveryState = await redis.mget(students.flatMap((student) => [
    `run:${runId}:assignment:${student.id}`,
    `run:${runId}:delivered:${student.id}`,
  ]));
  for (const [index, student] of students.entries()) {
    const assigned = deliveryState[index * 2];
    const delivered = deliveryState[index * 2 + 1];
    delivery.push({
      name: student.name,
      assigned: Array.isArray(assigned) ? assigned.length : 0,
      delivered: Boolean(delivered),
    });
  }
  const currentFunnel = Number(meta.funnelVersion || 0) >= 2;
  const funnel = {
    version: Number(meta.funnelVersion || 1),
    discovered: Number(meta.discoveredCount ?? meta.scrapedCandidateCount ?? meta.candidateCount ?? 0),
    initiallyEligible: Number(meta.initiallyEligibleCount ?? meta.candidateCount ?? 0),
    skippedRecentlyAnalyzed: Number(meta.skippedRecentlyAnalyzed || 0),
    freshCandidates: Number(meta.freshCandidateCount ?? meta.candidateCount ?? 0),
    detailPagesChecked: Number(funnelState[0] || 0),
    upcConfirmed: Number(funnelState[1] || 0),
    amazonUpcMatchFound: Number((currentFunnel ? funnelState[2] : funnelState[3]) || 0),
    exactAmazonMatchFound: currentFunnel ? Number(funnelState[3] || 0) : null,
    economicsPassed: Number(funnelState[4] || 0),
    stockConfirmed: currentFunnel ? Number(funnelState[5] || 0) : null,
    automaticallyQualified: currentFunnel
      ? Number(funnelState[6] || deals.length || 0)
      : deals.length,
    automaticallyDelivered: Number(funnelState[7] || 0),
    manualReview: Number(funnelState[8] || 0),
    titleSearchFallbackMatches: Number(funnelState[9] || 0),
  };
  const outcome = !finalized && !cancelled
    ? 'processing'
    : (deals.length > 0
      ? 'profitable_products_found'
      : (funnel.upcConfirmed === 0
        ? 'identity_not_established'
        : (currentFunnel && funnel.exactAmazonMatchFound === 0
          ? 'exact_amazon_identity_not_established'
          : 'no_profitable_products')));
  const legacyRun = meta.discoveredCount === undefined;
  return {
    runId,
    createdAt: meta.createdAt,
    status: cancelled
      ? 'cancelled'
      : (finalized ? (meta.auditMode && deals.length > 0 ? 'awaiting_audit' : 'finalized') : 'analyzing'),
    candidates: meta.candidateCount,
    completedJobs: Number(completedChunks || 0),
    totalJobs: meta.totalChunks,
    qualifiedDeals: deals.length,
    analysisErrors: errors.length,
    errorDetails: errors.slice(0, 20).map((item) => ({
      title: item?.title || 'Unknown candidate',
      chunkIndex: item?.chunkIndex,
      message: item?.message || 'Unknown processing error',
    })),
    rejectionCounts: rejections.reduce((counts, item) => {
      const reason = item?.reason || 'other';
      counts[reason] = (counts[reason] || 0) + 1;
      return counts;
    }, {}),
    rejectionDetails: rejections.slice(0, 20).map((item) => ({
      title: item?.title || 'Unknown Walmart product',
      reason: item?.reason || 'other',
      walmartIdentity: item?.walmartIdentity || null,
      comparisons: (item?.diagnostics || []).slice(0, 5),
    })),
    manualReview,
    qualifiedReview: deals.slice(0, 50).map((deal) => ({
      itemId: deal.itemId,
      asin: deal.asin,
      walmartTitle: deal.title,
      walmartUrl: deal.walmartUrl,
      walmartPrice: deal.currentPrice,
      amazonTitle: deal.amazonTitle,
      amazonUrl: deal.amazonUrl,
      amazonPrice: deal.amazonPrice,
      upc: deal.upc,
      variantId: deal.variantId,
      seller: deal.seller || null,
      matchMethod: deal.matchMethod,
      upcDiscoveryMethod: deal.upcDiscoveryMethod || 'code',
      roi: deal.roi,
      estimatedProfit: deal.estimatedProfit,
      estimatedMonthlySales: deal.estimatedMonthlySales,
    })),
    funnel,
    outcome: legacyRun ? 'legacy_run' : outcome,
    auditMode: Boolean(meta.auditMode),
    cancellation: cancelled || null,
    initialDelaySeconds: meta.initialDelaySeconds || 0,
    keepaTokensAtQueueTime: meta.keepaTokensAtQueueTime,
    keepaTokensPerMinute: meta.keepaTokensPerMinute,
    sourcing: {
      sourceUrl: meta.sourceUrl,
      sourceUrls: meta.sourceUrls || (meta.sourceUrl ? [meta.sourceUrl] : []),
      sourcePages: Number(meta.sourcePages || 0),
      sourceCandidateCounts: meta.sourceCandidateCounts || {},
      discoveryPoolLimit: Number(meta.discoveryPoolLimit || 0),
      excludedNoDealSignal: Number(meta.excludedNoDealSignal || 0),
      excludedWalmartBrands: Number(meta.excludedWalmartBrands || 0),
      excludedBuyCost: Number(meta.excludedBuyCost || 0),
      skippedRecentlyAnalyzed: Number(meta.skippedRecentlyAnalyzed || 0),
      freshCandidateCount: Number(meta.freshCandidateCount ?? meta.candidateCount ?? 0),
      notSelectedAfterLimit: Number(meta.notSelectedAfterLimit || 0),
    },
    delivery,
  };
}

export async function publishBatch(jobs) {
  for (let index = 0; index < jobs.length; index += 50) {
    await axios.post(
      `${config.qstashUrl}/v2/batch`,
      jobs.slice(index, index + 50).map(qstashMessage),
      { headers: qstashHeaders(), timeout: config.requestTimeoutMs },
    );
  }
}

export async function publishMessage(job) {
  await publishBatch([job]);
}

const asNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  // Walmart price nodes can repeat the same value alongside labels, for example
  // "$19.96 current price $19.96". Removing every non-number character would
  // concatenate those values into 199619.96, so parse only the first number.
  const match = value.match(/-?\d[\d,]*(?:\.\d+)?/);
  const parsed = match ? Number.parseFloat(match[0].replaceAll(',', '')) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

const first = (object, paths) => {
  for (const path of paths) {
    const value = path.split('.').reduce((current, key) => current?.[key], object);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
};

const walmartUrl = (value) => {
  if (!value) return null;
  try {
    const result = new URL(value, 'https://www.walmart.com');
    return ['http:', 'https:'].includes(result.protocol) ? result.href : null;
  } catch { return null; }
};

function normalizeWalmartProduct(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const title = first(candidate, ['title', 'name', 'productName', 'product.title', 'item.name']);
  const price = asNumber(first(candidate, [
    'currentPrice', 'price', 'salePrice', 'offers.price',
    'currentPrice.price', 'priceInfo.currentPrice.price', 'priceInfo.linePrice',
    'priceInfo.itemPrice', 'product.price',
  ]));
  const url = walmartUrl(first(candidate, [
    'walmartUrl', 'url', 'canonicalUrl', 'productUrl', 'product.url', 'item.url',
  ]));
  const imageUrl = walmartUrl(first(candidate, [
    'imageUrl', 'image', 'thumbnailUrl', 'imageInfo.thumbnailUrl', 'product.image', 'item.image',
  ]));
  let originalPriceValue = asNumber(first(candidate, [
    'originalPrice', 'wasPrice', 'listPrice', 'strikeThroughPrice',
    'priceInfo.wasPrice', 'priceInfo.wasPrice.price', 'priceInfo.listPrice',
    'priceInfo.listPrice.price', 'product.originalPrice',
  ]));
  const savingsAmount = asNumber(first(candidate, ['savingsAmount', 'savingsAmt', 'priceInfo.savingsAmt']));
  if (!(originalPriceValue > price) && savingsAmount > 0) originalPriceValue = price + savingsAmount;
  const originalPrice = originalPriceValue > price ? originalPriceValue : null;
  const dealBadge = first(candidate, [
    'dealBadge', 'badge.key', 'badge.text', 'badge.label',
    'badges.0.key', 'badges.0.text', 'badges.0.label',
  ]);
  const rawProductCode = first(candidate, [
    'upc', 'gtin', 'gtin13', 'gtin14', 'product.upc', 'product.gtin', 'item.upc',
  ]);
  const productCode = String(rawProductCode || '').replace(/\D/g, '');
  const upc = productCode.length >= 8 && productCode.length <= 14 ? productCode : null;
  const rawBrand = first(candidate, [
    'brand', 'brandName', 'product.brand', 'product.brandName', 'item.brand',
  ]);
  const brand = typeof rawBrand === 'object' ? first(rawBrand, ['name', 'displayName']) : rawBrand;
  const rawSeller = first(candidate, [
    'sellerName', 'sellerDisplayName', 'seller.name', 'seller.displayName',
    'offers.seller.name', 'offers.seller.displayName',
    'product.sellerName', 'product.sellerDisplayName', 'item.sellerName',
  ]);
  const seller = typeof rawSeller === 'object' ? first(rawSeller, ['name', 'displayName']) : rawSeller;
  const rawVariantId = first(candidate, [
    'variantId', 'usItemId', 'offerId', 'productId', 'product.variantId',
    'product.usItemId', 'item.variantId', 'item.usItemId',
  ]);
  const availability = first(candidate, [
    'availabilityStatus', 'availability', 'stockStatus', 'product.availabilityStatus',
    'availabilityStatusV2.value', 'product.availability', 'item.availabilityStatus',
    'offers.availability',
  ]);
  const availabilityText = String(availability || '').replace(/[_-]+/g, ' ');
  const explicitlyUnavailable = candidate.inStock === false
    || candidate.isAvailable === false
    || candidate.isOutOfStock === true
    || /(?:out\s*of\s*stock|unavailable|not\s+available)/i.test(availabilityText);
  const explicitlyAvailable = candidate.inStock === true
    || candidate.isAvailable === true
    || candidate.canAddToCart === true
    || /(?:in\s*stock|available|add\s+to\s+cart)/i.test(availabilityText);
  if (typeof title !== 'string' || !title.trim() || !price || price <= 0 || !url) return null;
  const itemId = url.match(/\/ip\/(?:[^/]+\/)?(\d+)/)?.[1] || url;
  const visibleTitle = title.trim();
  let searchTitle = visibleTitle;
  try {
    const slug = decodeURIComponent(new URL(url).pathname.match(/\/ip\/([^/]+)/)?.[1] || '')
      .replace(/[-_]+/g, ' ').trim();
    if (slug && !/^\d+$/.test(slug)
      && !normalizeIdentity(searchTitle).includes(normalizeIdentity(slug))) {
      searchTitle = `${searchTitle} ${slug}`;
    }
  } catch { /* Keep the visible title if the URL slug cannot be decoded. */ }
  const titleQuantities = extractListingQuantities(visibleTitle);
  const selectedVariant = {
    size: first(candidate, ['size', 'selectedSize', 'product.size', 'item.size']),
    color: first(candidate, ['color', 'selectedColor', 'product.color', 'item.color']),
    model: first(candidate, ['model', 'modelNumber', 'product.model', 'item.model']),
    count: titleQuantities.outer_count?.[0] || null,
    weightOz: titleQuantities.size_oz?.[0] || null,
    weightGrams: titleQuantities.weight_g?.[0] || null,
    voltage: titleQuantities.voltage_v?.[0] || null,
  };
  return {
    itemId,
    // Keep the retailer's visible title authoritative for quantity and variant
    // checks. URL slugs are useful search context, but can turn decimals such
    // as "25.4 oz" into the phantom quantities "25" and "4".
    title: visibleTitle,
    ...(searchTitle !== visibleTitle ? { searchTitle } : {}),
    currentPrice: price,
    walmartUrl: url,
    imageUrl,
    ...(originalPrice ? { originalPrice } : {}),
    ...(dealBadge ? { dealBadge: String(dealBadge).trim() } : {}),
    ...(upc ? { upc } : {}),
    ...(brand ? { brand: String(brand).trim() } : {}),
    ...(seller ? { seller: String(seller).trim() } : {}),
    variantId: String(rawVariantId || itemId),
    selectedVariant: Object.fromEntries(Object.entries(selectedVariant)
      .filter(([, value]) => value !== null && value !== undefined && value !== '')),
    ...(explicitlyUnavailable
      ? { onlineAvailable: false }
      : (explicitlyAvailable ? { onlineAvailable: true } : {})),
  };
}

function crawl(value, output, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  const product = normalizeWalmartProduct(value);
  if (product) output.push(product);
  for (const child of Object.values(value)) if (child && typeof child === 'object') crawl(child, output, seen);
}

export function normalizeWalmartPayload(payload) {
  const products = [];
  if (typeof payload !== 'string') crawl(payload, products);
  else {
    const $ = cheerio.load(payload);
    let searchPayloadFound = false;
    $('script#__NEXT_DATA__').each((_, element) => {
      try {
        const parsed = JSON.parse($(element).text());
        const searchResult = parsed?.props?.pageProps?.initialData?.searchResult;
        if (searchResult && Array.isArray(searchResult.itemStacks)) {
          // Search/deal pages contain analytics, recommendations, and navigation
          // objects that also resemble products. Only the authoritative result
          // stacks represent items actually shown for the requested source page.
          searchPayloadFound = true;
          for (const stack of searchResult.itemStacks) {
            for (const item of [...(stack?.items || []), ...(stack?.itemsV2 || [])]) {
              const product = normalizeWalmartProduct(item);
              if (product) products.push(product);
            }
          }
        }
      } catch { /* Ignore malformed application state. */ }
    });
    if (!searchPayloadFound) {
      // Product-detail pages do not have search result stacks. Retain the
      // broader extraction there so enrichWalmartCandidate can locate the
      // exact item and its UPC/variant data.
      $('[data-item-id], [data-testid="item-stack"]').each((_, element) => {
        const root = $(element);
        const link = root.find('a[href*="/ip/"]').first();
        const image = root.find('img').first();
        const product = normalizeWalmartProduct({
          title: link.attr('aria-label') || image.attr('alt') || link.text(),
          price: root.find('[itemprop="price"]').attr('content') || root.find('[data-automation-id="product-price"]').text(),
          originalPrice: root.find('[data-automation-id="strikethrough-price"], [data-testid="strikethrough-price"]').first().text(),
          url: link.attr('href'),
          image: image.attr('src'),
          availability: root.find('[data-automation-id*="availability"], [data-testid*="availability"]').text()
            || (/out\s+of\s+stock|unavailable/i.test(root.text()) ? 'Out of stock' : ''),
        });
        if (product) products.push(product);
      });
      $('script[type="application/ld+json"], script#__NEXT_DATA__').each((_, element) => {
        try { crawl(JSON.parse($(element).text()), products); } catch { /* Ignore unrelated scripts. */ }
      });
    }
  }
  const merged = new Map();
  for (const product of products) {
    const previous = merged.get(product.itemId) || {};
    const combined = { ...previous, ...product };
    if (previous.onlineAvailable === false || product.onlineAvailable === false) {
      combined.onlineAvailable = false;
    }
    merged.set(product.itemId, combined);
  }
  return [...merged.values()];
}

export function walmartSourceUrls() {
  const configured = config.walmartTargetUrls.map((value) => new URL(value));
  const walmartBase = configured.find((url) => /(^|\.)walmart\.com$/i.test(url.hostname));
  const curated = walmartBase ? [
    new URL('/shop/savings', walmartBase),
    new URL('/shop/deals/clearance', walmartBase),
    ...[
      'toys', 'tech', 'home', 'household-essentials', 'beauty', 'pets',
      'baby', 'wellness', 'sports-and-outdoors', 'auto', 'patio-and-garden',
      'home-improvement',
      // Confirmed as real Walmart clearance category routes (HTTP 200, not a
      // redirect to a 404/search fallback) before adding — widens discovery
      // beyond the original 11 categories.
      'furniture', 'shoes', 'seasonal', 'kitchen-and-dining', 'bedding',
      'decor', 'food',
    ].map((category) => new URL(`/shop/deals/clearance/${category}`, walmartBase)),
    ...categoryBuyCostOverrides.map((entry) => new URL(entry.pathname, walmartBase)),
  ] : [];
  const unique = new Map();
  for (const source of [...configured, ...curated]) {
    source.searchParams.delete('page');
    if (/(^|\.)walmart\.com$/i.test(source.hostname)) {
      source.searchParams.set('facet', 'retailer_type:Walmart');
    }
    unique.set(source.href, source.href);
  }
  return [...unique.values()];
}

export function walmartUrlsForWindow(windowIndex = 0) {
  const sources = walmartSourceUrls();
  if (sources.length === 0) return [];
  const normalizedWindow = ((Number(windowIndex) || 0) % sources.length + sources.length) % sources.length;
  // Walmart's clearance feeds currently report maxPage=1. Rotate real category
  // feeds instead of requesting nonexistent page=2+ URLs.
  return [sources[normalizedWindow]];
}

export function dailyWalmartWindow(now = Date.now()) {
  const sourceCount = Math.max(1, walmartSourceUrls().length);
  const day = Math.floor(Number(now) / 86400000);
  return ((day % sourceCount) + sourceCount) % sourceCount;
}

export function walmartUrlsForDailyRun(now = Date.now()) {
  const sources = walmartSourceUrls();
  if (sources.length === 0) return [];
  const broadSources = sources.filter((value) => [
    '/shop/savings', '/shop/deals/clearance',
  ].includes(new URL(value).pathname));
  // Pinned category pages run every day rather than competing for a slot in
  // the rotating pool, since they were added specifically to always be
  // scanned, not occasionally sampled.
  const pinnedPathnames = new Set(categoryBuyCostOverrides.map((entry) => entry.pathname));
  const pinnedSources = sources.filter((value) => pinnedPathnames.has(new URL(value).pathname));
  const categorySources = sources.filter((value) => !broadSources.includes(value) && !pinnedSources.includes(value));
  const day = Math.floor(Number(now) / 86400000);
  const budget = Math.max(1, config.walmartPagesPerRun);
  const selected = [...broadSources.slice(0, Math.min(2, budget)), ...pinnedSources];
  const categoryBudget = Math.max(0, budget - selected.length);
  const categoryStride = Math.max(1, Math.floor(categorySources.length / Math.max(1, categoryBudget)));
  const categoryStart = categorySources.length > 0
    ? ((day % categorySources.length) + categorySources.length) % categorySources.length
    : 0;
  for (let offset = 0; offset < categoryBudget && categorySources.length > 0; offset += 1) {
    selected.push(categorySources[(categoryStart + offset * categoryStride) % categorySources.length]);
  }
  return selected;
}

export function hasWalmartDealSignal(candidate) {
  if (Number(candidate?.originalPrice) > Number(candidate?.currentPrice)) return true;
  return /(?:clearance|rollback|reduced[ _-]?price|special[ _-]?buy)/i
    .test(String(candidate?.dealBadge || ''));
}

const preferredProductTerms = /\b(?:supplement|vitamin|beauty|skin|hair|shampoo|conditioner|soap|cleaner|detergent|toy|game|video game|madden|fifa|playstation|xbox|nintendo|jellycat|halloween costume|costume|crayola|molten|volleyball|needoh|office|school|pet|tool|kitchen|baby|diaper|battery|filter)\b/i;
const variationHeavyTerms = /\b(?:shirt|tee|shorts|pants|dress|outfit|pajamas?|coverall|shortall|romper|onesie|socks?|sandals?|clogs?|shoes?|sneakers?|underwear|bra|jacket|swimsuit|swimwear|swim trunks?|bathing suit|clothing|apparel|tire|furniture|sofa|mattress|television|tv|freezer|refrigerator|appliance)\b/i;
const perishableTerms = /\b(?:fresh|frozen|refrigerated|milk|meat|produce|ice cream)\b/i;

export function candidatePriority(candidate) {
  let score = 0;
  if (candidate.originalPrice > candidate.currentPrice) {
    score += 20 + Math.min(60, ((candidate.originalPrice - candidate.currentPrice) / candidate.originalPrice) * 100);
  } else {
    score -= 15;
  }
  if (candidate.upc) score += 30;
  if (candidate.brand) score += 12;
  if (/^(?:walmart|walmart\.com)$/i.test(String(candidate.seller || '').trim())) score += 12;
  else if (candidate.seller) score -= 15;
  if (candidate.onlineAvailable === true) score += 8;
  if (candidate.onlineAvailable === false) score -= 100;
  if (Object.keys(extractListingQuantities(candidate.title)).length > 0) score += 15;
  if (preferredProductTerms.test(candidate.title)) score += 12;
  if (candidate.currentPrice >= 3 && candidate.currentPrice <= 100) score += 10;
  if (candidate.currentPrice > 200) score -= 25;
  if (candidate.currentPrice < 1) score -= 10;
  // Apparel/furniture remain eligible for manual review, but should not consume
  // the first UPC/detail slots merely because an extreme markdown overwhelms
  // their variant risk. Standardized inventory must be analyzed first.
  if (variationHeavyTerms.test(candidate.title)) score -= 110;
  if (perishableTerms.test(candidate.title)) score -= 110;
  return score;
}

const normalizeBrandText = (value) => String(value || '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

export function isExcludedWalmartBrand(candidate) {
  const title = normalizeBrandText(candidate?.title);
  const explicitBrand = normalizeBrandText(candidate?.brand);
  const excludedBrands = [...new Set([...config.walmartExcludedBrands, ...config.blockedBrands])];
  return excludedBrands.some((brand) => {
    const normalized = normalizeBrandText(brand);
    return explicitBrand === normalized
      || title === normalized
      || title.startsWith(`${normalized} `)
      || ` ${title} `.includes(` ${normalized} `);
  });
}

export function prioritizeCandidates(candidates) {
  return [...candidates].sort((left, right) => candidatePriority(right) - candidatePriority(left));
}

export function mergeBalancedCandidates(candidateGroups, limit) {
  const safeLimit = Math.max(1, Number.parseInt(limit, 10) || 1);
  const groups = candidateGroups.map((group) => prioritizeCandidates(
    [...new Map(group.map((product) => [product.itemId, product])).values()],
  ));
  const merged = [];
  const seen = new Set();
  const cursors = groups.map(() => 0);
  while (merged.length < safeLimit) {
    let added = false;
    for (const [groupIndex, group] of groups.entries()) {
      let product;
      while (cursors[groupIndex] < group.length) {
        product = group[cursors[groupIndex]];
        cursors[groupIndex] += 1;
        if (!seen.has(product.itemId)) break;
        product = null;
      }
      if (!product) continue;
      seen.add(product.itemId);
      merged.push(product);
      added = true;
      if (merged.length >= safeLimit) break;
    }
    if (!added) break;
  }
  return prioritizeCandidates(merged).slice(0, safeLimit);
}

export function isExcludedProductType(title) {
  return variationHeavyTerms.test(String(title || '')) || perishableTerms.test(String(title || ''));
}

// A 200 response can still be an anti-bot interstitial rather than the real
// page. Treated as "no candidates" with no error, this silently starves the
// funnel; detecting it lets the caller pay for one premium-proxy retry.
export function looksLikeBlockedWalmartPage(html) {
  if (typeof html !== 'string') return false;
  if (/__NEXT_DATA__/.test(html)) return false;
  return /(?:robot or human|access to this page has been denied|are you a human|px-captcha|request unsuccessful|unusual (?:traffic|activity) from your (?:computer|network))/i
    .test(html) || html.length < 2000;
}

export function scrapingAntRequestOptions(url, browser = false) {
  return {
    params: {
      url,
      browser: String(browser),
      proxy_type: 'datacenter',
      proxy_country: 'US',
    },
    headers: { Accept: 'text/html,application/json', 'x-api-key': config.scrapingAntApiKey },
    timeout: Math.max(config.requestTimeoutMs, browser ? 60000 : 30000),
  };
}

export async function fetchWalmartCatalog(
  limit = config.maxCandidates,
  targetUrls = config.walmartTargetUrls,
  { includeUnavailable = false } = {},
) {
  const safeLimit = Math.max(1, Math.min(integer(limit, config.maxCandidates), config.maxCandidates));
  const candidateGroups = [];
  for (const url of targetUrls) {
    const scrapingAntRequest = (browser) => axios.get(
      config.scrapingAntApiUrl,
      scrapingAntRequestOptions(url, browser),
    );
    const scrapingBeeRequest = (premiumProxy) => axios.get(config.walmartScraperUrl, {
      params: {
        api_key: config.walmartScraperApiKey,
        url,
        render_js: String(config.walmartRenderJs),
        premium_proxy: String(premiumProxy),
        ...(premiumProxy ? { country_code: 'us' } : {}),
      },
      headers: { Accept: 'text/html,application/json' },
      timeout: Math.max(config.requestTimeoutMs, 30000),
    });
    let response;
    let provider = '';
    let scrapingAntError;
    let scraperApiError;
    let usedPremiumProxy = false;
    if (config.scrapingAntApiKey) {
      try {
        response = await scrapingAntRequest(false);
        provider = 'scrapingant-static';
        if (looksLikeBlockedWalmartPage(response.data)) response = null;
      } catch (error) {
        scrapingAntError = error;
      }
      if (!response && (!scrapingAntError || [403, 409, 422].includes(scrapingAntError.response?.status))) {
        try {
          response = await scrapingAntRequest(true);
          provider = 'scrapingant-browser';
          if (looksLikeBlockedWalmartPage(response.data)) response = null;
        } catch (error) {
          scrapingAntError = error;
        }
      }
    }
    if (!response && config.scraperApiKey) {
      try {
        response = await axios.get(config.scraperApiUrl, {
          params: {
            api_key: config.scraperApiKey,
            url,
            country_code: 'us',
            ...(config.scraperApiRenderJs ? { render: 'true' } : {}),
          },
          headers: { Accept: 'text/html,application/json' },
          timeout: Math.max(config.requestTimeoutMs, config.scraperApiRenderJs ? 45000 : 30000),
        });
        provider = 'scraperapi';
      } catch (error) {
        scraperApiError = error;
      }
    }
    if (!response && config.walmartScraperApiKey) {
      try {
        response = await scrapingBeeRequest(config.walmartPremiumProxy);
        provider = 'scrapingbee';
        usedPremiumProxy = config.walmartPremiumProxy;
      } catch (error) {
        if (config.walmartPremiumProxy || ![403, 429, 500, 502, 503, 504].includes(error.response?.status)) {
          throw scraperApiError || error;
        }
        response = await scrapingBeeRequest(true);
        provider = 'scrapingbee-premium';
        usedPremiumProxy = true;
      }
    }
    if (!response) throw scrapingAntError || scraperApiError || new Error('No Walmart scraper provider is configured');
    if (provider.startsWith('scrapingbee') && !usedPremiumProxy
      && config.walmartScraperApiKey && looksLikeBlockedWalmartPage(response.data)) {
      try {
        const retryResponse = await scrapingBeeRequest(true);
        if (!looksLikeBlockedWalmartPage(retryResponse.data)) {
          response = retryResponse;
          provider = 'scrapingbee-premium';
        }
      } catch { /* Keep the original response; a failed retry is no worse than not retrying. */ }
    }
    console.log(JSON.stringify({
      event: 'walmart_scrape_success',
      provider,
      targetHost: new URL(url).hostname,
      creditsUsed: Number(response.headers?.['ant-credits-cost']) || undefined,
    }));
    candidateGroups.push(normalizeWalmartPayload(response.data)
      .map((product) => ({ ...product, discoverySourceUrl: url }))
      .filter((product) => includeUnavailable || product.onlineAvailable !== false));
  }
  return mergeBalancedCandidates(candidateGroups, safeLimit);
}

export async function enrichWalmartCandidate(candidate) {
  if (!candidate?.walmartUrl || !candidate?.itemId) {
    return {
      ...candidate,
      detailVerified: false,
      onlineAvailable: false,
      matchMethod: 'MANUAL_REVIEW',
      detailFailure: 'missing_walmart_identity',
    };
  }
  const products = await fetchWalmartCatalog(20, [candidate.walmartUrl], { includeUnavailable: true });
  const exact = products.find((product) => String(product.itemId) === String(candidate.itemId));
  if (!exact) {
    return {
      ...candidate,
      detailVerified: false,
      onlineAvailable: false,
      matchMethod: 'MANUAL_REVIEW',
      detailFailure: 'walmart_unavailable_or_unverified',
    };
  }
  const enriched = {
    ...candidate,
    ...exact,
    itemId: String(candidate.itemId),
    walmartUrl: candidate.walmartUrl,
    detailVerified: true,
    onlineAvailable: exact.onlineAvailable === true,
    variantId: String(exact.variantId || exact.itemId || candidate.itemId),
    // exact was fetched from the item's own detail page, so its
    // discoverySourceUrl is that page, not the category the candidate was
    // actually discovered on. Keep the original — it decides which per-source
    // buy-cost ceiling applies downstream.
    discoverySourceUrl: candidate.discoverySourceUrl,
  };
  enriched.matchMethod = enriched.upc ? 'UPC' : 'MANUAL_REVIEW';
  return enriched;
}

export function manualReviewEntry(candidate, reason) {
  return {
    itemId: candidate.itemId,
    title: candidate.title,
    walmartUrl: candidate.walmartUrl,
    imageUrl: candidate.imageUrl || null,
    currentPrice: candidate.currentPrice,
    upc: candidate.upc || null,
    variantId: candidate.variantId || null,
    seller: candidate.seller || null,
    selectedVariant: candidate.selectedVariant || {},
    detailVerified: Boolean(candidate.detailVerified),
    onlineAvailable: Boolean(candidate.onlineAvailable),
    matchMethod: 'MANUAL_REVIEW',
    reason,
  };
}

// Keepa's monthlySold and salesRankDrops30 fields are both frequently absent
// for real, actively-selling products — an absent signal is not the same as
// a confirmed-slow one. A candidate with a fully-priced, identity-verified
// Amazon match that only failed because that data was missing gets a chance
// for a human to judge it directly, the same way manual sourcing already
// works, instead of being silently discarded like a genuine mismatch.
export function salesVelocityManualReviewEntry(candidate, diagnostic) {
  return {
    ...manualReviewEntry(candidate, 'missing_sales_velocity'),
    asin: diagnostic.asin,
    amazonTitle: diagnostic.amazonTitle,
    amazonUrl: `https://www.amazon.com/dp/${diagnostic.asin}`,
    amazonPrice: diagnostic.amazonPrice,
    roi: diagnostic.roi,
    estimatedProfit: diagnostic.estimatedProfit,
  };
}

export function automaticEligibilityReason(candidate) {
  if (!candidate?.detailVerified) return 'walmart_detail_unverified';
  if (candidate.onlineAvailable !== true) return 'walmart_unavailable';
  if (!candidate.upc) return 'missing_upc';
  const selectedVariant = candidate.selectedVariant || {};
  const exactVariantProven = Boolean(selectedVariant.size || selectedVariant.color || selectedVariant.model);
  if (variationHeavyTerms.test(String(candidate.title || '')) && !exactVariantProven) {
    return 'unverified_variant';
  }
  return null;
}

export async function confirmWalmartAvailability(deal) {
  if (!deal?.walmartUrl || !deal?.itemId) return false;
  const products = await fetchWalmartCatalog(20, [deal.walmartUrl]);
  const exact = products.find((product) => String(product.itemId) === String(deal.itemId));
  if (!exact || exact.onlineAvailable !== true) return false;
  if (!productCodesCompatible(deal.upc, { upcList: [exact.upc], eanList: [] })) return false;
  if (deal.variantId && exact.variantId && String(deal.variantId) !== String(exact.variantId)) return false;
  if (Math.abs(Number(exact.currentPrice) - Number(deal.currentPrice)) > 0.01) return false;
  return listingVariantsCompatible(deal.title, exact.title)
    && listingQuantitiesCompatible(deal.title, exact.title).compatible;
}

const airtableHeaders = () => ({ Authorization: `Bearer ${config.airtablePat}` });

async function fetchActiveStudentsFromAirtable() {
  const students = [];
  let offset;
  do {
    const response = await axios.get(
      `https://api.airtable.com/v0/${config.airtableBaseId}/${encodeURIComponent(config.airtableStudentsTable)}`,
      {
        headers: airtableHeaders(),
        params: { filterByFormula: "{Status}='Active'", pageSize: 100, offset },
        timeout: config.requestTimeoutMs,
      },
    );
    for (const record of response.data.records || []) {
      const fields = record.fields || {};
      if (!fields['Discord Webhook URL']) continue;
      students.push({
        id: record.id,
        name: fields.Name || fields.Email || 'Student',
        discordWebhookUrl: fields['Discord Webhook URL'],
        minRoi: number(fields['Minimum ROI'], config.minimumRoi),
        minMonthlySales: number(fields['Minimum Monthly Sales'], config.minimumMonthlySales),
        maxCost: number(fields['Maximum Cost'], 1_000_000),
        excludedBrands: list(fields['Excluded Brands']).map((brand) => brand.toLowerCase()),
      });
      if (students.length >= config.maxStudents) break;
    }
    offset = response.data.offset;
  } while (offset && students.length < config.maxStudents);
  return students;
}

export async function fetchActiveStudents(options = {}) {
  if (options.fresh) return fetchActiveStudentsFromAirtable();
  return cachedValue('cache:airtable:active-students', config.studentCacheSeconds, fetchActiveStudentsFromAirtable);
}

export function candidateFingerprint(candidate) {
  return createHash('sha256').update(JSON.stringify({
    pipeline: 'walmart-authoritative-results-v3',
    itemId: candidate.itemId,
    title: candidate.title,
    currentPrice: candidate.currentPrice,
  })).digest('hex').slice(0, 32);
}

export async function filterRecentlyAnalyzedCandidates(candidates) {
  const keys = candidates.map((candidate) => `catalog:seen:${candidateFingerprint(candidate)}`);
  const seen = await redis.mget(keys);
  return selectUnseenCandidates(candidates, seen);
}

export function selectUnseenCandidates(candidates, seenValues, limit = candidates.length) {
  const safeLimit = Math.max(0, Number.parseInt(limit, 10) || 0);
  return candidates.filter((_, index) => !seenValues[index]).slice(0, safeLimit);
}

export async function markCandidatesAnalyzed(candidates) {
  await Promise.all(candidates.map((candidate) => redis.set(
    `catalog:seen:${candidateFingerprint(candidate)}`,
    true,
    { ex: config.productCooldownSeconds },
  )));
}

export async function fetchPortalStudentByUsername(username) {
  const response = await axios.get(
    `https://api.airtable.com/v0/${config.airtableBaseId}/${encodeURIComponent(config.airtableStudentsTable)}`,
    { headers: airtableHeaders(), params: { filterByFormula: "{Status}='Active'", pageSize: 100 }, timeout: config.requestTimeoutMs },
  );
  const wanted = String(username || '').trim().toLowerCase();
  const record = (response.data.records || []).find((item) =>
    String(item.fields?.Username || '').trim().toLowerCase() === wanted);
  if (!record) return null;
  const fields = record.fields || {};
  return {
    id: record.id,
    name: fields.Name || fields.Username,
    username: fields.Username,
    passwordHash: fields['Password Hash'],
    onboardingComplete: Boolean(fields['Onboarding Complete']),
    minRoi: number(fields['Minimum ROI'], config.minimumRoi),
    minMonthlySales: number(fields['Minimum Monthly Sales'], config.minimumMonthlySales),
    maxCost: number(fields['Maximum Cost'], 1000),
    excludedBrands: list(fields['Excluded Brands']),
    webhookConfigured: Boolean(fields['Discord Webhook URL']),
  };
}

export async function fetchPortalStudentById(recordId) {
  const response = await axios.get(
    `https://api.airtable.com/v0/${config.airtableBaseId}/${encodeURIComponent(config.airtableStudentsTable)}/${encodeURIComponent(recordId)}`,
    { headers: airtableHeaders(), timeout: config.requestTimeoutMs },
  );
  const fields = response.data?.fields || {};
  if (fields.Status !== 'Active') return null;
  return {
    id: response.data.id,
    name: fields.Name || fields.Username,
    username: fields.Username,
    onboardingComplete: Boolean(fields['Onboarding Complete']),
    minRoi: number(fields['Minimum ROI'], config.minimumRoi),
    minMonthlySales: number(fields['Minimum Monthly Sales'], config.minimumMonthlySales),
    maxCost: number(fields['Maximum Cost'], 1000),
    excludedBrands: list(fields['Excluded Brands']),
    webhookConfigured: Boolean(fields['Discord Webhook URL']),
  };
}

export async function updatePortalStudent(recordId, preferences) {
  const fields = {
    'Minimum ROI': number(preferences.minRoi, config.minimumRoi),
    'Minimum Monthly Sales': number(preferences.minMonthlySales, config.minimumMonthlySales),
    'Maximum Cost': number(preferences.maxCost, 1000),
    'Excluded Brands': list(preferences.excludedBrands).join(', '),
    'Onboarding Complete': true,
  };
  await axios.patch(
    `https://api.airtable.com/v0/${config.airtableBaseId}/${encodeURIComponent(config.airtableStudentsTable)}/${encodeURIComponent(recordId)}`,
    { fields },
    { headers: { ...airtableHeaders(), 'Content-Type': 'application/json' }, timeout: config.requestTimeoutMs },
  );
  await redis.del('cache:airtable:active-students').catch(() => {});
  return fields;
}

export async function identifyProduct(candidate) {
  const response = await ai().models.generateContent({
    model: config.geminiModel,
    contents: `Create an exact Amazon catalog identity for this Walmart product. Return canonicalTitle in English even when the source title is another language. Preserve the exact brand, product line, model, style, size, color, version, and pack details. Remove promotion text and never invent or infer a pack count. The title field is authoritative for quantities and variants; searchTitle is supplemental identity context only.\n${JSON.stringify(candidate)}`,
    config: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          brand: { type: 'STRING' },
          canonicalTitle: { type: 'STRING' },
          cleanSearchTerm: { type: 'STRING' },
          estimatedPackCount: { type: 'INTEGER', minimum: 1 },
        },
        required: ['brand', 'canonicalTitle', 'cleanSearchTerm', 'estimatedPackCount'],
      },
    },
  });
  const result = JSON.parse(response.text);
  if (!result.cleanSearchTerm || !result.canonicalTitle || !result.brand) {
    throw new Error('Gemini returned an incomplete match query');
  }
  return result;
}

async function verifyExactProductMatch(candidate, deal) {
  try {
    const response = await ai().models.generateContent({
      model: config.geminiModel,
      contents: `Decide whether these are the exact same retail product and purchasable variant. Be strict. A shared brand and generic product type are insufficient. Reject different product lines, fragrance flankers (for example Ice versus Intense), named characters/styles (for example Wrinkle McStinkles versus Mr Screech), models, editions, colors, sizes, counts, bundles, voltage, or condition. If either title lacks a detail, do not invent it; approve only when the available identities are directly compatible.\n${JSON.stringify({
        walmartTitle: candidate.title,
        walmartSearchContext: candidate.searchTitle || '',
        walmartCanonicalTitle: deal.walmartCanonicalTitle || '',
        amazonTitle: deal.amazonTitle,
        brand: deal.brand,
      })}`,
      config: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            exactMatch: { type: 'BOOLEAN' },
            reason: { type: 'STRING' },
          },
          required: ['exactMatch', 'reason'],
        },
      },
    });
    const result = JSON.parse(response.text);
    return { exactMatch: result.exactMatch === true, reason: String(result.reason || '') };
  } catch (error) {
    // A 403 from this specific call has been observed as transient under a
    // valid, working Gemini key (isolated retries of the identical request
    // succeed) — tag it so isRetryableProviderError retries instead of
    // permanently discarding an otherwise-qualifying candidate.
    if (Number(error?.response?.status ?? error?.status) === 403) error.retryable = true;
    throw error;
  }
}

async function findKeepaProductsByCode(productCode) {
  const code = String(productCode || '').replace(/\D/g, '');
  if (!code) return [];
  try {
    const response = await axios.get('https://api.keepa.com/product', {
      params: {
        key: config.keepaApiKey,
        ...keepaProductCodeParams(code),
      },
      timeout: config.requestTimeoutMs,
    });
    return (response.data?.products || []).slice(0, config.keepaSearchResults);
  } catch (error) {
    const message = error.response?.data?.error?.message || error.response?.data?.message || error.message;
    const wrapped = new Error(`Keepa product-code lookup ${error.response?.status || 'request'}: ${message}`);
    wrapped.response = error.response;
    wrapped.code = error.code;
    throw wrapped;
  }
}

// Keepa's Product Finder (https://api.keepa.com/query) searches Amazon's
// catalog by title instead of by barcode. It is only a second way to find
// candidate ASINs: every ASIN it returns is still required to carry the same
// UPC/EAN as the Walmart listing (via productCodesCompatible) before a deal
// can qualify, so this widens ASIN discovery without weakening acceptance.
// Keepa rejects any perPage below its own default (50) with a 400
// ("combination of perPage and page exceeds limit or is too small") —
// confirmed against the live API. How many of the returned ASINs actually
// get hydrated and evaluated is controlled separately, client-side, by
// config.keepaTitleSearchResults.
const KEEPA_PRODUCT_FINDER_MIN_PER_PAGE = 50;
export function keepaTitleSearchSelection(term, perPage = KEEPA_PRODUCT_FINDER_MIN_PER_PAGE) {
  return { title: String(term || '').trim().slice(0, 200), perPage, sort: [['current_SALES', 'asc']] };
}

async function findKeepaProductsByTitleSearch(searchTerm) {
  const term = String(searchTerm || '').trim();
  if (!term) return [];
  try {
    const searchResponse = await axios.get('https://api.keepa.com/query', {
      params: {
        key: config.keepaApiKey,
        domain: config.keepaDomain,
        selection: JSON.stringify(keepaTitleSearchSelection(term)),
      },
      timeout: config.requestTimeoutMs,
    });
    const asins = (searchResponse.data?.asinList || []).slice(0, config.keepaTitleSearchResults);
    if (asins.length === 0) return [];
    const productResponse = await axios.get('https://api.keepa.com/product', {
      params: {
        key: config.keepaApiKey, domain: config.keepaDomain, asin: asins.join(','), stats: 30, history: 0,
      },
      timeout: config.requestTimeoutMs,
    });
    return (productResponse.data?.products || []).slice(0, config.keepaTitleSearchResults);
  } catch (error) {
    const message = error.response?.data?.error?.message || error.response?.data?.message || error.message;
    const wrapped = new Error(`Keepa title-search lookup ${error.response?.status || 'request'}: ${message}`);
    wrapped.response = error.response;
    wrapped.code = error.code;
    throw wrapped;
  }
}

export function keepaProductCodeParams(productCode) {
  return {
    domain: config.keepaDomain,
    code: String(productCode || '').replace(/\D/g, ''),
    stats: 30,
    history: 0,
  };
}

const keepaMoney = (value) => Number.isFinite(value) && value > 0 ? value / 100 : null;

const quantityPatterns = [
  {
    // Retailers commonly express a multipack as "12 x 2.47 oz" without using
    // the words pack or count. The leading multiplier is the sellable count.
    category: 'pack',
    pattern: /\b(\d+)\s*[x×]\s*\d+(?:\.\d+)?\s*(?:fl\.?\s*oz\.?|oz|ounces?|ml|milliliters?|g|grams?)\b/gi,
    normalize: (value) => Number(value),
  },
  {
    category: 'count',
    pattern: /(\d+(?:\.\d+)?)\s*(?:-|\s)?(?:count|ct\.?|each|colors?|pieces?|pcs?\.?|patches?|tablets?|capsules?|pods?|packets?|bags?|rolls?|bottles?|cans?|rubber\s+bands?|bands?)\b/gi,
    normalize: (value) => Number(value),
  },
  {
    category: 'pack',
    pattern: /(?:pack\s+of\s+(\d+)|(\d+)\s*(?:-|\s)?pack)\b/gi,
    normalize: (value) => Number(value),
  },
  ...[
    ['device', /(?:\b(\d+)\s+(?:plug[ -]?in\s+)?devices?\b)/gi],
    ['cartridge', /(?:\b(\d+)\s+cartridges?\b)/gi],
    ['pad', /(?:\b(\d+)\s+pads?\b)/gi],
    ['folder', /(?:\b(\d+)\s+(?:paper\s+)?folders?\b)/gi],
    ['bar', /(?:\b(\d+)\s+(?:snack\s+|granola\s+|energy\s+)?bars?\b)/gi],
    ['bone', /(?:\b(\d+)\s+(?:dog\s+chew\s+|chew\s+)?bones?\b)/gi],
  ].map(([category, pattern]) => ({ category, pattern, normalize: (value) => Number(value) })),
  {
    category: 'size_oz',
    pattern: /(\d+(?:\.\d+)?)\s*(lb|lbs|pounds?|oz|ounces?)\b/gi,
    normalize: (value, unit) => Number(value) * (/^(?:lb|lbs|pound)/i.test(unit) ? 16 : 1),
  },
  {
    category: 'weight_g',
    pattern: /(\d+(?:\.\d+)?)\s*(kg|kilograms?|g|grams?)\b/gi,
    normalize: (value, unit) => Number(value) * (/^(?:kg|kilogram)/i.test(unit) ? 1000 : 1),
  },
  {
    category: 'volume_ml',
    pattern: /(\d+(?:\.\d+)?)\s*(l|liters?|litres?|ml|milliliters?|millilitres?)\b/gi,
    normalize: (value, unit) => Number(value) * (/^(?:l|liter|litre)$/i.test(unit) ? 1000 : 1),
  },
  {
    category: 'size_oz',
    pattern: /(\d+(?:\.\d+)?)\s*(?:fl\.?\s*oz\.?|fluid\s+ounces?)\b/gi,
    normalize: (value) => Number(value),
  },
  {
    category: 'length_in',
    pattern: /(\d+(?:\.\d+)?)\s*(ft|feet|foot|in|inch|inches|cm|mm)\b/gi,
    normalize: (value, unit) => Number(value) * (/^(?:ft|feet|foot)$/i.test(unit)
      ? 12
      : (/^cm$/i.test(unit) ? 0.393701 : (/^mm$/i.test(unit) ? 0.0393701 : 1))),
  },
  {
    category: 'voltage_v',
    pattern: /\b(\d+(?:\.\d+)?)\s*(?:v|volts?)\b/gi,
    normalize: (value) => Number(value),
  },
];

export function extractListingQuantities(title) {
  const listingText = String(title || '');
  const quantities = {};
  for (const { category, pattern, normalize } of quantityPatterns) {
    pattern.lastIndex = 0;
    for (const match of listingText.matchAll(pattern)) {
      const value = match[1] || match[2];
      const unit = match[2] && match[1] ? match[2] : match[3];
      const normalized = normalize(value, unit);
      if (Number.isFinite(normalized) && normalized > 0) {
        quantities[category] ||= [];
        if (!quantities[category].includes(normalized)) quantities[category].push(normalized);
      }
    }
  }
  if (quantities.pack || quantities.count) {
    // An explicit pack size is the outer sellable quantity. A generic count is
    // only used when no pack wording exists (for example, "6 ct" vs "24 pack").
    quantities.outer_count = quantities.pack || quantities.count;
    delete quantities.pack;
    delete quantities.count;
  }
  const structuredCountPack = [...listingText.matchAll(
    /\b(\d+)\s*(?:count|ct\.?)\s*\(?\s*pack\s+of\s+(\d+)\s*\)?/gi,
  )].map((match) => Number(match[1]) * Number(match[2])).filter((value) => value > 0);
  if (structuredCountPack.length > 0) quantities.outer_count = [...new Set(structuredCountPack)];
  return quantities;
}

export function listingQuantitiesCompatible(
  walmartTitle,
  amazonTitle,
  amazonNumberOfItems = null,
  { allowMissingUnitSize = false } = {},
) {
  const walmart = extractListingQuantities(walmartTitle);
  const amazon = extractListingQuantities(amazonTitle);
  const structuredItems = Number(amazonNumberOfItems);
  if (!amazon.outer_count && Number.isFinite(structuredItems) && structuredItems > 1) {
    amazon.outer_count = [structuredItems];
  }
  const valuesMatch = (left, right) => Math.abs(left - right) <= Math.max(left, right) * 0.02;
  const reconciledCategories = new Set();
  for (const unitCategory of ['size_oz', 'weight_g', 'volume_ml']) {
    if (!walmart.outer_count || !amazon.outer_count || !walmart[unitCategory] || !amazon[unitCategory]) continue;
    const walmartTotals = walmart.outer_count.flatMap((count) => walmart[unitCategory]
      .map((unit) => count * unit));
    const amazonTotals = amazon.outer_count.flatMap((count) => amazon[unitCategory]
      .map((unit) => count * unit));
    if (walmartTotals.some((left) => amazonTotals.some((right) => valuesMatch(left, right)))) {
      // "12.5 fl oz × 12" and "150 fl oz (pack of 1)" are the same
      // sellable quantity even though the retailer titles group it differently.
      reconciledCategories.add('outer_count');
      reconciledCategories.add(unitCategory);
    }
  }
  const strictUnitCategories = new Set([
    'outer_count', 'device', 'cartridge', 'pad', 'folder', 'bar', 'bone',
    'size_oz', 'weight_g', 'volume_ml', 'voltage_v',
  ]);
  const categories = new Set([...Object.keys(walmart), ...Object.keys(amazon)]);
  for (const category of categories) {
    if (reconciledCategories.has(category)) continue;
    if (!walmart[category] || !amazon[category]) {
      if (!strictUnitCategories.has(category)) continue;
      if (allowMissingUnitSize && ['size_oz', 'weight_g', 'volume_ml'].includes(category)) continue;
      const explicit = walmart[category] || amazon[category];
      if (explicit.some((value) => value !== 1)) {
        return {
          compatible: false,
          category,
          walmart: walmart[category] || [1],
          amazon: amazon[category] || [1],
        };
      }
      continue;
    }
    const walmartCovered = walmart[category].every((left) => amazon[category]
      .some((right) => valuesMatch(left, right)));
    const amazonCovered = amazon[category].every((right) => walmart[category]
      .some((left) => valuesMatch(left, right)));
    if (!walmartCovered || !amazonCovered) {
      return { compatible: false, category, walmart: walmart[category], amazon: amazon[category] };
    }
  }
  return { compatible: true, walmart, amazon };
}

const normalizeIdentity = (value) => String(value || '').toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/\+/g, ' plus ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

export function brandsCompatible(walmartBrand, amazonBrand) {
  const left = normalizeIdentity(walmartBrand);
  const right = normalizeIdentity(amazonBrand);
  if (!left || !right) return false;
  return left === right
    || (Math.min(left.length, right.length) >= 4 && (left.includes(right) || right.includes(left)));
}

const identityStopWords = new Set([
  'a', 'an', 'and', 'by', 'ct', 'count', 'for', 'from', 'in', 'of', 'on', 'or', 'pack',
  'piece', 'pieces', 'size', 'sizes', 'the', 'to', 'with', 'walmart', 'amazon',
  // Generic merchandising language must not outweigh the actual model/style
  // name (for example, NeeDoh Nice Cream Cone versus NeeDoh Gumdrop).
  'toy', 'toys', 'sensory', 'color', 'colors', 'may', 'vary', 'assorted',
]);

const identityTokens = (title, brand) => {
  const brandTokens = new Set(normalizeIdentity(brand).split(' ').filter(Boolean));
  return new Set(normalizeIdentity(title).split(' ').map((token) => (
    token.length > 4 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token
  )).filter((token) => token.length >= 3
    && !/^\d+$/.test(token)
    && !identityStopWords.has(token)
    && !brandTokens.has(token)));
};

export function productIdentityCompatible(walmartTitle, amazonTitle, walmartBrand, amazonBrand) {
  if (!brandsCompatible(walmartBrand, amazonBrand)) return false;
  const walmartTokens = identityTokens(walmartTitle, walmartBrand);
  const amazonTokens = identityTokens(amazonTitle, amazonBrand);
  const shared = [...walmartTokens].filter((token) => amazonTokens.has(token)).length;
  const smallerTitle = Math.min(walmartTokens.size, amazonTokens.size);
  const required = smallerTitle <= 1 ? 1 : Math.max(2, Math.ceil(smallerTitle * 0.6));
  return shared >= required;
}

export function upcTitleIdentityCompatible(walmartTitle, amazonTitle) {
  const walmartTokens = identityTokens(walmartTitle, '');
  const amazonTokens = identityTokens(amazonTitle, '');
  const shared = [...walmartTokens].filter((token) => amazonTokens.has(token)).length;
  const smallerTitle = Math.min(walmartTokens.size, amazonTokens.size);
  // UPC agreement permits compact catalog aliases (for example Bitzee's
  // shortened Amazon title), but long competing variant names still need the
  // stronger overlap threshold.
  const required = smallerTitle <= 2 ? 1
    : (smallerTitle <= 4 ? 2 : Math.max(2, Math.ceil(smallerTitle * 0.6)));
  return shared >= required;
}

const colorTerms = [
  'black', 'white', 'red', 'blue', 'green', 'yellow', 'orange', 'purple', 'pink',
  'brown', 'gray', 'grey', 'silver', 'gold', 'beige', 'navy', 'teal', 'clear',
];
const versionTerms = [
  'select', 'plus', 'pro', 'max', 'ultra', 'mini', 'compact', 'classic',
  'original', 'ii', 'iii', 'iv', 'v2', 'v3', 'gen2', 'gen3',
];
const conditionTerms = ['mint', 'pristine', 'renewed', 'refurbished', 'used', 'preowned', 'recycled'];
const flavorStyleTerms = ['warheads', 'watermelon', 'icee', 'drip'];
const fragranceFlankerTerms = [
  'ice', 'intense', 'blue', 'aqua', 'sport', 'absolute', 'absolu', 'elixir', 'noir', 'night',
];
const constructionStyleTerms = ['mesh', 'pouch'];
const namedSizeTerms = [
  'mini', 'small', 'medium', 'large', 'xl', 'xxl', 'standard', 'junior', 'youth', 'adult',
];
const presentTerms = (title, terms) => {
  const tokens = new Set(normalizeIdentity(title).split(' '));
  return terms.filter((term) => tokens.has(term));
};
const modelCodes = (title) => normalizeIdentity(title).split(' ').filter((token) =>
  token.length >= 4 && /[a-z]/.test(token) && /\d/.test(token));
const setsConflict = (left, right) => left.length > 0 && right.length > 0
  && !left.some((value) => right.includes(value));
const normalizeProductCode = (value) => String(value || '').replace(/\D/g, '').replace(/^0+/, '');

export function listingVariantsCompatible(walmartTitle, amazonTitle) {
  const walmartColors = presentTerms(walmartTitle, colorTerms);
  const amazonColors = presentTerms(amazonTitle, colorTerms);
  if (setsConflict(walmartColors, amazonColors)) return false;
  const walmartVersions = presentTerms(walmartTitle, versionTerms);
  const amazonVersions = presentTerms(amazonTitle, versionTerms);
  if (setsConflict(walmartVersions, amazonVersions)) return false;
  const walmartConditions = presentTerms(walmartTitle, conditionTerms);
  const amazonConditions = presentTerms(amazonTitle, conditionTerms);
  if (amazonConditions.length > 0 && walmartConditions.length === 0) return false;
  if (setsConflict(walmartConditions, amazonConditions)) return false;
  const walmartFlavorStyles = presentTerms(walmartTitle, flavorStyleTerms);
  const amazonFlavorStyles = presentTerms(amazonTitle, flavorStyleTerms);
  if (setsConflict(walmartFlavorStyles, amazonFlavorStyles)) return false;
  const walmartFlankers = presentTerms(walmartTitle, fragranceFlankerTerms);
  const amazonFlankers = presentTerms(amazonTitle, fragranceFlankerTerms);
  if (setsConflict(walmartFlankers, amazonFlankers)) return false;
  const walmartConstructionStyles = presentTerms(walmartTitle, constructionStyleTerms);
  const amazonConstructionStyles = presentTerms(amazonTitle, constructionStyleTerms);
  if (setsConflict(walmartConstructionStyles, amazonConstructionStyles)) return false;
  const walmartSizes = presentTerms(walmartTitle, namedSizeTerms);
  const amazonSizes = presentTerms(amazonTitle, namedSizeTerms);
  if (setsConflict(walmartSizes, amazonSizes)) return false;
  const walmartModels = modelCodes(walmartTitle);
  const amazonModels = modelCodes(amazonTitle);
  return !setsConflict(walmartModels, amazonModels);
}

export function productCodesCompatible(walmartCode, product) {
  if (!walmartCode) return false;
  const walmart = normalizeProductCode(walmartCode);
  const amazonCodes = [...(product.upcList || []), ...(product.eanList || [])]
    .map(normalizeProductCode).filter(Boolean);
  return amazonCodes.includes(walmart);
}

// User-directed category additions, each with its own price ceiling tighter
// than the global default. Keyed by pathname (not the full href) because
// walmartSourceUrls() rewrites query params (facet, page) on every source.
export const categoryBuyCostOverrides = [
  { pathname: '/cp/video-games/2636', maxBuyCost: 40 },
  { pathname: '/cp/electronics/3944', maxBuyCost: 90 },
];

export function maximumBuyCostForSource(sourceUrl) {
  if (!sourceUrl) return config.maximumWalmartBuyCost;
  try {
    const pathname = new URL(sourceUrl).pathname;
    const override = categoryBuyCostOverrides.find((entry) => entry.pathname === pathname);
    return override ? override.maxBuyCost : config.maximumWalmartBuyCost;
  } catch {
    return config.maximumWalmartBuyCost;
  }
}

export function withinBuyCostLimit(price, sourceUrl) {
  return Number(price) > 0 && Number(price) <= maximumBuyCostForSource(sourceUrl);
}

export function productFormsCompatible(walmartTitle, amazonTitle) {
  const walmartMedia = /\b(?:movie|film|blu[ -]?ray|dvd)\b/i.test(walmartTitle);
  const amazonHardware = /\b(?:player|home theater|disc drive)\b/i.test(amazonTitle);
  const amazonMedia = /\b(?:movie|film|blu[ -]?ray|dvd)\b/i.test(amazonTitle);
  const walmartHardware = /\b(?:player|home theater|disc drive)\b/i.test(walmartTitle);
  return !(walmartMedia && amazonHardware) && !(amazonMedia && walmartHardware);
}

function evaluateProduct(candidate, identification, product) {
  // The verified Walmart detail title is authoritative and must not be
  // rewritten before deterministic identity and variant checks.
  const canonicalWalmartTitle = candidate.title;
  if (!upcTitleIdentityCompatible(
    canonicalWalmartTitle,
    product.title || '',
  )) return { rejection: 'identity_mismatch' };
  if (!listingVariantsCompatible(
    canonicalWalmartTitle,
    `${product.title || ''} ${product.color || ''} ${product.size || ''}`,
  )) return { rejection: 'variant_mismatch' };
  if (!productCodesCompatible(candidate.upc, product)) return { rejection: 'product_code_mismatch' };
  if (!productFormsCompatible(canonicalWalmartTitle, product.title || '')) return { rejection: 'product_type_mismatch' };
  if (!listingQuantitiesCompatible(
    candidate.title,
    `${product.title || ''} ${product.size || ''}`,
    product.numberOfItems,
    { allowMissingUnitSize: true },
  ).compatible) return { rejection: 'quantity_mismatch' };
  const current = product.stats?.current || [];
  const amazonPrice = keepaMoney([
    product.stats?.buyBoxPrice,
    current[18],
    current[10],
    current[1],
    current[0],
  ].find((value) => Number.isFinite(value) && value > 0));
  const estimatedMonthlySales = asNumber(product.monthlySold) ?? asNumber(product.stats?.salesRankDrops30);
  if (!amazonPrice) return { rejection: 'missing_amazon_price' };
  if (!estimatedMonthlySales) return { rejection: 'missing_sales_velocity' };
  const brand = product.brand || identification.brand;
  if (config.blockedBrands.includes(String(brand).toLowerCase())) return { rejection: 'blocked_brand' };
  const pickAndPackRaw = asNumber(product.fbaFees?.pickAndPackFee) || 0;
  const fulfillmentFee = pickAndPackRaw > 100 ? pickAndPackRaw / 100 : pickAndPackRaw;
  const referralPercent = asNumber(product.referralFeePercentage) || 15;
  const estimatedFees = fulfillmentFee + amazonPrice * (referralPercent / 100) + config.feeBuffer;
  const estimatedProfit = amazonPrice - candidate.currentPrice - estimatedFees;
  const roi = candidate.currentPrice > 0
    ? ((amazonPrice - candidate.currentPrice) / candidate.currentPrice) * 100
    : 0;
  return { deal: {
    ...candidate,
    asin: product.asin,
    amazonTitle: product.title || identification.cleanSearchTerm,
    walmartCanonicalTitle: canonicalWalmartTitle,
    amazonUrl: `https://www.amazon.com/dp/${product.asin}`,
    brand,
    packCount: identification.estimatedPackCount,
    amazonPrice,
    estimatedFees,
    estimatedProfit,
    roi,
    estimatedMonthlySales,
    categoryRisk: variationHeavyTerms.test(candidate.title) ? 'VARIATION_HEAVY' : 'STANDARD',
    policyStatus: 'UNVERIFIED',
  } };
}

export function calculateDeal(candidate, identification, product) {
  return evaluateProduct(candidate, identification, product).deal || null;
}

export async function analyzeCandidate(candidate) {
  if (!withinBuyCostLimit(candidate.currentPrice, candidate.discoverySourceUrl)) {
    return { deal: null, rejection: 'buy_cost_over_limit', funnel: {} };
  }
  const automaticRejection = automaticEligibilityReason(candidate);
  if (automaticRejection) return { deal: null, rejection: automaticRejection, funnel: {} };
  let products = await findKeepaProductsByCode(candidate.upc);
  let upcDiscoveryMethod = 'code';
  if (products.length === 0 && config.keepaTitleSearchFallback) {
    products = await findKeepaProductsByTitleSearch(candidate.searchTitle || candidate.title);
    upcDiscoveryMethod = 'title_search';
  }
  if (products.length === 0) return { deal: null, rejection: 'no_amazon_match', funnel: {} };
  // Every ASIN, however it was found, must still expose the Walmart UPC/EAN.
  // The title-search fallback only widens which ASINs get checked here — it
  // never relaxes this identity requirement.
  const exactCodeProducts = products.filter((product) => productCodesCompatible(candidate.upc, product));
  if (exactCodeProducts.length === 0) {
    return { deal: null, rejection: 'product_code_mismatch', diagnostics: products.map((product) => ({
      asin: product.asin,
      amazonTitle: product.title || '',
      amazonBrand: product.brand || '',
      rejection: 'product_code_mismatch',
    })), funnel: { amazonUpcMatchFound: false } };
  }
  const rejectionPriority = [
    'identity_mismatch', 'product_code_mismatch', 'product_type_mismatch', 'variant_mismatch', 'quantity_mismatch',
    'exact_match_verification', 'blocked_brand', 'missing_amazon_price', 'price_spread', 'net_profit',
    'missing_sales_velocity', 'sales_velocity',
  ];
  let furthestRejection = 'identity_mismatch';
  const qualified = [];
  const diagnostics = [];
  const candidateQuantities = extractListingQuantities(candidate.title);
  const identification = {
    brand: candidate.brand || '',
    canonicalTitle: candidate.title,
    cleanSearchTerm: candidate.title,
    estimatedPackCount: candidateQuantities.outer_count?.[0] || 1,
  };
  let economicsPassed = false;
  let exactAmazonMatchFound = false;
  const identityRejections = new Set([
    'identity_mismatch', 'product_code_mismatch', 'product_type_mismatch',
    'variant_mismatch', 'quantity_mismatch',
  ]);
  for (const product of exactCodeProducts) {
    const result = evaluateProduct(candidate, identification, product);
    if (!identityRejections.has(result.rejection)) exactAmazonMatchFound = true;
    const diagnostic = {
      asin: product.asin,
      amazonTitle: product.title || '',
      amazonBrand: product.brand || '',
      rejection: result.rejection || null,
      ...(result.deal ? {
        amazonPrice: result.deal.amazonPrice,
        roi: result.deal.roi,
        estimatedProfit: result.deal.estimatedProfit,
        estimatedMonthlySales: result.deal.estimatedMonthlySales,
      } : {}),
    };
    diagnostics.push(diagnostic);
    if (!result.deal) {
      if (rejectionPriority.indexOf(result.rejection) > rejectionPriority.indexOf(furthestRejection)) {
        furthestRejection = result.rejection;
      }
      continue;
    }
    if (result.deal.roi < config.minimumRoi) {
      furthestRejection = 'price_spread';
      diagnostic.rejection = 'price_spread';
      continue;
    }
    if (result.deal.estimatedProfit <= config.minimumEstimatedProfit) {
      furthestRejection = 'net_profit';
      diagnostic.rejection = 'net_profit';
      continue;
    }
    if (result.deal.estimatedMonthlySales < config.minimumMonthlySales) {
      furthestRejection = 'sales_velocity';
      diagnostic.rejection = 'sales_velocity';
      continue;
    }
    economicsPassed = true;
    const exactVerification = await verifyExactProductMatch(candidate, result.deal);
    diagnostics.at(-1).exactVerification = exactVerification;
    if (!exactVerification.exactMatch) {
      furthestRejection = 'exact_match_verification';
      diagnostic.rejection = 'exact_match_verification';
      continue;
    }
    qualified.push(result.deal);
  }
  return qualified.length
    ? {
      deal: { ...qualified[0], matchMethod: 'UPC', upcDiscoveryMethod },
      rejection: null,
      diagnostics,
      funnel: {
        amazonUpcMatchFound: true,
        exactAmazonMatchFound,
        economicsPassed,
        titleSearchFallbackMatched: upcDiscoveryMethod === 'title_search',
      },
    }
    : {
      deal: null,
      rejection: furthestRejection,
      diagnostics,
      funnel: { amazonUpcMatchFound: true, exactAmazonMatchFound, economicsPassed },
    };
}

const stableOrder = (seed) => Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 12), 16);
const dealRankingScore = (deal) => Math.min(Number(deal.roi) || 0, 75)
  + Math.log10(Math.max(1, Number(deal.estimatedMonthlySales) || 1)) * 15;

function eligibleForStudent(deal, student) {
  const canonicalWalmartTitle = deal.walmartCanonicalTitle || deal.searchTitle || deal.title;
  return deal.roi >= Math.max(config.minimumRoi, student.minRoi)
    && deal.matchMethod === 'UPC'
    && Boolean(deal.upc)
    && Boolean(deal.detailVerified)
    && Boolean(deal.onlineAvailable)
    && (deal.estimatedProfit === undefined || Number(deal.estimatedProfit) > config.minimumEstimatedProfit)
    && deal.estimatedMonthlySales >= student.minMonthlySales
    && deal.currentPrice <= student.maxCost
    && !student.excludedBrands.includes(String(deal.brand).toLowerCase())
    && (!deal.title || !deal.amazonTitle || (
      productIdentityCompatible(canonicalWalmartTitle, deal.amazonTitle, deal.brand, deal.brand)
      && listingVariantsCompatible(canonicalWalmartTitle, deal.amazonTitle)
      && listingQuantitiesCompatible(deal.title, deal.amazonTitle).compatible
    ));
}

export function allocateDeals(rawDeals, students, limit, seed) {
  const uniqueDeals = [...new Map(rawDeals.map((deal) => [deal.asin || deal.itemId, deal])).values()]
    .sort((left, right) => dealRankingScore(right) - dealRankingScore(left));
  const orderedStudents = [...students].sort((left, right) =>
    stableOrder(`${seed}:${left.id}`) - stableOrder(`${seed}:${right.id}`));
  const assignments = Object.fromEntries(students.map((student) => [student.id, []]));
  let cursor = 0;
  for (const deal of uniqueDeals) {
    let assigned = false;
    for (let attempts = 0; attempts < orderedStudents.length; attempts += 1) {
      const index = (cursor + attempts) % orderedStudents.length;
      const student = orderedStudents[index];
      if (assignments[student.id].length < limit && eligibleForStudent(deal, student)) {
        assignments[student.id].push(deal);
        cursor = (index + 1) % orderedStudents.length;
        assigned = true;
        break;
      }
    }
    if (!assigned && Object.values(assignments).every((deals) => deals.length >= limit)) break;
  }
  return assignments;
}

const dollars = (value) => `$${Number(value).toFixed(2)}`;

export function discordPayload(student, deals) {
  const embeds = deals.map((deal, index) => ({
    title: `${index + 1}. ${deal.amazonTitle}`.slice(0, 256),
    url: deal.amazonUrl,
    color: 0xf1c40f,
    thumbnail: deal.imageUrl ? { url: deal.imageUrl } : undefined,
    fields: [
      { name: 'Walmart cost', value: dollars(deal.currentPrice), inline: true },
      { name: 'Amazon price', value: dollars(deal.amazonPrice), inline: true },
      { name: 'Gross price spread', value: `${deal.roi.toFixed(1)}%`, inline: true },
      { name: 'Est. net after fees', value: dollars(deal.estimatedProfit), inline: true },
      { name: 'Sales signal', value: Math.round(deal.estimatedMonthlySales).toLocaleString('en-US'), inline: true },
      { name: 'ASIN', value: deal.asin, inline: true },
      { name: 'Source', value: `[Walmart](${deal.walmartUrl}) · [Amazon](${deal.amazonUrl})`, inline: false },
      ...(deal.categoryRisk === 'VARIATION_HEAVY'
        ? [{ name: 'Category risk', value: 'Variation-heavy product — verify the exact size, color, and style manually.', inline: false }]
        : []),
      { name: '⚠️ Manual verification required', value: 'IP risk and selling eligibility are **not verified by Keepa**. Confirm brand/IP risk, account eligibility, exact variation, fees, price, and stock before buying.', inline: false },
    ],
  }));
  return {
    username: 'Syndicate AI Sourcing',
    content: `Good morning ${student.name} — ${deals.length} unique candidate${deals.length === 1 ? '' : 's'} passed today’s automated profitability screen.`,
    embeds,
  };
}

export function discordPayloads(student, deals, dealsPerMessage = 4) {
  const chunks = [];
  for (let index = 0; index < deals.length; index += dealsPerMessage) {
    chunks.push(deals.slice(index, index + dealsPerMessage));
  }
  return chunks.map((chunk, index) => {
    const payload = discordPayload(student, chunk);
    if (chunks.length > 1) {
      payload.content += ` (Part ${index + 1} of ${chunks.length})`;
    }
    return payload;
  });
}

export function emptyDiscordPayload(student, summary = {}) {
  return {
    username: 'Syndicate AI Sourcing',
    content: `${summary.candidateCount || 0} products searched, nothing found.`,
    embeds: [],
  };
}
