import { createHash } from 'node:crypto';

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
const list = (value = '') => (Array.isArray(value) ? value : String(value).split(/[\n,]/))
  .map((item) => String(item).trim()).filter(Boolean);

export const config = Object.freeze({
  airtablePat: process.env.AIRTABLE_PAT,
  airtableBaseId: process.env.AIRTABLE_BASE_ID,
  airtableStudentsTable: process.env.AIRTABLE_STUDENTS_TABLE || 'Students',
  walmartScraperApiKey: process.env.WALMART_SCRAPER_API_KEY,
  walmartScraperUrl: process.env.WALMART_SCRAPER_API_URL || 'https://app.scrapingbee.com/api/v1/',
  walmartTargetUrls: list(process.env.WALMART_TARGET_URLS || process.env.WALMART_TARGET_URL),
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
  maxStudents: Math.min(integer(process.env.MAX_ACTIVE_STUDENTS, 10), 10),
  maxCandidates: integer(process.env.MAX_CANDIDATES_PER_RUN, 1000),
  targetDealsPerStudent: integer(process.env.TARGET_DEALS_PER_STUDENT, 10),
  analysisChunkSize: integer(process.env.ANALYSIS_CHUNK_SIZE, 2),
  minimumRoi: number(process.env.MINIMUM_ROI, 50),
  minimumMonthlySales: number(process.env.MINIMUM_MONTHLY_SALES, 200),
  feeBuffer: number(process.env.PER_ITEM_FEE_BUFFER, 1.5),
  blockedBrands: list(process.env.BLOCKED_BRANDS).map((brand) => brand.toLowerCase()),
  requestTimeoutMs: integer(process.env.REQUEST_TIMEOUT_MS, 8000),
  runTtlSeconds: integer(process.env.RUN_TTL_SECONDS, 172800),
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
  async set(key, value, options = {}) {
    const command = ['SET', key, JSON.stringify(value)];
    if (options.nx) command.push('NX');
    if (options.ex) command.push('EX', String(options.ex));
    return (await redisCommand(command)) === 'OK';
  },
  async rpush(key, value) {
    return Number(await redisCommand(['RPUSH', key, JSON.stringify(value)]));
  },
  async lrange(key, start, stop) {
    const values = await redisCommand(['LRANGE', key, String(start), String(stop)]);
    return Array.isArray(values) ? values.map(decodeJson) : [];
  },
  async incr(key) { return Number(await redisCommand(['INCR', key])); },
  async del(key) { return Number(await redisCommand(['DEL', key])); },
});

function qstashHeaders() {
  return {
    Authorization: `Bearer ${config.qstashToken}`,
    'Content-Type': 'application/json',
  };
}

function qstashMessage(job) {
  return {
    destination: job.url,
    body: JSON.stringify(job.body),
    headers: {
      'Content-Type': 'application/json',
      'Upstash-Forward-x-worker-secret': config.workerSecret,
      'Upstash-Retries': '3',
      'Upstash-Deduplication-Id': job.deduplicationId,
      'Upstash-Redact-Fields': 'body,header[x-worker-secret]',
    },
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
  const parsed = Number.parseFloat(value.replace(/[^0-9.-]/g, ''));
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
  if (typeof title !== 'string' || !title.trim() || !price || price <= 0 || !url) return null;
  const itemId = url.match(/\/ip\/(?:[^/]+\/)?(\d+)/)?.[1] || url;
  return { itemId, title: title.trim(), currentPrice: price, walmartUrl: url, imageUrl };
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
    $('script[type="application/ld+json"], script#__NEXT_DATA__').each((_, element) => {
      try { crawl(JSON.parse($(element).text()), products); } catch { /* Ignore unrelated scripts. */ }
    });
    $('[data-item-id], [data-testid="item-stack"]').each((_, element) => {
      const root = $(element);
      const link = root.find('a[href*="/ip/"]').first();
      const image = root.find('img').first();
      const product = normalizeWalmartProduct({
        title: link.attr('aria-label') || image.attr('alt') || link.text(),
        price: root.find('[itemprop="price"]').attr('content') || root.find('[data-automation-id="product-price"]').text(),
        url: link.attr('href'),
        image: image.attr('src'),
      });
      if (product) products.push(product);
    });
  }
  return [...new Map(products.map((product) => [product.itemId, product])).values()];
}

export async function fetchWalmartCatalog() {
  const results = [];
  for (const url of config.walmartTargetUrls) {
    const response = await axios.get(config.walmartScraperUrl, {
      params: {
        api_key: config.walmartScraperApiKey,
        url,
        render_js: 'true',
        premium_proxy: 'true',
        country_code: 'us',
      },
      headers: { Accept: 'text/html,application/json' },
      timeout: config.requestTimeoutMs,
    });
    results.push(...normalizeWalmartPayload(response.data));
    if (results.length >= config.maxCandidates) break;
  }
  return [...new Map(results.map((product) => [product.itemId, product])).values()]
    .slice(0, config.maxCandidates);
}

const airtableHeaders = () => ({ Authorization: `Bearer ${config.airtablePat}` });

export async function fetchActiveStudents() {
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
  const search = await axios.get('https://api.keepa.com/search', {
    params: { key: config.keepaApiKey, domain: config.keepaDomain, type: 'product', term: searchTerm },
    timeout: config.requestTimeoutMs,
  });
  const firstResult = search.data?.products?.[0] || search.data?.results?.[0];
  const asin = typeof firstResult === 'string' ? firstResult : firstResult?.asin;
  if (!asin) throw new Error('Keepa found no Amazon match');
  const detail = await axios.get('https://api.keepa.com/product', {
    params: {
      key: config.keepaApiKey,
      domain: config.keepaDomain,
      asin,
      stats: 30,
      buybox: 1,
      offers: 20,
    },
    timeout: config.requestTimeoutMs,
  });
  const product = detail.data?.products?.[0];
  if (!product) throw new Error('Keepa returned no product details');
  return product;
}

const keepaMoney = (value) => Number.isFinite(value) && value > 0 ? value / 100 : null;

export function calculateDeal(candidate, identification, product) {
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
  const identification = await identifyProduct(candidate);
  const product = await findKeepaProduct(identification.cleanSearchTerm);
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
    username: 'AMZ AI Student Sourcing',
    content: `Good morning ${student.name} — ${deals.length} unique candidate${deals.length === 1 ? '' : 's'} passed today’s automated profitability screen.`,
    embeds,
  };
}
