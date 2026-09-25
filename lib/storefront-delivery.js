import { randomUUID } from 'node:crypto';

// All transitions happen under a per-subscription lease. Persist pending ASINs
// before advancing the snapshot: failures must never turn unsent items into seen.
export async function processStorefront({ store, redis, fetchSeller, hydrate, blocked,
  payloads, send, ttl, jobId, now = () => new Date().toISOString() }) {
  const key = `storefront:state:${store.ownerKey}:${store.sellerId}`;
  const lock = `${key}:lock`;
  const token = randomUUID();
  if (!await redis.set(lock, token, { nx: true, ex: 180 })) {
    throw new Error('Storefront subscription is already processing');
  }
  const save = (state) => redis.set(key, state); // Durable backlog, no expiring outbox.
  let state;
  const finish = async (result) => {
    if (jobId) state.jobResults = Object.fromEntries(
      [...Object.entries(state.jobResults || {}), [jobId, result]].slice(-100),
    );
    await save(state);
    return result;
  };
  try {
    state = await redis.get(key);
    if (!state) {
      const legacy = await redis.get(`storefront:seen:${store.legacyOwnerKey || store.ownerKey}:${store.sellerId}`);
      state = { initialized: legacy !== null, seen: legacy || [], pending: [], delivered: 0 };
    }
    if (jobId && state.jobResults?.[jobId]) return state.jobResults[jobId];
    // A timeout after Discord accepted a message is ambiguous. Do not resend
    // blindly. Expose it for reconciliation; confirmed failures are retryable.
    if (state.outbox?.status === 'sending' || state.outbox?.status === 'unknown') {
      state.status = 'delivery_needs_review';
      await save(state);
      return { status: state.status, pending: state.pending.length };
    }
    if (!state.pending.length && !state.outbox) {
      const seller = await fetchSeller(store.sellerId);
      if (!seller || !Array.isArray(seller.asinList)) throw new Error('No Keepa storefront snapshot available');
      const current = [...new Set(seller.asinList)];
      const seen = new Set(state.seen);
      state.pending = state.initialized ? current.filter((asin) => !seen.has(asin)) : [];
      state.seen = [...new Set([...state.seen, ...current])];
      state.initialized = true;
      state.sellerName = seller.sellerName || store.label;
      state.checkedAt = now();
      state.status = state.pending.length ? 'pending' : 'up_to_date';
      state.error = null;
      await save(state);
      // Compatibility for existing readers; delivery does not depend on it.
      await redis.set(`storefront:seen:${store.ownerKey}:${store.sellerId}`, state.seen, { ex: ttl });
    }
    if (!state.pending.length && !state.outbox) return finish({ status: state.status, pending: 0 });
    if (!state.outbox) {
      const asins = state.pending.slice(0, 4);
      const products = await hydrate(asins);
      const byAsin = new Map(products.map((product) => [product.asin, product]));
      if (asins.some((asin) => !byAsin.has(asin))) throw new Error('Keepa omitted pending ASINs; backlog retained');
      const listings = asins.map((asin) => byAsin.get(asin)).filter((product) => !blocked(product)).map((product) => {
        const current = product.stats?.current || [];
        const cents = [product.stats?.buyBoxPrice, current[18], current[10], current[1], current[0]]
          .find((value) => Number.isFinite(value) && value > 0);
        const image = String(product.imagesCSV || '').split(',')[0];
        return { asin: product.asin, amazonTitle: product.title || product.asin,
          amazonUrl: `https://www.amazon.com/dp/${product.asin}`,
          amazonPrice: cents ? cents / 100 : null,
          imageUrl: image ? `https://m.media-amazon.com/images/I/${image}` : null,
          walmartMatch: null };
      });
      state.outbox = { id: randomUUID(), asins, count: listings.length,
        payload: payloads(state.sellerName || store.label, listings)[0] || null, status: 'prepared' };
      await save(state);
    }
    const outbox = state.outbox;
    if (outbox.status !== 'sent' && outbox.payload) {
      outbox.status = 'sending';
      state.status = 'delivering';
      await save(state);
      let receipt;
      try { receipt = await send(store.webhook, outbox.payload); }
      catch (error) {
        const code = Number(error.response?.status);
        // Only explicit 4xx rejection is known not to have posted. Network
        // failures and 5xx may have happened after acceptance.
        outbox.status = code >= 400 && code < 500 ? 'prepared' : 'unknown';
        state.status = outbox.status === 'unknown' ? 'delivery_needs_review' : 'delivery_failed';
        state.error = code ? `Discord HTTP ${code}` : 'Discord delivery outcome unknown';
        await save(state);
        throw new Error(state.error);
      }
      outbox.status = 'sent';
      outbox.messageId = receipt?.data?.id || null;
      await save(state);
    }
    state.pending = state.pending.filter((asin) => !outbox.asins.includes(asin));
    state.delivered += outbox.count;
    if (outbox.payload) state.lastDelivery = { at: now(), messageId: outbox.messageId, asins: outbox.asins };
    state.outbox = null;
    state.error = null;
    state.status = state.pending.length ? 'pending' : 'up_to_date';
    return finish({ status: state.status, delivered: outbox.count, pending: state.pending.length });
  } catch (error) {
    // Do not serialize Axios errors: request URLs can contain credentials.
    if (state && !['delivery_needs_review', 'delivery_failed'].includes(state.status)) {
      state.status = 'failed';
      state.error = 'Storefront lookup or persistence failed; pending listings retained';
      await save(state).catch(() => {});
    }
    throw error;
  } finally { await redis.releaseLock(lock, token).catch(() => {}); }
}
