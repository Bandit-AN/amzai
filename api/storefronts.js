import axios from 'axios';

import {
  bestWalmartMatchForAmazonProduct,
  config,
  enrichWalmartCandidate,
  fetchActiveStudents,
  fetchPortalStudentByEmail,
  fetchSellerStorefrontAsins,
  fetchWalmartCatalog,
  hydrateKeepaProductsByAsin,
  isBlockedStorefrontBrand,
  isRetryableProviderError,
  jsonResponse,
  readJsonBody,
  readPortalIdentity,
  redis,
  requireEnvironment,
  storefrontDiscordPayloads,
  verifyExactProductMatch,
  walmartSearchUrl,
  workerAuthorized,
} from '../lib/platform.js';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function postDiscord(webhook, payload) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await axios.post(webhook, payload, { timeout: config.requestTimeoutMs });
    } catch (error) {
      if (error.response?.status !== 429 || attempt === 4) throw error;
      const retryAfterSeconds = Number(error.response?.data?.retry_after || 1);
      await wait(Math.max(250, Math.ceil(retryAfterSeconds * 1000)));
    }
  }
  throw new Error('Discord delivery retries exhausted');
}

const storefrontTableUrl = () => `${config.supabaseUrl}/rest/v1/student_storefronts`;
const bearerToken = (request) => String(request.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
const supabaseHeaders = (token) => ({
  apikey: config.supabaseAnonKey,
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

function normalizedSellerId(value) {
  const raw = String(value || '').trim();
  let candidate = raw;
  try {
    const url = new URL(raw);
    candidate = url.searchParams.get('seller') || url.searchParams.get('me') || url.pathname.split('/').filter(Boolean).at(-1) || '';
  } catch {}
  candidate = candidate.trim().toUpperCase();
  if (!/^[A-Z0-9]{6,32}$/.test(candidate)) {
    throw new Error('Enter a valid Amazon seller ID or storefront URL containing seller=');
  }
  return candidate;
}

async function handleStudentStorefronts(request, response, identity) {
  if (identity.type !== 'supabase') {
    return jsonResponse(response, 403, { error: 'Sign in with Google to manage storefronts' });
  }
  const token = bearerToken(request);
  const headers = supabaseHeaders(token);
  const student = await fetchPortalStudentByEmail(identity.email);
  if (!student) return jsonResponse(response, 403, { error: 'This Google email is not an active Seller Syndicate student' });
  // A student may enroll and add stores in Discord before their first portal
  // login. Claim those rows on first Google-authenticated portal use.
  if (config.supabaseServiceRoleKey) {
    await axios.patch(storefrontTableUrl(), {
      user_id: identity.userId,
      airtable_student_id: student.id,
    }, {
      headers: {
        apikey: config.supabaseServiceRoleKey,
        Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
        'Content-Type': 'application/json',
      },
      params: { owner_email: `eq.${identity.email}`, user_id: 'is.null' },
      timeout: config.requestTimeoutMs,
    });
  }
  if (request.method === 'GET') {
    const result = await axios.get(storefrontTableUrl(), {
      headers,
      params: { select: 'id,seller_id,label,created_at', order: 'created_at.desc' },
      timeout: config.requestTimeoutMs,
    });
    return jsonResponse(response, 200, { ok: true, storefronts: result.data || [] });
  }
  if (request.method === 'POST') {
    const body = await readJsonBody(request);
    const sellerId = normalizedSellerId(body.sellerId || body.url);
    const label = String(body.label || '').trim().slice(0, 80);
    const result = await axios.post(storefrontTableUrl(), [{
      user_id: identity.userId,
      airtable_student_id: student.id,
      owner_email: identity.email,
      seller_id: sellerId,
      label,
    }], {
      headers: { ...headers, Prefer: 'return=representation' },
      timeout: config.requestTimeoutMs,
    });
    return jsonResponse(response, 201, { ok: true, storefront: result.data?.[0] });
  }
  if (request.method === 'DELETE') {
    const body = await readJsonBody(request);
    const id = String(body.id || request.query?.id || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid storefront entry');
    await axios.delete(storefrontTableUrl(), {
      headers,
      params: { id: `eq.${id}` },
      timeout: config.requestTimeoutMs,
    });
    return jsonResponse(response, 200, { ok: true });
  }
  return jsonResponse(response, 405, { error: 'Method not allowed' });
}

async function configuredStorefronts() {
  const tracked = [];
  if (config.supabaseUrl && config.supabaseServiceRoleKey) {
    const response = await axios.get(storefrontTableUrl(), {
      headers: {
        apikey: config.supabaseServiceRoleKey,
        Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
      },
      params: { select: 'id,user_id,owner_email,seller_id,label' },
      timeout: config.requestTimeoutMs,
    });
    const students = await fetchActiveStudents({ fresh: true });
    const byEmail = new Map(students.map((student) => [student.email, student]));
    for (const row of response.data || []) {
      const student = byEmail.get(String(row.owner_email || '').trim().toLowerCase());
      if (!student) continue;
      tracked.push({
        ownerKey: row.user_id,
        ownerEmail: row.owner_email,
        sellerId: row.seller_id,
        label: row.label || row.seller_id,
        webhook: student.discordWebhookUrl,
      });
    }
  }
  for (const entry of config.amazonTrackedSellers) {
    tracked.push({ ...entry, ownerKey: 'legacy', webhook: config.storefrontDiscordWebhookUrl });
  }
  return tracked;
}

function amazonImageUrl(product) {
  const firstImage = String(product.imagesCSV || '').split(',')[0]?.trim();
  return firstImage ? `https://m.media-amazon.com/images/I/${firstImage}` : null;
}

function amazonPriceDollars(product) {
  const current = product.stats?.current || [];
  const cents = [product.stats?.buyBoxPrice, current[18], current[10], current[1], current[0]]
    .find((value) => Number.isFinite(value) && value > 0);
  return Number.isFinite(cents) ? cents / 100 : null;
}

// Only the top few search results get the expensive per-item detail-page
// re-fetch (search cards don't carry a UPC, only detail pages do) — Walmart's
// own search relevance ranking is the filter that keeps this bounded.
async function findWalmartMatch(product) {
  const searchTerm = product.title ? product.title.split(' ').slice(0, 8).join(' ') : product.asin;
  const rawCandidates = await fetchWalmartCatalog(20, [walmartSearchUrl(searchTerm)]);
  const enriched = [];
  for (const candidate of rawCandidates.slice(0, 3)) {
    const detail = await enrichWalmartCandidate(candidate);
    if (detail.detailVerified && detail.upc) enriched.push(detail);
  }
  const best = bestWalmartMatchForAmazonProduct(product, enriched);
  if (!best) return null;
  if (best.roi < config.minimumRoi) return null;
  if (best.estimatedProfit <= config.minimumEstimatedProfit) return null;
  if (best.estimatedMonthlySales < config.minimumMonthlySales) return null;
  const verification = await verifyExactProductMatch(best, best);
  return verification.exactMatch ? best : null;
}

export default async function handler(request, response) {
  if (!['GET', 'POST', 'DELETE'].includes(request.method)) return jsonResponse(response, 405, { error: 'Method not allowed' });
  const portalIdentity = await readPortalIdentity(request);
  if (portalIdentity) {
    try { return await handleStudentStorefronts(request, response, portalIdentity); }
    catch (error) {
      const message = error.response?.data?.message || error.response?.data?.details || error.message;
      const status = error.response?.status === 409 ? 409 : 400;
      return jsonResponse(response, status, { ok: false, error: message });
    }
  }
  const internalRequest = request.method === 'POST' && workerAuthorized(request);
  if (!internalRequest && config.cronSecret && request.headers.authorization !== `Bearer ${config.cronSecret}`) {
    return jsonResponse(response, 401, { error: 'Unauthorized' });
  }
  try {
    requireEnvironment(['KEEPA_API_KEY', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']);
    const trackedStorefronts = await configuredStorefronts();
    if (trackedStorefronts.length === 0) {
      return jsonResponse(response, 200, { ok: true, skipped: true, reason: 'No student storefronts configured' });
    }
    if (!config.scraperApiKey && !config.walmartScraperApiKey && !config.scrapingAntApiKey) {
      throw new Error('A Walmart scraper provider is required to search for matches');
    }

    const sellers = [];
    const sellerCache = new Map();
    for (const { sellerId, label, ownerKey, ownerEmail, webhook } of trackedStorefronts) {
      if (!webhook) {
        sellers.push({ sellerId, label, ownerEmail, error: 'Student Discord webhook is not configured' });
        continue;
      }
      if (!sellerCache.has(sellerId)) sellerCache.set(sellerId, await fetchSellerStorefrontAsins(sellerId));
      const seller = sellerCache.get(sellerId);
      if (!seller) {
        sellers.push({ sellerId, label, error: 'Seller not found or has no storefront data' });
        continue;
      }
      const seenKey = `storefront:seen:${ownerKey}:${sellerId}`;
      const previouslySeen = new Set(await redis.get(seenKey) || []);
      const isFirstRun = previouslySeen.size === 0;
      const newAsins = seller.asinList.filter((asin) => !previouslySeen.has(asin));
      // Persist the full current catalog regardless, so the next run's diff
      // reflects what's really there even when nothing new was found today.
      await redis.set(seenKey, seller.asinList, { ex: config.productCooldownSeconds * 12 });

      if (isFirstRun) {
        // A brand-new tracked seller's entire existing catalog would all
        // read as "new" — baseline it instead of alerting on all of it.
        sellers.push({
          sellerId, label, sellerName: seller.sellerName, baseline: true, catalogSize: seller.asinList.length,
        });
        continue;
      }
      if (newAsins.length === 0) {
        sellers.push({ sellerId, label, sellerName: seller.sellerName, newListings: 0 });
        continue;
      }

      const toCheck = newAsins.slice(0, config.storefrontNewListingsPerRunLimit);
      const hydrated = await hydrateKeepaProductsByAsin(toCheck);
      const blockedCount = hydrated.filter(isBlockedStorefrontBrand).length;
      const products = hydrated.filter((product) => !isBlockedStorefrontBrand(product));
      const newListings = [];
      for (const product of products) {
        let walmartMatch = null;
        try {
          walmartMatch = await findWalmartMatch(product);
        } catch (error) {
          if (isRetryableProviderError(error)) throw error;
          console.error(JSON.stringify({
            event: 'storefront_walmart_search_failed', sellerId, asin: product.asin, message: error.message,
          }));
        }
        newListings.push({
          asin: product.asin,
          amazonTitle: product.title || product.asin,
          amazonUrl: `https://www.amazon.com/dp/${product.asin}`,
          amazonPrice: amazonPriceDollars(product),
          imageUrl: amazonImageUrl(product),
          walmartMatch,
        });
      }

      const payloads = storefrontDiscordPayloads(seller.sellerName || label, newListings);
      for (const payload of payloads) await postDiscord(webhook, payload);

      sellers.push({
        sellerId,
        label,
        sellerName: seller.sellerName,
        newListings: newListings.length,
        qualifiedMatches: newListings.filter((listing) => listing.walmartMatch).length,
        blockedBrandListings: blockedCount,
      });
    }
    return jsonResponse(response, 200, { ok: true, sellers });
  } catch (error) {
    console.error(JSON.stringify({ event: 'storefronts_failed', message: error.message }));
    return jsonResponse(response, 500, { ok: false, error: error.message });
  }
}
