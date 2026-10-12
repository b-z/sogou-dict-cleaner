#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""生成合成的示例词库：tests/sample.bin（测试用）与 web/sample.js（网页「加载示例词库」用）。

词条是手工挑选的，覆盖每一种筛选标签；人名均为虚构。格式与搜狗导出的备份一致，
但不是搜狗生成的，只用于演示和测试，不要拿去恢复。

用法: python3 tools/make_sample.py
"""
import base64
import os
import struct
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, ROOT)
import sogou_dict as sd  # noqa: E402

# 实际输入里的简拼编码（与 web/sogou.js 的 PARTIAL 一致）
_SYL = set(sd.PINYIN[:413])
PARTIAL = sorted({"i", "u", "v"} | {s[:k] for s in _SYL for k in range(1, len(s)) if s[:k] not in _SYL})


def typed_code(p):
    """实际输入里的拼音：完整音节用标准编码，不完整的（简拼）用 842 起的编码"""
    return sd.PINYIN_INDEX[p] if p in _SYL else 842 + PARTIAL.index(p)


# (词, 拼音, 词频, 实际输入的拼音或 None)；词为 None 表示文字区无法解码的残留记录
ENTRIES = [
    # 正常的词
    ("你好", "ni hao", 120, None), ("谢谢", "xie xie", 80, None), ("哈哈", "ha ha", 40, None),
    ("输入法", "shu ru fa", 35, None), ("词库", "ci ku", 12, None), ("时间", "shi jian", 60, None),
    ("工作", "gong zuo", 50, None), ("开会", "kai hui", 20, None), ("周末", "zhou mo", 10, None),
    ("天气", "tian qi", 9, None), ("下载", "xia zai", 7, None), ("文件夹", "wen jian jia", 6, None),
    ("喜欢", "xi huan", 30, None), ("机票价格", "ji piao jia ge", 2, None), ("快递", "kuai di", 14, None),
    ("白平衡", "bai ping heng", 8, "bai ping h"), ("按钮", "an niu", 8, "an n"), ("照片", "zhao pian", 15, "zhao p"),
    ("随便什么", "sui bian shen me", 3, "sui bian s m"),
    # 随手记下的短语（非常用词）
    ("我很喜欢喝", "wo hen xi huan he", 1, None), ("就可以了", "jiu ke yi le", 3, None),
    ("吃多了", "chi duo le", 1, None), ("还是怎么的", "hai shi zen me de", 1, None),
    ("今天晚上一起去吃饭吧", "jin tian wan shang yi qi qu chi fan ba", 1, None),
    # 乱码
    ("㥒쮤", "zi ji", 1, None), ("⍤Ⰻ⁅", "gen zhe zuo", 4, None), ("ꦪ뗡劗", "ba yan chi", 2, None),
    (None, "bai se de dao", 1, None),
    # 汉字乱码：全是冷僻字，读音也对不上
    ("埥䤅靨羹", "he kuang hai you", 1, None), ("趫蝭邖", "qu hao le", 1, None), ("䧸硵丫䣶", "zhou ri qu la", 1, None),
    # 生僻字、次常用字
    ("王喆", "wang zhe", 2, None), ("旖旎", "yi ni", 3, None), ("桎梏", "zhi gu", 1, None),
    # 繁体字
    ("來自於", "lai zi yu", 1, None), ("後來", "hou lai", 2, None),
    # 拼音不符：拼音里存了好几次输入尝试
    ("还与", "hai you hai you hai yu", 1, None), ("出现过", "chu xian ge chu xian guo", 1, None),
    # 人名（虚构）
    ("张小明", "zhang xiao ming", 3, None), ("李雨桐", "li yu tong", 2, None), ("陈思远", "chen si yuan", 1, None),
    # 英文、数字
    ("k8s", "k 8 s", 2, None), ("MD5", "m d 5", 1, None), ("ok", "o k", 4, None),
    # 重复词与多种拼音
    ("红外除尘", "hong wai chu chen", 2, None), ("红外除尘", "hong wai chu chen", 1, None),
    ("长度", "chang du", 5, None), ("长度", "zhang du", 1, None),
    # 零词频
    ("测试一下", "ce shi yi xia", 0, None),
    # 叠词
    ("闭包闭包", "bi bao bi bao", 1, None), ("啊啊啊啊", "a a a a", 1, None), ("看一下看一下", "kan yi xia kan yi xia", 1, None),
]


def record(word, pinyin, rank, typed, time):
    codes = [sd.PINYIN_INDEX[p] for p in pinyin.split()]
    pyb = struct.pack(f"<{len(codes)}H", *codes)
    # 无法解码的残留：用孤立的代理项构造非法 UTF-16
    wb = struct.pack("<2H", 0xD800, 0x0041) if word is None else word.encode("utf-16-le")
    tcodes = [typed_code(p) for p in typed.split()] if typed else codes
    tail = struct.pack("<H", len(pyb)) + struct.pack(f"<{len(tcodes)}H", *tcodes)
    flag = 2 if rank >= 20 else 3
    return (struct.pack("<HIBBBH", rank, time, 1, 0, flag, len(pyb)) + pyb
            + struct.pack("<HH", 2 + len(wb) + len(tail), len(wb)) + wb + tail), codes


def build():
    recs = []
    for k, (word, pinyin, rank, typed) in enumerate(ENTRIES):
        raw, codes = record(word, pinyin, rank, typed, 100 + 37 * k)
        recs.append((raw, codes, word or ""))
    blob = b"".join(r[0] for r in recs)
    offsets, pos = [], 0
    for raw, _, _ in recs:
        offsets.append(pos)
        pos += len(raw)
    order = sorted(range(len(recs)), key=lambda i: sd.sort_key(recs[i][1], recs[i][2]))

    isz, dcap = 400, 4000
    ib, db = sd.HEADER_SIZE, sd.HEADER_SIZE + isz
    out = bytearray(db + dcap)
    w = lambda off, v: struct.pack_into("<I", out, off, v)
    out[0:4] = sd.MAGIC
    for off, v in ((0x04, 0x28), (0x08, 0x0133A009), (0x10, len(out)), (0x14, 1), (0x18, 0x10), (0x24, 0x54),
                   (0x28, 100 + 37 * len(ENTRIES)), (0x38, ib), (0x3C, isz), (0x40, len(recs)), (0x44, db),
                   (0x48, dcap), (0x4C, len(blob)), (0x50, 9), (0x64, 0xFFFFFFFF), (0x68, 4), (0x6C, 0xFFFFFFFF)):
        w(off, v)
    w(0x54, sum(1 for e in ENTRIES if e[2] == 0))
    for j, i in enumerate(order):
        w(ib + 4 * j, offsets[i])
    out[db:db + len(blob)] = blob
    w(0x20, sd.header_checksum(out))
    assert not sd.check(out), sd.check(out)
    return bytes(out)


def main():
    data = build()
    os.makedirs(os.path.join(ROOT, "tests"), exist_ok=True)
    with open(os.path.join(ROOT, "tests", "sample.bin"), "wb") as f:
        f.write(data)
    with open(os.path.join(ROOT, "web", "sample.js"), "w", encoding="utf-8") as f:
        f.write("/* 由 tools/make_sample.py 生成的示例词库（合成数据，人名均为虚构），请勿手改。 */\n")
        f.write(f'globalThis.SOGOU_SAMPLE = "{base64.b64encode(data).decode()}";\n')
    print(f"示例词库：{len(ENTRIES)} 条，{len(data)} 字节 → tests/sample.bin、web/sample.js", file=sys.stderr)


if __name__ == "__main__":
    main()
