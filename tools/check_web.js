#!/usr/bin/env node
// 对拍：网页版 (web/sogou.js) 与命令行版 (sogou_dict.py) 处理同一个备份的结果必须一致。
// 用法: node tools/check_web.js 备份.bin
"use strict";
const fs = require("fs"), os = require("os"), path = require("path");
const { execFileSync } = require("child_process");
const S = require("../web/sogou.js");

const bin = process.argv[2];
if (!bin) { console.error("用法: node tools/check_web.js 备份.bin"); process.exit(2); }
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

fs.rmSync(tmp, { recursive: true });
process.exit(ok ? 0 : 1);
