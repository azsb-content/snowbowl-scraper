# Snowbowl Scraper

The API/data service behind the [Snowbowl Command Center](https://github.com/azsb-content/snowbowl-command-center)
(sibling repo). Collects live snowbowl.ski conditions/events, proxies live ops
alerts, and serves a small set of public "agent surface" endpoints that
automated agents (Cowork, cron) can read without any authentication.

## What it actually does

- **Primary data collection is JSON feeds, not page scraping.** `feeds.js`
  pulls Snowbowl's own `weather.json` (on-mountain conditions/forecast), the
  Events Calendar REST API (structured events), and `alerts.json` — all
  served from paths Snowbowl's Cloudflare WAF leaves open. This is canon:
  it's more structured than the old page-scraped text and isn't blocked.
- **Playwright page scraping (`scraper.js`) is now best-effort enrichment
  only**, not the primary source. Cloudflare blocks `snowbowl.ski`'s page
  routes for datacenter IPs / non-browser clients, so it fails intermittently
  from Render. When it does get through, it only contributes what the feeds
  can't provide: the winter snow-totals table and on-page announcement text.
  If it fails, the feed data stands on its own — nothing degrades.
- Both are combined every 30 minutes into an in-memory cache (`refreshData()`
  in `server.js`) that backs `/conditions.json` and the agent-surface
  endpoints below. The cache resets on every deploy/sleep-wake cycle.
- A **live alerts proxy** (`/snowbowl/alerts`) re-serves Snowbowl's own
  `alerts.json` with CORS headers added, since the upstream doesn't send them
  and the app's browser can't fetch it directly. Cached 60s, serves stale
  data on upstream failure rather than erroring.
- A small set of **public, unauthenticated, GET-only "agent surface"
  endpoints** (`/brief.json`, `/heat.json`, `/events.ics`, `/offerings.json`)
  built from pure functions in `agent.js` — these are what a scheduled
  automation reads to decide whether to message a deep link. Full field-level
  contract for these lives in the app repo's
  [`docs/AUTOMATION.md`](https://github.com/azsb-content/snowbowl-command-center/blob/main/docs/AUTOMATION.md)
  — that file is the authoritative API spec; this README is the one-line
  version.
- Optional **Canva** OAuth + design-creation proxy, and an optional **Loomly**
  calendar proxy (see the security note below) — both off unless their
  environment variables are set.

## Deploy

Render, Docker web service (`render.yaml`: `runtime: docker`, `plan: free`,
health check `/`). Auto-deploys on push to `main`. Free-tier services spin
down when idle — the first request after idle takes 30–90 seconds
(cold start) while it re-primes the feed cache; `/brief.json` and
`/heat.json` serve a graceful `ok:false`/`inSeason:false`-style body during
that window rather than erroring (see `docs/AUTOMATION.md` in the app repo
for the exact cold-start shapes).

The Dockerfile (`node:20-bookworm`) installs Playwright + Chromium, so
Playwright is available for the enrichment scrape even though it's no longer
the primary path.

Live at `https://snowbowl-scraper.onrender.com`.

## Endpoints

All endpoints are `GET` unless noted, CORS-open (`Access-Control-Allow-Origin: *`).

| Endpoint | Purpose |
|---|---|
| `GET /conditions.json` | Full raw feed cache (conditions, events, summer ops, announcement) — 30-min cache |
| `GET /refresh` | Force an immediate feed refresh (bypasses the 30-min cache) |
| `GET /snowbowl/alerts` | Live ops alerts proxy (CORS added), 60s cache, serves stale data on upstream failure |
| `GET /brief.json` | Agent morning brief — conditions, announcement, upcoming events, Power Pass cadence, ready-to-draft suggestions. 5-min cache |
| `GET /heat.json` | Phoenix-vs-mountain heat delta (the summer hero hook), season-gated (Jun 1–Aug 31). 5-min cache |
| `GET /events.ics` | Subscribable iCalendar feed — published events, 3-days-ahead "draft it" reminders, and the monthly 14th payment-plan-reel day. 15-min cache |
| `GET /offerings.json` | Static offering-fact brain — the 12 things Snowbowl sells, locked facts/angles, deterministic offering-of-the-day, per-offering deep links. 1-hour cache, never cold-start-blocked |
| `GET /canva/auth` | Starts the Canva OAuth flow (one-time, admin-only) |
| `GET /canva/callback` | OAuth redirect target — completes the token exchange |
| `GET /canva/status` | Whether Canva is configured + authorized |
| `POST /canva/create` | Creates a Canva Instagram Story design from `{ headline, body, label }` |
| `GET /loomly/calendar` | **Dormant** — see security note below |
| `GET /loomly/refresh` | Force-refresh the Loomly cache (dormant, same caveat) |
| `GET /loomly/status` | Whether a `LOOMLY_API_KEY` is configured |
| `GET /` | Health check / service status (what's configured, last scrape time) |

## Security note — `/loomly/calendar` is dormant and must not go live without auth

`/loomly/calendar`, `/loomly/refresh`, and `/loomly/status` are a **direct
Loomly-API proxy that was built when a direct API-key integration was
planned**, gated only on whether `LOOMLY_API_KEY` is set as an environment
variable — there is currently no key set, so these routes return `503` and
the feature is inert. **This is explicitly flagged, not accidental:** even if
a Loomly API key becomes available, these routes must not be turned on
without first adding authentication in front of them. Loomly post data
(draft copy, assignees) is internal team data, not public — and every other
endpoint on this service is deliberately unauthenticated and CORS-open by
design (see `docs/AUTOMATION.md` §5 in the app repo: "the scraper serves
public data only"). Wiring a public, unauthenticated route to internal draft
content would break that guarantee for the whole service.

The live Loomly integration that's actually connected today does **not** go
through this proxy at all — it's a separate path (Zapier → a Supabase
Edge Function → the `loomly_posts` table), documented in the app repo's
`SETUP.md` §3b. If `LOOMLY_API_KEY` is ever set on this service, treat that
as a deploy that needs an auth review first, not a config change.

## New routes

Per the app repo's `CLAUDE.md`: new scraper routes must stay GET-only,
CORS-open, public data only, reuse the existing 30-min feed cache, and keep
the pure logic in an `agent.js` builder with a thin route registered in
`server.js` — mirrors the pattern `/brief.json`/`/heat.json`/`/events.ics`/
`/offerings.json` already follow.
