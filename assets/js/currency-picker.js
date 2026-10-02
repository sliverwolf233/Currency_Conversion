// currency-picker.js — searchable combobox replacing the native <select> for
// the big currency lists (168 codes on Visa). Native selects cannot be
// searched or styled, and fail Apple HIG expectations for menus (origin-aware
// motion, translucent material, full keyboard navigation, instant response).
//
// Behaviour:
//  - click the trigger -> popover with a focused search field
//  - type to filter by ISO code / zh name / en name, with match highlighting
//  - full keyboard: ArrowUp/Down, Home/End, Enter to pick, Escape/Tab to close
//  - ARIA combobox pattern (role=combobox/listbox/option, aria-activedescendant)
//  - enter animation: 180ms ease-out, scale(0.97)+fade from the trigger
//    (never scale(0)); opacity-only under prefers-reduced-motion

import { LANG } from "./i18n.js";
import { CURRENCIES } from "./currencies.js";

export class CurrencyPicker {
  /**
   * @param root  element that will host the picker (replaced content)
   * @param codes full ISO code list to offer
   * @param value initial code
   * @param onChange(code) callback after a successful selection
   */
  constructor(root, codes, value, onChange) {
    this.root = root;
    this.codes = codes;
    this.value = value;
    this.onChange = onChange;
    this.activeIndex = 0;
    this.filtered = [];
    this.open = false;

    root.classList.add("cpicker");
    root.innerHTML = `
      <button type="button" class="cpicker-btn" role="combobox" aria-expanded="false" aria-haspopup="listbox">
        <span class="cpicker-value"></span>
        <span class="cpicker-caret" aria-hidden="true">▾</span>
      </button>
      <div class="cpicker-pop" role="listbox" aria-label="currency">
        <input type="text" class="cpicker-search" placeholder="${LANG === "zh" ? "搜索：代码 / 中文名 / English" : "Search: code / name"}" autocomplete="off" spellcheck="false" aria-autocomplete="list" />
        <div class="cpicker-list"></div>
        <div class="cpicker-empty hidden"></div>
      </div>`;
    this.btn = root.querySelector(".cpicker-btn");
    this.pop = root.querySelector(".cpicker-pop");
    this.search = root.querySelector(".cpicker-search");
    this.list = root.querySelector(".cpicker-list");
    this.emptyEl = root.querySelector(".cpicker-empty");

    this.btn.addEventListener("click", () => (this.open ? this.close() : this.show()));
    this.search.addEventListener("input", () => { this.filter(); this.renderList(); this.setActive(0); });
    this.search.addEventListener("keydown", (e) => this.onKeydown(e));
    document.addEventListener("pointerdown", (e) => {
      if (this.open && !this.root.contains(e.target)) this.close();
    });
    this.renderValue();
  }

  setCodes(codes, keepValue = true) {
    this.codes = codes;
    if (!keepValue || !codes.includes(this.value)) this.value = codes[0];
    this.renderValue();
  }

  setValue(code) {
    if (!this.codes.includes(code)) return;
    this.value = code;
    this.renderValue();
  }

  label(code) {
    const meta = CURRENCIES[code];
    return meta ? code + " · " + (LANG === "en" ? meta.en : meta.zh) : code;
  }

  renderValue() {
    this.root.querySelector(".cpicker-value").textContent = this.label(this.value);
  }

  match(code, q) {
    const meta = CURRENCIES[code] || { zh: "", en: "" };
    const hay = [code, meta.zh, meta.en.toLowerCase(), code.toLowerCase()];
    return hay.some((h) => h && h.toLowerCase().includes(q.toLowerCase()));
  }

  filter() {
    const q = this.search.value.trim();
    this.filtered = q ? this.codes.filter((c) => this.match(c, q)) : this.codes.slice();
  }

  highlight(code, q) {
    const label = this.label(code);
    if (!q) return label;
    const i = label.toLowerCase().indexOf(q.toLowerCase());
    if (i === -1) return label;
    return label.slice(0, i) + "<mark>" + label.slice(i, i + q.length) + "</mark>" + label.slice(i + q.length);
  }

  renderList() {
    const q = this.search.value.trim();
    this.list.innerHTML = "";
    this.filtered.forEach((code, i) => {
      const div = document.createElement("div");
      div.className = "cpicker-option" + (code === this.value ? " selected" : "");
      div.id = this.root.id + "-opt-" + i;
      div.setAttribute("role", "option");
      div.dataset.code = code;
      div.innerHTML = this.highlight(code, q);
      div.addEventListener("pointerdown", (e) => { e.preventDefault(); this.pick(code); }); // pointer-down, not click
      this.list.appendChild(div);
    });
    this.emptyEl.classList.toggle("hidden", this.filtered.length !== 0);
    this.emptyEl.textContent = LANG === "zh" ? "无匹配币种 No match" : "No matching currency";
  }

  setActive(i) {
    this.activeIndex = Math.max(0, Math.min(i, this.filtered.length - 1));
    const opts = this.list.querySelectorAll(".cpicker-option");
    opts.forEach((o, idx) => {
      const on = idx === this.activeIndex;
      o.classList.toggle("active", on);
      if (on) {
        o.setAttribute("aria-selected", "true");
        this.search.setAttribute("aria-activedescendant", o.id);
        // keep the highlighted row in view while arrowing through
        const above = o.offsetTop < this.list.scrollTop;
        const below = o.offsetTop + o.offsetHeight > this.list.scrollTop + this.list.clientHeight;
        if (above) this.list.scrollTop = o.offsetTop;
        else if (below) this.list.scrollTop = o.offsetTop + o.offsetHeight - this.list.clientHeight;
      } else o.setAttribute("aria-selected", "false");
    });
  }

  onKeydown(e) {
    if (e.key === "ArrowDown") { e.preventDefault(); this.setActive(this.activeIndex + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); this.setActive(this.activeIndex - 1); }
    else if (e.key === "Home") { e.preventDefault(); this.setActive(0); }
    else if (e.key === "End") { e.preventDefault(); this.setActive(this.filtered.length - 1); }
    else if (e.key === "Enter") { e.preventDefault(); if (this.filtered[this.activeIndex]) this.pick(this.filtered[this.activeIndex]); }
    else if (e.key === "Escape" || e.key === "Tab") { this.close(); }
  }

  pick(code) {
    this.value = code;
    this.renderValue();
    this.close();
    if (this.onChange) this.onChange(code);
  }

  show() {
    this.open = true;
    this.btn.setAttribute("aria-expanded", "true");
    this.search.value = "";
    this.filter();
    this.renderList();
    const sel = this.filtered.indexOf(this.value);
    this.setActive(sel >= 0 ? sel : 0);
    // enter transition: from scale(0.97) toward the trigger, opacity fade — never scale(0)
    this.pop.classList.add("pre-enter");
    this.pop.classList.remove("hidden");
    void this.pop.offsetWidth;
    this.pop.classList.remove("pre-enter");
    this.search.focus();
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.btn.setAttribute("aria-expanded", "false");
    this.pop.classList.add("hidden");
    this.search.setAttribute("aria-activedescendant", "");
  }
}
