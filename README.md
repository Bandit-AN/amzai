# Syndicate AI Multi-Tenant OA Prototype

A queued Walmart-to-Amazon sourcing pipeline for 1–10 students. It targets up to 10 strictly unique candidate deals per student each morning; it never weakens filters or duplicates a deal to fill an undersupplied digest.

## Pipeline

```text
Vercel cron
  → discover candidates on broad Walmart pages
  → QStash detail jobs verify the exact Walmart item, UPC, variant, price, seller, and stock
  → products without provable identity go to manual review
  → UPC-only Keepa jobs (one verified candidate each, token-rate staggered)
  → strict variant, quantity, economics, and sales checks
  → Redis qualified-deal pool
  → one allocation job (strict daily uniqueness)
  → QStash delivery job per student
  → private Discord webhooks
```

Splitting work prevents one long HTTP execution from owning the whole run and gives each chunk independent retries. It does not bypass Vercel account usage, scraper credits, Gemini usage, or Keepa tokens.

The code defaults to `KEEPA_TOKENS_PER_MINUTE=1` and reserves a conservative `15` tokens per UPC search plus product details. Before queueing, it reads Keepa's token balance without spending a token and delays work long enough to recover any deficit. Set `KEEPA_TOKENS_PER_MINUTE=20` for the upgraded plan; spacing automatically adjusts. Product lookup excludes Keepa's optional offers payload because the profitability calculator does not use it and it can add substantial token cost.

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
- Gemini: one platform key used only after UPC confirmation to normalize and adjudicate exact product identity.
- Keepa: one platform key used for UPC-first Amazon matching, live price/history fields, and a monthly-sales signal.
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
- `WALMART_DETAIL_LOOKUP_LIMIT`: maximum individual Walmart product pages verified per run; defaults to `50` and is capped at `100`.
- `MAXIMUM_WALMART_BUY_COST`: global Walmart buy-cost ceiling applied before Gemini and Keepa; defaults to `$150`.
- `WALMART_RENDER_JS=true` with `WALMART_PREMIUM_PROXY=false`: uses the verified 5-credit page request and automatically retries once with a premium US proxy only for blocking or temporary upstream failures.
- `STUDENT_CACHE_SECONDS`: Redis cache lifetime for the active Airtable roster; defaults to 15 minutes.
- `PRODUCT_COOLDOWN_SECONDS`: unchanged-product and delivered-ASIN cooldown; defaults to 30 days.
- `WALMART_PAGES_PER_RUN` and `WALMART_MAX_PAGE`: rotate a fixed-size page window through the Walmart catalog without increasing daily scraper requests.

`WALMART_TARGET_URLS` may contain multiple comma- or newline-separated category/page URLs. Results are merged and deduplicated by Walmart item ID before the run limit is applied.

Generate secrets locally:

```bash
openssl rand -hex 32
```

## Qualification and allocation

The platform screens for gross price spread ≥ 60% and estimated monthly sales ≥ 200 by default. Estimated profit subtracts Walmart cost, Keepa's available FBA pick/pack fee, referral percentage, and `PER_ITEM_FEE_BUFFER`, and must be greater than $1 by default. These are estimates, not purchase advice.

Broad Walmart pages are discovery only. Before Keepa is called, an individual product page must prove the exact Walmart item ID, selected variant, UPC/GTIN, current price, and online availability. Missing UPCs, unavailable products, and unprovable variants go to the manual-review queue and can never reach Discord automatically. Keepa is searched by UPC, and the returned ASIN must expose the same UPC/EAN.

Before calculating ROI, explicit count, pack, weight, volume, voltage, model, color, condition, named style, and fragrance flanker values must agree. Known mismatches such as Walmart `32 Count` versus Amazon `96 ct`, `Man Ice` versus `Man Intense`, or one Fuggler character versus another are rejected. Fragrances are allowed only when the UPC and named flanker agree.

Completed Walmart item/title/price combinations are cached for seven days, so unchanged listings do not repeatedly consume Gemini and Keepa. A price or title change produces a new fingerprint and is eligible immediately. Successfully delivered Amazon ASINs are also suppressed for seven days across runs.

Candidates are ranked before detail verification using available clearance discount, explicit quantity information, and practical OA price bands. Variation-heavy, oversized, and perishable listings are deprioritized, but they are not category-banned. The mandatory ROI threshold is at least 60% gross Amazon-versus-Walmart price spread before fees; Airtable may raise but cannot lower it. Estimated net profit after available Keepa fees and the configured buffer must also be strictly greater than `MINIMUM_ESTIMATED_PROFIT`, which defaults to $1.

Qualified-deal ranking caps the benefit of gross spread at 75%, so implausible 200%–300% spreads cannot dominate solid products near the threshold. Sales velocity remains part of ranking.

Walmart runs rotate through retailer-filtered Savings, Clearance, New Deals, Trending Deals, and broad department searches before moving deeper within a source. Historical winners do not niche or bias discovery toward those specific brands.

`WALMART_EXCLUDED_BRANDS` removes configured Walmart private-label products after page extraction but before Gemini, Keepa, and QStash work. `BLOCKED_BRANDS` applies the same early exclusion to restricted national brands. LEGO, Barbie, Monster High, Apple, and Bissell are always blocked; configured values extend that list. These filters save downstream usage, though the source pages must still be downloaded by the scraper.

When `SCRAPERAPI_KEY` is configured, Walmart pages use ScraperAPI with US routing. Walmart's embedded product JSON currently works without browser rendering, so `SCRAPERAPI_RENDER_JS=false` is the faster, lower-credit default. ScrapingBee remains a compatibility fallback when its key is also present.

Keepa does **not** verify intellectual-property complaint risk or whether a particular Amazon seller account is eligible to sell an ASIN. Every Discord card therefore carries a prominent manual IP/eligibility warning. `BLOCKED_BRANDS` provides only an admin-maintained preliminary exclusion list.

The finalizer deduplicates by ASIN, ranks qualified deals, rotates the student order deterministically per run, and assigns every deal to at most one student. Student ROI, sales, maximum-cost, and excluded-brand preferences are enforced during allocation. Immediately before Discord, Walmart stock, UPC, variant ID, title quantities, and price are checked again; changed or unavailable items are suppressed. A run-lifetime delivery claim prevents concurrent or retried workers from reposting the same batch. Discord delivery splits assignments into confirmed messages of at most four product embeds and retries provider rate limits.

Manual optimization runs may include a bounded `continuationRunsRemaining` count. Each run finalizes before QStash starts the next Walmart source, preventing overlapping Keepa work and unbounded scraper spending.

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

Run a controlled 50-product accuracy cohort without sending qualified products to Discord:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "$PUBLIC_BASE_URL/api/cron?limit=50&audit=true&refresh=true"
```

The admin dashboard shows the full funnel, manual-review reasons, Walmart/Amazon identity comparisons, and every exact qualified identity. Audit every qualified row and require 100% precision before disabling audit mode for larger production runs. Qualification yield is reported separately and is never forced.

Check a run without exposing student credentials:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "$PUBLIC_BASE_URL/api/status?runId=YOUR_RUN_ID"
```

The production cron is configured for `13:00 UTC` daily (6:00 AM Pacific during daylight saving time and 5:00 AM Pacific during standard time). Vercel cron schedules are UTC and only invoke production deployments.
If a manual or scheduled sourcing run is still analyzing, a new cron invocation returns `409` with the active run ID instead of creating an overlapping Keepa queue.

## Scale expectations

Ten students receiving ten strictly unique deals requires 100 qualified products. At a 1% qualification rate, that implies roughly 10,000 raw candidates; at 2%, roughly 5,000. Measure every stage before increasing source coverage and token budgets. A paid student product is commercial; treat free service tiers as prototype allowances rather than a permanent cost model.

The prototype checks at most 50 Walmart detail pages per run. Scraper usage is therefore the discovery-page requests plus up to 50 detail requests, while only UPC-confirmed items consume Keepa and Gemini capacity. Do not increase `WALMART_DETAIL_LOOKUP_LIMIT`, page count, or daily frequency without reviewing current scraper, QStash, Redis, Gemini, Keepa, and Vercel usage dashboards.
