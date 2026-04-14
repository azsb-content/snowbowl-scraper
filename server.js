const express = require('express');
const { scrapeSnowReport } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

// Cache the latest scrape result
let cachedData = null;
let lastScrape = 0;
const SCRAPE_INTERVAL = 30 * 60 * 1000; // 30 minutes

async function refreshData() {
  console.log(`[${new Date().toISOString()}] Scraping snowbowl.ski...`);
  try {
    cachedData = await scrapeSnowReport();
    lastScrape = Date.now();
    console.log(`  Success. ${cachedData.raw.length} fields scraped.`);
    if (cachedData.raw.length > 0) {
      cachedData.raw.forEach(r => console.log(`    ${r.label}: ${r.value}`));
    }
  } catch (err) {
    console.error(`  Scrape error: ${err.message}`);
  }
}

// CORS headers so the command center HTML can fetch from any domain
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Main endpoint — returns latest conditions
app.get('/conditions.json', async (req, res) => {
  // If cache is stale or empty, refresh
  if (!cachedData || Date.now() - lastScrape > SCRAPE_INTERVAL) {
    await refreshData();
  }
  res.json(cachedData || { error: 'No data available yet', scrapedAt: null, raw: [] });
});

// Force refresh endpoint
app.get('/refresh', async (req, res) => {
  await refreshData();
  res.json(cachedData);
});

// Health check
app.get('/', (req, res) => {
  res.json({
    service: 'Snowbowl Snow Report Scraper',
    status: 'running',
    lastScrape: cachedData ? cachedData.scrapedAt : null,
    dataFields: cachedData ? cachedData.raw.length : 0,
    endpoint: '/conditions.json',
    refreshEndpoint: '/refresh'
  });
});

// Initial scrape on startup
refreshData().then(() => {
  app.listen(PORT, () => {
    console.log(`Snowbowl scraper running on port ${PORT}`);
    console.log(`  GET /conditions.json — latest data`);
    console.log(`  GET /refresh — force new scrape`);
  });
});

// Re-scrape on interval
setInterval(refreshData, SCRAPE_INTERVAL);
