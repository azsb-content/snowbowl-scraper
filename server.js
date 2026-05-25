const express = require('express');
const { scrapeSnowReport } = require('./scraper');

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
  console.log(`[${new Date().toISOString()}] Scraping snowbowl.ski...`);
  try {
    cachedData = await scrapeSnowReport();
    lastScrape = Date.now();
    console.log(`  Success. ${cachedData.raw.length} fields scraped.`);
  } catch (err) {
    console.error(`  Scrape error: ${err.message}`);
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
  if (!cachedData || Date.now() - lastScrape > SCRAPE_INTERVAL) await refreshData();
  res.json(cachedData || { error: 'No data available yet', scrapedAt: null, raw: [] });
});

app.get('/refresh', async (req, res) => {
  await refreshData();
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

app.get('/loomly/calendar', async (req, res) => {
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
refreshData().then(() => {
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

setInterval(refreshData, SCRAPE_INTERVAL);
