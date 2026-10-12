#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""生成网页用的数据文件 web/data.js：常用词表与繁体字表。

用法: python3 tools/build_data.py [jieba dict.txt] [OpenCC TSCharacters.txt]
不给路径时从 GitHub 下载：
  - jieba 分词词典 dict.txt（MIT 许可）→ 常用词表（两字及以上的汉字词）
  - OpenCC 繁→简字表 TSCharacters.txt（Apache-2.0 许可）→ 繁体字表（有不同于自身的简体写法的字）
"""
import os
import re
import sys
import urllib.request

JIEBA_URL = "https://raw.githubusercontent.com/fxsjy/jieba/master/jieba/dict.txt"
OPENCC_URL = "https://raw.githubusercontent.com/BYVoid/OpenCC/master/data/dictionary/TSCharacters.txt"
HAN = re.compile(r"^[㐀-鿿豈-﫿\U00020000-\U0003134f]{2,}$")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "data.js")


def load(path, url):
    if path:
        return open(path, encoding="utf-8").read()
    print(f"下载 {url} …", file=sys.stderr)
    return urllib.request.urlopen(url).read().decode("utf-8")


def main():
    args = sys.argv[1:] + [None, None]
    jieba, opencc = load(args[0], JIEBA_URL), load(args[1], OPENCC_URL)

    words = sorted({w for line in jieba.splitlines() if line.strip() and HAN.match(w := line.split()[0])})
    trad = []
    for line in opencc.splitlines():
        if not line or line.startswith("#"):
            continue
        key, values = line.split("\t")
        if len(key) == 1 and key not in values.split():
            trad.append(key)
    trad = "".join(sorted(set(trad)))

    with open(OUT, "w", encoding="utf-8") as f:
        f.write("/* 由 tools/build_data.py 生成，请勿手改。\n"
                " * 常用词表：jieba 分词词典 https://github.com/fxsjy/jieba （MIT 许可，Copyright (c) 2013 Sun Junyi）\n"
                " * 繁体字表：OpenCC TSCharacters.txt https://github.com/BYVoid/OpenCC （Apache-2.0 许可） */\n")
        f.write(f'globalThis.SOGOU_TRAD_CHARS = "{trad}";\n')
        f.write('globalThis.SOGOU_COMMON_WORDS = "' + "\\n".join(words) + '";\n')
    print(f"常用词 {len(words)} 个，繁体字 {len(trad)} 个 → {os.path.normpath(OUT)}"
          f"（{os.path.getsize(OUT) / 1e6:.1f} MB）", file=sys.stderr)


if __name__ == "__main__":
    main()
