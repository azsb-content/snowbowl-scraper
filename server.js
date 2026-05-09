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
    endpoints: {
      conditions:   'GET  /conditions.json',
      refresh:      'GET  /refresh',
      canvaAuth:    'GET  /canva/auth     — authorize Canva (do once)',
      canvaStatus:  'GET  /canva/status',
      canvaCreate:  'POST /canva/create   { headline, body, label }',
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
  });
});

setInterval(refreshData, SCRAPE_INTERVAL);
