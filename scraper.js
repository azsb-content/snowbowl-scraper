const { chromium } = require('playwright');

const CONDITIONS_URL = 'https://www.snowbowl.ski/the-mountain/weather-conditions-webcams/';
const EVENTS_URL     = 'https://www.snowbowl.ski/events/';
const SUMMER_URL     = 'https://www.snowbowl.ski/summer/';

// ─── SNOW CONDITIONS ──────────────────────────────────────────────────────────
async function scrapeConditions(page) {
  await page.goto(CONDITIONS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  try {
    await page.waitForSelector('.m-snow-totals-table', { timeout: 10000 });
  } catch (e) {
    console.warn('  No snow totals table found — page may be summer layout');
  }

  const raw = await page.$$eval(
    '.m-snow-totals-table.m-h-s.m-vp-top-m > div',
    (items) => items.map((el) => ({
      value: (el.querySelector('.m-snow-totals-top')?.innerText  || '').trim(),
      label: (el.querySelector('.m-snow-totals-label')?.innerText || '').trim(),
    }))
  ).catch(() => []);

  // Build parsed key/value map
  const parsed = {};
  raw.forEach(({ value, label }) => {
    const key = label.toLowerCase().replace(/\s+/g, '_');
    if (key) parsed[key] = value;
  });

  const announcement = await page.$eval(
    '.m-alert-bar, .m-hero-text, [class*="announcement"], [class*="banner-text"]',
    (el) => el?.innerText?.trim() || null
  ).catch(() => null);

  const operatingStatus = await page.$eval(
    '[class*="operating"], [class*="status"], [class*="hours-of-operation"]',
    (el) => el?.innerText?.trim() || null
  ).catch(() => null);

  return { raw, parsed, announcement, operatingStatus };
}

// ─── EVENTS ───────────────────────────────────────────────────────────────────
async function scrapeEvents(page) {
  await page.goto(EVENTS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);

  const events = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    function clean(t) {
      return (t || '').replace(/\s+/g, ' ').trim();
    }
    function text(root, ...sels) {
      for (const s of sels) {
        const el = root.querySelector(s);
        if (el && el.innerText && el.innerText.trim()) return clean(el.innerText);
      }
      return '';
    }

    const containerSelectors = [
      '.tribe-events-calendar-list__event-row',
      '.tribe-events-calendar-month__calendar-event',
      '.tribe-event',
      '.tribe-events-loop .tribe-events-event',
      '.m-event-item',
      '[class*="event-item"]',
      '[class*="event-card"]',
      '[class*="event-listing"]',
      'article.tribe_events_cat',
      'article[class*="event"]',
      '.events-archive article',
      '.page article',
    ];

    let containers = [];
    for (const sel of containerSelectors) {
      const found = Array.from(document.querySelectorAll(sel));
      if (found.length > 0) { containers = found; break; }
    }

    if (!containers.length) {
      containers = Array.from(document.querySelectorAll('article')).filter(el => {
        const t = el.innerText || '';
        return /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}\/\d{1,2})/i.test(t);
      });
    }

    containers.forEach(el => {
      const name = text(el,
        '.tribe-event-url', '.tribe-events-list-event-title a',
        '.tribe-events-calendar-list__event-title-link',
        '.tribe-events-calendar-month__calendar-event-title-link',
        'h1 a', 'h2 a', 'h3 a', 'h4 a',
        '.event-title', '.m-event-title', '[class*="event-title"]',
        'h1', 'h2', 'h3', 'h4'
      );
      if (!name || seen.has(name)) return;
      seen.add(name);

      const date = text(el,
        '.tribe-event-date-start', '.tribe-events-schedule__datetime',
        '.tribe-events-calendar-list__event-datetime',
        'abbr.tribe-events-abbr', 'time',
        '.event-date', '[class*="event-date"]', '[class*="event-time"]',
        '.m-event-date'
      );

      const timeEl = el.querySelector('.tribe-events-schedule__datetime, [class*="event-time"], time');
      const time = timeEl ? clean(timeEl.innerText) : '';

      const price = text(el,
        '.tribe-events-cost', '.tribe-ticket__price',
        '[class*="event-cost"]', '[class*="event-price"]', '[class*="price"]'
      );

      const desc = text(el,
        '.tribe-events-list-event-description p',
        '.tribe-events-calendar-list__event-description p',
        '.tribe-excerpt', '.event-description p',
        '[class*="event-description"] p', '[class*="event-excerpt"]',
        '.entry-summary p', '.entry-content p', 'p'
      );

      const linkEl = el.querySelector('a[href*="event"], h2 a, h3 a, h4 a, .tribe-event-url');
      const link = linkEl ? linkEl.href : '';

      results.push({ name, date, time, price, desc, link });
    });

    return results;
  });

  if (events.length) {
    console.log(`  Found ${events.length} event(s)`);
    events.forEach(e => console.log(`    - ${e.name} (${e.date})`));
  } else {
    console.warn('  No events found — returning empty array');
  }

  return events;
}

// ─── SUMMER OPERATIONS ───────────────────────────────────────────────────────
async function scrapeSummerOps(page) {
  await page.goto(SUMMER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);

  const data = await page.evaluate(() => {
    function clean(t) { return (t || '').replace(/\s+/g, ' ').trim(); }

    const schedulePattern = /\b(open|available|daily|closed|starting|beginning|may|jun|jul|aug|sep|oct)\b/i;
    const seen = new Set();
    const scheduleLines = [];

    document.querySelectorAll('h1,h2,h3,h4,h5,p,li,span').forEach(el => {
      if (el.children.length > 3) return; // skip containers
      const t = clean(el.innerText);
      if (t.length < 10 || t.length > 200) return;
      if (!schedulePattern.test(t)) return;
      if (seen.has(t)) return;
      seen.add(t);
      scheduleLines.push(t);
    });

    // Pull out the most relevant lines — prioritise lines that start with or lead with "Open"
    const gondolaLine = scheduleLines.find(l =>
      /^open\b|open\s+(may|daily|now|today)/i.test(l)
    ) || scheduleLines.find(l =>
      /scenic.*gondola|gondola.*open|open.*gondola/i.test(l)
    ) || scheduleLines.find(l =>
      /scenic|gondola/i.test(l)
    ) || scheduleLines.find(l => /open/i.test(l)) || '';

    const sunsetLine = scheduleLines.find(l =>
      /sunset|saturday|sunday|weekend/i.test(l)
    ) || '';

    return { scheduleLines: scheduleLines.slice(0, 12), gondolaLine, sunsetLine };
  });

  const isOpen = /open/i.test(data.gondolaLine) && !/closed/i.test(data.gondolaLine);
  console.log(`  Summer ops — gondola: "${data.gondolaLine}" | isOpen: ${isOpen}`);

  return { ...data, isOpen };
}

// ─── MAIN EXPORT ──────────────────────────────────────────────────────────────
async function scrapeSnowReport() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const page = await browser.newPage();

    console.log(`[${new Date().toISOString()}] Scraping conditions...`);
    const conditions = await scrapeConditions(page);

    console.log(`[${new Date().toISOString()}] Scraping events...`);
    const events = await scrapeEvents(page);

    console.log(`[${new Date().toISOString()}] Scraping summer ops...`);
    const summerOps = await scrapeSummerOps(page);

    const output = {
      scrapedAt:       new Date().toISOString(),
      source:          'snowbowl.ski',
      raw:             conditions.raw,
      parsed:          conditions.parsed,
      events,
      summerOps,
      error:           null,
    };

    if (conditions.announcement)    output.announcement    = conditions.announcement;
    if (conditions.operatingStatus) output.operatingStatus = conditions.operatingStatus;

    console.log(`  Conditions fields: ${conditions.raw.length}`);
    console.log(`  Events: ${events.length}`);

    return output;

  } catch (err) {
    console.error(`  Scrape error: ${err.message}`);
    return {
      scrapedAt: new Date().toISOString(),
      source:    'snowbowl.ski',
      raw:       [],
      parsed:    {},
      events:    [],
      error:     err.message,
    };
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeSnowReport };
