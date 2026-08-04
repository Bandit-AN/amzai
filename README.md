# Syndicate AI Multi-Tenant OA Prototype

A queued Walmart-to-Amazon sourcing pipeline for 1–10 students. It targets up to 10 strictly unique candidate deals per student each morning; it never weakens filters or duplicates a deal to fill an undersupplied digest.

## Pipeline

```text
Vercel cron
  → scrape configured Walmart pages once
  → QStash analysis jobs (one candidate each, token-rate staggered)
  → Redis qualified-deal pool
  → one allocation job (strict daily uniqueness)
  → QStash delivery job per student
  → private Discord webhooks
```

Splitting work prevents one long HTTP execution from owning the whole run and gives each chunk independent retries. It does not bypass Vercel account usage, scraper credits, Gemini usage, or Keepa tokens.

The prototype defaults to `KEEPA_TOKENS_PER_MINUTE=1` and a conservative budget of `12` tokens per candidate: approximately 10 for keyword search, one for product details, and one token of safety margin. Before queueing, it reads Keepa's token balance without spending a token and delays the first job long enough to recover any deficit. QStash then spaces candidates about 12 minutes apart. Product lookup intentionally excludes Keepa's optional offers payload because the profitability calculator does not consume it and it can add substantial token cost. When Keepa is upgraded, set `KEEPA_TOKENS_PER_MINUTE=20`; spacing automatically drops to about 36 seconds without a code change.

## Airtable setup

Create a table named `Students` with these exact fields:

| Field | Airtable type | Required |
|---|---|---|
| `Name` | Single line text | Yes |
| `Email` | Email | Optional |
| `Status` | Single select (`Active`, `Inactive`) | Yes |
| `Discord Webhook URL` | URL | Yes |
| `Username` | Single line text | Yes for portal login |
| `Password Hash` | Long text | Yes for portal login; never store plaintext passwords |
| `Onboarding Complete` | Checkbox | Optional |
| `Minimum ROI` | Number | Optional; defaults to platform value |
| `Minimum Monthly Sales` | Number | Optional; defaults to platform value |
| `Maximum Cost` | Currency | Optional |
| `Excluded Brands` | Long text | Optional |

Create a scoped Airtable personal access token with `data.records:read` and `data.records:write` access to this base. The portal writes only student sourcing preferences and onboarding status. Discord webhooks remain admin-managed and are never returned to the browser.

Generate a student's password hash locally without placing the password in shell history:

```bash
read -s STUDENT_PASSWORD
export STUDENT_PASSWORD
npm run hash-password
unset STUDENT_PASSWORD
```

Paste the resulting `pbkdf2$...` value into Airtable's `Password Hash` field. Store the student's chosen username in `Username`. Never place the plaintext password in Airtable.

## Services and environment

Copy `.env.example` to `.env` and set the same variables in Vercel for Production, Preview, and Development.

- ScrapingBee: one platform key and a comma-separated set of Walmart URLs. Add category and pagination URLs to grow the candidate pool without asking students for scraper keys.
- Gemini: one platform key used only to normalize product identity.
- Keepa: one platform key used for catalog matching, live price/history fields, and a monthly-sales signal.
- Airtable: student roster and preferences.
- Upstash QStash: durable fan-out and retry delivery.
- `QSTASH_URL`: use the regional endpoint matching the token shown in the QStash console (`https://qstash-us-east-1.upstash.io` for US or `https://qstash.upstash.io` for EU).
- Upstash Redis: temporary run/chunk/results state with a default 48-hour TTL.
- `PUBLIC_BASE_URL`: the production Vercel origin, without a trailing slash.
- `CRON_SECRET`: Vercel sends this to the cron endpoint as a bearer token.
- `WORKER_SECRET`: a separate random secret QStash forwards to internal endpoints.
- `PORTAL_SESSION_SECRET`: a third random secret used only to sign 12-hour student login cookies.
- `ONBOARDING_VIDEO_URL`: an embeddable HTTPS video URL; leave blank to show the branded placeholder.
- `KEEPA_TOKENS_PER_MINUTE`: the refill rate shown by Keepa; this controls QStash spacing.
- `KEEPA_SEARCH_RESULTS`: number of Amazon candidates evaluated per Walmart product; defaults to `5`.
- `KEEPA_ESTIMATED_TOKENS_PER_CANDIDATE`: conservative budget for one keyword search plus five product details; defaults to `15`.
- `WALMART_RENDER_JS=true` with `WALMART_PREMIUM_PROXY=false`: uses the verified 5-credit page request and automatically retries once with a premium US proxy only for blocking or temporary upstream failures.
- `STUDENT_CACHE_SECONDS`: Redis cache lifetime for the active Airtable roster; defaults to 15 minutes.
- `PRODUCT_COOLDOWN_SECONDS`: unchanged-product and delivered-ASIN cooldown; defaults to 30 days.
- `WALMART_PAGES_PER_RUN` and `WALMART_MAX_PAGE`: rotate a fixed-size page window through the Walmart catalog without increasing daily scraper requests.
- `ANALYSIS_BATCH_SIZE`: number of ranked candidates released per Keepa wave; defaults to 50.

`WALMART_TARGET_URLS` may contain multiple comma- or newline-separated category/page URLs. Results are merged and deduplicated by Walmart item ID before the run limit is applied.

Generate secrets locally:

```bash
openssl rand -hex 32
```

## Qualification and allocation

The platform screens for ROI ≥ 50% and estimated monthly sales ≥ 200 by default. Estimated profit subtracts Walmart cost, Keepa's available FBA pick/pack fee, referral percentage, and `PER_ITEM_FEE_BUFFER`. These are estimates, not purchase advice.

Before calculating ROI, explicit count, pack, weight, and volume values in the Walmart and Amazon titles must agree. Known mismatches such as Walmart `32 Count` versus Amazon `96 ct` are rejected. Products whose titles omit comparable quantity information still require manual listing verification.

Completed Walmart item/title/price combinations are cached for seven days, so unchanged listings do not repeatedly consume Gemini and Keepa. A price or title change produces a new fingerprint and is eligible immediately. Successfully delivered Amazon ASINs are also suppressed for seven days across runs.

Candidates are ranked before Keepa using available clearance discount, UPC/GTIN presence, explicit quantity information, practical OA price bands, and category heuristics. Variation-heavy, oversized, and perishable listings are deprioritized. The configured ROI threshold is the gross Amazon-versus-Walmart price spread before fees; estimated fees and net profit are displayed for manual review but do not control qualification. Keepa work is released in waves; if strict allocation can already fill every active student's target, later waves are not published.

Walmart runs rotate through the retailer-filtered Savings, Clearance, New Deals, and Trending Deals feeds before moving to the next six-page block within a feed. Only one six-page feed window is scraped per run, keeping ScrapingBee usage bounded while reducing repeated inventory.

Keepa does **not** verify intellectual-property complaint risk or whether a particular Amazon seller account is eligible to sell an ASIN. Every Discord card therefore carries a prominent manual IP/eligibility warning. `BLOCKED_BRANDS` provides only an admin-maintained preliminary exclusion list.

The finalizer deduplicates by ASIN, ranks qualified deals, rotates the student order deterministically per run, and assigns every deal to at most one student. Student ROI, sales, maximum-cost, and excluded-brand preferences are enforced during allocation. If fewer deals qualify, students receive fewer than 10.

## Run locally

Use Node 20.18.1 or newer:

```bash
npm install
npm test
npm run check
npx vercel dev
```

QStash requires publicly reachable worker URLs, so a complete queue test needs a deployed Preview/Production URL or a secure tunnel. Trigger the production cron manually with:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" "$PUBLIC_BASE_URL/api/cron"
```

Run a smaller authenticated smoke test without changing the daily production limit:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" "$PUBLIC_BASE_URL/api/cron?limit=3"
```

Check a run without exposing student credentials:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "$PUBLIC_BASE_URL/api/status?runId=YOUR_RUN_ID"
```

The production cron is configured for `13:00 UTC` daily (6:00 AM Pacific during daylight saving time and 5:00 AM Pacific during standard time). Vercel cron schedules are UTC and only invoke production deployments.
If a manual or scheduled sourcing run is still analyzing, a new cron invocation returns `409` with the active run ID instead of creating an overlapping Keepa queue.

## Scale expectations

Ten students receiving ten strictly unique deals requires 100 qualified products. At a 1% qualification rate, that implies roughly 10,000 raw candidates; at 2%, roughly 5,000. Measure every stage before increasing source coverage and token budgets. A paid student product is commercial; treat free service tiers as prototype allowances rather than a permanent cost model.

The sustainable prototype configuration uses six Walmart pages once daily and a 300-candidate hard cap. At five ScrapingBee credits per standard JavaScript-rendered page, that is about 900 credits per 30-day month. The hard cap leaves substantial room under QStash's 1,000-message daily free allowance for finalization, Discord delivery, and retries. Do not increase the page count or daily frequency without reviewing current ScrapingBee, QStash, Redis, Gemini, Keepa, and Vercel usage dashboards.
