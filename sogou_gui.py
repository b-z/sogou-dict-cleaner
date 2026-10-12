#!/usr/bin/env python3
"""搜狗词库清理工具的图形界面：在浏览器里挑选要移除的词，导出干净的词库。

用法: python3 sogou_gui.py 备份.bin [--port 端口] [--no-browser]

只监听 127.0.0.1；进度自动保存在 备份.bin.cleaner.json，导出的文件写在备份文件旁边。
"""
import argparse
import json
import os
import re
import secrets
import sys
import time
import webbrowser
from collections import Counter, defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import sogou_dict as sd

HERE = os.path.dirname(os.path.abspath(__file__))

# 标签位（与 gui.html 中 TAGS 对应）
GARBLED = 1 << 0      # 含非汉字非 ASCII 字符，或文字无法解码
HAN_GARBLED = 1 << 1  # 全是汉字，但字和拼音几乎都对不上
RARE3 = 1 << 2        # 含 GB2312 以外的字
RARE2 = 1 << 3        # 含 GB2312 二级字（次常用字）
PY_MISMATCH = 1 << 4  # 字数与音节数不一致，或某个字的读音只在这个词里出现过
NAME = 1 << 5         # 疑似人名
LATIN = 1 << 6        # 含英文字母或数字
MULTI_PY = 1 << 7     # 同一个词有多种拼音

HAN = re.compile(r"^[㐀-鿿豈-﫿\U00020000-\U0003134f]+$")
LATIN_RE = re.compile(r"[A-Za-z0-9]")

SURNAMES = set("王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈"
               "姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向"
               "汤常温康施文牛樊葛邢安齐易乔伍庞颜倪庄聂章鲁岳翟殷詹申欧耿关兰焦俞左柳甘祝包宁尚符舒阮柯纪梅童凌毕"
               "单季裴霍涂成苗谷盛曲翁冉骆蓝路游辛靳管柴蒙鲍华喻祁蒲房滕屈饶解牟艾尤阳时穆农司卓古吉缪简车项连芦麦"
               "褚娄窦戚岑景党宫费卜冷晏席卫米柏宗瞿桂全佟应臧闵苟邬边卞姬师和仇栾隋商刁沙荣巫寇桑郎甄丛仲虞敖巩明"
               "佘池查麻苑迟邝")
# 常见名字用字（用于判断两字词是否像人名）
NAME_CHARS = set("伟芳娜敏静丽强磊军洋勇艳杰娟涛明超秀霞平刚桂英华玉萍红娥玲芬燕彬鹏辉宇浩凯晨瑶琪婷雪琳萱怡欣"
                 "颖慧佳嘉思雨倩薇蕾璐瑾瑜琦珊莹菲妍婧晶露蓉媛楠岚昊轩睿博涵泽豪鑫俊峰帆航旭阳斌毅锋皓翔宸逸彤悦"
                 "诗梦洁茜蓓淼焱鹤骏翊珂钰珺琛玥婕瑞霖烨晗昕曦熙然坤乾鸿鹏")
# 含这些字的多半是普通短语而不是人名
NOT_NAME_CHARS = set("的了是我你他她它们这那个在有不也就都和与着过吗呢吧啊上下来去说要会能可么没还很太更最"
                     "把被让给对从向往到里外前后中边面头子儿们些点种样次回些")
COMPOUND_SURNAMES = {"欧阳", "司马", "诸葛", "上官", "东方", "皇甫", "慕容", "令狐", "司徒", "夏侯", "尉迟", "公孙",
                     "长孙", "宇文", "端木", "南宫", "独孤", "轩辕", "钟离", "澹台"}


def gb2312_level(ch):
    """0: ASCII 等单字节；1: 一级字；2: 二级字；3: 不在 GB2312 中"""
    try:
        b = ch.encode("gb2312")
    except UnicodeEncodeError:
        return 3
    if len(b) < 2:
        return 0
    if b[0] < 0xB0:  # 符号区
        return 1
    return 1 if b[0] < 0xD8 else 2


def looks_like_name(w, known_words):
    """粗略判断是否像人名：姓 + 名，名的部分不是词库里已有的词、不含虚字"""
    if w[:2] in COMPOUND_SURNAMES and 3 <= len(w) <= 4:
        given = w[2:]
    elif w[0] in SURNAMES and 2 <= len(w) <= 3:
        given = w[1:]
    else:
        return False
    if any(c in NOT_NAME_CHARS for c in given):
        return False
    if len(given) == 1:
        return given in NAME_CHARS
    # 「游泳馆」「关键词」这类：后两字或前两字本身就是常用词
    return given not in known_words and w[:2] not in known_words


def analyze(recs):
    """为每个词条计算标签位和可疑字位置。返回 [(tags, bad_positions)]"""
    # 用整本词库自身做读音字典：(字, 音节) 出现在多少个词条里
    aligned = [r for r in recs if r.word and HAN.match(r.word) and len(r.word) == len(r.codes)]
    pair = Counter((c, p) for r in aligned for c, p in zip(r.word, r.codes))
    readings = defaultdict(int)
    for (c, _p), n in pair.items():
        readings[c] += n
    pinyins_of = defaultdict(set)
    for r in recs:
        if r.word:
            pinyins_of[r.word].add(r.codes)

    out = []
    for r in recs:
        w = r.word
        tags, bad = 0, []
        if w is None or not sd.NORMAL_WORD.match(w):
            tags |= GARBLED
            if w:
                bad = [i for i, c in enumerate(w) if not sd.NORMAL_WORD.match(c)]
            out.append((tags, bad))
            continue
        if LATIN_RE.search(w):
            tags |= LATIN
        if len(pinyins_of[w]) > 1:
            tags |= MULTI_PY
        if HAN.match(w):
            levels = [gb2312_level(c) for c in w]
            if 3 in levels:
                tags |= RARE3
            elif 2 in levels:
                tags |= RARE2
            if len(w) != len(r.codes):
                tags |= PY_MISMATCH
            else:
                support = [pair[(c, p)] for c, p in zip(w, r.codes)]
                corroborated = sum(1 for s in support if s >= 2)
                # 读音只在本词出现、而这个字在别处另有常见读音 → 读音可疑
                bad = [i for i, (c, s) in enumerate(zip(w, support)) if s <= 1 and readings[c] - s >= 2]
                if bad:
                    tags |= PY_MISMATCH
                score = corroborated / len(w)
                # 乱码用的多是在别处几乎不出现的冷僻字；字很常见只是读音不对的（如「日文表述 a ao a ao」）
                # 属于拼音损坏，不算乱码
                unfamiliar = sum(1 for c, s in zip(w, support) if readings[c] - s < 2) / len(w)
                if len(w) >= 2 and unfamiliar >= 0.5 and (
                        (score == 0 and len(w) >= 3) or (score < 0.5 and 3 in levels)):
                    tags |= HAN_GARBLED
                    bad = [i for i, s in enumerate(support) if s <= 1]
            if 3 not in levels and looks_like_name(w, pinyins_of):
                tags |= NAME
        out.append((tags, bad))
    return out


class App:
    def __init__(self, path):
        self.path = os.path.abspath(path)
        self.state_path = self.path + ".cleaner.json"
        with open(self.path, "rb") as f:
            self.orig = f.read()
        self.recs = sd.read_records(self.orig)
        info = analyze(self.recs)
        self.rows = [[r.word if r.word is not None else "〈无法解码〉", r.pinyin, r.rank, t, b]
                     for r, (t, b) in zip(self.recs, info)]
        self.token = secrets.token_urlsafe(16)

    def load_state(self):
        try:
            with open(self.state_path, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return {"candidates": [], "removed": []}

    def save_state(self, state):
        tmp = self.state_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False)
        os.replace(tmp, self.state_path)

    def export(self, removed):
        removed = set(removed)
        keep = {i: None for i in range(len(self.recs)) if i not in removed}
        data, nkept = sd.rebuild_indices(self.orig, keep, recs=self.recs)
        problems = sd.check(data)
        if problems:
            raise ValueError("；".join(problems))
        base = os.path.splitext(self.path)[0] + "_干净_" + time.strftime("%Y%m%d_%H%M%S")
        with open(base + ".bin", "wb") as f:
            f.write(data)
        with open(base + ".txt", "w", encoding="utf-8") as f:
            for i in sorted(keep):
                r = self.recs[i]
                if r.word is not None:
                    f.write(f"{r.word}\t{r.pinyin}\t{r.rank}\n")
        return {"bin": base + ".bin", "txt": base + ".txt", "kept": nkept, "removed": len(removed)}


def make_handler(app):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, code, body, ctype="application/json; charset=utf-8"):
            if isinstance(body, (dict, list)):
                body = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
            elif isinstance(body, str):
                body = body.encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def local_host(self):
            # 防 DNS 重绑定：只接受以本机地址访问
            host = self.headers.get("Host", "").rsplit(":", 1)[0]
            return host in ("127.0.0.1", "localhost")

        def authorized(self):
            return self.local_host() and secrets.compare_digest(self.headers.get("X-Token", ""), app.token)

        def do_GET(self):
            if not self.local_host():
                return self.send(403, {"error": "forbidden"})
            if self.path == "/" or self.path.startswith("/?"):
                with open(os.path.join(HERE, "gui.html"), encoding="utf-8") as f:
                    html = f.read().replace("__TOKEN__", app.token)
                return self.send(200, html, "text/html; charset=utf-8")
            if not self.authorized():
                return self.send(403, {"error": "forbidden"})
            if self.path == "/api/data":
                return self.send(200, {"file": os.path.basename(app.path), "rows": app.rows,
                                       "state": app.load_state()})
            self.send(404, {"error": "not found"})

        def do_POST(self):
            if not self.authorized():
                return self.send(403, {"error": "forbidden"})
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                n = len(app.recs)
                ids = lambda key: [i for i in body.get(key, []) if isinstance(i, int) and 0 <= i < n]
                if self.path == "/api/state":
                    app.save_state({"candidates": ids("candidates"), "removed": ids("removed")})
                    return self.send(200, {"ok": True})
                if self.path == "/api/export":
                    return self.send(200, app.export(ids("removed")))
            except Exception as e:  # 把错误显示在界面上
                return self.send(500, {"error": str(e)})
            self.send(404, {"error": "not found"})

    return Handler


def main():
    ap = argparse.ArgumentParser(description="搜狗词库清理工具图形界面")
    ap.add_argument("bin", help="搜狗导出的备份 .bin 文件")
    ap.add_argument("--port", type=int, default=0, help="端口（默认随机）")
    ap.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    args = ap.parse_args()

    print("正在读取词库…", file=sys.stderr)
    app = App(args.bin)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(app))
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    print(f"共 {len(app.recs)} 条。界面地址：{url}  （Ctrl+C 退出）", file=sys.stderr)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
