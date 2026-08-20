import axios from 'axios';

import {
  bestWalmartMatchForAmazonProduct,
  config,
  enrichWalmartCandidate,
  fetchSellerStorefrontAsins,
  fetchWalmartCatalog,
  hydrateKeepaProductsByAsin,
  isRetryableProviderError,
  jsonResponse,
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
  if (!['GET', 'POST'].includes(request.method)) return jsonResponse(response, 405, { error: 'Method not allowed' });
  const internalRequest = request.method === 'POST' && workerAuthorized(request);
  if (!internalRequest && config.cronSecret && request.headers.authorization !== `Bearer ${config.cronSecret}`) {
    return jsonResponse(response, 401, { error: 'Unauthorized' });
  }
  try {
    requireEnvironment(['KEEPA_API_KEY', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']);
    if (config.amazonTrackedSellers.length === 0) {
      return jsonResponse(response, 200, { ok: true, skipped: true, reason: 'No AMAZON_TRACKED_SELLERS configured' });
    }
    if (!config.storefrontDiscordWebhookUrl) throw new Error('STOREFRONT_DISCORD_WEBHOOK_URL is required');
    if (!config.scraperApiKey && !config.walmartScraperApiKey && !config.scrapingAntApiKey) {
      throw new Error('A Walmart scraper provider is required to search for matches');
    }

    const sellers = [];
    for (const { sellerId, label } of config.amazonTrackedSellers) {
      const seller = await fetchSellerStorefrontAsins(sellerId);
      if (!seller) {
        sellers.push({ sellerId, label, error: 'Seller not found or has no storefront data' });
        continue;
      }
      const seenKey = `storefront:seen:${sellerId}`;
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
      const products = await hydrateKeepaProductsByAsin(toCheck);
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
      for (const payload of payloads) await postDiscord(config.storefrontDiscordWebhookUrl, payload);

      sellers.push({
        sellerId,
        label,
        sellerName: seller.sellerName,
        newListings: newListings.length,
        qualifiedMatches: newListings.filter((listing) => listing.walmartMatch).length,
      });
    }
    return jsonResponse(response, 200, { ok: true, sellers });
  } catch (error) {
    console.error(JSON.stringify({ event: 'storefronts_failed', message: error.message }));
    return jsonResponse(response, 500, { ok: false, error: error.message });
  }
}
