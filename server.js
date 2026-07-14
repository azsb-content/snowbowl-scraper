const express = require('express');
const { scrapeSnowReport } = require('./scraper');
const { collectFromFeeds } = require('./feeds');
const agent = require('./agent');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── CANVA CONFIG ─────────────────────────────────────────────────────────────
const CANVA_CLIENT_ID     = process.env.CANVA_CLIENT_ID     || '';
const CANVA_CLIENT_SECRET = process.env.CANVA_CLIENT_SECRET || '';
const CANVA_API           = 'https://api.canva.com/rest/v1';
const CANVA_AUTH_URL      = 'https://www.canva.com/api/oauth/code';
const CANVA_TOKEN_URL     = 'https://api.canva.com/rest/v1/oauth/token';
const CANVA_REDIRECT_URI  = process.env.CANVA_REDIRECT_URI
  || 'https://snowbowl-scraper.onrender.com/canva/callback';
const BRAND_KIT = process.env.CANVA_BRAND_KIT || 'kAGecsp4l1c';

// ─── LOOMLY CONFIG ────────────────────────────────────────────────────────────
const LOOMLY_API_KEY     = process.env.LOOMLY_API_KEY     || '';
const LOOMLY_CALENDAR_ID = process.env.LOOMLY_CALENDAR_ID || '573747';
const LOOMLY_API         = 'https://api.loomly.com/v2';

// Loomly cache (15 min)
let loomlyCache = { posts: null, fetchedAt: 0 };
const LOOMLY_CACHE_MS = 15 * 60 * 1000;

// In-memory token store (persists across requests, resets on deploy)
// For a permanent store: save CANVA_REFRESH_TOKEN as a Render env var after first auth
let tokenStore = {
  accessToken:  process.env.CANVA_ACCESS_TOKEN  || null,
  refreshToken: process.env.CANVA_REFRESH_TOKEN || null,
  expiresAt:    0,
};

// ─── CACHE ────────────────────────────────────────────────────────────────────
let cachedData = null;
let lastScrape = 0;
const SCRAPE_INTERVAL = 30 * 60 * 1000; // 30 minutes

async function refreshData() {
  console.log(`[${new Date().toISOString()}] Collecting snowbowl.ski data (JSON feeds)...`);
  // PRIMARY: JSON feeds — Cloudflare blocks page routes for datacenter IPs,
  // so Playwright page scraping returns empty from Render. The feeds
  // (m-json/weather.json, tribe events API, m-json/alerts.json) live on
  // paths the WAF leaves open and carry better-structured data anyway.
  try {
    cachedData = await collectFromFeeds();
    lastScrape = Date.now();
    console.log(`  Feeds OK. events=${cachedData.events.length}`);
  } catch (err) {
    console.error(`  Feed collection error: ${err.message}`);
  }

  // BEST-EFFORT ENRICHMENT: the Playwright scrape works only when Cloudflare
  // lets it through (intermittent). FEEDS REMAIN CANON — the events API and
  // derived summer ops are cleaner than page-scraped text (20 structured
  // events vs ~6; page sunsetLine picks up promo-banner garbage). The page
  // scrape only contributes what feeds can't provide: the winter snow-totals
  // table and on-page announcements.
  try {
    const scraped = await scrapeSnowReport();
    if (scraped && (scraped.raw.length > 0 || scraped.announcement)) {
      if (scraped.raw.length)   { cachedData.raw = scraped.raw; cachedData.parsed = scraped.parsed; }
      if (scraped.announcement && !cachedData.announcement) cachedData.announcement = scraped.announcement;
      cachedData.source = 'snowbowl.ski (feeds + page scrape)';
      console.log('  Playwright enrichment: snow table/announcement merged.');
    } else {
      console.log('  Playwright contributed nothing this round — feeds data stands.');
    }
  } catch (err) {
    console.log(`  Playwright enrichment skipped: ${err.message}`);
  }
}

// IN-FLIGHT GUARD — refreshData() does a full scrape (3 feed fetches + a
// Playwright browser launch+navigate), expensive enough that two overlapping
// calls (a request-triggered background refresh racing the setInterval tick,
// or two requests landing in the same instant right at cache expiry) would
// double the load for no benefit. Every caller should go through this wrapper
// instead of calling refreshData() directly, so at most one scrape runs at a time.
let refreshPromise = null;
function refreshDataGuarded() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = refreshData()
    .catch((err) => {
      // refreshData() already try/catches its own feed + scrape calls, but this
      // belt-and-suspenders catch guarantees a fire-and-forget background call
      // (nothing awaiting it) can never produce an unhandled promise rejection.
      console.error(`  refreshDataGuarded error: ${err.message}`);
    })
    .finally(() => { refreshPromise = null; });
  return refreshPromise;
}

// STALE-WHILE-REVALIDATE — serve cachedData immediately, even if past
// SCRAPE_INTERVAL, and kick a background refresh for the NEXT request instead
// of blocking this one on a full scrape. Only the very first request ever
// (cachedData still null) blocks on a synchronous refresh.
async function ensureData() {
  if (!cachedData) {
    await refreshDataGuarded();
    return;
  }
  if (Date.now() - lastScrape > SCRAPE_INTERVAL) {
    void refreshDataGuarded(); // fire-and-forget — don't block this response
  }
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',  '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── SNOW CONDITIONS ──────────────────────────────────────────────────────────
app.get('/conditions.json', async (req, res) => {
  await ensureData();
  res.json(cachedData || { error: 'No data available yet', scrapedAt: null, raw: [] });
});

app.get('/refresh', async (req, res) => {
  await refreshDataGuarded();
  res.json(cachedData);
});

// ─── CANVA OAUTH ──────────────────────────────────────────────────────────────

// Helper — exchange a code or refresh token for a fresh access token
async function getAccessToken() {
  // Still valid?
  if (tokenStore.accessToken && Date.now() < tokenStore.expiresAt - 60000) {
    return tokenStore.accessToken;
  }

  if (!tokenStore.refreshToken) {
    throw new Error('canva_not_authorized');
  }

  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: tokenStore.refreshToken,
    client_id:     CANVA_CLIENT_ID,
    client_secret: CANVA_CLIENT_SECRET,
  });

  const r = await fetch(CANVA_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });

  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Token refresh failed (${r.status}): ${txt}`);
  }

  const data = await r.json();
  tokenStore.accessToken  = data.access_token;
  tokenStore.refreshToken = data.refresh_token || tokenStore.refreshToken;
  tokenStore.expiresAt    = Date.now() + (data.expires_in || 3600) * 1000;

  console.log(`  Canva token refreshed. Expires in ${data.expires_in}s`);
  return tokenStore.accessToken;
}

// Step 1 — redirect user to Canva to authorize the app
app.get('/canva/auth', (req, res) => {
  if (!CANVA_CLIENT_ID) {
    return res.status(503).send('Add CANVA_CLIENT_ID to Render environment variables.');
  }

  const scopes = [
    'design:content:read',
    'design:content:write',
    'design:meta:read',
    'brandkit:content:read',
    'brandtemplate:content:read',
  ].join(' ');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CANVA_CLIENT_ID,
    redirect_uri:  CANVA_REDIRECT_URI,
    scope:         scopes,
  });

  res.redirect(`${CANVA_AUTH_URL}?${params.toString()}`);
});

// Step 2 — Canva redirects here after user approves
app.get('/canva/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.status(400).send(`Authorization failed: ${error || 'no code returned'}`);
  }

  try {
    const body = new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri:  CANVA_REDIRECT_URI,
      client_id:     CANVA_CLIENT_ID,
      client_secret: CANVA_CLIENT_SECRET,
    });

    const r = await fetch(CANVA_TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
    });

    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`Token exchange failed (${r.status}): ${txt}`);
    }

    const data = await r.json();
    tokenStore.accessToken  = data.access_token;
    tokenStore.refreshToken = data.refresh_token;
    tokenStore.expiresAt    = Date.now() + (data.expires_in || 3600) * 1000;

    console.log(`  Canva authorized! Refresh token received.`);
    console.log(`  ⚠  Save this refresh token as CANVA_REFRESH_TOKEN in Render to survive redeploys:`);
    console.log(`     ${data.refresh_token}`);

    res.send(`
      <html><body style="font-family:sans-serif;padding:40px;max-width:600px">
        <h2>✅ Canva connected!</h2>
        <p>The command center can now create Canva designs automatically.</p>
        <p><strong>One more step to make this permanent:</strong><br>
        Copy the refresh token below and add it as <code>CANVA_REFRESH_TOKEN</code>
        in your Render environment variables. This prevents re-authorization after redeploys.</p>
        <textarea rows="4" style="width:100%;font-size:12px;margin-top:8px">${data.refresh_token}</textarea>
        <p style="margin-top:16px;color:#666">You can close this tab.</p>
      </body></html>
    `);
  } catch (err) {
    console.error('  Canva callback error:', err.message);
    res.status(500).send(`Authorization error: ${err.message}`);
  }
});

// Status — tells the command center if Canva is connected
app.get('/canva/status', (req, res) => {
  const configured = !!(CANVA_CLIENT_ID && CANVA_CLIENT_SECRET);
  const authorized = !!(tokenStore.refreshToken || process.env.CANVA_REFRESH_TOKEN);
  res.json({
    configured,
    authorized,
    ready: configured && authorized,
    authUrl: configured ? `${process.env.CANVA_REDIRECT_URI?.replace('/canva/callback', '') || 'https://snowbowl-scraper.onrender.com'}/canva/auth` : null,
  });
});

// Create — generates a Canva story design from story copy
app.post('/canva/create', async (req, res) => {
  if (!CANVA_CLIENT_ID || !CANVA_CLIENT_SECRET) {
    return res.status(503).json({
      error: 'canva_not_configured',
      message: 'Add CANVA_CLIENT_ID and CANVA_CLIENT_SECRET to Render environment variables.',
    });
  }

  let token;
  try {
    token = await getAccessToken();
  } catch (err) {
    if (err.message === 'canva_not_authorized') {
      return res.status(401).json({
        error: 'canva_not_authorized',
        message: 'Visit /canva/auth on this server to connect your Canva account.',
        authUrl: `https://snowbowl-scraper.onrender.com/canva/auth`,
      });
    }
    return res.status(500).json({ error: err.message });
  }

  const { headline, body, label } = req.body || {};
  if (!headline) return res.status(400).json({ error: 'headline is required' });

  try {
    // Create an editable design (Instagram Story format)
    const createRes = await fetch(`${CANVA_API}/designs`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        design_type: { type: 'preset', name: 'instagramStory' },
        title: label ? `Snowbowl — ${label}` : 'Snowbowl Story',
      }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      throw new Error(`Design creation failed (${createRes.status}): ${errText}`);
    }

    const createData = await createRes.json();
    const design     = createData.design;
    const editUrl    = design?.urls?.edit_url;

    if (!editUrl) throw new Error('No edit URL returned from Canva');

    console.log(`  Canva design created: ${editUrl}`);
    res.json({
      url:       editUrl,
      designId:  design.id,
      thumbnail: design.thumbnail?.url || null,
    });

  } catch (err) {
    console.error('  Canva error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── LOOMLY (CONTENT CALENDAR) ────────────────────────────────────────────────

// Pull posts from a Loomly calendar. Cached 15 min. Server proxies the API so
// the key stays out of the browser. Auto-disables if LOOMLY_API_KEY isn't set.
async function fetchLoomlyPosts() {
  if (!LOOMLY_API_KEY) throw new Error('loomly_not_configured');

  // Reasonable date range: last 7 days through next 30 days
  const now = new Date();
  const start = new Date(now); start.setDate(start.getDate() - 7);
  const end   = new Date(now); end.setDate(end.getDate() + 30);
  const iso = (d) => d.toISOString().split('T')[0];

  const url = `${LOOMLY_API}/calendars/${LOOMLY_CALENDAR_ID}/posts`
    + `?start_date=${iso(start)}&end_date=${iso(end)}&limit=200`;

  const r = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${LOOMLY_API_KEY}`,
      'Accept':        'application/json',
    },
  });

  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Loomly API ${r.status}: ${txt.slice(0, 200)}`);
  }

  const data = await r.json();
  // Normalize each post to the shape the command center expects.
  // CAPTION TEXT is required for the front-end auto-import into POST_LOG,
  // so we expose it under all common Loomly field names (caption/body/text/content).
  const posts = (data.posts || data || []).map(p => ({
    id:        p.id,
    title:     p.title || p.subject || '',
    caption:   p.caption || p.body || p.text || p.content || p.message || '',
    date:      p.scheduled_date || p.publish_date || p.date,
    time:      p.scheduled_time || null,
    platforms: (p.platforms || []).map(x => typeof x === 'string' ? x : x.name),
    platform:  Array.isArray(p.platforms) && p.platforms[0] ? (typeof p.platforms[0] === 'string' ? p.platforms[0] : p.platforms[0].name) : null,
    status:    p.status || p.workflow_state || 'draft',
    label:     p.label || p.category || null,
    url:       p.url || null,
  }));
  return posts;
}

// CODE-LEVEL AUTH GUARD — this route returns real Loomly post data (draft
// copy, assignee names/emails) once LOOMLY_API_KEY is set; that's internal
// team data, not public (see SETUP.md §3a and docs/ADMIN_RUNBOOK.md). Until
// now the only thing stopping it from going live-and-public was a comment
// telling an admin to remember to add auth — a real gap a brand-guardian
// review flagged. Same fail-closed shared-secret pattern as the live
// loomly-webhook Edge Function: an unset LOOMLY_CALENDAR_SECRET means the
// route 503s even if LOOMLY_API_KEY gets set, so turning the integration on
// can never accidentally also turn it public.
const LOOMLY_CALENDAR_SECRET = process.env.LOOMLY_CALENDAR_SECRET || '';
function requireLoomlyCalendarSecret(req, res) {
  if (!LOOMLY_CALENDAR_SECRET) {
    res.status(503).json({ error: 'loomly_calendar_not_configured', message: 'Set LOOMLY_CALENDAR_SECRET to enable this route.' });
    return false;
  }
  if (req.get('x-loomly-calendar-secret') !== LOOMLY_CALENDAR_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

app.get('/loomly/calendar', async (req, res) => {
  if (!requireLoomlyCalendarSecret(req, res)) return;
  if (!LOOMLY_API_KEY) {
    return res.status(503).json({
      configured: false,
      message: 'Add LOOMLY_API_KEY to Render environment variables to enable Loomly integration.',
    });
  }

  // Serve from cache if fresh
  if (loomlyCache.posts && Date.now() - loomlyCache.fetchedAt < LOOMLY_CACHE_MS) {
    return res.json({ configured: true, cached: true, fetchedAt: loomlyCache.fetchedAt, posts: loomlyCache.posts });
  }

  try {
    const posts = await fetchLoomlyPosts();
    loomlyCache = { posts, fetchedAt: Date.now() };
    res.json({ configured: true, cached: false, fetchedAt: loomlyCache.fetchedAt, posts });
  } catch (err) {
    console.error('  Loomly fetch error:', err.message);
    res.status(500).json({ configured: true, error: err.message });
  }
});

app.get('/loomly/refresh', async (req, res) => {
  if (!requireLoomlyCalendarSecret(req, res)) return;
  if (!LOOMLY_API_KEY) return res.status(503).json({ error: 'loomly_not_configured' });
  try {
    const posts = await fetchLoomlyPosts();
    loomlyCache = { posts, fetchedAt: Date.now() };
    res.json({ refreshed: true, fetchedAt: loomlyCache.fetchedAt, count: posts.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/loomly/status', (req, res) => {
  res.json({
    configured: !!LOOMLY_API_KEY,
    calendarId: LOOMLY_CALENDAR_ID,
    cached:     !!loomlyCache.posts,
    fetchedAt:  loomlyCache.fetchedAt || null,
  });
});

// ─── LIVE ALERTS PROXY ────────────────────────────────────────────────────────
// Snowbowl's alerts JSON doesn't send CORS headers, so the browser can't fetch
// it directly. This endpoint proxies it server-side and serves it with CORS
// open. Cached 60s — alerts can flip in minutes during monsoon ops.
const ALERTS_URL = 'https://www.snowbowl.ski/wp-content/uploads/sites/9/m-json/alerts.json';
let alertsCache = { data: null, fetchedAt: 0 };
const ALERTS_CACHE_MS = 60 * 1000; // 1 minute

app.get('/snowbowl/alerts', async (req, res) => {
  try {
    if (alertsCache.data && Date.now() - alertsCache.fetchedAt < ALERTS_CACHE_MS) {
      return res.json({ cached: true, fetchedAt: alertsCache.fetchedAt, alerts: alertsCache.data });
    }
    const r = await fetch(ALERTS_URL, { headers: { 'User-Agent': 'snowbowl-scraper/1.0' } });
    if (!r.ok) throw new Error(`alerts ${r.status}`);
    const data = await r.json();
    alertsCache = { data, fetchedAt: Date.now() };
    res.json({ cached: false, fetchedAt: alertsCache.fetchedAt, alerts: data });
  } catch (err) {
    console.error('  Alerts fetch error:', err.message);
    // If we have ANY cached data, serve it even if stale
    if (alertsCache.data) {
      return res.json({ cached: true, stale: true, fetchedAt: alertsCache.fetchedAt, alerts: alertsCache.data });
    }
    res.status(500).json({ error: err.message });
  }
});

// ─── AGENT SURFACE (brief + heat + ICS) ───────────────────────────────────────
// Public machine-readable surfaces for scheduled agents (Cowork): a morning
// brief, the Phoenix-vs-mountain heat delta, and a subscribable marketing
// calendar. Bodies are built by the pure functions in agent.js; this section
// only owns I/O. brief + ICS are pure derivations of the existing 30-min feed
// cache; heat adds exactly ONE new cached upstream (Phoenix NOAA, 15-min TTL,
// stale-on-error). Public data only — snowbowl.ski feeds, NOAA, published
// powerpass.ski facts. GET-only, no secrets, no team data.

// Deep links land on the command center; Dylan's signed-in browser applies
// them on load. Default host verified against the app repo's render.yaml
// (Render static site `snowbowl-command-center`).
const APP_URL = process.env.APP_URL || 'https://snowbowl-command-center.onrender.com';

// Phoenix NOAA (api.weather.gov) — same point the app's Heat Gap tab uses.
const PHX_POINT = { lat: 33.4342, lon: -112.0080 }; // Phoenix Sky Harbor
let phxUrls = null; // memoized points-API forecast URLs (stable per point)
let phxCache = { data: null, fetchedAt: 0 };
const PHX_CACHE_MS = 15 * 60 * 1000; // 15 minutes
// NOAA 403s requests without a User-Agent — contact info per their API docs.
const NOAA_HEADERS = { 'User-Agent': 'snowbowl-scraper/2.0 (dheckert@snowbowl.ski)', Accept: 'application/geo+json' };

async function getPhx() {
  if (phxCache.data && Date.now() - phxCache.fetchedAt < PHX_CACHE_MS) {
    return { ...phxCache.data, stale: false };
  }
  try {
    if (!phxUrls) {
      const pr = await fetch(`https://api.weather.gov/points/${PHX_POINT.lat},${PHX_POINT.lon}`, { headers: NOAA_HEADERS });
      if (!pr.ok) throw new Error(`points ${pr.status}`);
      const props = (await pr.json()).properties || {};
      if (!props.forecastHourly || !props.forecast) throw new Error('points response missing forecast URLs');
      phxUrls = { hourly: props.forecastHourly, daily: props.forecast };
    }
    const [hr, dr] = await Promise.all([
      fetch(phxUrls.hourly, { headers: NOAA_HEADERS }),
      fetch(phxUrls.daily,  { headers: NOAA_HEADERS }),
    ]);
    if (!hr.ok) throw new Error(`hourly ${hr.status}`);
    if (!dr.ok) throw new Error(`forecast ${dr.status}`);
    const hj = await hr.json();
    const dj = await dr.json();

    // Current temp MUST come from the HOURLY forecast's first period —
    // daily periods are highs/lows, not "right now".
    const first = ((hj.properties || {}).periods || [])[0] || null;
    const tempNow = first ? agent.numOrNull(first.temperature) : null;
    const short = first ? (first.shortForecast || null) : null;

    const daily = ((dj.properties || {}).periods || [])
      .filter((p) => p && p.isDaytime)
      .map((p) => ({
        date: String(p.startTime || '').slice(0, 10),
        high: agent.numOrNull(p.temperature),
        label: p.name || '',
      }));
    // After ~6pm NOAA drops today's daytime period ("Tonight" leads) — then
    // highToday is null, never a guess.
    const today = daily.find((p) => p.date === agent.phxDateKey(new Date()));

    phxCache = {
      data: { tempNow, short, highToday: today ? today.high : null, daily, fetchedAt: Date.now() },
      fetchedAt: Date.now(),
    };
    console.log(`  Phoenix NOAA OK. now=${tempNow}°, high=${today ? today.high : '—'}°`);
    return { ...phxCache.data, stale: false };
  } catch (err) {
    console.error('  Phoenix NOAA error:', err.message);
    // Serve stale if we have ANYTHING; otherwise null — NEVER a fabricated temp.
    if (phxCache.data) return { ...phxCache.data, stale: true };
    return null;
  }
}

// Morning brief — everything a scheduled agent needs in one GET.
app.get('/brief.json', async (req, res) => {
  await ensureData();
  res.set('Cache-Control', 'public, max-age=300');
  const now = new Date();
  // The heat block reads the NOAA cache PASSIVELY — fresh + in season, or
  // null. The brief never triggers a NOAA fetch.
  const phxFresh =
    agent.inHeatSeason(now) && phxCache.data && Date.now() - phxCache.fetchedAt < PHX_CACHE_MS
      ? phxCache.data
      : null;
  res.json(agent.buildBrief(cachedData, now, phxFresh));
});

// Heat delta — Phoenix (NOAA) vs mountain (existing feed cache: zero new
// snowbowl.ski traffic). Season-gated so NOAA is never called off-season.
app.get('/heat.json', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  const now = new Date();
  if (!agent.inHeatSeason(now)) {
    return res.json(agent.buildHeatBody(null, null, now)); // season gate FIRST — no NOAA call
  }
  const phx = await getPhx();
  res.json(agent.buildHeatBody(cachedData, phx, now));
});

// Marketing-dates calendar — resort events, 3-days-ahead draft windows, and
// the 14th-of-month payment-plan reel series. Subscribable (Google/Apple).
app.get('/events.ics', async (req, res) => {
  await ensureData();
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=900');
  res.send(agent.buildEventsIcs(cachedData, new Date(), APP_URL));
});

// Offering fact brain — static public product facts + offering-of-the-day +
// per-offering deep links. NO refreshData(): the body is built from constants
// only, so this endpoint answers INSTANTLY even during a cold start (the one
// agent endpoint with no feed dependency). Cached 1h — the facts rarely change.
app.get('/offerings.json', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(agent.buildOfferings(new Date(), APP_URL));
});

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    service:    'Snowbowl Content Scraper + Canva Integration',
    status:     'running',
    lastScrape: cachedData ? cachedData.scrapedAt : null,
    canva: {
      configured: !!(CANVA_CLIENT_ID && CANVA_CLIENT_SECRET),
      authorized: !!(tokenStore.refreshToken),
      authUrl:    'GET /canva/auth',
    },
    loomly: {
      configured: !!LOOMLY_API_KEY,
      calendarId: LOOMLY_CALENDAR_ID,
    },
    endpoints: {
      conditions:    'GET  /conditions.json',
      refresh:       'GET  /refresh',
      alerts:        'GET  /snowbowl/alerts — live ops alerts proxy (CORS open)',
      brief:         'GET  /brief.json     — agent morning brief: conditions, events, pass cadence, draft suggestions',
      heat:          'GET  /heat.json      — Phoenix-vs-mountain heat delta (Jun 1 – Aug 31)',
      eventsIcs:     'GET  /events.ics     — subscribable marketing-dates calendar (events, draft windows, reel days)',
      offerings:     'GET  /offerings.json — public offering fact brain + offering-of-the-day + per-offering deep links',
      canvaAuth:     'GET  /canva/auth     — authorize Canva (do once)',
      canvaStatus:   'GET  /canva/status',
      canvaCreate:   'POST /canva/create   { headline, body, label }',
      loomlyCalendar:'GET  /loomly/calendar — scheduled posts from Loomly',
      loomlyRefresh: 'GET  /loomly/refresh  — force re-pull (bypass 15min cache)',
      loomlyStatus:  'GET  /loomly/status',
    },
  });
});

// ─── START ────────────────────────────────────────────────────────────────────
refreshDataGuarded().then(() => {
  app.listen(PORT, () => {
    console.log(`Snowbowl server running on port ${PORT}`);
    const configured = !!(CANVA_CLIENT_ID && CANVA_CLIENT_SECRET);
    const authorized = !!(tokenStore.refreshToken);
    console.log(`  Canva: ${configured ? '✓ credentials set' : '✗ add CANVA_CLIENT_ID + CANVA_CLIENT_SECRET'}`);
    if (configured && !authorized) {
      console.log(`  ⚠  Visit /canva/auth to authorize your Canva account`);
    }
    if (authorized) {
      console.log(`  ✓ Canva authorized and ready`);
    }
    console.log(`  Loomly: ${LOOMLY_API_KEY ? '✓ key set (calendar ' + LOOMLY_CALENDAR_ID + ')' : '✗ add LOOMLY_API_KEY to enable'}`);
  });
});

setInterval(refreshDataGuarded, SCRAPE_INTERVAL);
