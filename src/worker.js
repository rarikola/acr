// Astra Capital Research Worker.
// Serves the static site from ./public and adds one API route:
//   GET /api/track  ->  every pick in public/picks.json with entry price,
//                       live (or exit) price, % return and the SPY benchmark.
//
// Rules (also shown on the picks page):
//   * Entry  = official opening price on the pick date (picks are published
//              pre-market, so the open is the first price anyone could trade at).
//   * Live   = latest quote (delayed ~15 min) while the pick is open.
//   * Exit   = closing price on the first trading day on/after pick date + horizon_days;
//              after that the result is frozen.
//   * Bearish picks ("direction": "short") count a falling stock as a gain.
//   * Benchmark = SPY over the same entry -> now/exit window.
//
// Prices come from Yahoo Finance's public chart endpoint, with Stooq as a fallback.
// Responses are cached at the edge for CACHE_SECONDS.

const CACHE_SECONDS = 300;
const BENCHMARK = "SPY";
const UA = "Mozilla/5.0 (compatible; AstraCapitalResearch/1.0; +https://astracapitalresearch.com)";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/track") {
      return handleTrack(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleTrack(request, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(new URL("/api/track", request.url).toString(), { method: "GET" });
  const fresh = new URL(request.url).searchParams.has("fresh");
  if (!fresh) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  let body;
  try {
    body = await buildTrack(request, env);
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) }, 500, 0);
  }
  const res = json(body, 200, CACHE_SECONDS);
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

export async function buildTrack(request, env, fetcher = fetch, now = new Date()) {
  const picksRes = await env.ASSETS.fetch(new Request(new URL("/picks.json", request.url)));
  if (!picksRes.ok) throw new Error("picks.json not found");
  const data = await picksRes.json();
  const picks = Array.isArray(data.picks) ? data.picks : [];
  const horizon = Number(data.horizon_days) || 30;

  if (!picks.length) {
    return { ok: true, updated: now.toISOString(), horizon_days: horizon, picks: [], summary: summarize([]) };
  }

  const earliest = picks.map(p => p.date).sort()[0];
  const symbols = [...new Set(picks.map(p => String(p.symbol).toUpperCase()).concat(BENCHMARK))];

  const series = {};
  await Promise.all(symbols.map(async sym => {
    series[sym] = await getSeries(sym, earliest, now, fetcher);
  }));

  const today = isoDateInNY(now);
  const bench = series[BENCHMARK];
  const rows = picks.map(p => evaluate(p, series[String(p.symbol).toUpperCase()], bench, horizon, today));
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.symbol.localeCompare(b.symbol)));

  return { ok: true, updated: now.toISOString(), horizon_days: horizon, picks: rows, summary: summarize(rows) };
}

function evaluate(p, s, bench, horizon, today) {
  const row = {
    id: p.id || `${p.date}-${p.symbol}`,
    date: p.date,
    symbol: String(p.symbol).toUpperCase(),
    name: p.name || "",
    direction: p.direction === "short" ? "short" : "long",
    premarket_ref: p.premarket_ref ?? null,
    report: p.report || null,
    note: p.note || "",
    entry: null, entry_date: null,
    price: null, price_date: null,
    status: "pending",           // pending | open | closed | nodata
    exit_target: addDays(p.date, horizon),
    ret: null, spy_ret: null, vs_spy: null,
    days_held: null,
  };

  if (!s || !s.bars.length) { row.status = "nodata"; return row; }

  const entryBar = s.bars.find(b => b.date >= p.date && b.open > 0);
  if (!entryBar) { row.status = "pending"; return row; }   // pick date's open hasn't happened yet
  row.entry = entryBar.open;
  row.entry_date = entryBar.date;

  const exitBar = row.exit_target <= today ? s.bars.find(b => b.date >= row.exit_target && b.close > 0) : null;
  if (exitBar) {
    row.status = "closed";
    row.price = exitBar.close;
    row.price_date = exitBar.date;
  } else {
    row.status = "open";
    row.price = s.live ?? s.bars[s.bars.length - 1].close;
    row.price_date = s.liveDate || s.bars[s.bars.length - 1].date;
  }

  row.ret = pct(row.entry, row.price, row.direction);
  row.days_held = daysBetween(row.entry_date, row.status === "closed" ? row.price_date : today);

  if (bench && bench.bars.length) {
    const bEntry = bench.bars.find(b => b.date >= row.entry_date && b.open > 0);
    let bEnd = null;
    if (row.status === "closed") {
      const bb = bench.bars.find(b => b.date >= row.price_date && b.close > 0);
      bEnd = bb ? bb.close : null;
    } else {
      bEnd = bench.live ?? bench.bars[bench.bars.length - 1].close;
    }
    if (bEntry && bEnd) {
      row.spy_ret = pct(bEntry.open, bEnd, "long");
      row.vs_spy = round(row.ret - row.spy_ret, 2);
    }
  }
  return row;
}

function summarize(rows) {
  const scored = rows.filter(r => r.ret !== null);
  const closed = scored.filter(r => r.status === "closed");
  const avg = arr => arr.length ? round(arr.reduce((a, b) => a + b, 0) / arr.length, 2) : null;
  const winRate = arr => arr.length ? round(100 * arr.filter(r => r.ret > 0).length / arr.length, 1) : null;
  return {
    total: rows.length,
    open: rows.filter(r => r.status === "open").length,
    closed: closed.length,
    pending: rows.filter(r => r.status === "pending" || r.status === "nodata").length,
    win_rate: winRate(scored),
    win_rate_closed: winRate(closed),
    avg_return: avg(scored.map(r => r.ret)),
    avg_vs_spy: avg(scored.filter(r => r.vs_spy !== null).map(r => r.vs_spy)),
    best: scored.length ? scored.reduce((a, b) => (b.ret > a.ret ? b : a)).symbol : null,
    worst: scored.length ? scored.reduce((a, b) => (b.ret < a.ret ? b : a)).symbol : null,
  };
}

// ---------- price data ----------

async function getSeries(sym, fromDate, now, fetcher) {
  try {
    const s = await yahooSeries(sym, fromDate, now, fetcher);
    if (s && s.bars.length) return s;
  } catch (_) { /* fall through */ }
  try {
    const s = await stooqSeries(sym, fromDate, now, fetcher);
    if (s && s.bars.length) return s;
  } catch (_) { /* fall through */ }
  return null;
}

async function yahooSeries(sym, fromDate, now, fetcher) {
  const p1 = Math.floor(Date.parse(addDays(fromDate, -5) + "T00:00:00Z") / 1000);
  const p2 = Math.floor(now.getTime() / 1000) + 86400;
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${p2}&interval=1d&includePrePost=false&events=div%2Csplit`;
  const r = await fetcher(u, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!r.ok) throw new Error(`yahoo ${r.status}`);
  const j = await r.json();
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error("yahoo empty");
  const tz = (res.meta && res.meta.exchangeTimezoneName) || "America/New_York";
  const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
  const ts = res.timestamp || [];
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const open = q.open && q.open[i], close = q.close && q.close[i];
    if (open == null && close == null) continue;
    bars.push({ date: isoDateInTZ(new Date(ts[i] * 1000), tz), open: num(open), close: num(close) });
  }
  dedupeByDate(bars);
  const live = num(res.meta && res.meta.regularMarketPrice);
  const liveDate = res.meta && res.meta.regularMarketTime ? isoDateInTZ(new Date(res.meta.regularMarketTime * 1000), tz) : null;
  return { bars, live: live > 0 ? live : null, liveDate, source: "yahoo" };
}

async function stooqSeries(sym, fromDate, now, fetcher) {
  const d1 = addDays(fromDate, -5).replace(/-/g, "");
  const d2 = addDays(isoDateInNY(now), 1).replace(/-/g, "");
  const u = `https://stooq.com/q/d/l/?s=${encodeURIComponent(sym.toLowerCase())}.us&d1=${d1}&d2=${d2}&i=d`;
  const r = await fetcher(u, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`stooq ${r.status}`);
  const text = await r.text();
  const lines = text.trim().split(/\r?\n/);
  if (!/^date/i.test(lines[0] || "")) throw new Error("stooq unexpected");
  const bars = lines.slice(1).map(l => l.split(",")).filter(c => c.length >= 5)
    .map(c => ({ date: c[0], open: num(c[1]), close: num(c[4]) }))
    .filter(b => /^\d{4}-\d{2}-\d{2}$/.test(b.date));
  bars.sort((a, b) => (a.date < b.date ? -1 : 1));
  const last = bars[bars.length - 1];
  return { bars, live: last ? last.close : null, liveDate: last ? last.date : null, source: "stooq" };
}

// ---------- helpers ----------

function json(obj, status, maxAge) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": maxAge ? `public, max-age=60, s-maxage=${maxAge}` : "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? round(n, 4) : null; }
function round(n, d) { const f = 10 ** d; return Math.round(n * f) / f; }
function pct(entry, price, dir) {
  if (!(entry > 0) || !(price > 0)) return null;
  const r = (price / entry - 1) * 100;
  return round(dir === "short" ? -r : r, 2);
}
function addDays(iso, n) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400000);
}
function isoDateInTZ(d, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function isoDateInNY(d) { return isoDateInTZ(d, "America/New_York"); }
function dedupeByDate(bars) {
  for (let i = bars.length - 1; i > 0; i--) if (bars[i].date === bars[i - 1].date) bars.splice(i - 1, 1);
}
