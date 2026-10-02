// net.js — resilient cross-origin fetching for the four card-network data sources.
// None of the networks send Access-Control-Allow-Origin, so a browser page must
// go through a CORS proxy. Strategy: direct fetch first (future-proof) -> custom
// user proxy (see worker/proxy.js) -> race several public CORS proxies in
// parallel and take the first success, with aggressive localStorage caching so
// a single successful fetch survives later outages.

const PROXIES = [
  { name: "allorigins-raw", url: "https://api.allorigins.win/raw?url={enc}" },
  { name: "allorigins-get", url: "https://api.allorigins.win/get?url={enc}", wrapped: true },
  { name: "codetabs", url: "https://api.codetabs.com/v1/proxy?quest={enc}" },
  { name: "cors-lol", url: "https://api.cors.lol/?url={enc}" },
  // r.jina.ai renders HTML pages to markdown (breaks JCB's HTML parsing), so it
  // is only raced for JSON endpoints, with extraction from its text wrapper.
  { name: "jina", url: "https://r.jina.ai/{url}", jsonOnly: true, extract: true },
];

const TIMEOUT_MS = 15000;

export function customProxy() {
  try { return (typeof localStorage !== "undefined" && localStorage.getItem("cc.proxy")) || ""; }
  catch { return ""; }
}

async function tryFetch(url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "follow" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } finally { clearTimeout(timer); }
}

function buildProxied(target, tpl) {
  return tpl.replace("{enc}", encodeURIComponent(target)).replace("{url}", target);
}

function unwrap(text, ch) {
  if (ch.extract) {
    // r.jina.ai style wrapper: strip narrative, keep the JSON payload
    try { JSON.parse(text); return text; } catch { /* fall through */ }
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s !== -1 && e > s) { const cut = text.slice(s, e + 1); JSON.parse(cut); return cut; }
    throw new Error("jina extract failed");
  }
  if (ch.wrapped) {
    const j = JSON.parse(text);
    if (typeof j.contents !== "string") throw new Error("bad wrapper payload");
    return j.contents;
  }
  return text;
}

function plausible(ch, text, kind) {
  if (ch.jsonOnly && kind !== "json") return false;
  return true;
}

// Fetch target's text. Channels: direct -> custom -> public proxies raced in
// parallel (Promise.any), repeated for `passes` rounds on total failure.
export async function fetchText(target, opts = {}) {
  const kind = opts.kind || "text";
  const errors = [];
  try {
    const direct = await tryFetch(target, opts.timeoutMs);
    if (direct) return { text: direct, via: "direct" };
  } catch (e) { errors.push("direct: " + e.message); }

  const cp = customProxy();
  if (cp) {
    try {
      const raw = await tryFetch(buildProxied(target, cp), opts.timeoutMs);
      if (raw) return { text: raw, via: "custom" };
    } catch (e) { errors.push("custom: " + e.message); }
  }

  const passes = opts.passes || 2;
  for (let round = 0; round < passes; round++) {
    const racers = [];
    for (const p of PROXIES) {
      if (!plausible(p, null, kind)) continue;
      racers.push(
        (async () => {
          const raw = await tryFetch(buildProxied(target, p.url), opts.timeoutMs);
          const text = unwrap(raw, p);
          if (!text || !text.length) throw new Error(p.name + ": empty");
          return { text, via: p.name };
        })().catch(e => { throw new Error(p.name + ": " + e.message); })
      );
    }
    try {
      return await Promise.any(racers);
    } catch (agg) {
      const msgs = (agg && agg.errors ? agg.errors : [agg]).map(String);
      errors.push(...msgs);
      if (round < passes - 1) await new Promise(r => setTimeout(r, 600 + Math.random() * 700));
    }
  }
  throw new Error("all channels failed [" + errors.join(" | ").slice(0, 300) + "]");
}

export async function fetchJSON(target, opts = {}) {
  const { text, via } = await fetchText(target, { ...opts, kind: "json" });
  return { json: JSON.parse(text), via };
}

// ---------- localStorage cache with TTL ----------
const PREFIX = "cc.cache.";
function ls() { try { return typeof localStorage !== "undefined" ? localStorage : null; } catch { return null; } }

export function cacheGet(key) {
  const s = ls(); if (!s) return null;
  try {
    const raw = s.getItem(PREFIX + key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (Date.now() > obj.exp) { s.removeItem(PREFIX + key); return null; }
    return obj.data;
  } catch { return null; }
}

export function cacheSet(key, data, ttlMs) {
  const s = ls(); if (!s) return;
  try {
    s.setItem(PREFIX + key, JSON.stringify({ exp: Date.now() + ttlMs, data, at: Date.now() }));
  } catch { /* storage full / private mode — ignore */ }
}

export function clearCache() {
  const s = ls(); if (!s) return;
  const kill = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k && k.startsWith(PREFIX)) kill.push(k);
  }
  kill.forEach(k => s.removeItem(k));
}

// ms until the end of the current UTC day + 6h safety
export function ttlEndOfDayPlus(h = 6) {
  const now = new Date();
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, h, 0, 0);
  return end - now;
}
