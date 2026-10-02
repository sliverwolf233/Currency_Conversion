import { t, LANG, setLang, I18N } from "./i18n.js";
import { CURRENCIES, currName } from "./currencies.js";
import { clearCache } from "./net.js";
import { CurrencyPicker } from "./currency-picker.js";
import * as visa from "./providers/visa.js";
import * as mastercard from "./providers/mastercard.js";
import * as jcb from "./providers/jcb.js";
import * as unionpay from "./providers/unionpay.js";

const PROVIDERS = {
  visa: { mod: visa, nameKey: "visaName", cls: "visa", fee: true, src: "https://www.visa.com.hk/zh_HK/support/consumer/travel-support/exchange-rate-calculator.html" },
  mastercard: { mod: mastercard, nameKey: "mcName", cls: "mastercard", fee: true, src: "https://www.mastercard.com/cn/zh/personal/get-support/currency-exchange-rate-converter.html" },
  jcb: { mod: jcb, nameKey: "jcbName", cls: "jcb", fee: false, src: "https://www.jcb.jp/rate/usd.html" },
  unionpay: { mod: unionpay, nameKey: "upName", cls: "unionpay", fee: false, src: "https://www.unionpayintl.com/cn/rate/" },
};

const $ = (id) => document.getElementById(id);

// rAF with fallback (Node/jsdom test harnesses)
const raf = typeof requestAnimationFrame === "function"
  ? (fn) => requestAnimationFrame(fn)
  : (fn) => setTimeout(fn, 16);

// reveal a card with a 200ms enter transition (opacity/translate/scale — never scale(0))
function reveal(el) {
  if (!el || !el.classList.contains("hidden")) return;
  el.classList.add("pre-enter");
  el.classList.remove("hidden");
  void el.offsetWidth; // force reflow so the transition runs
  raf(() => el.classList.remove("pre-enter"));
}
let provider = localStorage.getItem("cc.provider") || "visa";
if (provider === "compare" || !PROVIDERS[provider]) provider = "visa";

// ---------- currency options ----------
function availableCodes() {
  if (provider === "jcb") return jcb.currencies($("sel-jcb-billing").value);
  if (provider === "unionpay") return unionpay.currencies();
  if (provider === "mastercard") return mastercard.CURRENCIES;
  return visa.CURRENCIES;
}

function orderCodes(codes) {
  // majors (with metadata) first, then the rest alphabetically
  const known = codes.filter(c => CURRENCIES[c]);
  const rest = codes.filter(c => !CURRENCIES[c]).sort();
  return [...new Set([...known, ...rest])];
}

// searchable comboboxes replace native selects for the big currency lists
const pickFrom = new CurrencyPicker($("pick-from"), [], "USD", () => maybeConvert());
const pickTo = new CurrencyPicker($("pick-to"), [], "CNY", () => maybeConvert());
function maybeConvert() { if (provider !== "compare") runConvert(); }

function refreshSelectors() {
  const codes = orderCodes(availableCodes());
  const keepFrom = pickFrom.codes.includes(pickFrom.value) ? pickFrom.value : "USD";
  const keepTo = pickTo.codes.includes(pickTo.value) ? pickTo.value : "CNY";
  pickFrom.setCodes(codes, false);
  pickTo.setCodes(codes, false);
  pickFrom.setValue(codes.includes(keepFrom) ? keepFrom : "USD");
  pickTo.setValue(codes.includes(keepTo) ? keepTo : "CNY");
  // JCB JPY mode: default pair USD -> JPY
  if (provider === "jcb" && $("sel-jcb-billing").value === "JPY") {
    pickFrom.setValue("USD");
    pickTo.setValue("JPY");
  }
}

// ---------- UI state ----------
function setProvider(p, opts = {}) {
  provider = p;
  localStorage.setItem("cc.provider", p);
  for (const b of document.querySelectorAll(".tab")) b.classList.toggle("active", b.dataset.provider === p);
  $("fee-field").classList.toggle("hidden", p !== "visa" && p !== "mastercard");
  $("jcb-billing-field").classList.toggle("hidden", p !== "jcb");
  $("result-card").classList.add("hidden");
  $("compare-card").classList.add("hidden");
  refreshSelectors();
  if (!opts.silent) runConvert(); // auto-query on tab switch, like the official calculators
}

// ---------- conversion ----------
function fmtRate(r) {
  if (!isFinite(r)) return "-";
  const abs = Math.abs(r);
  const dp = abs >= 1000 ? 2 : abs >= 100 ? 3 : abs >= 1 ? 4 : abs >= 0.01 ? 5 : 7;
  return r.toFixed(dp);
}
function fmtMoney(v) {
  if (!isFinite(v)) return "-";
  const abs = Math.abs(v);
  const dp = abs >= 1 ? 2 : 6;
  return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: dp });
}

function kindLabel(kind) {
  return kind === "direct" ? t("directQuote") : kind === "inverse" ? t("inverseQuote") : t("crossQuote");
}

let seq = 0; // guard against out-of-order responses when switching fast
async function runConvert() {
  const my = ++seq;
  const from = pickFrom.value, to = pickTo.value;
  const amount = parseFloat($("inp-amount").value) || 0;
  const fee = Math.min(10, Math.max(0, parseFloat($("inp-fee").value) || 0));
  const dateRaw = $("inp-date").value; // "" = latest, else YYYY-MM-DD
  const date = dateRaw || null;
  $("fee-val").textContent = fee.toFixed(1) + "%";
  if (provider === "compare") return runCompare(from, to, amount, fee, date);

  const btn = $("btn-convert");
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = t("loading");
  reveal($("result-card"));
  $("res-converted").innerHTML = '<span class="spin"></span>';

  try {
    let res;
    if (provider === "visa") res = await visa.convert({ from, to, amount, fee, date });
    else if (provider === "mastercard") res = await mastercard.convert({ from, to, amount, fee, date });
    else if (provider === "jcb") res = await jcb.convert({ from, to, amount, billing: $("sel-jcb-billing").value, date });
    else res = await unionpay.convert({ from, to, amount, date });
    if (my !== seq) return; // stale response

    const meta = PROVIDERS[provider];
    $("res-provider").textContent = t(meta.nameKey);
    $("res-provider").className = "provider-badge " + meta.cls;
    $("res-asof").textContent = t("asOf") + ": " + (res.asOf || "-") + (res.cached ? " " + t("cachedData") : "");
    // blur-bridged number swap so old/new amounts don't visibly overlap
    const amt = $("res-amount");
    amt.classList.add("swapping");
    setTimeout(() => {
      $("res-converted").textContent = fmtMoney(res.converted);
      amt.classList.remove("swapping");
    }, 130);
    $("res-unit").textContent = to;
    $("res-rate").textContent = "1 " + from + " = " + fmtRate(res.rate) + " " + to + "  ·  " + kindLabel(res.kind) + (res.fee != null && res.fee > 0 ? " · " + fee.toFixed(1) + "% " + t("feeIncluded") : "");
    $("res-rate-inv").textContent = "1 " + to + " = " + fmtRate(1 / res.rate) + " " + from;
    const notes = [...(res.notes || [])];
    if (res.fee == null) notes.push(t("feeExcluded"));
    $("res-notes").innerHTML = notes.map(n => '<span class="tag">i</span>' + n).join("<br>");
    const links = PROVIDERS[provider];
    $("res-links").innerHTML = t("source") + ': <a href="' + links.src + '" target="_blank" rel="noopener">' + t("viewSource") + " ↗</a>";
  } catch (e) {
    if (my !== seq) return; // stale error
    $("res-provider").textContent = t("errRate");
    $("res-provider").className = "provider-badge compare";
    $("res-asof").textContent = "";
    $("res-converted").textContent = "—";
    $("res-unit").textContent = "";
    $("res-rate").textContent = "";
    $("res-rate-inv").textContent = "";
    $("res-notes").innerHTML = '<span class="tag">!</span>' + t("errAll");
    $("res-notes").innerHTML += "<br><small>" + (e && e.message ? e.message : "") + "</small>";
    $("res-links").textContent = "";
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
}

async function runCompare(from, to, amount, fee, date = null) {
  const card = $("compare-card");
  const rows = $("compare-rows");
  rows.innerHTML = "";
  reveal(card);
  const jobs = Object.entries(PROVIDERS).map(async ([key, meta], i) => {
    const div = document.createElement("div");
    div.className = "compare-row pre-enter";
    div.style.transitionDelay = (i * 40) + "ms"; // 40ms stagger per network
    div.innerHTML = '<span class="compare-org">' + t(meta.nameKey) + '</span><span class="compare-rate"><span class="spin"></span></span><span class="compare-conv"></span><span class="compare-status"></span>';
    rows.appendChild(div);
    raf(() => raf(() => div.classList.remove("pre-enter")));
    try {
      let res;
      if (key === "visa") res = await visa.convert({ from, to, amount, fee, date });
      else if (key === "mastercard") res = await mastercard.convert({ from, to, amount, fee, date });
      else if (key === "jcb") res = await jcb.convert({ from, to, amount, billing: "JPY", date });
      else res = await unionpay.convert({ from, to, amount, date });
      div.querySelector(".compare-rate").textContent = "1 " + from + " = " + fmtRate(res.rate) + " " + to + " (" + kindLabel(res.kind) + (res.fee != null && res.fee > 0 ? ", " + fee.toFixed(1) + "%" : "") + ")";
      div.querySelector(".compare-conv").textContent = fmtMoney(res.converted) + " " + to;
      const st = div.querySelector(".compare-status");
      st.className = "compare-status ok";
      st.textContent = (t("asOf") + ": " + (res.asOf || "-") + (res.cached ? " " + t("cachedData") : "")) + (res.fee == null ? " · " + t("feeExcluded") : "");
    } catch (e) {
      const unsupported = /unsupported pair/.test(String(e && e.message));
      div.querySelector(".compare-rate").textContent = unsupported ? t("errUnsupported") : t("errRate");
      div.querySelector(".compare-conv").textContent = "—";
      const st = div.querySelector(".compare-status");
      st.className = "compare-status err";
      st.textContent = unsupported ? "" : ((e && e.message) || "").slice(0, 160);
    }
  });
  await Promise.allSettled(jobs);
}

// ---------- i18n ----------
function applyLang() {
  document.documentElement.lang = LANG === "zh" ? "zh-CN" : "en";
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  $("btn-lang").textContent = LANG === "zh" ? "EN" : "中文";
  refreshSelectors();
  pickFrom.renderValue(); pickTo.renderValue(); // relabel in the new language
}

// ---------- wiring ----------
$("provider-tabs").addEventListener("click", (ev) => {
  const b = ev.target.closest(".tab");
  if (b) setProvider(b.dataset.provider);
});
$("btn-convert").addEventListener("click", runConvert);
let swapRot = 0;
$("btn-swap").addEventListener("click", () => {
  const tmp = pickFrom.value;
  pickFrom.setValue(pickTo.value);
  pickTo.setValue(tmp);
  maybeConvert();
  swapRot += 180;
  const btnS = $("btn-swap");
  btnS.style.setProperty("--rot", swapRot + "deg");
  btnS.classList.add("flipped");
});
$("inp-fee").addEventListener("input", () => { $("fee-val").textContent = (parseFloat($("inp-fee").value) || 0).toFixed(1) + "%"; });
$("sel-jcb-billing").addEventListener("change", () => { refreshSelectors(); $("result-card").classList.add("hidden"); });
$("btn-lang").addEventListener("click", () => { setLang(LANG === "zh" ? "en" : "zh"); applyLang(); });
$("btn-settings").addEventListener("click", () => {
  $("inp-proxy").value = localStorage.getItem("cc.proxy") || "";
  $("dlg-settings").showModal();
});
$("dlg-settings").addEventListener("close", () => {
  const v = $("inp-proxy").value.trim();
  if (v) localStorage.setItem("cc.proxy", v); else localStorage.removeItem("cc.proxy");
});
$("btn-clear-cache").addEventListener("click", () => { clearCache(); $("btn-clear-cache").textContent = "✓"; });

applyLang();
setProvider(provider, { silent: true }); // no network on first paint
$("fee-val").textContent = (parseFloat($("inp-fee").value) || 0).toFixed(1) + "%";
// date picker bounds: oldest practical limit is UnionPay's 2021 archive floor
{
  const today = new Date().toISOString().slice(0, 10);
  $("inp-date").max = today;
  $("inp-date").min = "2021-01-04";
}
$("inp-date").addEventListener("change", () => { if (provider !== "compare") runConvert(); });
$("inp-fee").addEventListener("change", () => { if (provider === "visa" || provider === "mastercard") runConvert(); });
