const express = require('express');
const { scrapeSnowReport } = require('./scraper');

const app  = express();
const PORT = process.env.PORT || 3000;

const CANVA_API  = 'https://api.canva.com/rest/v1';
const BRAND_KIT  = process.env.CANVA_BRAND_KIT || 'kAGecsp4l1c';

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

// ─── CANVA INTEGRATION ────────────────────────────────────────────────────────

// Status check — lets the command center know if Canva is configured
app.get('/canva/status', (req, res) => {
  res.json({ configured: !!process.env.CANVA_TOKEN });
});

// Create a Canva design from story copy
app.post('/canva/create', async (req, res) => {
  const token = process.env.CANVA_TOKEN;

  if (!token) {
    return res.status(503).json({
      error: 'canva_not_configured',
      message: 'Add CANVA_TOKEN to Render environment variables to enable Canva integration.'
    });
  }

  const { headline, body, label } = req.body || {};
  if (!headline) return res.status(400).json({ error: 'headline is required' });

  const query = [
    'Arizona Snowbowl Instagram Story.',
    `Headline: "${headline.replace(/\n/g, ' ')}".`,
    `Body copy: "${(body || '').replace(/\n/g, ' ')}".`,
    'Mountain/ski resort aesthetic. Bold clean typography. Professional, modern design.'
  ].join(' ');

  try {
    // Step 1 — generate design candidates
    const genRes = await fetch(`${CANVA_API}/generations`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        design_type:  'your_story',
        query,
        brand_kit_id: BRAND_KIT,
      }),
    });

    if (!genRes.ok) {
      const errText = await genRes.text();
      throw new Error(`Canva generation failed (${genRes.status}): ${errText}`);
    }

    let genData = await genRes.json();
    let job = genData.job;

    // Poll if the job is still running
    let attempts = 0;
    while (job.status === 'in_progress' && attempts < 20) {
      await new Promise(r => setTimeout(r, 1500));
      const pollRes = await fetch(`${CANVA_API}/generations/${job.id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const pollData = await pollRes.json();
      job = pollData.job;
      attempts++;
    }

    if (job.status !== 'success') {
      throw new Error(`Generation ended with status: ${job.status}`);
    }

    const candidates = job.result?.generated_designs || [];
    if (!candidates.length) throw new Error('No designs were generated');

    const candidate = candidates[0];

    // Step 2 — create an editable design from the top candidate
    let editUrl = candidate.url; // fallback preview URL

    const createRes = await fetch(`${CANVA_API}/designs`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        design_type: 'your_story',
        title: label ? `Snowbowl — ${label}` : 'Snowbowl Story',
        asset_id: candidate.candidate_id,
      }),
    });

    if (createRes.ok) {
      const createData = await createRes.json();
      editUrl = createData.design?.urls?.edit_url || editUrl;
    } else {
      console.warn(`  create-design returned ${createRes.status}, using preview URL`);
    }

    console.log(`  Canva design created: ${editUrl}`);

    res.json({
      url: editUrl,
      thumbnail: candidate.thumbnail?.url || null,
      allCandidates: candidates.slice(0, 4).map(c => ({
        url: c.url,
        thumbnail: c.thumbnail?.url || null,
      })),
    });

  } catch (err) {
    console.error('  Canva error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    service:      'Snowbowl Content Scraper + Canva Proxy',
    status:       'running',
    lastScrape:   cachedData ? cachedData.scrapedAt : null,
    canva:        !!process.env.CANVA_TOKEN ? 'configured' : 'not configured — add CANVA_TOKEN',
    endpoints: {
      conditions:   'GET /conditions.json',
      refresh:      'GET /refresh',
      canvaStatus:  'GET /canva/status',
      canvaCreate:  'POST /canva/create  { headline, body, label }',
    },
  });
});

// ─── START ────────────────────────────────────────────────────────────────────
refreshData().then(() => {
  app.listen(PORT, () => {
    console.log(`Snowbowl server running on port ${PORT}`);
    console.log(`  Canva: ${process.env.CANVA_TOKEN ? '✓ configured' : '✗ add CANVA_TOKEN env var'}`);
  });
});

setInterval(refreshData, SCRAPE_INTERVAL);
