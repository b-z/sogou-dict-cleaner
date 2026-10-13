#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// 生成 README 用的高分辨率截图 docs/screenshot.png（示例词库，浅色主题，2 倍像素密度）。
// 需要本机装有 Google Chrome（或用环境变量 CHROME 指定路径）；node 22 以上（自带 WebSocket）。
// 用法: node tools/screenshot.js
"use strict";
const { spawn } = require("child_process");
const fs = require("fs"), http = require("http"), os = require("os"), path = require("path");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "web");
const OUT = path.join(ROOT, "docs", "screenshot.png");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WIDTH = 1440, HEIGHT = 860, SCALE = 2;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 页面里执行的演示步骤：载入示例词库，摆出一个有代表性的界面
const DEMO = `(async () => {
  await window.SogouCleaner.loadSample();
  const chip = n => [...document.querySelectorAll("#chips .chip")].find(c => c.querySelector(".name").textContent === n);
  const pane = i => document.querySelector('.pane[data-pane="' + i + '"]');
  const tick = (p, k) => p.querySelectorAll(".row")[k].querySelector(".ck").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  const wait = () => new Promise(r => setTimeout(r, 50));
  // 乱码一类先全部移到备选，再挑几条确认移除
  for (const n of ["乱码", "汉字乱码", "生僻字", "叠词", "重复词"]) chip(n).click();
  pane(0).querySelector("[data-selall]").click(); pane(0).querySelector('[data-act="1"]').click(); await wait();
  for (const k of [0, 1, 2, 3]) tick(pane(1), k);
  pane(1).querySelector('[data-act="2"]').click(); await wait();
  for (const n of ["乱码", "汉字乱码", "生僻字", "叠词", "重复词"]) chip(n).click();
  // 左栏展示一个组合筛选，右上留两条选中状态
  chip("非常用词").click();
  const fmax = document.querySelector("#freqMax"); fmax.value = "3"; fmax.dispatchEvent(new Event("input", { bubbles: true }));
  for (const k of [1, 3]) tick(pane(1), k);
  document.querySelector("#toast").classList.remove("show");
  document.activeElement.blur();
  await wait();
  return "ok";
})()`;

function serve() {
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".txt": "text/plain; charset=utf-8" };
  const server = http.createServer((req, res) => {
    const p = path.join(WEB, decodeURIComponent(req.url.split("?")[0]).replace(/\/$/, "/index.html"));
    if (!p.startsWith(WEB) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": types[path.extname(p)] || "application/octet-stream" });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise(r => server.listen(0, "127.0.0.1", () => r(server)));
}

async function main() {
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "sdc-chrome-"));
  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--hide-scrollbars", "--force-color-profile=srgb", `--window-size=${WIDTH},${HEIGHT}`, "about:blank"], { stdio: "ignore" });
  try {
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      await sleep(200);
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === "page"); } catch {}
    }
    if (!target) throw new Error("无法连接 Chrome");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0;
    const pending = new Map(), events = [];
    ws.onmessage = m => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } else events.push(msg.method);
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, msg => (msg.error ? reject(new Error(method + ": " + msg.error.message)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });

    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false });
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
    await send("Page.navigate", { url });
    for (let i = 0; i < 50 && !events.includes("Page.loadEventFired"); i++) await sleep(100);
    const r = await send("Runtime.evaluate", { expression: DEMO, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("演示脚本出错：" + JSON.stringify(r.exceptionDetails));
    await sleep(500);
    const shot = await send("Page.captureScreenshot", { format: "png" });
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, Buffer.from(shot.data, "base64"));
    console.log(`已保存 ${path.relative(ROOT, OUT)}（${WIDTH * SCALE}×${HEIGHT * SCALE}）`);
    ws.close();
  } finally {
    const exited = new Promise(r => chrome.once("exit", r));
    chrome.kill();
    await Promise.race([exited, sleep(3000)]);
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
