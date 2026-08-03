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

export const config = Object.freeze({
  airtablePat: process.env.AIRTABLE_PAT,
  airtableBaseId: process.env.AIRTABLE_BASE_ID,
  airtableStudentsTable: process.env.AIRTABLE_STUDENTS_TABLE || 'Students',
  walmartScraperApiKey: process.env.WALMART_SCRAPER_API_KEY,
  walmartScraperUrl: process.env.WALMART_SCRAPER_API_URL || 'https://app.scrapingbee.com/api/v1/',
  walmartTargetUrls: list(process.env.WALMART_TARGET_URLS || process.env.WALMART_TARGET_URL),
  walmartRenderJs: boolean(process.env.WALMART_RENDER_JS, true),
  walmartPremiumProxy: boolean(process.env.WALMART_PREMIUM_PROXY, false),
  walmartPagesPerRun: integer(process.env.WALMART_PAGES_PER_RUN, 6),
  walmartMaxPage: integer(process.env.WALMART_MAX_PAGE, 60),
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
  targetDealsPerStudent: integer(process.env.TARGET_DEALS_PER_STUDENT, 10),
  keepaTokensPerMinute: integer(process.env.KEEPA_TOKENS_PER_MINUTE, 1),
  keepaTokensPerCandidate: Math.max(number(process.env.KEEPA_ESTIMATED_TOKENS_PER_CANDIDATE, 12), 12),
  minimumRoi: number(process.env.MINIMUM_ROI, 50),
  minimumMonthlySales: number(process.env.MINIMUM_MONTHLY_SALES, 200),
  feeBuffer: number(process.env.PER_ITEM_FEE_BUFFER, 1.5),
  blockedBrands: list(process.env.BLOCKED_BRANDS).map((brand) => brand.toLowerCase()),
  requestTimeoutMs: integer(process.env.REQUEST_TIMEOUT_MS, 8000),
  runTtlSeconds: integer(process.env.RUN_TTL_SECONDS, 172800),
  studentCacheSeconds: integer(process.env.STUDENT_CACHE_SECONDS, 900),
  productCooldownSeconds: integer(process.env.PRODUCT_COOLDOWN_SECONDS, 2592000),
  analysisBatchSize: Math.min(integer(process.env.ANALYSIS_BATCH_SIZE, 50), 100),
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
  const status = Number(error?.response?.status);
  return [408, 425, 429, 500, 502, 503, 504].includes(status)
    || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error?.code);
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
  async del(key) { return Number(await redisCommand(['DEL', key])); },
});

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
  tokensPerCandidate = config.keepaTokensPerCandidate, initialDelaySeconds = 0) {
  const spacingSeconds = Math.ceil((tokensPerCandidate / tokensPerMinute) * 60);
  return Math.max(0, initialDelaySeconds + index * spacingSeconds);
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
  const [state, deals, errors] = await Promise.all([
    redis.mget([
      `run:${runId}:meta`,
      `run:${runId}:completedChunks`,
      `run:${runId}:finalized`,
      `run:${runId}:cancelled`,
    ]),
    redis.lrange(`run:${runId}:qualified`, 0, -1),
    redis.lrange(`run:${runId}:errors`, 0, -1),
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
  return {
    runId,
    createdAt: meta.createdAt,
    status: cancelled ? 'cancelled' : (finalized ? 'finalized' : 'analyzing'),
    candidates: meta.candidateCount,
    completedJobs: Number(completedChunks || 0),
    totalJobs: meta.totalChunks,
    qualifiedDeals: deals.length,
    analysisErrors: errors.length,
    cancellation: cancelled || null,
    initialDelaySeconds: meta.initialDelaySeconds || 0,
    keepaTokensAtQueueTime: meta.keepaTokensAtQueueTime,
    keepaTokensPerMinute: meta.keepaTokensPerMinute,
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
    'currentPrice.price', 'priceInfo.currentPrice.price', 'product.price',
  ]));
  const url = walmartUrl(first(candidate, [
    'walmartUrl', 'url', 'canonicalUrl', 'productUrl', 'product.url', 'item.url',
  ]));
  const imageUrl = walmartUrl(first(candidate, [
    'imageUrl', 'image', 'thumbnailUrl', 'imageInfo.thumbnailUrl', 'product.image', 'item.image',
  ]));
  const originalPriceValue = asNumber(first(candidate, [
    'originalPrice', 'wasPrice', 'listPrice', 'strikeThroughPrice',
    'priceInfo.wasPrice.price', 'priceInfo.listPrice.price', 'product.originalPrice',
  ]));
  const originalPrice = originalPriceValue > price ? originalPriceValue : null;
  const rawProductCode = first(candidate, [
    'upc', 'gtin', 'gtin13', 'gtin14', 'product.upc', 'product.gtin', 'item.upc',
  ]);
  const productCode = String(rawProductCode || '').replace(/\D/g, '');
  const upc = productCode.length >= 8 && productCode.length <= 14 ? productCode : null;
  if (typeof title !== 'string' || !title.trim() || !price || price <= 0 || !url) return null;
  const itemId = url.match(/\/ip\/(?:[^/]+\/)?(\d+)/)?.[1] || url;
  return {
    itemId,
    title: title.trim(),
    currentPrice: price,
    walmartUrl: url,
    imageUrl,
    ...(originalPrice ? { originalPrice } : {}),
    ...(upc ? { upc } : {}),
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
    // Prefer visible product cards. Walmart's internal analytics JSON sometimes
    // represents prices in integer cents, while the cards contain display dollars.
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
      });
      if (product) products.push(product);
    });
    $('script[type="application/ld+json"], script#__NEXT_DATA__').each((_, element) => {
      try { crawl(JSON.parse($(element).text()), products); } catch { /* Ignore unrelated scripts. */ }
    });
  }
  return [...new Map(products.map((product) => [product.itemId, product])).values()];
}

export function walmartUrlsForWindow(windowIndex = 0) {
  const base = new URL(config.walmartTargetUrls[0]);
  base.searchParams.delete('page');
  const windows = Math.max(1, Math.ceil(config.walmartMaxPage / config.walmartPagesPerRun));
  const normalizedWindow = ((Number(windowIndex) || 0) % windows + windows) % windows;
  return Array.from({ length: config.walmartPagesPerRun }, (_, offset) => {
    const page = normalizedWindow * config.walmartPagesPerRun + offset + 1;
    const target = new URL(base);
    if (page > 1) target.searchParams.set('page', String(page));
    return target.href;
  }).filter((_, offset) => normalizedWindow * config.walmartPagesPerRun + offset + 1 <= config.walmartMaxPage);
}

const preferredProductTerms = /\b(?:supplement|vitamin|beauty|skin|hair|shampoo|conditioner|soap|cleaner|detergent|toy|game|office|school|pet|tool|kitchen|baby|diaper|battery|filter)\b/i;
const variationHeavyTerms = /\b(?:shirt|pants|dress|shoe|sneaker|underwear|bra|jacket|swimsuit|swimwear|bathing suit|clothing|apparel|tire|furniture|sofa|mattress|television|tv|freezer|refrigerator|appliance)\b/i;
const perishableTerms = /\b(?:fresh|frozen|refrigerated|milk|meat|produce|ice cream)\b/i;

export function candidatePriority(candidate) {
  let score = 0;
  if (candidate.originalPrice > candidate.currentPrice) {
    score += Math.min(60, ((candidate.originalPrice - candidate.currentPrice) / candidate.originalPrice) * 100);
  }
  if (candidate.upc) score += 30;
  if (Object.keys(extractListingQuantities(candidate.title)).length > 0) score += 15;
  if (preferredProductTerms.test(candidate.title)) score += 12;
  if (candidate.currentPrice >= 3 && candidate.currentPrice <= 100) score += 10;
  if (candidate.currentPrice > 200) score -= 25;
  if (candidate.currentPrice < 1) score -= 10;
  if (variationHeavyTerms.test(candidate.title)) score -= 45;
  if (perishableTerms.test(candidate.title)) score -= 60;
  return score;
}

export function prioritizeCandidates(candidates) {
  return [...candidates].sort((left, right) => candidatePriority(right) - candidatePriority(left));
}

export function isExcludedProductType(title) {
  return variationHeavyTerms.test(String(title || '')) || perishableTerms.test(String(title || ''));
}

export async function fetchWalmartCatalog(limit = config.maxCandidates, targetUrls = config.walmartTargetUrls) {
  const safeLimit = Math.max(1, Math.min(integer(limit, config.maxCandidates), config.maxCandidates));
  const results = [];
  for (const url of targetUrls) {
    const request = (premiumProxy) => axios.get(config.walmartScraperUrl, {
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
    try {
      response = await request(config.walmartPremiumProxy);
    } catch (error) {
      if (config.walmartPremiumProxy || ![403, 429, 500, 502, 503, 504].includes(error.response?.status)) throw error;
      response = await request(true);
    }
    results.push(...normalizeWalmartPayload(response.data));
    if (results.length >= safeLimit) break;
  }
  return prioritizeCandidates([...new Map(results.map((product) => [product.itemId, product])).values()])
    .slice(0, safeLimit);
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
    itemId: candidate.itemId,
    title: candidate.title,
    currentPrice: candidate.currentPrice,
  })).digest('hex').slice(0, 32);
}

export async function filterRecentlyAnalyzedCandidates(candidates) {
  const keys = candidates.map((candidate) => `catalog:seen:${candidateFingerprint(candidate)}`);
  const seen = await redis.mget(keys);
  return candidates.filter((_, index) => !seen[index]);
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
    contents: `Create an exact Amazon catalog search for this Walmart product. Remove promotion text, preserve model/size/color/pack details, and never invent a pack count.\n${JSON.stringify(candidate)}`,
    config: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          brand: { type: 'STRING' },
          cleanSearchTerm: { type: 'STRING' },
          estimatedPackCount: { type: 'INTEGER', minimum: 1 },
        },
        required: ['brand', 'cleanSearchTerm', 'estimatedPackCount'],
      },
    },
  });
  const result = JSON.parse(response.text);
  if (!result.cleanSearchTerm || !result.brand) throw new Error('Gemini returned an incomplete match query');
  return result;
}

async function findKeepaProduct(searchTerm) {
  let search;
  try {
    search = await axios.get('https://api.keepa.com/search', {
      params: { key: config.keepaApiKey, domain: config.keepaDomain, type: 'product', term: searchTerm },
      timeout: config.requestTimeoutMs,
    });
  } catch (error) {
    const detail = error.response?.data?.error?.message || error.response?.data?.message || error.message;
    throw new Error(`Keepa search ${error.response?.status || 'request'}: ${detail}`);
  }
  const firstResult = search.data?.products?.[0] || search.data?.results?.[0];
  const asin = typeof firstResult === 'string' ? firstResult : firstResult?.asin;
  if (!asin) throw new Error('Keepa found no Amazon match');
  let detail;
  try {
    detail = await axios.get('https://api.keepa.com/product', {
      params: { key: config.keepaApiKey, domain: config.keepaDomain, asin, stats: 30 },
      timeout: config.requestTimeoutMs,
    });
  } catch (error) {
    const message = error.response?.data?.error?.message || error.response?.data?.message || error.message;
    throw new Error(`Keepa product ${error.response?.status || 'request'}: ${message}`);
  }
  const product = detail.data?.products?.[0];
  if (!product) throw new Error('Keepa returned no product details');
  return product;
}

const keepaMoney = (value) => Number.isFinite(value) && value > 0 ? value / 100 : null;

const quantityPatterns = [
  {
    category: 'count',
    pattern: /(\d+(?:\.\d+)?)\s*(?:-|\s)?(?:count|ct\.?|pieces?|pcs?\.?|patches?|tablets?|capsules?|pods?|packets?|bags?|rolls?|bottles?|cans?)\b/gi,
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
    category: 'weight_oz',
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
    category: 'volume_fl_oz',
    pattern: /(\d+(?:\.\d+)?)\s*(?:fl\.?\s*oz\.?|fluid\s+ounces?)\b/gi,
    normalize: (value) => Number(value),
  },
];

export function extractListingQuantities(title) {
  const quantities = {};
  for (const { category, pattern, normalize } of quantityPatterns) {
    pattern.lastIndex = 0;
    for (const match of String(title || '').matchAll(pattern)) {
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
  return quantities;
}

export function listingQuantitiesCompatible(walmartTitle, amazonTitle, amazonNumberOfItems = null) {
  const walmart = extractListingQuantities(walmartTitle);
  const amazon = extractListingQuantities(amazonTitle);
  const structuredItems = Number(amazonNumberOfItems);
  if (!amazon.outer_count && Number.isFinite(structuredItems) && structuredItems > 1) {
    amazon.outer_count = [structuredItems];
  }
  const strictUnitCategories = new Set([
    'outer_count', 'device', 'cartridge', 'pad', 'folder', 'bar', 'bone',
  ]);
  const categories = new Set([...Object.keys(walmart), ...Object.keys(amazon)]);
  for (const category of categories) {
    if (!walmart[category] || !amazon[category]) {
      if (!strictUnitCategories.has(category)) continue;
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
    const matches = walmart[category].some((left) => amazon[category]
      .some((right) => Math.abs(left - right) <= Math.max(left, right) * 0.02));
    if (!matches) return { compatible: false, category, walmart: walmart[category], amazon: amazon[category] };
  }
  return { compatible: true, walmart, amazon };
}

const normalizeIdentity = (value) => String(value || '').toLowerCase()
  .replace(/&/g, ' and ')
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
]);

const identityTokens = (title, brand) => {
  const brandTokens = new Set(normalizeIdentity(brand).split(' ').filter(Boolean));
  return new Set(normalizeIdentity(title).split(' ').filter((token) =>
    token.length >= 3
    && !/^\d+$/.test(token)
    && !identityStopWords.has(token)
    && !brandTokens.has(token)));
};

export function productIdentityCompatible(walmartTitle, amazonTitle, walmartBrand, amazonBrand) {
  if (!brandsCompatible(walmartBrand, amazonBrand)) return false;
  const walmartTokens = identityTokens(walmartTitle, walmartBrand);
  const amazonTokens = identityTokens(amazonTitle, amazonBrand);
  const shared = [...walmartTokens].filter((token) => amazonTokens.has(token)).length;
  const required = Math.min(walmartTokens.size, amazonTokens.size) <= 1 ? 1 : 2;
  return shared >= required;
}

export function calculateDeal(candidate, identification, product) {
  if (!productIdentityCompatible(
    candidate.title,
    product.title || '',
    identification.brand,
    product.brand,
  )) return null;
  if (!listingQuantitiesCompatible(
    candidate.title,
    product.title || '',
    product.numberOfItems,
  ).compatible) return null;
  const current = product.stats?.current || [];
  const amazonPrice = keepaMoney([
    product.stats?.buyBoxPrice,
    current[18],
    current[10],
    current[1],
    current[0],
  ].find((value) => Number.isFinite(value) && value > 0));
  const estimatedMonthlySales = asNumber(product.monthlySold) ?? asNumber(product.stats?.salesRankDrops30);
  if (!amazonPrice || !estimatedMonthlySales) return null;
  const brand = product.brand || identification.brand;
  if (config.blockedBrands.includes(String(brand).toLowerCase())) return null;
  const pickAndPackRaw = asNumber(product.fbaFees?.pickAndPackFee) || 0;
  const fulfillmentFee = pickAndPackRaw > 100 ? pickAndPackRaw / 100 : pickAndPackRaw;
  const referralPercent = asNumber(product.referralFeePercentage) || 15;
  const estimatedFees = fulfillmentFee + amazonPrice * (referralPercent / 100) + config.feeBuffer;
  const estimatedProfit = amazonPrice - candidate.currentPrice - estimatedFees;
  const roi = candidate.currentPrice > 0 ? (estimatedProfit / candidate.currentPrice) * 100 : 0;
  return {
    ...candidate,
    asin: product.asin,
    amazonTitle: product.title || identification.cleanSearchTerm,
    amazonUrl: `https://www.amazon.com/dp/${product.asin}`,
    brand,
    packCount: identification.estimatedPackCount,
    amazonPrice,
    estimatedFees,
    estimatedProfit,
    roi,
    estimatedMonthlySales,
    policyStatus: 'UNVERIFIED',
  };
}

export async function analyzeCandidate(candidate) {
  if (isExcludedProductType(candidate.title)) return null;
  const identification = await identifyProduct(candidate);
  const product = await findKeepaProduct(candidate.upc || identification.cleanSearchTerm);
  const deal = calculateDeal(candidate, identification, product);
  return deal && deal.roi >= config.minimumRoi && deal.estimatedMonthlySales >= config.minimumMonthlySales
    ? deal
    : null;
}

const stableOrder = (seed) => Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 12), 16);

function eligibleForStudent(deal, student) {
  return deal.roi >= student.minRoi
    && deal.estimatedMonthlySales >= student.minMonthlySales
    && deal.currentPrice <= student.maxCost
    && !student.excludedBrands.includes(String(deal.brand).toLowerCase());
}

export function allocateDeals(rawDeals, students, limit, seed) {
  const uniqueDeals = [...new Map(rawDeals.map((deal) => [deal.asin || deal.itemId, deal])).values()]
    .sort((left, right) => (right.roi + Math.log10(right.estimatedMonthlySales) * 10)
      - (left.roi + Math.log10(left.estimatedMonthlySales) * 10));
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
      { name: 'Est. profit', value: dollars(deal.estimatedProfit), inline: true },
      { name: 'Est. ROI', value: `${deal.roi.toFixed(1)}%`, inline: true },
      { name: 'Sales signal', value: Math.round(deal.estimatedMonthlySales).toLocaleString('en-US'), inline: true },
      { name: 'ASIN', value: deal.asin, inline: true },
      { name: 'Source', value: `[Walmart](${deal.walmartUrl}) · [Amazon](${deal.amazonUrl})`, inline: false },
      { name: '⚠️ Manual verification required', value: 'IP risk and selling eligibility are **not verified by Keepa**. Confirm brand/IP risk, account eligibility, exact variation, fees, price, and stock before buying.', inline: false },
    ],
  }));
  return {
    username: 'Syndicate AI Sourcing',
    content: `Good morning ${student.name} — ${deals.length} unique candidate${deals.length === 1 ? '' : 's'} passed today’s automated profitability screen.`,
    embeds,
  };
}

export function emptyDiscordPayload(student, summary = {}) {
  const failed = Number(summary.failedCandidates || 0);
  return {
    username: 'Syndicate AI Sourcing',
    content: `Good morning ${student.name} — no products passed today's automated screen. `
      + `${summary.candidateCount || 0} Walmart candidates were checked`
      + `${failed ? `, with ${failed} API or matching error${failed === 1 ? '' : 's'}` : ''}. `
      + 'No deal is better than an unqualified deal; the next scheduled run will try again.',
    embeds: [],
  };
}
