// A delayed low-token run is not a stalled run. Include the full expected
// detail + analysis queue duration before the six-hour inactivity allowance.
export function runIsStalled(meta, lastProgress, now, tokensPerCandidate, detailSpacing) {
  const created = Date.parse(meta.createdAt);
  if (!Number.isFinite(created)) return false;
  const duration = (Number(meta.initialDelaySeconds || 0)
    + Number(meta.totalChunks || 0) * (detailSpacing
      + tokensPerCandidate / Math.max(1, Number(meta.keepaTokensPerMinute || 1)) * 60)) * 1000;
  const progress = Date.parse(lastProgress || meta.createdAt);
  return now > created + duration + 6 * 3600000
    && now - (Number.isFinite(progress) ? progress : created) > 6 * 3600000;
}

export async function recoverRun({ redis, runId, config, publish, now = Date.now() }) {
  const prefix = `run:${runId}`;
  const [meta, finalized, cancelled, lastProgress] = await redis.mget([
    `${prefix}:meta`, `${prefix}:finalized`, `${prefix}:cancelled`, `${prefix}:lastProgress`,
  ]);
  if (!meta || finalized || cancelled) return { active: false };
  const total = Number(meta.totalChunks || 0);
  const completions = await redis.mget(Array.from({ length: total }, (_, i) => `${prefix}:chunk:${i}:complete`));
  const completed = completions.filter(Boolean).length;
  // Reconcile a crash between setting a chunk completion and incrementing its
  // aggregate only when all jobs are done; never race active increments.
  if (total > 0 && completed === total) {
    await redis.set(`${prefix}:completedChunks`, completed, { ex: config.runTtlSeconds });
    await publish({ url: `${config.publicBaseUrl}/api/finalize`, body: { runId },
      deduplicationId: `${runId}-recover-finalize-${Math.floor(now / 3600000)}` });
    return { active: true, finalizationQueued: true, completed, total };
  }
  if (!runIsStalled(meta, lastProgress, now, config.keepaTokensPerCandidate,
    Math.max(20, config.walmartDetailJobSpacingSeconds || 20))) return { active: true, completed, total };
  const reason = { at: new Date(now).toISOString(), reason: 'stalled_queue',
    message: 'Stopped after expected queue duration plus six hours without progress. Incomplete work is not a no-deals result.',
    completedJobs: completed, incompleteJobs: total - completed };
  await redis.set(`${prefix}:cancelled`, reason, { nx: true, ex: config.runTtlSeconds });
  return { active: false, recovered: true, ...reason };
}
