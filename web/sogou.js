/*
 * 搜狗输入法用户词库备份（.bin，SGPU 格式）的解析、分析与重建。
 * 浏览器中挂在 globalThis.SogouDict 上；在 node 中可直接 require。
 * 与 sogou_dict.py 的逻辑保持一致。
 */
(function (root) {
  "use strict";

  const HEADER_SIZE = 0x8c;

  // 拼音码表：前 413 个是音节，之后是单个字母、数字和 '#'
  const PINYIN = ("a ai an ang ao ba bai ban bang bao bei ben beng bi bian biao bie bin bing bo bu ca cai can cang cao ce cen ceng cha chai chan chang chao che chen cheng chi chong chou chu chua chuai chuan chuang chui chun chuo ci cong cou cu cuan cui cun cuo da dai dan dang dao de dei den deng di dia dian diao die ding diu dong dou du duan dui dun duo e ei en eng er fa fan fang fei fen feng fiao fo fou fu ga gai gan gang gao ge gei gen geng gong gou gu gua guai guan guang gui gun guo ha hai han hang hao he hei hen heng hong hou hu hua huai huan huang hui hun huo ji jia jian jiang jiao jie jin jing jiong jiu ju juan jue jun ka kai kan kang kao ke kei ken keng kong kou ku kua kuai kuan kuang kui kun kuo la lai lan lang lao le lei leng li lia lian liang liao lie lin ling liu lo long lou lu luan lve lun luo lv ma mai man mang mao me mei men meng mi mian miao mie min ming miu mo mou mu na nai nan nang nao ne nei nen neng ni nian niang niao nie nin ning niu nong nou nu nuan nve nun nuo nv o ou pa pai pan pang pao pei pen peng pi pian piao pie pin ping po pou pu qi qia qian qiang qiao qie qin qing qiong qiu qu quan que qun ran rang rao re ren reng ri rong rou ru rua ruan rui run ruo sa sai san sang sao se sen seng sha shai shan shang shao she shei shen sheng shi shou shu shua shuai shuan shuang shui shun shuo si song sou su suan sui sun suo ta tai tan tang tao te tei teng ti tian tiao tie ting tong tou tu tuan tui tun tuo wa wai wan wang wei wen weng wo wu xi xia xian xiang xiao xie xin xing xiong xiu xu xuan xue xun ya yan yang yao ye yi yin ying yo yong you yu yuan yue yun za zai zan zang zao ze zei zen zeng zha zhai zhan zhang zhao zhe zhei zhen zheng zhi zhong zhou zhu zhua zhuai zhuan zhuang zhui zhun zhuo zi zong zou zu zuan zui zun zuo"
  ).split(" ").concat("abcdefghijklmnopqrstuvwxyz0123456789#".split(""));

  // 词条尾部记录的「实际输入」拼音里，还会出现不完整的拼音（简拼）：所有音节前缀中本身不是音节的那些
  // （b、be、bia、c、ch、cho……）加上 i、u、v，按字母排序后从 842 开始编号；另外 478–487 是数字 0–9。
  const PARTIAL = (() => {
    const syl = new Set(PINYIN.slice(0, 413)), p = new Set(["i", "u", "v"]);
    for (const s of syl) for (let k = 1; k < s.length; k++) if (!syl.has(s.slice(0, k))) p.add(s.slice(0, k));
    return [...p].sort();
  })();
  function codeText(c) {
    if (c < PINYIN.length) return PINYIN[c];
    if (c >= 842 && c < 842 + PARTIAL.length) return PARTIAL[c - 842];
    if (c >= 478 && c <= 487) return String(c - 478);
    return "?";
  }

  // ---------- 标签 ----------
  const TAG = {
    GARBLED: 1 << 0,     // 含非汉字非 ASCII 字符，或文字无法解码
    HAN_GARBLED: 1 << 1, // 全是冷僻汉字，读音也对不上
    RARE3: 1 << 2,       // 含 GB2312 以外的字
    RARE2: 1 << 3,       // 含 GB2312 二级字
    PY_MISMATCH: 1 << 4, // 字数与音节数不一致，或读音只在本词出现
    NAME: 1 << 5,        // 疑似人名
    LATIN: 1 << 6,       // 含英文字母或数字
    MULTI_PY: 1 << 7,    // 同一个词有多种拼音
    UNCOMMON: 1 << 8,    // 多字汉字词，词典里查不到
    TRAD: 1 << 9,        // 含繁体字
    DUP: 1 << 10,        // 重复词：同一个词出现多次，除词频最高的一条外都标记
    ZERO: 1 << 11,       // 词频为 0
    REDUP: 1 << 12,      // 叠词：同一片段重复（闭包闭包），或同一个字连续 4 次以上
  };

  const NORMAL_CHAR = /^[㐀-䶿一-鿿\u{20000}-\u{3134f}\x21-\x7e〇]$/u;
  const HAN_CHAR = /^[㐀-鿿豈-﫿\u{20000}-\u{3134f}]$/u;
  const LATIN_RE = /[A-Za-z0-9]/;
  const REDUP_RE = /^(.{2,}?)\1+$/u, REDUP1_RE = /^(.)\1{3,}$/u;

  const SURNAMES = new Set("王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈" +
    "姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向" +
    "汤常温康施文牛樊葛邢安齐易乔伍庞颜倪庄聂章鲁岳翟殷詹申欧耿关兰焦俞左柳甘祝包宁尚符舒阮柯纪梅童凌毕" +
    "单季裴霍涂成苗谷盛曲翁冉骆蓝路游辛靳管柴蒙鲍华喻祁蒲房滕屈饶解牟艾尤阳时穆农司卓古吉缪简车项连芦麦" +
    "褚娄窦戚岑景党宫费卜冷晏席卫米柏宗瞿桂全佟应臧闵苟邬边卞姬师和仇栾隋商刁沙荣巫寇桑郎甄丛仲虞敖巩明" +
    "佘池查麻苑迟邝");
  const NAME_CHARS = new Set("伟芳娜敏静丽强磊军洋勇艳杰娟涛明超秀霞平刚桂英华玉萍红娥玲芬燕彬鹏辉宇浩凯晨瑶琪婷雪琳萱怡欣" +
    "颖慧佳嘉思雨倩薇蕾璐瑾瑜琦珊莹菲妍婧晶露蓉媛楠岚昊轩睿博涵泽豪鑫俊峰帆航旭阳斌毅锋皓翔宸逸彤悦" +
    "诗梦洁茜蓓淼焱鹤骏翊珂钰珺琛玥婕瑞霖烨晗昕曦熙然坤乾鸿鹏");
  const NOT_NAME_CHARS = new Set("的了是我你他她它们这那个在有不也就都和与着过吗呢吧啊上下来去说要会能可么没还很太更最" +
    "把被让给对从向往到里外前后中边面头子儿们些点种样次回些");
  const COMPOUND_SURNAMES = new Set(["欧阳", "司马", "诸葛", "上官", "东方", "皇甫", "慕容", "令狐", "司徒", "夏侯", "尉迟",
    "公孙", "长孙", "宇文", "端木", "南宫", "独孤", "轩辕", "钟离", "澹台"]);

  // ---------- 读取 ----------
  const u32 = (dv, o) => dv.getUint32(o, true);
  const u16 = (dv, o) => dv.getUint16(o, true);
  const utf16 = new TextDecoder("utf-16le", { fatal: true });

  function view(u8) { return new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }

  function layout(u8) {
    if (u8.length < HEADER_SIZE || u8[0] !== 0x53 || u8[1] !== 0x47 || u8[2] !== 0x50 || u8[3] !== 0x55)
      throw new Error("不是搜狗 SGPU 格式的备份文件");
    const dv = view(u8);
    return { ib: u32(dv, 0x38), isz: u32(dv, 0x3c), cnt: u32(dv, 0x40), db: u32(dv, 0x44), dcap: u32(dv, 0x48), dused: u32(dv, 0x4c) };
  }

  /** 按索引顺序读出所有词条：{offset, raw, rank, time, codes, word(null 表示无法解码), pinyin} */
  function parse(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const L = layout(u8), dv = view(u8);
    if (L.ib + 4 * L.cnt > u8.length || L.db + L.dused > u8.length) throw new Error("文件不完整或已损坏");
    const recs = new Array(L.cnt);
    for (let i = 0; i < L.cnt; i++) {
      const off = u32(dv, L.ib + 4 * i), p = L.db + off;
      const n = u16(dv, p + 9);
      const codes = new Array(n >> 1);
      for (let k = 0; k < codes.length; k++) codes[k] = u16(dv, p + 11 + 2 * k);
      const ext = u16(dv, p + 11 + n), wlen = u16(dv, p + 13 + n);
      let word = null;
      try { word = utf16.decode(u8.subarray(p + 15 + n, p + 15 + n + wlen)); } catch (e) { word = null; }
      // 尾部通常是拼音的副本；不同时记录的是实际怎么打出来的（例如用了简拼）
      let typed = null;
      const tail = p + 15 + n + wlen, tailEnd = p + 13 + n + ext;
      if (tailEnd - tail === 2 + n && u16(dv, tail) === n) {
        const tc = [];
        for (let k = 0; k < n >> 1; k++) tc.push(u16(dv, tail + 2 + 2 * k));
        if (tc.some((c, k) => c !== codes[k])) typed = tc.map(codeText).join(" ");
      }
      const pinyin = codes.map(c => (c < PINYIN.length ? PINYIN[c] : "?" + c)).join(" ");
      if (typed === pinyin) typed = null;   // 编码不同但写出来一样（如英文字母的两套编码）
      recs[i] = {
        offset: off, raw: u8.subarray(p, p + 13 + n + ext), rank: u16(dv, p), time: u32(dv, p + 2),
        codes, word, typed, pinyin,
      };
    }
    return recs;
  }

  // ---------- 校验 ----------
  /** 搜狗 t_dictBase::CheckValid 的校验和：文件头各字段之和（不含 0x20 本身和 0x28-0x37） */
  function headerChecksum(u8) {
    const dv = view(u8), size = u8.length;
    const base = u32(dv, 4) + u32(dv, 0x18), sections = u32(dv, 0x14);
    let s = base + u32(dv, 0) + u32(dv, 8) + sections + size + u32(dv, 0xc) + u32(dv, 0x1c) + u32(dv, 0x24);
    for (let k = 0; k < sections; k++)
      for (let j = 0; j < 21; j++) s += u32(dv, base + 0x54 * k + 4 * j);
    return s % 0x100000000;
  }

  /** 复现搜狗加载时的文件头检查，返回问题列表（空表示通过） */
  function check(u8) {
    const problems = [];
    try { layout(u8); } catch (e) { return [e.message]; }
    const dv = view(u8), size = u8.length;
    const base = u32(dv, 4) + u32(dv, 0x18), sections = u32(dv, 0x14);
    if (sections * 0x54 + base > size) return ["文件头段越界"];
    if (u32(dv, 0x10) !== size) problems.push(`文件长度字段 ${u32(dv, 0x10)} 与实际大小 ${size} 不符`);
    for (let k = 0; k < sections; k++) {
      const sec = j => u32(dv, base + 0x54 * k + 4 * j);
      for (const [a, b] of [[0, 1], [3, 4], [8, 9]]) if (sec(a) + sec(b) > size) problems.push(`第 ${k} 段字段 ${a} 越界`);
    }
    if (headerChecksum(u8) !== u32(dv, 0x20)) problems.push("校验和不符");
    return problems;
  }

  // ---------- 重建 ----------
  /**
   * 以原始备份为模板，只保留 keep（原索引位置的数组或 Set）中的词条。
   * 保留的词条逐字节照搬，文件头只改条数、已用大小、零词频条数和校验和。
   */
  function rebuild(orig, keep, recs) {
    recs = recs || parse(orig);
    const L = layout(orig);
    const kept = Array.from(keep).sort((a, b) => a - b);
    if (kept.length * 4 > L.isz) throw new Error("词条超出原文件容量");
    // 数据区：保留记录按原物理顺序紧凑排列
    const byOffset = kept.slice().sort((a, b) => recs[a].offset - recs[b].offset);
    let used = 0;
    for (const i of byOffset) used += recs[i].raw.length;
    if (used > L.dcap) throw new Error("词条超出原文件容量");
    const out = new Uint8Array(orig.length);
    out.set(orig.subarray(0, HEADER_SIZE));
    const dv = view(out);
    const newOff = new Map();
    let pos = 0, zero = 0;
    for (const i of byOffset) {
      out.set(recs[i].raw, L.db + pos);
      newOff.set(i, pos);
      pos += recs[i].raw.length;
      if (recs[i].rank === 0) zero++;
    }
    // 索引：维持原索引顺序
    kept.forEach((i, j) => dv.setUint32(L.ib + 4 * j, newOff.get(i), true));
    dv.setUint32(0x40, kept.length, true);
    dv.setUint32(0x4c, used, true);
    dv.setUint32(0x54, zero, true);
    dv.setUint32(0x20, headerChecksum(out), true);
    const problems = check(out);
    if (problems.length) throw new Error("生成结果未通过检查：" + problems.join("；"));
    return out;
  }

  /** 导出为 TSV 文本：词<TAB>拼音<TAB>词频 */
  function toTSV(recs, keep) {
    const ids = keep ? Array.from(keep).sort((a, b) => a - b) : recs.map((_, i) => i);
    let s = "";
    for (const i of ids) { const r = recs[i]; if (r.word !== null) s += `${r.word}\t${r.pinyin}\t${r.rank}\n`; }
    return s;
  }

  // ---------- 分析 ----------
  let gbLevels = null;
  /** 0: 非汉字；1: GB2312 一级字或符号；2: 二级字；3: 不在 GB2312 中 */
  function gb2312Level(ch) {
    if (!gbLevels) {
      gbLevels = new Map();
      const dec = new TextDecoder("gbk");
      for (let b1 = 0xa1; b1 <= 0xf7; b1++)
        for (let b2 = 0xa1; b2 <= 0xfe; b2++) {
          const c = dec.decode(new Uint8Array([b1, b2]));
          if (c.length && c !== "�" && !gbLevels.has(c)) gbLevels.set(c, b1 < 0xd8 ? 1 : 2);
        }
    }
    if (ch.codePointAt(0) < 0x80) return 0;
    return gbLevels.get(ch) || 3;
  }

  function looksLikeName(w, chars, knownWords) {
    let given;
    if (COMPOUND_SURNAMES.has(w.slice(0, 2)) && chars.length >= 3 && chars.length <= 4) given = chars.slice(2);
    else if (SURNAMES.has(chars[0]) && chars.length >= 2 && chars.length <= 3) given = chars.slice(1);
    else return false;
    if (given.some(c => NOT_NAME_CHARS.has(c))) return false;
    if (given.length === 1) return NAME_CHARS.has(given[0]);
    // 「游泳馆」「关键词」这类：后两字或前两字本身就是常用词
    return !knownWords.has(given.join("")) && !knownWords.has(chars.slice(0, 2).join(""));
  }

  /**
   * 为每个词条计算标签位与可疑字位置。
   * dicts.commonWords：常用词 Set（用于「非常用词」）；dicts.tradChars：繁体字 Set（用于「繁体字」）。都可省略。
   * 返回 [{tags, bad}]，bad 为可疑字在词中的位置（按字计）。
   */
  function analyze(recs, dicts) {
    const { commonWords, tradChars } = dicts || {};
    const chars = recs.map(r => (r.word === null ? null : Array.from(r.word)));
    const isHan = cs => cs !== null && cs.length > 0 && cs.every(c => HAN_CHAR.test(c));
    // 用整本词库自身做读音字典：(字, 音节) 出现在多少个词条里
    const pair = new Map(), readings = new Map();
    recs.forEach((r, i) => {
      const cs = chars[i];
      if (!isHan(cs) || cs.length !== r.codes.length) return;
      cs.forEach((c, k) => {
        const key = c + "\u0001" + r.codes[k];
        pair.set(key, (pair.get(key) || 0) + 1);
        readings.set(c, (readings.get(c) || 0) + 1);
      });
    });
    // 重复词：每个词保留词频最高的一条（并列取最先出现的），其余标记为重复
    const best = new Map();
    recs.forEach((r, i) => {
      if (r.word === null) return;
      const b = best.get(r.word);
      if (b === undefined || r.rank > recs[b].rank) best.set(r.word, i);
    });
    const pinyinsOf = new Map();
    for (const r of recs) {
      if (r.word === null) continue;
      let s = pinyinsOf.get(r.word);
      if (!s) pinyinsOf.set(r.word, (s = new Set()));
      s.add(r.codes.join(","));
    }

    return recs.map((r, i) => {
      const w = r.word, cs = chars[i];
      let tags = r.rank === 0 ? TAG.ZERO : 0, bad = [];
      if (w !== null) {
        if (best.get(w) !== i) tags |= TAG.DUP;
        if (REDUP_RE.test(w) || REDUP1_RE.test(w)) tags |= TAG.REDUP;
      }
      if (w === null || !cs.every(c => NORMAL_CHAR.test(c))) {
        if (w !== null) bad = cs.map((c, k) => (NORMAL_CHAR.test(c) ? -1 : k)).filter(k => k >= 0);
        return { tags: tags | TAG.GARBLED, bad };
      }
      if (LATIN_RE.test(w)) tags |= TAG.LATIN;
      if (tradChars && cs.some(c => tradChars.has(c))) tags |= TAG.TRAD;
      if (pinyinsOf.get(w).size > 1) tags |= TAG.MULTI_PY;
      if (isHan(cs)) {
        const levels = cs.map(gb2312Level);
        if (levels.includes(3)) tags |= TAG.RARE3;
        else if (levels.includes(2)) tags |= TAG.RARE2;
        if (cs.length !== r.codes.length) tags |= TAG.PY_MISMATCH;
        else {
          const support = cs.map((c, k) => pair.get(c + "\u0001" + r.codes[k]) || 0);
          const corroborated = support.filter(s => s >= 2).length;
          // 读音只在本词出现、而这个字在别处另有常见读音 → 读音可疑
          bad = support.map((s, k) => (s <= 1 && (readings.get(cs[k]) || 0) - s >= 2 ? k : -1)).filter(k => k >= 0);
          if (bad.length) tags |= TAG.PY_MISMATCH;
          const score = corroborated / cs.length;
          // 乱码用的多是在别处几乎不出现的冷僻字；字常见只是读音不对的属于拼音损坏
          const unfamiliar = support.filter((s, k) => (readings.get(cs[k]) || 0) - s < 2).length / cs.length;
          if (cs.length >= 2 && unfamiliar >= 0.5 &&
              ((score === 0 && cs.length >= 3) || (score < 0.5 && levels.includes(3)))) {
            tags |= TAG.HAN_GARBLED;
            bad = support.map((s, k) => (s <= 1 ? k : -1)).filter(k => k >= 0);
          }
        }
        if (!levels.includes(3) && looksLikeName(w, cs, pinyinsOf)) tags |= TAG.NAME;
        if (commonWords && cs.length >= 2 && !commonWords.has(w)) tags |= TAG.UNCOMMON;
      }
      return { tags, bad };
    });
  }

  const api = { PINYIN, TAG, HEADER_SIZE, parse, layout, check, headerChecksum, rebuild, toTSV, analyze, gb2312Level };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SogouDict = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
