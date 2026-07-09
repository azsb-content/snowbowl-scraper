// ─── AGENT SURFACE (pure builders) ────────────────────────────────────────────
// Machine-readable surfaces for scheduled agents (Cowork): the morning brief
// (/brief.json), the Phoenix-vs-mountain heat delta (/heat.json) and the
// marketing-dates calendar (/events.ics).
//
// Everything in this module is a PURE function of (cachedData, now, phx) —
// no fetches, no timers, no state — so it's node -e smoke-testable. server.js
// owns all I/O (the 30-min feed cache and the 15-min Phoenix NOAA cache).
//
// PUBLIC DATA ONLY by construction: snowbowl.ski's own feeds, NOAA, and
// published powerpass.ski facts. Nothing Supabase-adjacent exists in this repo.

const crypto = require('crypto');

// ─── Phoenix time helpers ─────────────────────────────────────────────────────
// America/Phoenix has no DST (fixed UTC-7), so 'en-CA' formatting gives a
// stable YYYY-MM-DD wall date for any instant and the +7h shift to UTC used
// by the ICS builder is always safe.

function phxDateKey(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' });
}

function phxParts(d = new Date()) {
  const [y, m, day] = phxDateKey(d).split('-').map(Number);
  return { year: y, month: m - 1, day }; // month 0-based, like Date#getMonth
}

function pad2(n) { return String(n).padStart(2, '0'); }

// Strict numeric parse: null/undefined/'' and non-finite → null. NEVER use a
// bare Number() on a temperature — Number(null) is 0, which would fabricate
// a 0° reading (the cardinal sin of this surface).
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Whole days between two YYYY-MM-DD keys (b − a). UTC math — DST-immune.
function daysBetweenKeys(a, b) {
  const [ay, am, ad] = String(a).split('-').map(Number);
  const [by, bm, bd] = String(b).split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

function addDaysKey(key, days) {
  const [y, m, d] = String(key).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

// ─── Season tags ──────────────────────────────────────────────────────────────
// MIRROR — update together with app/src/lib/seasons.ts getSeasonalContext().
// Ported verbatim; only change is that year/month/day come from the
// America/Phoenix wall date instead of the browser's local clock.

function nthDow(year, month, weekday, occurrence) {
  // occurrence: 1 = first, 2 = second, -1 = last
  // (the weekday of a calendar date is timezone-independent)
  const first = new Date(year, month, 1);
  const firstDow = first.getDay();
  let day = ((weekday - firstDow + 7) % 7) + 1;
  if (occurrence > 0) day += 7 * (occurrence - 1);
  else { day += 28; while (new Date(year, month, day).getMonth() !== month) day -= 7; }
  return day;
}

function seasonTags(d = new Date()) {
  const { year, month, day } = phxParts(d);
  const tags = [];
  if ((month === 6) || (month === 7) || (month === 8 && day <= 15)) tags.push('monsoon');
  if (month >= 5 && month <= 7) tags.push('phx-heat');
  if ((month === 5 && day >= 20) || month === 6) tags.push('wildflowers');
  if ((month === 8 && day >= 15) || month === 9) tags.push('foliage');
  if ((month === 4 && day >= 23) || month === 5 || month === 6 || (month === 7 && day <= 10)) tags.push('school-out');
  if (month === 7 && day >= 5 && day <= 20) tags.push('back-to-school');
  if (month === 4 && day >= nthDow(year, 4, 1, -1) - 3) tags.push('memorial-day');
  if (month === 8 && day <= nthDow(year, 8, 1, 1) + 1) tags.push('labor-day');
  if (month === 9 && day >= 15) tags.push('pre-season');
  if (month === 10) tags.push('pre-season');
  if (month === 11) tags.push('holiday');
  return tags;
}

// Heat-gap season gate: Jun 1 – Aug 31, America/Phoenix month.
// MIRROR of the app's HeatGap gate (the 'phx-heat' window above).
function inHeatSeason(d = new Date()) {
  const { month } = phxParts(d);
  return month >= 5 && month <= 7;
}

// ─── Power Pass cadence ───────────────────────────────────────────────────────
// MIRRORS of app-side constants — update together:
//   onSale / paymentPlanDay 14 / planEnds '2027-02-01' / source 'powerpass.ski'
//     ↔ app/src/lib/passDeadlines.ts (PASS_ON_SALE, PAYMENT_PLAN_DAY,
//       PAYMENT_PLAN_ENDS, POWERPASS_URL)
//   planFrom '$13/month' ↔ app/src/lib/facts.ts FACTS.paymentPlanFrom
//   deadlines [] mirrors app/src/lib/passDeadlines.ts PASS_DEADLINES, which is
//     DELIBERATELY EMPTY — the 2026/27 Power Pass price is FROZEN (4th year,
//     no increase), so there is NO hard price deadline. NEVER invent one; the
//     real urgency is the monthly payment-plan window (the "14th message").

const PASS_ON_SALE      = true;
const PAYMENT_PLAN_DAY  = 14;
const PAYMENT_PLAN_ENDS = '2027-02-01';
const PLAN_FROM         = '$13/month';
const POWERPASS_URL     = 'powerpass.ski';

// MIRROR of app/src/lib/pulse.ts PLAN_REEL_PROMPT (same facts baked in so the
// number and the end date can never drift between the app and this surface).
const PLAN_REEL_PROMPT =
  'Payment-plan reel — Power Pass from $13/month on the 0% payment plan ' +
  '(plan ends Feb 1, 2027). powerpass.ski';

function passCadence(d = new Date()) {
  const { year, month, day } = phxParts(d);
  let ry = year, rm = month;
  if (day > PAYMENT_PLAN_DAY) { rm += 1; if (rm > 11) { rm = 0; ry += 1; } }
  const nextReelDate = `${ry}-${pad2(rm + 1)}-${pad2(PAYMENT_PLAN_DAY)}`;
  return {
    onSale: PASS_ON_SALE,
    paymentPlanDay: PAYMENT_PLAN_DAY,
    nextReelDate,
    daysToReel: daysBetweenKeys(phxDateKey(d), nextReelDate),
    isReelDay: day === PAYMENT_PLAN_DAY,
    planEnds: PAYMENT_PLAN_ENDS,
    planFrom: PLAN_FROM,
    deadlines: [], // mirrors PASS_DEADLINES — deliberately empty, see above
    source: POWERPASS_URL,
  };
}

// ─── Heat-gap thresholds ──────────────────────────────────────────────────────
// MIRROR of app/src/lib/heatGap.ts FRAME_MIN_DELTA / BIG_DELTA — update together.
const FRAME_MIN_DELTA = 15; // below this the gap isn't a story
const BIG_DELTA       = 30; // headline-worthy gap

// ─── Mountain-side readers (cachedData → normalized shapes) ───────────────────

// cachedData.mountainWeather.current = { conditions, temperature } (feeds.js).
function mtnCurrent(cachedData) {
  const mw = cachedData && cachedData.mountainWeather;
  if (!mw || !mw.current) return null;
  return {
    tempNow: numOrNull(mw.current.temperature),
    conditions: mw.current.conditions || null,
    asOf: mw.asOf || null,
    source: 'snowbowl.ski weather feed',
  };
}

// The snowbowl.ski forecast labels days by WEEKDAY NAME ("Wednesday"), not by
// date. Map each name to the next matching America/Phoenix calendar date
// (today counts) so heat.json can DATE-join against NOAA's real dates.
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function weekdayToDateKey(name, now = new Date()) {
  const target = WEEKDAYS.indexOf(String(name || '').trim().toLowerCase());
  if (target === -1) return null;
  const todayKey = phxDateKey(now);
  const [y, m, d] = todayKey.split('-').map(Number);
  const todayDow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDaysKey(todayKey, (target - todayDow + 7) % 7);
}

function mountainOutlook(cachedData, now = new Date()) {
  const mw = cachedData && cachedData.mountainWeather;
  const fc = mw && Array.isArray(mw.forecast) ? mw.forecast : [];
  const out = [];
  for (const f of fc) {
    if (!f) continue;
    const date = weekdayToDateKey(f.day, now);
    if (!date) continue; // unmappable label — skip, never guess
    out.push({
      date,
      tempMin: numOrNull(f.tempMin),
      tempMax: numOrNull(f.tempMax),
      conditions: f.conditions || null,
    });
  }
  return out;
}

// ─── Events (cachedData.events → brief list + prompts) ────────────────────────

function offeringFor(name) {
  const n = String(name || '');
  if (/family/i.test(n)) return 'family';
  if (/sunset/i.test(n)) return 'sunset';
  if (/wedding/i.test(n)) return 'weddings';
  if (/disc/i.test(n)) return 'disc-golf';
  return null;
}

function slugify(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 40) || 'event';
}

// startISO is Phoenix local wall time 'YYYY-MM-DDTHH:MM:SS' (feeds.js) — the
// calendar date IS the first 10 chars, no timezone conversion needed.
function eventDateKey(ev) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String((ev && ev.startISO) || ''));
  return m ? m[1] : null;
}

function upcomingEvents(cachedData, now = new Date(), withinDays = 14) {
  const todayKey = phxDateKey(now);
  const src = cachedData && Array.isArray(cachedData.events) ? cachedData.events : [];
  const out = [];
  for (const ev of src) {
    const key = eventDateKey(ev);
    if (!key) continue; // no parseable date — can't place it, skip
    const daysOut = daysBetweenKeys(todayKey, key);
    if (daysOut < 0 || daysOut > withinDays) continue;
    out.push({
      name: ev.name || '',
      dateLabel: ev.date || '',
      time: ev.time || '',
      price: ev.price || '',
      url: ev.url || null,
      startISO: ev.startISO || null,
      daysOut,
    });
  }
  out.sort((a, b) => a.daysOut - b.daysOut);
  return out;
}

// The prompt an agent deep-links into Posts (#posts?prompt=...) — same shape
// as the app's Daily Drop / Pulse handoffs. feeds.js dateLabels already embed
// "@ time" for timed events, so only append the time when they don't.
function eventPrompt(ev) {
  let p = `${ev.name} — ${ev.dateLabel}`;
  if (ev.time && !String(ev.dateLabel).includes('@')) p += ` @ ${ev.time}`;
  return p;
}

// ─── Suggestions (deep-link-ready drafts, cap 5) ──────────────────────────────

function buildSuggestions(events, cadence, heat) {
  const extras = [];
  if (cadence.daysToReel <= 1) {
    extras.push({
      id: 'plan-reel',
      tab: 'posts',
      label: cadence.isReelDay
        ? 'Payment-plan reel — today is the 14th'
        : 'Payment-plan reel — the 14th is tomorrow',
      prompt: PLAN_REEL_PROMPT,
      offering: 'pass',
    });
  }
  if (heat && heat.storyWorthy) {
    // Deliberately "on the mountain", NOT a station elevation — this mtn temp
    // is the snowbowl.ski feed, not the app's NOAA summit/midway station.
    extras.push({
      id: 'heat',
      tab: 'posts',
      label: `Heat gap — ${heat.delta}° cooler than Phoenix`,
      prompt: `Phoenix heat escape — Phoenix ${heat.phx}° today, ${heat.mtn}° on the mountain. ${heat.delta}° cooler. Two hours north.`,
      offering: null,
    });
  }
  const seenIds = new Set();
  const fromEvents = events
    .filter((e) => e.daysOut <= 7)
    .map((e) => {
      // Recurring events (weekly live music etc.) share a name — suffix the
      // days-out on repeats so every suggestion id stays unique.
      let id = `evt-${slugify(e.name)}`;
      if (seenIds.has(id)) id += `-${e.daysOut}`;
      seenIds.add(id);
      return {
        id,
        tab: 'posts',
        label: `${e.name} — ${e.daysOut === 0 ? 'today' : `${e.daysOut} day${e.daysOut === 1 ? '' : 's'} out`}`,
        prompt: eventPrompt(e),
        offering: offeringFor(e.name),
      };
    });
  // Cap 5, events first; the reel/heat suggestions always make the cut.
  return fromEvents.slice(0, Math.max(0, 5 - extras.length)).concat(extras);
}

// ─── /brief.json body ─────────────────────────────────────────────────────────
// phx is an optional snapshot of the server's Phoenix NOAA cache ({ tempNow })
// — the route passes it ONLY when the cache is fresh and we're in season. The
// brief never triggers a NOAA fetch itself.

function buildBrief(cachedData, now = new Date(), phx = null) {
  const generatedAt = now.toISOString();
  const tags = seasonTags(now);
  const cadence = passCadence(now);

  if (!cachedData) {
    // Render free-tier cold start / feeds down: pure date math still served.
    return {
      ok: false,
      ready: false,
      generatedAt,
      reason: 'feeds not loaded yet — retry in 60s',
      seasonTags: tags,
      passCadence: cadence,
    };
  }

  const scraped = Date.parse(cachedData.scrapedAt || '');
  const feedAgeSec = Number.isFinite(scraped)
    ? Math.max(0, Math.round((now.getTime() - scraped) / 1000))
    : null;
  // Stale = older than 1.5× the 30-min refresh interval (refresh is overdue).
  const stale = feedAgeSec !== null && feedAgeSec > 45 * 60;

  const cur = mtnCurrent(cachedData);
  const mountain = cur
    ? { tempNow: cur.tempNow, conditions: cur.conditions, asOf: cur.asOf, outlook: mountainOutlook(cachedData, now) }
    : null;

  let heat = null;
  const phxTemp = phx ? numOrNull(phx.tempNow) : null;
  if (inHeatSeason(now) && phxTemp !== null && cur && cur.tempNow !== null) {
    const delta = phxTemp - cur.tempNow;
    heat = {
      phx: phxTemp,
      mtn: cur.tempNow,
      delta,
      storyWorthy: delta >= FRAME_MIN_DELTA,
      bigDelta: delta >= BIG_DELTA,
    };
  }

  const events = upcomingEvents(cachedData, now, 14);

  return {
    ok: true,
    generatedAt,
    feedAgeSec,
    stale,
    mountain,
    summerOps: cachedData.summerOps || null,
    announcement: cachedData.announcement || null,
    // Derived from the ops announcement feeds.js extracts from active alerts.
    alertsActive: !!cachedData.announcement,
    events,
    seasonTags: tags,
    passCadence: cadence,
    heat,
    suggestions: buildSuggestions(events, cadence, heat),
  };
}

// ─── /heat.json body ──────────────────────────────────────────────────────────

// Widest Phoenix-vs-mountain day over the next 5 days. DATE-join (YYYY-MM-DD)
// — NOT the app's NOAA label-join (heatGap.ts joins two NOAA outlooks by
// period name). The sources differ here: NOAA gives real dates while the
// snowbowl.ski feed gives weekday names, which weekdayToDateKey() resolves
// against the Phoenix calendar.
function bestPushDay(cachedData, phx, now = new Date()) {
  const daily = phx && Array.isArray(phx.daily) ? phx.daily : [];
  if (!daily.length) return null;
  const mtnByDate = new Map();
  for (const o of mountainOutlook(cachedData, now)) {
    if (o.tempMax !== null && !mtnByDate.has(o.date)) mtnByDate.set(o.date, o.tempMax);
  }
  const todayKey = phxDateKey(now);
  let best = null;
  for (const p of daily) {
    if (!p || !p.date) continue;
    const high = numOrNull(p.high);
    if (high === null) continue;
    const daysOut = daysBetweenKeys(todayKey, p.date);
    if (daysOut < 0 || daysOut > 5) continue;
    const mtnHigh = mtnByDate.get(p.date);
    if (mtnHigh === undefined) continue;
    const delta = high - mtnHigh;
    if (!best || delta > best.delta) {
      best = { label: p.label || p.date, date: p.date, phxHigh: high, mtnHigh, delta };
    }
  }
  return best;
}

function buildHeatBody(cachedData, phx, now = new Date()) {
  const generatedAt = now.toISOString();
  const tags = seasonTags(now);

  if (!inHeatSeason(now)) {
    return {
      ok: true,
      inSeason: false,
      generatedAt,
      phx: null,
      mtn: null,
      delta: null,
      storyWorthy: false,
      bigDelta: false,
      bestPushDay: null,
      seasonTags: tags,
      note: 'Heat gap runs Jun 1 – Aug 31',
    };
  }

  const phxBody = phx
    ? {
        tempNow: numOrNull(phx.tempNow),
        highToday: numOrNull(phx.highToday),
        short: phx.short || null,
        fetchedAt: phx.fetchedAt || null,
        stale: !!phx.stale,
      }
    : null; // NOAA down with no cache — NEVER a fabricated temp

  const mtn = mtnCurrent(cachedData);

  const delta =
    phxBody && phxBody.tempNow !== null && mtn && mtn.tempNow !== null
      ? phxBody.tempNow - mtn.tempNow
      : null;

  return {
    ok: true,
    inSeason: true,
    generatedAt,
    phx: phxBody,
    mtn,
    delta,
    storyWorthy: delta !== null && delta >= FRAME_MIN_DELTA, // MIRROR heatGap.ts FRAME_MIN_DELTA
    bigDelta: delta !== null && delta >= BIG_DELTA,          // MIRROR heatGap.ts BIG_DELTA
    bestPushDay: bestPushDay(cachedData, phx, now),
    seasonTags: tags,
    sources: {
      phx: 'api.weather.gov hourly (Phoenix Sky Harbor)',
      mtn: 'snowbowl.ski weather.json',
    },
  };
}

// ─── /events.ics (RFC 5545, hand-built — no npm deps) ─────────────────────────

// Escape TEXT property values: backslash first, strip CR, LF → \n, then ; and ,
function icsEscape(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '')
    .replace(/\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

// RFC 5545 §3.1 line folding — fold at 74 chars; continuations start with one
// space (so every physical line stays ≤ 74 chars incl. the leading space).
function foldLine(line) {
  if (line.length <= 74) return line;
  let out = line.slice(0, 74);
  for (let i = 74; i < line.length; i += 73) out += '\r\n ' + line.slice(i, i + 73);
  return out;
}

function shortHash(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8);
}

// 'YYYY-MM-DDTHH:MM:SS' (Phoenix wall time) → parts, or null if unparseable.
function parseStartISO(startISO) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(startISO || ''));
  if (!m) return null;
  return {
    y: +m[1], mo: +m[2], d: +m[3],
    hh: m[4] === undefined ? 0 : +m[4],
    mm: m[5] === undefined ? 0 : +m[5],
    ss: m[6] === undefined ? 0 : +m[6],
    hasTime: m[4] !== undefined,
  };
}

// Phoenix wall-time parts → UTC basic format (AZ is fixed UTC-7, no DST).
function phxToUtcStamp(y, mo, d, hh, mm, ss) {
  const t = new Date(Date.UTC(y, mo - 1, d, hh + 7, mm, ss));
  return `${t.getUTCFullYear()}${pad2(t.getUTCMonth() + 1)}${pad2(t.getUTCDate())}` +
    `T${pad2(t.getUTCHours())}${pad2(t.getUTCMinutes())}${pad2(t.getUTCSeconds())}Z`;
}

function utcStampOf(d) {
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
}

function dateValueOf(key) { return String(key).replace(/-/g, ''); }

// Deep-Link Protocol: the app parses #posts?prompt=...&offering=...&mode=...
// on load (prefill only — the app never auto-fires AI from a URL). Keys and
// encodeURIComponent must match that grammar exactly.
function postsDeepLink(appUrl, params) {
  if (!appUrl) return null; // unverified host — omit deep-link lines entirely
  const q = Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `${appUrl}/#posts?${q}`;
}

function buildEventsIcs(cachedData, now = new Date(), appUrl = '') {
  const todayKey = phxDateKey(now);
  const dtstamp = utcStampOf(now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Arizona Snowbowl//snowbowl-scraper//EN',
    'CALSCALE:GREGORIAN',
    'X-WR-CALNAME:Snowbowl Marketing Dates',
  ];

  const pushEvent = (fields) => {
    lines.push('BEGIN:VEVENT');
    for (const f of fields) lines.push(f);
    lines.push('END:VEVENT');
  };

  // (1) resort events + (2) draft-window companions
  const events = cachedData && Array.isArray(cachedData.events) ? cachedData.events : [];
  for (const ev of events) {
    const p = parseStartISO(ev && ev.startISO);
    if (!p) continue; // unparseable date — never emit a broken VEVENT
    const uidHash = shortHash(`${ev.url || ev.name || ''}${ev.startISO}`);
    const dateKey = `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`;
    const isAllDay = !!ev.allDay || !p.hasTime || (p.hh === 0 && p.mm === 0);
    const prompt = eventPrompt({ name: ev.name || '', dateLabel: ev.date || '', time: ev.time || '' });
    const link = postsDeepLink(appUrl, { prompt });

    const descParts = [];
    if (ev.price) descParts.push(`Price: ${ev.price}`);
    if (ev.url) descParts.push(ev.url);
    if (link) descParts.push(`Draft it: ${link}`);

    const fields = [`UID:evt-${uidHash}@snowbowl-scraper`, `DTSTAMP:${dtstamp}`];
    if (isAllDay) {
      fields.push(`DTSTART;VALUE=DATE:${dateValueOf(dateKey)}`);
      fields.push(`DTEND;VALUE=DATE:${dateValueOf(addDaysKey(dateKey, 1))}`);
    } else {
      fields.push(`DTSTART:${phxToUtcStamp(p.y, p.mo, p.d, p.hh, p.mm, p.ss)}`);
      // +1h placeholder — the feed carries no end time
      fields.push(`DTEND:${phxToUtcStamp(p.y, p.mo, p.d, p.hh + 1, p.mm, p.ss)}`);
    }
    fields.push(`SUMMARY:${icsEscape(ev.name || 'Snowbowl event')}`);
    if (descParts.length) fields.push(`DESCRIPTION:${icsEscape(descParts.join('\n'))}`);
    pushEvent(fields);

    // Draft-window companion — all-day marker 3 days ahead of every future
    // event (the "sell next-day, not game-day" rule). Skip once passed.
    if (dateKey >= todayKey) {
      const draftKey = addDaysKey(dateKey, -3);
      if (draftKey >= todayKey) {
        const draftFields = [
          `UID:draft-${uidHash}@snowbowl-scraper`,
          `DTSTAMP:${dtstamp}`,
          `DTSTART;VALUE=DATE:${dateValueOf(draftKey)}`,
          `DTEND;VALUE=DATE:${dateValueOf(addDaysKey(draftKey, 1))}`,
          `SUMMARY:${icsEscape(`Draft: ${ev.name || 'Snowbowl event'} (post window opens)`)}`,
        ];
        if (link) draftFields.push(`DESCRIPTION:${icsEscape(`Draft it: ${link}`)}`);
        pushEvent(draftFields);
      }
    }
  }

  // (3) payment-plan reel series — the 14th of each month, current Phoenix
  // month through the last 14th strictly before PAYMENT_PLAN_ENDS (2027-01-14).
  const { year: nowY, month: nowM } = phxParts(now);
  const [endY, endM, endD] = PAYMENT_PLAN_ENDS.split('-').map(Number);
  let lastY = endY, lastM = endM - 1; // 0-based month of the final reel day
  if (endD <= PAYMENT_PLAN_DAY) { lastM -= 1; if (lastM < 0) { lastM = 11; lastY -= 1; } }

  const reelLink = postsDeepLink(appUrl, { offering: 'pass', mode: 'caption', prompt: PLAN_REEL_PROMPT });
  let y = nowY, m = nowM;
  while (y < lastY || (y === lastY && m <= lastM)) {
    const key = `${y}-${pad2(m + 1)}-${pad2(PAYMENT_PLAN_DAY)}`;
    const descParts = ['Post the 0% payment-plan reel. Power Pass from $13/month. powerpass.ski'];
    if (reelLink) descParts.push(`Draft it: ${reelLink}`);
    pushEvent([
      `UID:plan-${key}@snowbowl-scraper`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${dateValueOf(key)}`,
      `DTEND;VALUE=DATE:${dateValueOf(addDaysKey(key, 1))}`,
      'SUMMARY:Power Pass payment-plan reel day',
      `DESCRIPTION:${icsEscape(descParts.join('\n'))}`,
    ]);
    m += 1; if (m > 11) { m = 0; y += 1; }
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

// ─── /offerings.json body ─────────────────────────────────────────────────────
// The OFFERING FACT BRAIN — public product facts only (no feed, no NOAA, no
// team/guest data, no PII). This is the ONE agent endpoint with no I/O: every
// value below is a static constant, so the route answers INSTANTLY even during a
// Render cold start (nothing to refresh).
//
// MIRROR — the app is the source of truth. When these change, update this block
// AND docs/AUTOMATION.md §6 in the same commit:
//   FACTS / FACT_PHRASES      ↔ app/src/lib/facts.ts
//   OFFERINGS (public subset) ↔ app/src/lib/offerings.ts (id, name, eyebrow,
//     sunset, whatItIs, facts[], angles[], titleIdeas[], storyBody, heroStat).
// Only the PUBLIC product fields are mirrored — the app's LLM-context helpers
// (offeringContext / offeringStoryFrame) are NOT part of the surface.

// FACTS — single source of truth for prices/dates that drift (mirror facts.ts).
const FACTS = {
  // Power Pass
  passAdultFrom:     '$349',
  paymentPlanFrom:   '$13/month',
  passHeldSinceYear: 2023,
  passMountains:     12,
  // Family Fridays
  familyFridayAdult:  '$59',
  familyFridayKid:    '$39',
  familyFridayWindow: 'May 22–August 7',
  // Gondola + activities
  bowlBucks:      '$10',
  sunsetRideFrom: '$19',
  gondolaFrom:    '$3',
  // Elevation (feet): summitFt = top of the gondola (11,500); agassizFt =
  // Agassiz Lodge, mountain dining + activities (9,500).
  summitFt:  11500,
  agassizFt: 9500,
};

// Pre-built phrases so the WORDING stays consistent too (mirror facts.ts).
const FACT_PHRASES = {
  passValue:     `${FACTS.passMountains} mountains on one pass, kids 12 and under ski free, adult passes from ${FACTS.passAdultFrom}`,
  heldSince:     `prices held since ${FACTS.passHeldSinceYear}`,
  paymentPlan:   `payment plans from ${FACTS.paymentPlanFrom}`,
  familyFridays: `Every Friday, ${FACTS.familyFridayWindow}: all-day unlimited activities, unlimited gondola rides, and treasure panning. Adults ${FACTS.familyFridayAdult}, kids 12 and under ${FACTS.familyFridayKid}`,
};

// Deterministic thousands separator — the app builds these strings with
// Number#toLocaleString(); reproduce "11,500"/"9,500" here WITHOUT depending on
// the server's default ICU locale (which is not guaranteed to be en-US).
function withCommas(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// OFFERINGS — public product fields only (mirror offerings.ts OFFERINGS). Strings
// interpolate the local FACTS above exactly as the app does, so a FACTS bump
// updates every offering line in lockstep (no drifting hardcoded prices/dates).
const OFFERINGS = [
  {
    id: 'gondola',
    name: 'Scenic Gondola + Activities',
    eyebrow: 'TOP OF ARIZONA',
    whatItIs: `Arizona's only gondola. Eight minutes to the top of the state. Scenic rides, tubing, climbing wall, bungee, mini golf, treasure panning — a full mountain day from the base to 11,500 feet.`,
    facts: [
      `Gondola rides from ${FACTS.gondolaFrom}`,
      `Buy online for ${FACTS.bowlBucks} Bowl Bucks back`,
      `${withCommas(FACTS.summitFt)} ft summit — Grand Canyon on clear days`,
      'Open daily through summer',
    ],
    angles: [
      'Eight minutes to the top of Arizona.',
      '70-mile views on a clear day.',
      'A full mountain day for every age.',
      "When Phoenix hits 100°, up here it's 65.",
    ],
    titleIdeas: ['TOP OF\nARIZONA', 'EIGHT\nMINUTES UP', 'ONLY IN\nARIZONA', 'COOL OFF\nUP HIGH'],
    storyBody: 'SCENIC RIDES TO\n11,500 FEET',
    heroStat: { value: '11,500', label: 'FEET UP' },
  },
  {
    id: 'sunset',
    name: 'Sunset Dinners',
    eyebrow: 'SUNSET DINNERS',
    sunset: true,
    whatItIs: `Sunset gondola rides paired with dinner by our chef at Agassiz Lodge (${withCommas(FACTS.agassizFt)} ft), Friday and Saturday evenings.`,
    facts: [
      'Friday + Saturday evenings',
      `Dinner at Agassiz Lodge, ${withCommas(FACTS.agassizFt)} ft`,
      `Sunset gondola rides from ${FACTS.sunsetRideFrom}`,
      'Reservations recommended',
    ],
    angles: [
      'Two hours from Phoenix, no other restaurant this cold and this high.',
      'Sunset rides to 11,500, then dinner while the valley turns.',
      'The only gondola dinner in Arizona. Friday and Saturday only.',
      'Thirty degrees cooler than town, gold light, no haze.',
    ],
    titleIdeas: ['DINNER\nWITH A VIEW', 'GOLDEN\nHOUR', "ARIZONA'S\nHIGHEST TABLE", 'SUNSET\nAT THE TOP'],
    storyBody: 'SUNSET RIDES AND DINNER\nFRIDAY AND SATURDAY',
    heroStat: { value: '9,500', label: 'FEET AT SUNSET' },
  },
  {
    id: 'family',
    name: 'Family Fridays',
    eyebrow: 'FAMILY FRIDAYS',
    whatItIs: `Every Friday (${FACTS.familyFridayWindow}): unlimited all-day activities, unlimited gondola rides, and treasure panning.`,
    facts: [
      `Every Friday, ${FACTS.familyFridayWindow}`,
      'Unlimited activities + gondola',
      'Treasure panning included',
      `Adults ${FACTS.familyFridayAdult}, kids 12 & under ${FACTS.familyFridayKid}`,
    ],
    angles: [
      'Every Friday: one price, unlimited rides and activities, all day.',
      'The one deal families actually plan around.',
      'Cool air and tubing until the kids crash.',
      'Unlimited gondola, unlimited activities, one family-sized price.',
    ],
    titleIdeas: ['FAMILY\nFRIDAYS', 'UNLIMITED\nFRIDAY', 'EVERY\nFRIDAY', 'ONE PRICE\nALL DAY'],
    storyBody: 'UNLIMITED RIDES AND\nACTIVITIES ALL DAY',
    heroStat: { value: 'UNLIMITED', label: 'EVERY FRIDAY' },
  },
  {
    id: 'pass',
    name: 'Power Pass',
    eyebrow: 'POWER PASS',
    whatItIs: `The Power Pass — ${FACTS.passMountains} mountains, prices locked since ${FACTS.passHeldSinceYear}, kids 12 and under ski free, payment plans from ${FACTS.paymentPlanFrom}.`,
    facts: [
      `Adult passes from ${FACTS.passAdultFrom}`,
      `${FACTS.passMountains} mountains on one pass`,
      `Payment plans from ${FACTS.paymentPlanFrom}`,
      `Prices held since ${FACTS.passHeldSinceYear}`,
    ],
    angles: [
      `Prices held since ${FACTS.passHeldSinceYear} — summer's the time to lock in.`,
      'Next winter costs less when you buy now.',
      `Payment plans as low as ${FACTS.paymentPlanFrom} — spread the cost.`,
      `${FACTS.passMountains} mountains, one price, kids free, locked.`,
    ],
    titleIdeas: ['ONE PASS\n12 MOUNTAINS', 'KIDS\nSKI FREE', 'NEXT WINTER\nSTARTS NOW', 'LOCK IN\nTODAY'],
    storyBody: '12 MOUNTAINS, ONE PASS\nKIDS SKI FREE',
    heroStat: { value: '12', label: 'MOUNTAINS ONE PASS' },
  },
  {
    id: 'disc-golf',
    name: 'Alpine Disc Golf',
    eyebrow: 'DISC GOLF',
    whatItIs: "Arizona's highest disc golf — a free 18-hole course in the pines at 9,300 ft, with cool air and mountain views. Bring your own disc or rent one.",
    facts: [
      'Free 18-hole course on the mountain',
      'Open daily through summer',
      '9,300 ft — cool air and mountain views',
      "Home of the Brewer's Cup Disc Golf Tournament",
    ],
    angles: [
      'Free 18 holes in the pines at 9,300 feet — no greens fees.',
      'Cooler air, mountain views, zero crowds.',
      'Bring a disc or rent one and play all day.',
      'The highest disc golf course in Arizona.',
    ],
    titleIdeas: ['FREE ROUNDS\nAT ELEVATION', 'DISC GOLF\nIN THE PINES', '9,300 FEET\nOF FAIRWAYS', 'COOL OFF\nUP HIGH'],
    storyBody: '18 HOLES\nZERO GREENS FEES',
    heroStat: { value: 'FREE', label: '18 HOLES' },
  },
  {
    id: 'basecamp',
    name: 'Basecamp Lodging',
    eyebrow: 'STAY ON THE MOUNTAIN',
    whatItIs: "Basecamp at Snowbowl — cabins and rooms at 9,300 ft with a full restaurant and bar, on-site recreation, and a free scenic gondola ride for every guest each night. Pet-friendly.",
    facts: [
      '22 cabins, including the historic Clark Gable cabin',
      'One free scenic gondola ride per guest, per night',
      'Full restaurant and bar on-site, open daily',
      'Pet-friendly — $15 per pet, per night',
      `Passholders: 15% off lodging plus ${FACTS.bowlBucks} Bowl Bucks`,
    ],
    angles: [
      'Sleep at 9,300 feet. Wake up to a free gondola ride.',
      'Full restaurant on-site — no drive down the mountain for dinner.',
      'Pet-friendly cabins with firepits and mountain air.',
      'The only way to stay the night at the top of Arizona.',
    ],
    titleIdeas: ['STAY ON\nTHE MOUNTAIN', 'MOUNTAIN\nNIGHTS', 'SLEEP UP\nHERE', 'CABINS AT\n9,300 FEET'],
    storyBody: 'CABINS AT 9,300 FEET\nFREE GONDOLA NIGHTLY',
    heroStat: { value: '9,300', label: 'FEET UP' },
  },
  {
    id: 'group-events',
    name: 'Group Outings',
    eyebrow: 'BRING YOUR CREW',
    whatItIs: "Private group outings and team retreats at 9,300 ft — activities, dining, and lodging in one place, with full-service catering from casual BBQ to elegant dinners.",
    facts: [
      'Cabins, catering, and activities in one place',
      'Full-service catering — boxed lunches to smoked BBQ to plated dinners',
      'Unlimited summer activities for the group',
      'Reserve the on-site restaurant for private events',
    ],
    angles: [
      'Cool air and altitude for team focus — 30 degrees cooler than Phoenix.',
      'All-day activities built in: tubing, climbing wall, mini golf, gondola.',
      'One venue: cabins, food, activities, mountain views.',
      'Custom catering, casual to elegant.',
    ],
    titleIdeas: ['BRING YOUR\nCREW', 'TEAM RETREAT\nAT ALTITUDE', 'GROUP GOALS\nMOUNTAIN AIR', 'TOGETHER\nUP HERE'],
    storyBody: 'ONE VENUE\nEVERYTHING INCLUDED',
  },
  {
    id: 'weddings',
    name: 'Mountain Weddings',
    eyebrow: 'ELEVATION AND ELEGANCE',
    whatItIs: "Full-service mountain weddings at 9,300 ft — indoor and outdoor ceremony spaces, on-site catering from rehearsal to reception, and Basecamp lodging for guests.",
    facts: [
      'Indoor and outdoor ceremony and reception spaces',
      'Full-service catering, rehearsal dinner through reception',
      'On-mountain lodging at Basecamp for guests',
      'Now booking 2026 and 2027',
    ],
    angles: [
      'Exchange vows at 9,300 feet with the Peaks as your backdrop.',
      'Chef-crafted catering from rehearsal through reception.',
      'Guests sleep on the mountain — no long drive after dancing.',
      'Altitude, views, and full service in one rare venue.',
    ],
    titleIdeas: ['VOWS AT\nELEVATION', 'WEDDING IN\nTHE PEAKS', 'PEAKS AND\nVOWS', 'I DO\nUP HERE'],
    storyBody: 'VOWS AT 9,300 FEET\nRECEPTION AND LODGING',
    heroStat: { value: '9,300', label: 'FEET UP' },
  },
  {
    id: 'vr-skiing',
    name: 'Summer VR Skiing',
    eyebrow: 'DOWNHILL IN SUMMER',
    whatItIs: `Immersive 15-minute virtual-reality ski runs at Agassiz Lodge (${withCommas(FACTS.agassizFt)} ft) — practice your line, race friends, or ski summer pow with no snow. Ages 7+.`,
    facts: [
      '15-minute VR ski runs, daily in summer',
      '$10 weekdays, $15 weekends',
      'Ages 7 and up, 55–250 lbs',
      `At Agassiz Lodge, ${withCommas(FACTS.agassizFt)} ft`,
    ],
    angles: [
      'Ski virtual pow without waiting for snow.',
      'Practice your line in summer, ski it in winter.',
      'Race a friend down the same run.',
      'Fifteen minutes of downhill at 9,500 feet.',
    ],
    titleIdeas: ['SKI SUMMER\nPOW', 'VIRTUAL\nDOWNHILL', 'RACE YOUR\nFRIENDS', 'SKI WITH\nNO SNOW'],
    storyBody: '15-MINUTE SKI RUNS\nANY SEASON',
    heroStat: { value: '15 MIN', label: 'SKI RUNS' },
  },
  {
    id: 'lessons',
    name: 'Ski & Ride School',
    eyebrow: 'LEARN TO SKI AND RIDE',
    whatItIs: "Ski & Ride School group lessons for every age and ability — never-ever beginners to advanced, with certified instructors and gear-included options.",
    facts: [
      'Group lessons for all ages and abilities',
      'Never-ever beginner options for first-timers',
      'Gear-included lesson packages available',
      'Certified instructors, small groups',
    ],
    angles: [
      'From the bunny hill to the lift in one day.',
      'Certified instructors, small groups, every level.',
      'Rent gear and take a lesson — walk in with nothing.',
      "Kids progress fast on Snowbowl's beginner terrain.",
    ],
    titleIdeas: ['LEARN TO\nSKI TODAY', 'FIRST CHAIR\nFIRST TIME', 'BUNNY TO\nBLUE RUN', 'EVERY LEVEL\nWELCOME'],
    storyBody: 'ALL AGES AND ABILITIES\nCERTIFIED INSTRUCTORS',
  },
  {
    id: 'rentals',
    name: 'Rentals',
    eyebrow: 'RENT AND RIDE',
    whatItIs: "Full equipment rentals — skis, snowboards, boots, and helmets — so you can show up with nothing and still ride. Demo gear available.",
    facts: [
      'Skis, boards, boots, and helmets available',
      'Show up with nothing and still ride',
      'Demo gear to try before you buy',
    ],
    angles: [
      'Show up in jeans. Ride in boots.',
      'Demo the latest skis and boards before you buy.',
      'Helmets and gear included.',
      'A few hours from Phoenix, zero gear needed.',
    ],
    titleIdeas: ['NO GEAR\nNO PROBLEM', 'RENT AND\nRIDE TODAY', 'EVERYTHING\nINCLUDED', 'SHOW UP\nSKI NOW'],
    storyBody: 'FULL RENTAL SHOP\nSHOW UP AND RIDE',
    heroStat: { value: 'NO GEAR', label: 'NO PROBLEM' },
  },
  {
    id: 'lift-ticket',
    name: 'Lift Tickets',
    eyebrow: 'SKI AND RIDE',
    whatItIs: "Day-pass lift tickets for the winter season — all-day access to open terrain and the gondola. Also on the Power Pass, weather permitting.",
    facts: [
      'All-day lift access for the ski season',
      'Season runs late fall through spring, weather permitting',
      `Or ride on the Power Pass — ${FACTS.passMountains} mountains, kids 12 & under ski free`,
    ],
    angles: [
      'One day, unlimited terrain.',
      'Spring corn snow through deep winter pow.',
      'Weekdays are yours — beat the weekend crowds.',
      'The top of Arizona, lift-served.',
    ],
    titleIdeas: ['SKI\nTODAY', 'ALL DAY\nON THE HILL', 'LIFTS ARE\nSPINNING', 'FRESH SNOW\nWAITS'],
    storyBody: 'DAY PASS\nUNLIMITED TERRAIN',
    heroStat: { value: 'ALL DAY', label: 'ONE TICKET' },
  },
];

// Offering-of-the-day: DETERMINISTIC daily rotation, seeded by the America/Phoenix
// day-of-year (never randomizes within a day). WEIGHTED toward the summer hero /
// anchor offerings per the strategy — Sunset Dinners and Family Fridays heaviest,
// then the other summer draws — so the pick leans on the anchors but still cycles.
const OFFERING_OF_DAY_WEIGHTS = { sunset: 4, family: 4, gondola: 2, pass: 2 };
const HERO_OFFERING_IDS = new Set(['sunset', 'family']);

function phxDayOfYear(now = new Date()) {
  const { year, month, day } = phxParts(now);
  return Math.round((Date.UTC(year, month, day) - Date.UTC(year, 0, 1)) / 86400000);
}

function offeringOfDayReason(o) {
  const angle = (o.angles && o.angles[0]) || o.whatItIs;
  return HERO_OFFERING_IDS.has(o.id)
    ? `${o.name} is a summer anchor — ${angle}`
    : `Today's rotation: ${o.name}. ${angle}`;
}

function offeringOfDay(now = new Date()) {
  const bag = [];
  for (const o of OFFERINGS) {
    const w = OFFERING_OF_DAY_WEIGHTS[o.id] || 1;
    for (let i = 0; i < w; i++) bag.push(o.id);
  }
  const doy = phxDayOfYear(now);
  const id = bag[((doy % bag.length) + bag.length) % bag.length];
  const o = OFFERINGS.find((x) => x.id === id) || OFFERINGS[0];
  return { id: o.id, reason: offeringOfDayReason(o) };
}

// Pure builder for GET /offerings.json. appUrl is threaded through so the per-
// offering deep links resolve to the live app; when it's '' (unverified host)
// postsDeepLink returns null and deepLink/captionLink degrade gracefully. No I/O.
function buildOfferings(now = new Date(), appUrl = '') {
  return {
    ok: true,
    generatedAt: now.toISOString(),
    facts: { ...FACTS },
    phrases: { ...FACT_PHRASES },
    offerings: OFFERINGS.map((o) => ({
      id: o.id,
      name: o.name,
      eyebrow: o.eyebrow,
      sunset: !!o.sunset,
      whatItIs: o.whatItIs,
      facts: o.facts.slice(),
      angles: o.angles.slice(),
      titleIdeas: o.titleIdeas.slice(),
      storyBody: o.storyBody,
      heroStat: o.heroStat || null,
      deepLink: postsDeepLink(appUrl, { offering: o.id, mode: 'story' }),
      captionLink: postsDeepLink(appUrl, { offering: o.id, mode: 'caption' }),
    })),
    offeringOfDay: offeringOfDay(now),
  };
}

module.exports = {
  // route-body builders
  buildBrief,
  buildHeatBody,
  buildEventsIcs,
  buildOfferings,
  // date/season/cadence helpers (server.js + smoke tests)
  phxDateKey,
  numOrNull,
  seasonTags,
  inHeatSeason,
  passCadence,
  // pure pieces exported for smoke tests
  icsEscape,
  foldLine,
  weekdayToDateKey,
  bestPushDay,
  eventPrompt,
  // mirrored constants
  FRAME_MIN_DELTA,
  BIG_DELTA,
  PLAN_REEL_PROMPT,
};
