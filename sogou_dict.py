#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# 词条解析逻辑与拼音码表参考 imewlconverter 的 SougouBinParser（源自 nopdan/rose），均为 GPL-3.0。
"""搜狗输入法用户词库备份（.bin，SGPU 格式）清理工具。

用法:
  python3 sogou_dict.py export  备份.bin [输出.txt]        导出为 TSV：词<TAB>拼音<TAB>词频
  python3 sogou_dict.py clean   备份.bin 输出.bin          一步删除乱码词条，生成可恢复的 .bin
  python3 sogou_dict.py rebuild 备份.bin 编辑后.txt 输出.bin 按编辑后的 TSV 重建 .bin
  python3 sogou_dict.py check   文件.bin                    按搜狗加载逻辑检查文件头

rebuild/clean 以原始备份为模板：保留的词条逐字节照搬，文件头只改条数、已用大小、
零词频条数和校验和，其余字段（含含义未知的统计值）保持原样。
"""
import re
import struct
import sys
from collections import defaultdict

MAGIC = b"SGPU"
HEADER_SIZE = 0x8C

# 拼音码表：前 413 个是音节，之后是单个字母、数字和 '#'（用于 '-' 等符号）
PINYIN = """a ai an ang ao ba bai ban bang bao bei ben beng bi bian biao bie bin bing bo bu ca cai can cang cao ce cen ceng cha chai chan chang chao che chen cheng chi chong chou chu chua chuai chuan chuang chui chun chuo ci cong cou cu cuan cui cun cuo da dai dan dang dao de dei den deng di dia dian diao die ding diu dong dou du duan dui dun duo e ei en eng er fa fan fang fei fen feng fiao fo fou fu ga gai gan gang gao ge gei gen geng gong gou gu gua guai guan guang gui gun guo ha hai han hang hao he hei hen heng hong hou hu hua huai huan huang hui hun huo ji jia jian jiang jiao jie jin jing jiong jiu ju juan jue jun ka kai kan kang kao ke kei ken keng kong kou ku kua kuai kuan kuang kui kun kuo la lai lan lang lao le lei leng li lia lian liang liao lie lin ling liu lo long lou lu luan lve lun luo lv ma mai man mang mao me mei men meng mi mian miao mie min ming miu mo mou mu na nai nan nang nao ne nei nen neng ni nian niang niao nie nin ning niu nong nou nu nuan nve nun nuo nv o ou pa pai pan pang pao pei pen peng pi pian piao pie pin ping po pou pu qi qia qian qiang qiao qie qin qing qiong qiu qu quan que qun ran rang rao re ren reng ri rong rou ru rua ruan rui run ruo sa sai san sang sao se sen seng sha shai shan shang shao she shei shen sheng shi shou shu shua shuai shuan shuang shui shun shuo si song sou su suan sui sun suo ta tai tan tang tao te tei teng ti tian tiao tie ting tong tou tu tuan tui tun tuo wa wai wan wang wei wen weng wo wu xi xia xian xiang xiao xie xin xing xiong xiu xu xuan xue xun ya yan yang yao ye yi yin ying yo yong you yu yuan yue yun za zai zan zang zao ze zei zen zeng zha zhai zhan zhang zhao zhe zhei zhen zheng zhi zhong zhou zhu zhua zhuai zhuan zhuang zhui zhun zhuo zi zong zou zu zuan zui zun zuo""".split() \
    + list("abcdefghijklmnopqrstuvwxyz0123456789#")

PINYIN_INDEX = {}
for _i, _p in enumerate(PINYIN):
    PINYIN_INDEX.setdefault(_p, _i)

# 正常词条只含汉字（含扩展区）、可见 ASCII 字符和「〇」
NORMAL_WORD = re.compile(r"^[㐀-䶿一-鿿\U00020000-\U0003134f\x21-\x7e〇]+$")


class Record:
    """一个词条。raw 为原始字节；word 为 None 表示文字区无法解码（乱码残留）。"""

    __slots__ = ("offset", "raw", "rank", "codes", "word")

    def __init__(self, offset, raw, rank, codes, word):
        self.offset, self.raw, self.rank, self.codes, self.word = offset, raw, rank, codes, word

    @property
    def pinyin(self):
        return " ".join(PINYIN[c] if c < len(PINYIN) else f"?{c}" for c in self.codes)

    @property
    def key(self):
        return f"{self.word}\t{self.pinyin}"


def u32(data, off):
    return struct.unpack_from("<I", data, off)[0]


def layout(data):
    """返回 (索引起点, 索引容量字节, 条数, 数据区起点, 数据区容量, 已用大小)"""
    if data[:4] != MAGIC:
        raise ValueError("不是搜狗 SGPU 格式的备份文件")
    return struct.unpack_from("<6I", data, 0x38)


def read_records(data):
    """按索引顺序读出所有词条"""
    ib, _isz, cnt, db, _dcap, dused = layout(data)
    end = db + dused
    if ib + 4 * cnt > len(data) or end > len(data):
        raise ValueError("文件不完整或已损坏")
    out = []
    for i in range(cnt):
        off = u32(data, ib + 4 * i)
        p = db + off
        if p + 15 > end:
            raise ValueError(f"第 {i + 1} 条词条超出数据区，文件不完整或已损坏")
        rank = struct.unpack_from("<H", data, p)[0]
        n = struct.unpack_from("<H", data, p + 9)[0]
        if p + 15 + n > end:
            raise ValueError(f"第 {i + 1} 条词条超出数据区，文件不完整或已损坏")
        codes = struct.unpack_from(f"<{n // 2}H", data, p + 11)
        ext, wlen = struct.unpack_from("<HH", data, p + 11 + n)
        if p + 13 + n + ext > end or wlen > ext - 2:
            raise ValueError(f"第 {i + 1} 条词条长度异常，文件不完整或已损坏")
        try:
            word = data[p + 15 + n:p + 15 + n + wlen].decode("utf-16-le")
        except UnicodeDecodeError:
            word = None
        out.append(Record(off, data[p:p + 13 + n + ext], rank, codes, word))
    return out


def header_checksum(data):
    """搜狗 t_dictBase::CheckValid 的校验和：文件头各字段之和（不含 0x20 本身和 0x28-0x37 扩展区）"""
    size = len(data)
    base = u32(data, 4) + u32(data, 0x18)
    sections = u32(data, 0x14)
    s = base + u32(data, 0) + u32(data, 8) + sections + size + u32(data, 0xC) + u32(data, 0x1C) + u32(data, 0x24)
    for k in range(sections):
        s += sum(struct.unpack_from("<21I", data, base + 0x54 * k))
    return s & 0xFFFFFFFF


def check(data):
    """复现搜狗加载时的文件头检查，返回问题列表（空表示通过）"""
    problems = []
    if data[:4] != MAGIC:
        return ["魔数不是 SGPU"]
    size = len(data)
    base = u32(data, 4) + u32(data, 0x18)
    sections = u32(data, 0x14)
    if sections * 0x54 + base > size:
        problems.append("文件头段越界")
    if u32(data, 0x10) != size:
        problems.append(f"文件长度字段 {u32(data, 0x10)} 与实际大小 {size} 不符")
    for k in range(sections):
        sec = struct.unpack_from("<21I", data, base + 0x54 * k)
        for a, b in ((0, 1), (3, 4), (8, 9)):
            if sec[a] + sec[b] > size:
                problems.append(f"第 {k} 段字段 {a} 越界")
    if header_checksum(data) != u32(data, 0x20):
        problems.append(f"校验和不符：文件 {u32(data, 0x20):#x}，计算 {header_checksum(data):#x}")
    return problems


def new_record(word, codes, rank):
    """按备份里常见的词条格式构造新词条（实验性）"""
    pyb = struct.pack(f"<{len(codes)}H", *codes)
    wb = word.encode("utf-16-le")
    tail = struct.pack("<H", len(pyb)) + pyb
    return (struct.pack("<HH5BH", rank, 0, 0, 0, 1, 0, 3, len(pyb)) + pyb
            + struct.pack("<HH", 2 + len(wb) + len(tail), len(wb)) + wb + tail)


def sort_key(codes, word):
    return (list(codes), word.encode("utf-16-be"))


def rebuild(orig, entries):
    """以 orig 为模板，按 entries [(行号, 词, 拼音, 词频|None)] 重建。
    返回 (新文件字节, 保留条数, 新增列表, 错误列表)"""
    recs = read_records(orig)
    pool = defaultdict(list)  # key -> 原记录在索引中的位置
    for i, r in enumerate(recs):
        if r.word is not None:
            pool[r.key].append(i)

    keep, added, errors = {}, [], []  # keep: 索引位置 -> 新词频(None 不改)
    for ln, word, py, rank in entries:
        try:
            codes = tuple(PINYIN_INDEX[s] for s in py.split())
        except KeyError as e:
            errors.append(f"第{ln}行 {word} [{py}]: 未知拼音 {e}")
            continue
        if not word or not codes:
            errors.append(f"第{ln}行: 词或拼音为空")
            continue
        k = f"{word}\t{' '.join(PINYIN[c] for c in codes)}"
        if pool.get(k):
            keep[pool[k].pop(0)] = rank
        else:
            added.append((word, codes, 1 if rank is None else rank))
    return rebuild_indices(orig, keep, added, recs) + (added, errors)


def rebuild_indices(orig, keep, added=(), recs=None):
    """以 orig 为模板重建。keep: {原索引位置: 新词频或 None}；added: [(词, 拼音码, 词频)]。
    返回 (新文件字节, 保留条数)"""
    ib, isz, _cnt, db, dcap, _dused = layout(orig)
    if recs is None:
        recs = read_records(orig)
    # 数据区：保留记录按原物理顺序紧凑排列
    kept = sorted(keep, key=lambda i: recs[i].offset)
    blob, new_off = bytearray(), {}
    for i in kept:
        raw = bytearray(recs[i].raw)
        if keep[i] is not None:
            struct.pack_into("<H", raw, 0, max(0, min(keep[i], 0xFFFF)))
        new_off[i] = len(blob)
        blob += raw
    # 索引：保留记录维持原索引相对顺序，新词按 (拼音码, 词) 插入
    index = [(sort_key(recs[i].codes, recs[i].word or ""), new_off[i]) for i in sorted(kept)]
    for word, codes, rank in added:
        index.append((sort_key(codes, word), len(blob)))
        blob += new_record(word, codes, max(0, min(rank, 0xFFFF)))
    if added:
        index.sort(key=lambda t: t[0])  # 稳定排序，原有相对顺序不变

    n = len(index)
    if n * 4 > isz or len(blob) > dcap:
        raise ValueError("词条超出原文件容量，暂不支持扩容")
    zero = sum(1 for _, off in index if struct.unpack_from("<H", blob, off)[0] == 0)

    out = bytearray(len(orig))
    out[:HEADER_SIZE] = orig[:HEADER_SIZE]
    struct.pack_into("<I", out, 0x40, n)
    struct.pack_into("<I", out, 0x4C, len(blob))
    struct.pack_into("<I", out, 0x54, zero)
    for j, (_, off) in enumerate(index):
        struct.pack_into("<I", out, ib + 4 * j, off)
    out[db:db + len(blob)] = blob
    struct.pack_into("<I", out, 0x20, header_checksum(out))
    return bytes(out), len(kept)


def read_tsv(path):
    with open(path, encoding="utf-8") as f:
        for ln, line in enumerate(f, 1):
            line = line.rstrip("\n")
            if not line.strip():
                continue
            parts = line.split("\t")
            rank = int(parts[2]) if len(parts) > 2 and parts[2].strip() else None
            yield ln, parts[0], parts[1] if len(parts) > 1 else "", rank


def write_bin(path, data):
    problems = check(data)
    if problems:
        raise SystemExit("生成结果未通过检查：" + "；".join(problems))
    with open(path, "wb") as f:
        f.write(data)


def cmd_export(src, dst=None):
    recs = read_records(open(src, "rb").read())
    good = [r for r in recs if r.word is not None]
    out = open(dst, "w", encoding="utf-8") if dst else sys.stdout
    for r in good:
        out.write(f"{r.word}\t{r.pinyin}\t{r.rank}\n")
    print(f"导出 {len(good)} 条，跳过 {len(recs) - len(good)} 条无法解码的记录", file=sys.stderr)


def cmd_clean(src, dst):
    orig = open(src, "rb").read()
    recs = read_records(orig)
    keep = {i: None for i, r in enumerate(recs) if r.word is not None and NORMAL_WORD.match(r.word)}
    data, nkept = rebuild_indices(orig, keep, recs=recs)
    write_bin(dst, data)
    print(f"保留 {nkept} 条，删除 {len(recs) - nkept} 条乱码词条", file=sys.stderr)


def cmd_rebuild(src, tsv, dst):
    orig = open(src, "rb").read()
    data, nkept, added, errors = rebuild(orig, read_tsv(tsv))
    write_bin(dst, data)
    print(f"保留 {nkept} 条，新增 {len(added)} 条（实验性），失败 {len(errors)} 条", file=sys.stderr)
    for e in errors[:50]:
        print("  " + e, file=sys.stderr)


def cmd_check(path):
    data = open(path, "rb").read()
    problems = check(data)
    _, _, cnt, _, _, _ = layout(data)
    print(f"{cnt} 条词条；" + ("文件头检查通过" if not problems else "；".join(problems)))
    return 1 if problems else 0


COMMANDS = {"export": (cmd_export, 1, 2), "clean": (cmd_clean, 2, 2),
            "rebuild": (cmd_rebuild, 3, 3), "check": (cmd_check, 1, 1)}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    fn, lo, hi = COMMANDS[sys.argv[1]]
    args = sys.argv[2:]
    if not lo <= len(args) <= hi:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    try:
        sys.exit(fn(*args) or 0)
    except (ValueError, struct.error, OSError) as e:
        sys.exit(f"错误：{e}")
