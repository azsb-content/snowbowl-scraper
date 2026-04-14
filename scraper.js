const { chromium } = require('playwright');

async function scrapeSnowReport() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const page = await browser.newPage();
    await page.goto('https://www.snowbowl.ski/the-mountain/weather-conditions-webcams/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    await page.waitForSelector('.m-snow-totals-table', { timeout: 15000 });

    // Pull every value/label pair from the snow totals table
    // This reads the EXACT text from the website — no interpretation
    const raw = await page.$$eval(
      '.m-snow-totals-table.m-h-s.m-vp-top-m > div',
      (items) => items.map((el) => ({
        value: (el.querySelector('.m-snow-totals-top') || {}).innerText?.trim() || '',
        label: (el.querySelector('.m-snow-totals-label') || {}).innerText?.trim() || ''
      }))
    );

    // Also grab any announcement/alert banner text
    const announcement = await page.evaluate(() => {
      // Try multiple selectors that Snowbowl might use for announcements
      const selectors = [
        '.m-alert-bar',
        '.m-hero-text',
        '[class*="announcement"]',
        '[class*="alert"] p',
        '.wp-block-heading'
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.innerText.trim().length > 10) {
          return el.innerText.trim();
        }
      }
      return null;
    });

    return {
      scrapedAt: new Date().toISOString(),
      source: 'snowbowl.ski',
      raw: raw,
      announcement: announcement,
      error: null
    };

  } catch (err) {
    return {
      scrapedAt: new Date().toISOString(),
      source: 'snowbowl.ski',
      raw: [],
      announcement: null,
      error: err.message
    };
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeSnowReport };
