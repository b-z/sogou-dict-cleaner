#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// 对拍：网页版 (web/sogou.js) 与命令行版 (sogou_dict.py) 处理同一个备份的结果必须一致。
// 用法: node tools/check_web.js 备份.bin [--all-tags]
//   --all-tags  额外检查每一种筛选标签都至少命中一条（用于示例词库 tests/sample.bin）
"use strict";
const fs = require("fs"), os = require("os"), path = require("path");
const { execFileSync } = require("child_process");
const S = require("../web/sogou.js");

const bin = process.argv.slice(2).find(a => !a.startsWith("--"));
const allTags = process.argv.includes("--all-tags");
if (!bin) { console.error("用法: node tools/check_web.js 备份.bin [--all-tags]"); process.exit(2); }
const py = path.join(__dirname, "..", "sogou_dict.py");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sdc-"));
const u8 = new Uint8Array(fs.readFileSync(bin));
const recs = S.parse(u8);
let ok = true;
const expect = (name, cond) => { console.log(`${cond ? "✓" : "✗"} ${name}`); ok = ok && cond; };

execFileSync("python3", ["-I", py, "export", bin, path.join(tmp, "e.txt")], { stdio: "ignore" });
expect("导出文本一致", S.toTSV(recs) === fs.readFileSync(path.join(tmp, "e.txt"), "utf8"));

execFileSync("python3", ["-I", py, "clean", bin, path.join(tmp, "c.bin")], { stdio: "ignore" });
const info = S.analyze(recs);
const keep = recs.map((_, i) => i).filter(i => !(info[i].tags & S.TAG.GARBLED));
expect("删除乱码后的 .bin 逐字节一致", Buffer.compare(Buffer.from(S.rebuild(u8, keep, recs)), fs.readFileSync(path.join(tmp, "c.bin"))) === 0);
expect("全部保留时与原文件逐字节一致", Buffer.compare(Buffer.from(S.rebuild(u8, recs.map((_, i) => i), recs)), Buffer.from(u8)) === 0);
expect("原文件通过文件头检查", S.check(u8).length === 0);

if (allTags) {
  require("../web/data.js");
  const full = S.analyze(recs, {
    commonWords: new Set(globalThis.SOGOU_COMMON_WORDS.split("\n")),
    tradChars: new Set(Array.from(globalThis.SOGOU_TRAD_CHARS)),
  });
  for (const [name, bit] of Object.entries(S.TAG))
    expect(`标签 ${name} 至少命中一条`, full.some(x => x.tags & bit));
  expect("能解析出实际输入的拼音", recs.some(r => r.typed));
}

fs.rmSync(tmp, { recursive: true });
process.exit(ok ? 0 : 1);
