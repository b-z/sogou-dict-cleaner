// SPDX-License-Identifier: GPL-3.0-only
// 搜狗词库清理：网页界面逻辑。核心解析与重建见 sogou.js。
"use strict";
const S = window.SogouDict;
const ROW_H = 26;
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = n => n.toLocaleString("zh-CN");

const TAGS = [
  { bit: S.TAG.GARBLED, name: "乱码", color: "--t-red", tip: "含非汉字、非 ASCII 的字符，或文字无法解码" },
  { bit: S.TAG.HAN_GARBLED, name: "汉字乱码", color: "--t-orange", tip: "全是冷僻汉字，读音也对不上（如「埥䤅靨」读作 he kuang hai）" },
  { bit: S.TAG.RARE3, name: "生僻字", color: "--t-purple", tip: "含 GB2312 以外的字" },
  { bit: S.TAG.RARE2, name: "次常用字", color: "--t-violet", tip: "含 GB2312 二级字。正常词也不少，请逐条确认" },
  { bit: S.TAG.TRAD, name: "繁体字", color: "--t-brown", tip: "含繁体字（有不同于自身的简体写法，依据 OpenCC 字表）" },
  { bit: S.TAG.PY_MISMATCH, name: "拼音不符", color: "--t-amber", tip: "字数与音节数不一致（这类词按正常拼音打不出来），或某个字的读音在整本词库里只出现在这个词中" },
  { bit: S.TAG.UNCOMMON, name: "非常用词", color: "--t-green", tip: "两字及以上的汉字词，在常用词典（jieba）里查不到，多是随手输入记下的短语" },
  { bit: S.TAG.NAME, name: "人名", color: "--t-blue", tip: "姓 + 名的组合，规则粗略，请逐条确认" },
  { bit: S.TAG.LATIN, name: "英文数字", color: "--t-teal", tip: "含英文字母或数字" },
  { bit: S.TAG.MULTI_PY, name: "多拼音", color: "--t-gray", tip: "同一个词以多种拼音出现" },
  { bit: S.TAG.DUP, name: "重复词", color: "--t-gray", tip: "同一个词出现了多次。只标记其中词频较低的几条，词频最高的那条不标记",
    note: "重复词：全部移除后，每个词仍会保留词频最高的一条" },
  { bit: S.TAG.ZERO, name: "零词频", color: "--t-gray", tip: "词频为 0" },
  { bit: S.TAG.REDUP, name: "叠词", color: "--t-gray", tip: "ABAB 型叠词，如「闭包闭包」「看一下看一下」；也包括同一个字连续 4 次以上，如「啊啊啊啊」",
    note: "叠词：筛选 ABAB 型（闭包闭包、看一下看一下）及同一个字连续 4 次以上的词，「哈哈」这类两字叠词不算" },
];
// width：列宽；only0：只在「现有词库」显示
const COLS = [
  { key: "word", label: "词", width: "minmax(80px, 2fr)" },
  { key: "py", label: "拼音", width: "minmax(70px, 1.7fr)", tip: "括号里是实际输入的拼音（和词条拼音不同时才显示，例如用了简拼）" },
  { key: "rank", label: "词频", num: true, width: "52px" },
  { key: "len", label: "字数", num: true, width: "40px", only0: true },
  { key: "time", label: "时序", num: true, width: "48px", only0: true, tip: "词条里记录的相对时间（伪时间），数值越大越近，无法换算成具体日期" },
  { key: "tags", label: "标签", width: "minmax(64px, 1.4fr)" }, { key: null, label: "", width: "104px" },
];
// 每栏的两个移动按钮：[目标栏, 文字, 是否危险操作]
const ROW_ACTS = [[[1, "备选 →"]], [[0, "← 保留"], [2, "移除 ↓", 1]], [[0, "← 保留"], [1, "↑ 备选"]]];
const OFFICIAL_HOST = "sogou-clean.pages.dev";

// ---------- 状态 ----------
let file = null;        // {name, bytes, recs, fp}
let rows = [];          // {w, py, rank, time, tags, bad, len}
let N = 0, loc = new Uint8Array(0);
const undoStack = [];
const filter = { tags: new Int8Array(TAGS.length), mode: "any", freqMin: null, freqMax: null, lenMin: null, lenMax: null, search: null };
let panes = [];

// ---------- 存储 ----------
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};

// ---------- 数据加载 ----------
let dictsPromise = null;
function loadDicts() {
  if (!dictsPromise) dictsPromise = new Promise(resolve => {
    const s = document.createElement("script");
    s.src = "data.js";
    s.onload = () => resolve({
      commonWords: new Set(globalThis.SOGOU_COMMON_WORDS.split("\n")),
      tradChars: new Set(Array.from(globalThis.SOGOU_TRAD_CHARS)),
    });
    s.onerror = () => resolve({});   // 词典加载失败时，相关标签不可用
    document.head.appendChild(s);
  });
  return dictsPromise;
}

function busy(msg) { const b = $("#busy"); b.textContent = msg || ""; b.classList.toggle("show", !!msg); }

async function openFile(f) {
  if (!f) return;
  busy("正在读取词库…");
  try { await loadBuffer(f.name, await f.arrayBuffer()); }
  catch (e) { busy(); alertModal("无法打开这个文件", e.message + "。请确认它是搜狗输入法导出的用户词库备份（.bin）。"); }
}

async function loadBuffer(name, buf) {
  busy("正在分析词库…");
  await new Promise(r => setTimeout(r, 20));
  const bytes = new Uint8Array(buf);
  const recs = S.parse(bytes);
  const dicts = await loadDicts();
  const info = S.analyze(recs, dicts);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  file = { name, bytes, recs, fp: `sdc:${name}:${bytes.length}:${dv.getUint32(0x20, true)}:${recs.length}` };
  rows = recs.map((r, i) => ({
    w: r.word === null ? "〈无法解码〉" : r.word, py: r.pinyin, typed: r.typed, rank: r.rank, time: r.time,
    tags: info[i].tags, bad: info[i].bad, len: r.word === null ? 0 : Array.from(r.word).length,
  }));
  N = rows.length; loc = new Uint8Array(N);
  undoStack.length = 0;
  const saved = store.get(file.fp);
  if (saved) {
    for (const i of saved.c || []) if (i < N) loc[i] = 1;
    for (const i of saved.r || []) if (i < N) loc[i] = 2;
  }
  for (const k in sortKeys) delete sortKeys[k];
  $("#fileName").textContent = name; $("#fileName").title = name;
  document.title = `${name} · 搜狗词库清理`;
  $("#welcome").style.display = "none";
  ["#search", "#exportBtn"].forEach(s => ($(s).disabled = false));
  panes.forEach(p => { p.sel.clear(); p.anchor = p.cursor = -1; p.body.scrollTop = 0; });
  refreshAll();
  $("#saveState").textContent = saved ? "已恢复上次进度" : "";
  busy();
  panes[0].el.focus();
}

// ---------- 筛选 ----------
function buildChips() {
  const box = $("#chips");
  TAGS.forEach((t, k) => {
    const c = document.createElement("span");
    c.className = "chip"; c.style.setProperty("--c", `var(${t.color})`);
    c.title = t.tip + "\n点击选中，再点一次取消";
    c.innerHTML = `<span class="dot"></span><span class="name">${t.name}</span><span class="count">–</span>`;
    c.onclick = () => { filter.tags[k] = filter.tags[k] ? 0 : 1; filterChanged(); };
    box.appendChild(c);
  });
}
function filterActive() {
  return filter.tags.some(x => x !== 0) || filter.freqMin !== null || filter.freqMax !== null
    || filter.lenMin !== null || filter.lenMax !== null || !!filter.search;
}
// 基础条件：词频、字数、搜索
function passBase(i) {
  const r = rows[i];
  if (filter.freqMin !== null && r.rank < filter.freqMin) return false;
  if (filter.freqMax !== null && r.rank > filter.freqMax) return false;
  if (filter.lenMin !== null && r.len < filter.lenMin) return false;
  if (filter.lenMax !== null && r.len > filter.lenMax) return false;
  if (filter.search && !filter.search(i)) return false;
  return true;
}
let incMask = 0;
function pass(i) {
  if (!passBase(i)) return false;
  const t = rows[i].tags;
  if (incMask) return filter.mode === "any" ? (t & incMask) !== 0 : (t & incMask) === incMask;
  return true;
}
function filterChanged() {
  incMask = 0;
  TAGS.forEach((t, k) => { if (filter.tags[k]) incMask |= t.bit; });
  document.querySelectorAll("#chips .chip").forEach((c, k) => c.classList.toggle("on", !!filter.tags[k]));
  document.querySelectorAll("#modeSeg button").forEach(b => b.classList.toggle("on", b.dataset.mode === filter.mode));
  store.set("sdc-filter", { tags: Array.from(filter.tags), mode: filter.mode, freqMin: filter.freqMin, freqMax: filter.freqMax, lenMin: filter.lenMin, lenMax: filter.lenMax });
  if (N) refreshAll();
}
function updateFilterCounts() {
  const counts = new Array(TAGS.length).fill(0);
  for (let i = 0; i < N; i++) {
    if (loc[i] !== 0 || !passBase(i)) continue;
    const t = rows[i].tags;
    if (t) for (let k = 0; k < TAGS.length; k++) if (t & TAGS[k].bit) counts[k]++;
  }
  document.querySelectorAll("#chips .chip").forEach((c, k) => {
    $(".count", c).textContent = N ? fmt(counts[k]) : "–";
    c.classList.toggle("zero", counts[k] === 0);
  });
  renderExpr();
}
// 把当前筛选条件写成「(生僻字 OR 次常用字) AND NOT 乱码 AND 词频 ≤ 1」的形式
function renderExpr() {
  const tag = k => `<span class="t" style="color:var(${TAGS[k].color})">${TAGS[k].name}</span>`;
  const op = (o, cls = "") => ` <span class="op ${cls}">${o}</span> `;
  const inc = [];
  TAGS.forEach((_, k) => { if (filter.tags[k]) inc.push(tag(k)); });
  const parts = [];
  if (inc.length) {
    const joined = inc.join(op(filter.mode === "any" ? "OR" : "AND"));
    parts.push(inc.length > 1 && filter.mode === "any" ? `(${joined})` : joined);
  }
  const range = (name, lo, hi) => {
    if (lo !== null && hi !== null) return lo === hi ? `${name} = ${lo}` : `${lo} ≤ ${name} ≤ ${hi}`;
    if (lo !== null) return `${name} ≥ ${lo}`;
    if (hi !== null) return `${name} ≤ ${hi}`;
    return null;
  };
  for (const r of [range("词频", filter.freqMin, filter.freqMax), range("字数", filter.lenMin, filter.lenMax)]) if (r) parts.push(r);
  $("#expr").innerHTML = parts.length ? parts.join(op("AND")) : `<span class="none">无，显示全部</span>`;
  const q = $("#search").value.trim();
  const notes = TAGS.filter((t, k) => filter.tags[k] && t.note).map(t => t.note);
  $("#exprNote").textContent = ["只作用于「现有词库」", q && `搜索「${q}」作用于三栏`, ...notes].filter(Boolean).join("；");
}
function setSearch(q) {
  q = q.trim();
  $("#search").style.borderColor = "";
  if (!q) filter.search = null;
  else if (q.length > 2 && q.startsWith("/") && q.endsWith("/")) {
    try { const re = new RegExp(q.slice(1, -1)); filter.search = i => re.test(rows[i].w) || re.test(rows[i].py); }
    catch { $("#search").style.borderColor = "var(--danger)"; return; }
  } else {
    const ql = q.toLowerCase().replace(/\s+/g, " ");
    // 带空格时按完整音节匹配（「ha ha」不会匹配 cha hao），不带空格时连写模糊匹配
    const pyMatch = ql.includes(" ")
      ? i => (" " + rows[i].py + " ").includes(" " + ql + " ")
      : i => rows[i].py.replace(/ /g, "").includes(ql);
    filter.search = i => rows[i].w.toLowerCase().includes(ql) || pyMatch(i);
  }
  refreshAll();
}

// ---------- 排序 ----------
const sortKeys = {};
function sortKey(key) {
  if (sortKeys[key]) return sortKeys[key];
  const ids = Array.from({ length: N }, (_, i) => i);
  const by = {
    word: (() => { const c = new Intl.Collator("zh-Hans-CN-u-co-pinyin"); return (a, b) => c.compare(rows[a].w, rows[b].w); })(),
    py: (a, b) => (rows[a].py < rows[b].py ? -1 : rows[a].py > rows[b].py ? 1 : 0),
    rank: (a, b) => rows[a].rank - rows[b].rank,
    len: (a, b) => rows[a].len - rows[b].len,
    time: (a, b) => rows[a].time - rows[b].time,
    tags: (a, b) => rows[b].tags - rows[a].tags,
  }[key];
  ids.sort((a, b) => by(a, b) || a - b);
  const r = new Int32Array(N);
  ids.forEach((id, k) => (r[id] = k));
  return (sortKeys[key] = r);
}

// ---------- 栏 ----------
class Pane {
  constructor(el, idx) {
    this.el = el; this.idx = idx;
    this.body = $(".body", el); this.spacer = $(".spacer-y", el); this.hint = $(".empty-hint", el);
    this.badge = $("[data-badge]", el);
    this.view = []; this.sel = new Set(); this.anchor = -1; this.cursor = -1;
    this.sort = { key: idx === 0 ? null : "tags", dir: 1 };
    this.buildCols();
    this.body.addEventListener("scroll", () => this.render());
    this.body.addEventListener("mousedown", e => this.onMouseDown(e));
    this.body.addEventListener("click", e => this.onClick(e));
    this.body.addEventListener("dblclick", e => this.onDblClick(e));
    el.addEventListener("keydown", e => this.onKey(e));
    new ResizeObserver(() => this.render()).observe(this.body);
    el.querySelectorAll("[data-act]").forEach(b => b.addEventListener("click", () => this.moveSelection(+b.dataset.act)));
    $("[data-selall]", el).addEventListener("click", () => this.selectAll());
  }
  buildCols() {
    const cols = $(".cols", this.el);
    this.cols = COLS.filter(c => !c.only0 || this.idx === 0);
    this.el.style.setProperty("--cols", "26px " + this.cols.map(c => c.width).join(" "));
    cols.innerHTML = `<div class="ck" title="全选 / 全不选当前显示的词"><input type="checkbox" data-all></div>`
      + this.cols.map(c => `<div data-key="${c.key || ""}" class="${c.num ? "num" : ""} ${c.key ? "" : "nosort"}" ${c.tip ? `title="${c.tip}"` : ""}>${c.label}</div>`).join("");
    this.allBox = $("[data-all]", cols);
    cols.addEventListener("click", e => {
      if (e.target.closest(".ck")) {
        // 不阻止默认行为：勾选状态最后由 updateHead 统一设置
        if (this.view.length && this.view.every(id => this.sel.has(id))) { this.sel.clear(); this.render(); this.updateHead(); }
        else this.selectAll();
        return;
      }
      const k = e.target.closest("[data-key]")?.dataset.key; if (!k) return;
      if (this.sort.key === k) { if (this.sort.dir === 1) this.sort.dir = -1; else this.sort = { key: null, dir: 1 }; }
      else this.sort = { key: k, dir: (k === "rank" || k === "time") ? -1 : 1 };
      this.refresh(); this.el.focus();
    });
  }
  refresh() {
    const v = [];
    // 筛选只作用于「现有词库」；搜索作用于三栏
    for (let i = 0; i < N; i++)
      if (loc[i] === this.idx && (this.idx === 0 ? pass(i) : !filter.search || filter.search(i))) v.push(i);
    if (this.sort.key) { const r = sortKey(this.sort.key), d = this.sort.dir; v.sort((a, b) => (r[a] - r[b]) * d); }
    this.view = v;
    for (const id of this.sel) if (loc[id] !== this.idx) this.sel.delete(id);
    $(".cols", this.el).querySelectorAll("[data-key]").forEach(c => {
      const col = this.cols.find(x => (x.key || "") === c.dataset.key), on = col.key && col.key === this.sort.key;
      c.classList.toggle("sorted", !!on);
      c.textContent = col.label + (on ? (this.sort.dir === 1 ? " ↑" : " ↓") : "");
    });
    this.spacer.style.height = v.length * ROW_H + "px";
    this.hint.style.display = v.length || !N ? "none" : "";
    this.render(); this.updateHead();
  }
  total() { let t = 0; for (let i = 0; i < N; i++) if (loc[i] === this.idx) t++; return t; }
  updateHead() {
    const total = this.total(), shown = this.view.length;
    this.badge.textContent = (shown !== total ? `${fmt(shown)} / ` : "") + fmt(total) + (this.sel.size ? ` · 已选 ${fmt(this.sel.size)}` : "");
    this.el.querySelectorAll("[data-act]").forEach(b => (b.disabled = this.sel.size === 0));
    $("[data-selall]", this.el).disabled = shown === 0;
    const nSel = this.sel.size;
    this.allBox.checked = shown > 0 && nSel >= shown && this.view.every(id => this.sel.has(id));
    this.allBox.indeterminate = nSel > 0 && !this.allBox.checked;
    this.allBox.disabled = shown === 0;
  }
  render() {
    const top = this.body.scrollTop, h = this.body.clientHeight;
    const start = Math.max(0, Math.floor(top / ROW_H) - 5), end = Math.min(this.view.length, Math.ceil((top + h) / ROW_H) + 5);
    const acts = ROW_ACTS[this.idx].map(([to, label, danger]) => `<button data-to="${to}"${danger ? ' class="danger"' : ""}>${label}</button>`).join("");
    let html = "";
    for (let k = start; k < end; k++) {
      const id = this.view[k], r = rows[id];
      const cls = "row" + (this.sel.has(id) ? " sel" : "") + (id === this.cursor ? " cur" : "");
      html += `<div class="${cls}" data-id="${id}" style="top:${k * ROW_H}px">`
        + `<div class="ck"><input type="checkbox" tabindex="-1"${this.sel.has(id) ? " checked" : ""}></div>`
        + this.cols.map(c => cellHtml(c.key, r, acts)).join("") + `</div>`;
    }
    this.body.querySelectorAll(".row").forEach(n => n.remove());
    this.body.insertAdjacentHTML("beforeend", html);
  }
  posOf(id) { return this.view.indexOf(id); }
  setCursor(id, scroll = true) {
    this.cursor = id;
    if (scroll && id >= 0) {
      const y = this.posOf(id) * ROW_H, b = this.body;
      if (y < b.scrollTop) b.scrollTop = y;
      else if (y + ROW_H > b.scrollTop + b.clientHeight) b.scrollTop = y + ROW_H - b.clientHeight;
    }
  }
  selectRange(fromId, toId, add) {
    const a = this.posOf(fromId), b = this.posOf(toId);
    if (!add) this.sel.clear();
    if (a < 0) { this.sel.add(toId); return; }
    for (let k = Math.min(a, b); k <= Math.max(a, b); k++) this.sel.add(this.view[k]);
  }
  selectAll() { this.sel = new Set(this.view); this.el.focus(); this.render(); this.updateHead(); }
  onMouseDown(e) {
    if (e.target.closest("button")) return;
    const row = e.target.closest(".row"); if (!row) return;
    const id = +row.dataset.id, meta = e.metaKey || e.ctrlKey;
    // 勾选框：单独选中或取消这一行（按住 ⇧ 时把锚点到这一行之间都勾上）
    if (e.target.closest(".ck")) {
      e.preventDefault();
      if (e.shiftKey && this.anchor >= 0) this.selectRange(this.anchor, id, true);
      else { this.sel.has(id) ? this.sel.delete(id) : this.sel.add(id); this.anchor = id; }
      this.setCursor(id, false);
      this.el.focus({ preventScroll: true });
      this.render(); this.updateHead();
      return;
    }
    if (e.shiftKey) this.selectRange(this.anchor >= 0 ? this.anchor : id, id, meta);
    else if (meta) { this.sel.has(id) ? this.sel.delete(id) : this.sel.add(id); this.anchor = id; }
    else if (!(e.detail === 2 && this.sel.has(id))) { this.sel = new Set([id]); this.anchor = id; }
    this.setCursor(id, false);
    this.el.focus({ preventScroll: true });
    this.render(); this.updateHead();
  }
  // 行内按钮：点在已选中的行上时作用于整个选区，否则只作用于这一行
  onClick(e) {
    if (e.target.closest(".ck")) { e.preventDefault(); return; }   // 勾选状态由 mousedown 处理
    const btn = e.target.closest("button[data-to]"); if (!btn) return;
    const id = +btn.closest(".row").dataset.id, to = +btn.dataset.to;
    if (this.sel.has(id) && this.sel.size > 1) this.moveSelection(to);
    else { this.sel = new Set([id]); this.moveSelection(to); }
  }
  onDblClick(e) {
    if (e.target.closest("button, .ck")) return;
    const row = e.target.closest(".row"); if (!row) return;
    this.sel = new Set([+row.dataset.id]);
    this.moveSelection(this.idx === 0 ? 1 : this.idx === 1 ? 2 : 1);
  }
  onKey(e) {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === "a") { e.preventDefault(); this.selectAll(); return; }
    if (meta) return;
    const v = this.view; if (!v.length) return;
    let k = this.posOf(this.cursor);
    const page = Math.max(1, Math.floor(this.body.clientHeight / ROW_H) - 1);
    const nav = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page, Home: -1e9, End: 1e9 }[e.key];
    if (nav !== undefined) {
      e.preventDefault();
      k = k < 0 ? 0 : Math.max(0, Math.min(v.length - 1, k + nav));
      const id = v[k];
      if (e.shiftKey) this.selectRange(this.anchor >= 0 ? this.anchor : id, id, false);
      else { this.sel = new Set([id]); this.anchor = id; }
      this.setCursor(id); this.render(); this.updateHead();
      return;
    }
    const key = e.key.toLowerCase();
    if (e.key === "Delete" || e.key === "Backspace" || key === "d") {
      e.preventDefault();
      if (this.idx < 2) this.moveSelection(this.idx + 1);
      else if (e.key === "Backspace") this.moveSelection(1);
    } else if (key === "r" || key === "k") { e.preventDefault(); if (this.idx > 0) this.moveSelection(0); }
    else if (key === "b") { e.preventDefault(); if (this.idx !== 1) this.moveSelection(1); }
    else if (e.key === "Escape") { this.sel.clear(); this.render(); this.updateHead(); }
  }
  // 移动选区，之后光标停在原来位置附近，方便连续操作
  moveSelection(to) {
    if (this.idx === 0 && to === 2) to = 1;   // 现有词库里的词必须先进备选
    if (to === this.idx) return;
    const ids = this.view.filter(id => this.sel.has(id));
    if (!ids.length) return;
    const firstPos = this.posOf(ids[0]);
    const rest = this.view.filter(id => !this.sel.has(id));
    const next = rest[Math.min(firstPos, rest.length - 1)];
    this.sel = new Set(next !== undefined ? [next] : []);
    this.anchor = this.cursor = next !== undefined ? next : -1;
    move(ids, to, `${fmt(ids.length)} 条${["已保留", "移到备选", "确认移除"][to]}`);
    this.el.focus({ preventScroll: true });
  }
}

function cellHtml(key, r, acts) {
  switch (key) {
    case "word": return `<div class="w" title="${esc(r.w)}">${wordHtml(r)}</div>`;
    case "py": return r.typed
      ? `<div class="py" title="${esc(r.py)}（实际输入：${esc(r.typed)}）">${esc(r.py)} <span class="typed">(${esc(r.typed)})</span></div>`
      : `<div class="py" title="${esc(r.py)}">${esc(r.py)}</div>`;
    case "rank": return `<div class="num">${r.rank}</div>`;
    case "len": return `<div class="num">${r.len}</div>`;
    case "time": return `<div class="num">${r.time}</div>`;
    case "tags": return `<div class="tags" title="${TAGS.filter(g => r.tags & g.bit).map(g => g.name).join("、")}">${tagsHtml(r.tags)}</div>`;
    default: return `<div class="acts">${acts}</div>`;
  }
}

function wordHtml(r) {
  if (!r.bad.length) return esc(r.w);
  const set = new Set(r.bad);
  return Array.from(r.w).map((c, i) => (set.has(i) ? `<mark>${esc(c)}</mark>` : esc(c))).join("");
}
function tagsHtml(t) {
  let s = "";
  if (t) for (const g of TAGS) if (t & g.bit) s += `<span class="tag" style="color:var(${g.color})">${g.name}</span>`;
  return s;
}

// ---------- 移动、撤销、保存 ----------
function move(ids, to, msg) {
  const prev = new Uint8Array(ids.length);
  ids.forEach((id, k) => { prev[k] = loc[id]; loc[id] = to; });
  undoStack.push({ ids, prev });
  if (undoStack.length > 200) undoStack.shift();
  afterChange();
  if (msg) toast(msg, true);
}
function undo() {
  const u = undoStack.pop(); if (!u) return;
  u.ids.forEach((id, k) => (loc[id] = u.prev[k]));
  afterChange();
  toast(`已撤销（${fmt(u.ids.length)} 条）`, false);
}
function refreshAll() { panes.forEach(p => p.refresh()); updateFilterCounts(); updateSummary(); }
function afterChange() { refreshAll(); $("#undoBtn").disabled = !undoStack.length; scheduleSave(); }
function updateSummary() {
  if (!N) { $("#summary").textContent = ""; return; }
  const c = [0, 0, 0]; for (let i = 0; i < N; i++) c[loc[i]]++;
  $("#summary").textContent = `导出后将保留 ${fmt(c[0] + c[1])} 条，移除 ${fmt(c[2])} 条`;
}
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const c = [], r = [];
    for (let i = 0; i < N; i++) { if (loc[i] === 1) c.push(i); else if (loc[i] === 2) r.push(i); }
    $("#saveState").textContent = store.set(file.fp, { c, r }) ? "进度已保存" : "进度无法保存（浏览器存储不可用）";
  }, 500);
}

let toastTimer = null;
function toast(msg, canUndo) {
  $("#toastText").textContent = msg;
  $("#toastUndo").style.display = canUndo ? "" : "none";
  $("#toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("show"), 3500);
}

// ---------- 对话框与导出 ----------
function showModal(html) { $("#modalBody").innerHTML = html; $("#modal").classList.add("show"); }
function hideModal() { $("#modal").classList.remove("show"); }
function alertModal(title, msg) {
  showModal(`<h3>${esc(title)}</h3><p>${esc(msg)}</p><div class="actions"><button class="btn primary" data-close>好</button></div>`);
}
function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function exportDialog() {
  const c = [0, 0, 0]; for (let i = 0; i < N; i++) c[loc[i]]++;
  const base = file.name.replace(/\.bin$/i, "") + "_干净";
  showModal(`<h3>导出干净词库</h3>
    <div class="stats"><span>保留</span><b>${fmt(c[0] + c[1])} 条</b><span>移除（确认移除栏）</span><b>${fmt(c[2])} 条</b></div>
    ${file.name === "示例词库.bin" ? `<p><b>这是示例词库</b>，导出的文件只用于看看效果，请不要拿去在搜狗里恢复。</p>` : ""}
    ${c[1] ? `<p>备选栏里还有 <b>${fmt(c[1])}</b> 条未处理，导出时会<b>保留</b>。</p>` : ""}
    <p><b>.bin</b> 用于在搜狗输入法「偏好设置 › 词库 › 中文用户词库」里「恢复（完全覆盖）」；<b>.txt</b> 是文本版，方便查看。原始备份请留好。</p>
    <p>在 macOS 上如果搜狗提示恢复失败，多半是它没有权限读取「下载」文件夹：可以在「系统设置 › 隐私与安全性 › 文件和文件夹」里允许搜狗输入法访问，或把文件移到主目录下的其他文件夹再恢复。</p>
    <div class="actions"><button class="btn" data-close>关闭</button>
      <button class="btn" id="dlTxt">下载 .txt</button><button class="btn primary" id="dlBin" ${c[2] ? "" : "disabled"}>下载 .bin</button></div>`);
  const keep = () => { const k = []; for (let i = 0; i < N; i++) if (loc[i] !== 2) k.push(i); return k; };
  $("#dlBin").onclick = () => {
    try { download(base + ".bin", S.rebuild(file.bytes, keep(), file.recs), "application/octet-stream"); }
    catch (e) { alertModal("导出失败", e.message); }
  };
  $("#dlTxt").onclick = () => download(base + ".txt", S.toTSV(file.recs, keep()), "text/plain;charset=utf-8");
}

// ---------- 启动 ----------
function checkHost() {
  const h = location.hostname;
  if (location.protocol === "file:" || !h || h === OFFICIAL_HOST || h.endsWith("." + OFFICIAL_HOST)
      || h === "localhost" || h === "127.0.0.1") return;
  const w = $("#hostWarn");
  w.textContent = `⚠ 你正在访问的不是本工具的官方网址（${OFFICIAL_HOST}）。词库里含有大量个人信息，请不要在来历不明的网站上打开词库文件。`;
  w.style.display = "block";
}

function init() {
  checkHost();
  buildChips();
  const saved = store.get("sdc-filter");
  if (saved) {
    (saved.tags || []).forEach((v, k) => { if (k < TAGS.length) filter.tags[k] = v === 1 ? 1 : 0; });
    if (saved.mode === "all") filter.mode = "all";
    for (const k of ["freqMin", "freqMax", "lenMin", "lenMax"]) {
      filter[k] = Number.isFinite(saved[k]) ? saved[k] : null;
      $("#" + k).value = filter[k] ?? "";
    }
  }
  panes = [...document.querySelectorAll(".pane")].map((el, k) => new Pane(el, k));
  filterChanged(); refreshAll();

  const pick = () => $("#fileInput").click();
  $("#openBtn").onclick = pick; $("#openBtn2").onclick = pick;
  $("#sampleBtn").onclick = loadSample;
  $("#fileInput").onchange = e => { openFile(e.target.files[0]); e.target.value = ""; };
  let dragDepth = 0;
  window.addEventListener("dragenter", e => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); dragDepth++; document.body.classList.add("dragging"); } });
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
  window.addEventListener("dragover", e => e.preventDefault());
  window.addEventListener("drop", e => {
    e.preventDefault(); dragDepth = 0; document.body.classList.remove("dragging");
    openFile(e.dataTransfer.files[0]);
  });

  $("#modeSeg").addEventListener("click", e => { const m = e.target.dataset.mode; if (m) { filter.mode = m; filterChanged(); } });
  for (const k of ["freqMin", "freqMax", "lenMin", "lenMax"])
    $("#" + k).addEventListener("input", e => { const v = parseInt(e.target.value, 10); filter[k] = Number.isFinite(v) ? v : null; filterChanged(); });
  $("#clearFilter").onclick = () => {
    filter.tags.fill(0); filter.mode = "any";
    for (const k of ["freqMin", "freqMax", "lenMin", "lenMax"]) { filter[k] = null; $("#" + k).value = ""; }
    $("#search").value = ""; filter.search = null;
    filterChanged();
  };
  let searchTimer = null;
  $("#search").addEventListener("input", e => { clearTimeout(searchTimer); searchTimer = setTimeout(() => setSearch(e.target.value), 180); });
  $("#undoBtn").onclick = undo;
  $("#toastUndo").onclick = undo;
  $("#exportBtn").onclick = exportDialog;
  $("#modal").addEventListener("click", e => { if (e.target.id === "modal" || e.target.dataset.close !== undefined) hideModal(); });
  document.addEventListener("keydown", e => {
    const inInput = document.activeElement.tagName === "INPUT";
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey && !inInput) { e.preventDefault(); undo(); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f" && N) { e.preventDefault(); $("#search").focus(); $("#search").select(); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") { e.preventDefault(); pick(); }
    if (e.key === "Escape" && $("#modal").classList.contains("show")) hideModal();
  });
  loadDicts();   // 提前在后台加载词典
}
init();
// 示例词库：合成数据（tools/make_sample.py 生成），以脚本形式加载，不需要网络请求权限
function loadSample() {
  busy("正在载入示例词库…");
  const s = document.createElement("script");
  s.src = "sample.js";
  s.onload = () => {
    const bin = atob(globalThis.SOGOU_SAMPLE), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    loadBuffer("示例词库.bin", bytes.buffer).catch(e => { busy(); alertModal("无法载入示例词库", e.message); });
  };
  s.onerror = () => { busy(); alertModal("无法载入示例词库", "sample.js 加载失败"); };
  document.head.appendChild(s);
}

window.SogouCleaner = { loadBuffer, loadSample };   // 便于自动化测试
