# Automation reliability

The daily schedules remain 13:00 UTC for sourcing, 19:00 UTC for storefronts,
and 16:00 UTC for order-email tracking. These are 6 AM, noon and 9 AM in PDT;
one hour earlier in PST. No new scheduler, billable service or cron was added.

## Storefront notifications

- The scheduled endpoint now dispatches an independent QStash worker per
  subscription. It does not scrape Walmart or require scraper credits.
- Each subscription has a persistent Redis state, backlog and outbox under
  `storefront:state:<student-id>:<seller-id>`. Portal and Discord registrations
  use the same Airtable student identity. Existing per-user snapshots are
  imported as baselines; old, potentially shared null-owner snapshots are not.
- New subscriptions baseline their current catalog. Alerts begin with subsequent
  new ASINs in Keepa's snapshot. Keepa data may lag Amazon; no live-refresh SLA.
- Workers hydrate and send at most four ASINs per message. Each daily cycle is
  bounded by the configured listing allowance, rounded up to a four-item batch.
  Excess stays pending for subsequent cycles. Missing Keepa records never vanish.
- Explicit Discord 4xx failures keep a retryable outbox. A timeout or 5xx may
  have posted: that outbox stops in `delivery_needs_review` instead of guessing
  and posting a duplicate. An operator must inspect the destination channel
  before reconciling it. Exactly-once delivery cannot be guaranteed across an
  external webhook and Redis, but ambiguous requests are never blindly resent.
- Existing brand exclusions remain. AI sourcing still uses only opted-in
  sourcing recipients, not all spy-tool student channels.
- Admin-authorized `GET /api/storefronts?task=health` reports subscription health
  without exposing webhook credentials. `GET /api/storefronts` dispatches work.
- Alerts lost before this change cannot reliably be reconstructed from the old
  seen snapshot. Do not replay entire historical catalogs into student channels.

## Sourcing recovery

- Every new sourcing request checks prior runs. A run is stale only after its
  estimated detail/Keepa queue duration plus six hours, and six hours without
  progress. A slow one-token/minute queue is not immediately cancelled.
- Stale runs are cancelled with preserved errors/results and an explicit count
  of unfinished jobs. They are not represented as successful zero-deal scans.
- Completed runs whose finalization publish was lost get a new finalize job.
- Chunk completion and its counter increment are now one Redis transaction.
- Admin-authorized `POST /api/cron` with `{"task":"recover"}` runs maintenance
  without starting a new scrape. It may enqueue finalization for complete runs.
- Known quota/authentication failures open a six-hour per-provider circuit
  breaker, preventing repeated calls with the same rejected key. Rotation uses
  a new hashed key namespace automatically. Concurrency-limit failures do not
  get treated as depleted monthly credits. This does not refill an account.
- `/api/admin` reports the last sourcing attempt and known provider blocks.
  The dashboard displays failures rather than implying profitable products
  were simply unavailable. Unknown/unblocked health is not a quota guarantee.

Run regression checks with:

```sh
npm run check
node --test --test-concurrency=1 test/platform.test.js test/discord.test.js test/email-tracking.test.js test/automation-reliability.test.js
```
