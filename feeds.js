// JSON-feed data collection — replaces Playwright page scraping, which
// Cloudflare now blocks (page routes 403 for datacenter IPs / non-browser
// clients). These three feeds are served from paths the WAF leaves open:
//
//   1. /wp-content/uploads/sites/9/m-json/weather.json  — Snowbowl's own
//      on-mountain weather (Open Snow): current temp/conditions + 5-day,
//      including snow amounts in winter.
//   2. /wp-json/tribe/events/v1/events — The Events Calendar REST API:
//      structured events with real ISO dates, costs, venues.
//   3. /wp-content/uploads/sites/9/m-json/alerts.json — ops alerts
//      (already proxied separately; reused here for the announcement field).
//
// Output intentionally matches the old scraper shape (raw/parsed/events/
// summerOps/announcement) so the frontends need no changes.

const WEATHER_URL = 'https://www.snowbowl.ski/wp-content/uploads/sites/9/m-json/weather.json';
const EVENTS_URL  = 'https://www.snowbowl.ski/wp-json/tribe/events/v1/events?per_page=20';
const ALERTS_URL  = 'https://www.snowbowl.ski/wp-content/uploads/sites/9/m-json/alerts.json';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&#8217;/g, "'").replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, '"').replace(/&#8221;/g, '"').replace(/&#038;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'snowbowl-scraper/2.0', Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

// "2026-06-13 10:00:00" → { date: "June 13 @ 10:00 am", time: "10:00 am" }
function formatTribeDate(startDate, allDay) {
  const m = String(startDate || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return { date: startDate || '', time: '' };
  const month = MONTHS[parseInt(m[2], 10) - 1];
  const day = parseInt(m[3], 10);
  let hh = parseInt(m[4], 10);
  const min = m[5];
  const ampm = hh >= 12 ? 'pm' : 'am';
  hh = hh % 12 || 12;
  const time = `${hh}:${min} ${ampm}`;
  const isMidnight = m[4] === '00' && min === '00';
  if (allDay || isMidnight) return { date: `${month} ${day}`, time: '' };
  return { date: `${month} ${day} @ ${time}`, time };
}

// Summer operating window — gondola historically runs Mother's Day weekend
// (~May 8) through mid-October. Date-derived because no ops-status feed
// exists; day-to-day holds/closures come through the alerts feed instead.
function inSummerWindow(d = new Date()) {
  const m = d.getMonth(); // 0-based
  if (m > 4 && m < 9) return true;                 // Jun–Sep
  if (m === 4) return d.getDate() >= 8;            // May 8+
  if (m === 9) return d.getDate() <= 20;           // through Oct 20
  return false;
}

async function collectFromFeeds() {
  const out = {
    scrapedAt: new Date().toISOString(),
    source: 'snowbowl.ski json feeds',
    raw: [],
    parsed: {},
    events: [],
    summerOps: null,
    announcement: null,
    mountainWeather: null,
    error: null,
  };

  // ── Weather (Snowbowl's own Open Snow feed) ──
  try {
    const w = await fetchJson(WEATHER_URL);
    out.mountainWeather = {
      provider: w.weather_provider,
      asOf: w.date,
      current: { conditions: w.current_weather, temperature: w.current_temperature },
      forecast: (w.forecast || []).map((f) => ({
        day: f.day, conditions: f.day_forecast,
        tempMin: f.temp_min, tempMax: f.temp_max,
        snowDay: f.day_precip_snow, snowNight: f.night_precip_snow,
      })),
    };
    // In winter, synthesize snow totals from the feed so the legacy `raw`
    // consumers keep working (24hr ≈ today's snow forecast/actual).
    const today = (w.forecast || [])[0];
    if (today && (today.day_precip_snow > 0 || today.night_precip_snow > 0)) {
      out.raw.push({ label: '24 Hour Snowfall', value: `${today.day_precip_snow + today.night_precip_snow}"` });
    }
  } catch (e) {
    console.warn('  weather.json failed:', e.message);
  }

  // ── Events (The Events Calendar REST API) ──
  try {
    const ev = await fetchJson(EVENTS_URL);
    out.events = (ev.events || []).map((e) => {
      const { date, time } = formatTribeDate(e.start_date, e.all_day);
      return {
        name: decodeEntities(e.title),
        date,
        time,
        price: e.cost ? decodeEntities(e.cost) : '',
        url: e.url || null,
        desc: decodeEntities(String(e.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 400),
      };
    });
  } catch (e) {
    console.warn('  events API failed:', e.message);
  }

  // ── Summer ops (date-derived; alerts carry the day-to-day truth) ──
  if (inSummerWindow()) {
    const hasSunset = out.events.some((e) => /sunset gondola/i.test(e.name));
    out.summerOps = {
      gondolaLine: 'Open Daily for Summer Fun',
      sunsetLine: hasSunset ? 'Available Friday & Saturday Evenings' : 'Friday & Saturday Evenings (seasonal)',
      derived: true, // not scraped — date-window + events; alerts override day-to-day
    };
  }

  // ── Announcement from ops alerts ──
  try {
    const alerts = await fetchJson(ALERTS_URL);
    const now = Date.now();
    const parseT = (s) => {
      if (!s || String(s).startsWith('1970')) return null;
      const m = String(s).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
      return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : null;
    };
    const active = (alerts || []).filter((a) => {
      const st = parseT(a.starts), ex = parseT(a.expires);
      if (st === null && ex === null) return true;
      if (st !== null && now < st) return false;
      if (ex !== null && now > ex) return false;
      return true;
    });
    const ops = active.find((a) => /operations|closed|on hold|paused|lightning|wind/i.test(`${a.headline} ${a.content}`));
    if (ops) {
      out.announcement = decodeEntities(`${ops.headline}: ${String(ops.content).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`);
    }
  } catch (e) {
    console.warn('  alerts.json failed:', e.message);
  }

  console.log(`  Feeds: weather=${out.mountainWeather ? 'ok' : 'fail'}, events=${out.events.length}, summerOps=${out.summerOps ? 'derived' : 'off-window'}`);
  return out;
}

module.exports = { collectFromFeeds };
