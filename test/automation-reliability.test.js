import test from 'node:test';
import assert from 'node:assert/strict';
import { processStorefront } from '../lib/storefront-delivery.js';
import { recoverRun, runIsStalled } from '../lib/run-recovery.js';
import { guardedProviderRequest, permanentProviderFailure } from '../lib/provider-health.js';

function memory() {
  const data = new Map();
  return { data, async get(k) { return structuredClone(data.get(k) ?? null); },
    async mget(keys) { return Promise.all(keys.map((k) => this.get(k))); },
    async set(k, v, opts = {}) { if (opts.nx && data.has(k)) return false; data.set(k, structuredClone(v)); return true; },
    async releaseLock(k, token) { if (data.get(k) === token) data.delete(k); } };
}
function fixture() {
  const redis = memory();
  const sent = [];
  const options = { redis, store: { ownerKey: 'student', sellerId: 'SELLER', webhook: 'private' },
    fetchSeller: async () => ({ asinList: ['old'], sellerName: 'Seller' }),
    hydrate: async (asins) => asins.map((asin) => ({ asin })), blocked: () => false,
    payloads: (_, items) => items.length ? [{ items }] : [], send: async (_, p) => { sent.push(p); return { data: { id: 'receipt' } }; }, ttl: 1000 };
  return { options, redis, sent, key: 'storefront:state:student:SELLER' };
}
test('first snapshot is a baseline; listings beyond one chunk survive and deliver once', async () => {
  const { options, sent, redis, key } = fixture();
  await processStorefront(options);
  assert.equal(sent.length, 0);
  options.fetchSeller = async () => ({ asinList: ['old', ...Array.from({ length: 10 }, (_, i) => `new${i}`)] });
  assert.equal((await processStorefront(options)).pending, 6);
  assert.equal((await processStorefront(options)).pending, 2);
  assert.equal((await processStorefront(options)).pending, 0);
  await processStorefront(options);
  assert.equal(sent.length, 3);
  assert.equal((await redis.get(key)).delivered, 10);
});
test('hydration failure and explicit Discord rejection retain pending items', async () => {
  const { options, redis, key, sent } = fixture();
  await processStorefront(options);
  options.fetchSeller = async () => ({ asinList: ['old', 'new'] });
  const hydrate = options.hydrate;
  options.hydrate = async () => { throw new Error('Keepa unavailable'); };
  await assert.rejects(processStorefront(options));
  assert.deepEqual((await redis.get(key)).pending, ['new']);
  options.hydrate = hydrate;
  const send = options.send;
  options.send = async () => { throw { response: { status: 429 } }; };
  await assert.rejects(processStorefront(options));
  assert.equal((await redis.get(key)).outbox.status, 'prepared');
  options.send = send;
  await processStorefront(options);
  assert.equal(sent.length, 1);
});
test('ambiguous Discord outcome is visible and never automatically resent', async () => {
  const { options, redis, key, sent } = fixture();
  await processStorefront(options);
  options.fetchSeller = async () => ({ asinList: ['old', 'new'] });
  options.send = async () => { sent.push('accepted but timeout'); throw new Error('timeout'); };
  await assert.rejects(processStorefront(options));
  assert.equal((await processStorefront(options)).status, 'delivery_needs_review');
  assert.equal(sent.length, 1);
  assert.equal((await redis.get(key)).pending.length, 1);
});
test('concurrent workers cannot both deliver; legacy baseline is preserved', async () => {
  const { options, redis, sent } = fixture();
  await redis.set('storefront:seen:student:SELLER', ['old']);
  options.fetchSeller = async () => ({ asinList: ['old', 'new'] });
  const results = await Promise.allSettled([processStorefront(options), processStorefront(options)]);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  assert.equal(sent.length, 1);
});
test('missing hydration records do not silently discard new ASINs', async () => {
  const { options, redis, key } = fixture();
  await processStorefront(options);
  options.fetchSeller = async () => ({ asinList: ['new'] });
  options.hydrate = async () => [];
  await assert.rejects(processStorefront(options));
  assert.deepEqual((await redis.get(key)).pending, ['new']);
});
test('retry of a completed queue job does not consume another backlog chunk', async () => {
  const { options, sent } = fixture();
  await processStorefront(options);
  options.fetchSeller = async () => ({ asinList: ['old', 'a', 'b', 'c', 'd', 'e'] });
  options.jobId = 'cycle:5';
  assert.equal((await processStorefront(options)).pending, 1);
  assert.equal((await processStorefront(options)).pending, 1);
  assert.equal(sent.length, 1);
  options.jobId = 'cycle:4';
  assert.equal((await processStorefront(options)).pending, 0);
  assert.equal(sent.length, 2);
});
test('stale recovery cancels incomplete run honestly and unblocks tomorrow', async () => {
  const redis = memory();
  const meta = { createdAt: '2026-09-18T00:00:00Z', totalChunks: 3, keepaTokensPerMinute: 20 };
  await redis.set('run:r:meta', meta);
  await redis.set('run:r:chunk:0:complete', true);
  const result = await recoverRun({ redis, runId: 'r', now: Date.parse('2026-09-24'),
    config: { keepaTokensPerCandidate: 10, runTtlSeconds: 600000 }, publish: async () => assert.fail() });
  assert.equal(result.active, false);
  assert.equal(result.incompleteJobs, 2);
  assert.equal((await redis.get('run:r:cancelled')).reason, 'stalled_queue');
  assert.equal(await redis.get('run:r:finalized'), null);
});
test('slow queue or recent progress is not treated as stale', () => {
  const meta = { createdAt: '2026-09-24T00:00:00Z', totalChunks: 100, keepaTokensPerMinute: 1 };
  assert.equal(runIsStalled(meta, null, Date.parse('2026-09-24T08:00:00Z'), 10, 30), false);
  assert.equal(runIsStalled(meta, '2026-09-25T07:00:00Z', Date.parse('2026-09-25T08:00:00Z'), 10, 30), false);
});
test('fully completed run recovers lost finalize publication without rescraping', async () => {
  const redis = memory(); const jobs = [];
  await redis.set('run:r:meta', { totalChunks: 1 });
  await redis.set('run:r:chunk:0:complete', true);
  const result = await recoverRun({ redis, runId: 'r', config: { publicBaseUrl: 'https://example.com' }, publish: async (job) => jobs.push(job) });
  assert.equal(result.finalizationQueued, true);
  assert.equal(jobs[0].body.runId, 'r');
  assert.equal(await redis.get('run:r:completedChunks'), 1);
});
test('quota breaker avoids repeated calls and key rotation automatically bypasses old block', async () => {
  const redis = memory(); let calls = 0;
  const params = { redis, name: 'test', key: 'old', request: async () => { calls++; throw { response: { status: 403, data: 'monthly quota exhausted' } }; } };
  await assert.rejects(guardedProviderRequest(params));
  await assert.rejects(guardedProviderRequest(params));
  assert.equal(calls, 1);
  assert.equal(await guardedProviderRequest({ ...params, key: 'new', request: async () => 'ok' }), 'ok');
  assert.equal(permanentProviderFailure({ response: { status: 403, data: 'Concurrent request limit reached' } }), null);
  assert.equal(permanentProviderFailure({ response: { status: 429, data: 'Try again later' } }), null);
});
