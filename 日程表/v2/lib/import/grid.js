// §5.7 P6 网格重建：OCR 词级 bbox → 课表网格 → PreviewItem 清单（与文字通道同契约）。
// 锚点法（PRD 方案 B）：顶部"周一…周日"表头定列，左列"1…14"节次号定行；
// 词按列归属，列内"课名样式词"开一门新课、房号/周次等附加行并入当前课，
// 节次区间取组内各词最近锚点行的 min–max。锚点找不齐 → gridFailed，
// 由浮层降级半自动，绝不硬猜。纯函数：输入 { text, confidence, bbox } 数组，node 可测。
import { COURSE_COLORS } from '../courseStore.js';
import { findDays, findWeeks, looksLikeRoom, splitLine, isNoiseLine } from './tokenize.js';
import { SEMESTER } from '../../data/semester.js';

const DATE_HEADER_RE = /^(\d{1,2})[.．](\d{1,2})$/;

const DAY_RE_EXACT = /^(?:周|星期|礼拜)?([一二三四五六日天1-7])$/;
const SECTION_RE_EXACT = /^第?(\d{1,2})节?$/;
const WEEKS_LINE_RE = /^第?[\d(（)[\s\-–~～)）]+周$/;
const ROOMNUM_RE = /^\d{1,6}[A-Za-z()（）-]*$/;
const hasWordChar = (s) => /\p{L}|\p{N}/u.test(s);

const cx = (w) => (w.bbox.x0 + w.bbox.x1) / 2;
const cy = (w) => (w.bbox.y0 + w.bbox.y1) / 2;
const wordH = (w) => Math.max(1, w.bbox.y1 - w.bbox.y0);

/** 把词按 y 中心聚成横向条带（行），带宽容差取词高中位数。 */
export function clusterRows(words) {
  const sorted = [...words].sort((a, b) => cy(a) - cy(b));
  if (!sorted.length) return [];
  const heights = sorted.map(wordH).sort((a, b) => a - b);
  const tol = Math.max(6, heights[Math.floor(heights.length / 2)] * 0.7);
  const rows = [];
  for (const w of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(cy(w) - row.sum / row.n) <= tol) {
      row.items.push(w);
      row.sum += cy(w);
      row.n += 1;
    } else {
      rows.push({ items: [w], sum: cy(w), n: 1 });
    }
  }
  return rows.map((r) => ({ y: r.sum / r.n, items: r.items }));
}

function dayOfHeaderWord(text) {
  const t = String(text).trim();
  const m = t.match(DAY_RE_EXACT);
  if (m) {
    const cn = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
    return cn[m[1]] ?? Number(m[1]);
  }
  // 日期表头（"9.21"…）：单字星期在截图里常丢，按学期年份反查星期几同样能定列
  const d = t.match(DATE_HEADER_RE);
  if (d) {
    const year = Number(String(SEMESTER.week1Monday).slice(0, 4));
    const date = new Date(year, Number(d[1]) - 1, Number(d[2]));
    if (date.getMonth() !== Number(d[1]) - 1) return null; // 非法日期（如状态栏 16.19）
    return ((date.getDay() + 6) % 7) + 1; // 周一=1 … 周日=7
  }
  const many = findDays(t);
  return many.length === 1 && t.length <= 4 ? many[0].day : null;
}

/** 按 x 排序后取"星期序号严格递增"的最长子序列：孤立的错位单字（周天列里认出的"三"）当不了列锚点。 */
function monotoneByX(seen) {
  const cols = [...seen.entries()].map(([day, x]) => ({ day, x })).sort((a, b) => a.x - b.x);
  const dp = cols.map(() => 1);
  const prev = cols.map(() => -1);
  let bestI = 0;
  for (let i = 0; i < cols.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (cols[j].day < cols[i].day && dp[j] + 1 > dp[i]) { dp[i] = dp[j] + 1; prev[i] = j; }
    }
    if (dp[i] > dp[bestI]) bestI = i;
  }
  const chain = [];
  for (let i = bestI; i >= 0; i = prev[i]) chain.unshift(cols[i]);
  return dp[bestI] >= 2 ? chain : [];
}

/** 表头 → 星期列锚点 [{day,x}]：取最靠上、命中 ≥2 个不同星期的一行；表头必须在上半幅。 */
export function findDayColumns(words, imgHeight) {
  let best = null;
  for (const row of clusterRows(words)) {
    const seen = new Map();
    for (const w of row.items) {
      const day = dayOfHeaderWord(w.text);
      if (day && !seen.has(day)) seen.set(day, cx(w));
    }
    if (seen.size < 2) continue;
    const cols = monotoneByX(seen);
    if (cols.length >= 2 && (!best || row.y < best.y)) best = { y: row.y, cols };
  }
  if (!best || best.y > imgHeight * 0.5) return null;
  return best.cols;
}

/** 左列节次号 → [{section,y}]：x 在首列锚点左侧、编号沿 y 单调递增，≥2 个才认。
 *  漏识的号（截断/白字糊掉）按中位行距插值补回，缺 2/3 号时课不会全部错锚到第 1 节。 */
export function findSectionRows(words, firstColX) {
  const labels = [];
  for (const w of words) {
    if (cx(w) >= firstColX) continue;
    const m = String(w.text).trim().match(SECTION_RE_EXACT);
    if (!m) continue;
    const section = Number(m[1]);
    if (section >= 1 && section <= 20) labels.push({ section, y: cy(w) });
  }
  labels.sort((a, b) => a.y - b.y);
  const inc = [];
  for (const l of labels) {
    if (inc.length && l.section <= inc[inc.length - 1].section) {
      if (inc.length >= 2) break; // 页面下半另有编号重置：只取第一段单调上升
      inc.length = 0;
    }
    inc.push(l);
  }
  if (inc.length < 2) return null;
  const steps = [];
  for (let i = 1; i < inc.length; i += 1) steps.push((inc[i].y - inc[i - 1].y) / (inc[i].section - inc[i - 1].section));
  const step = steps.sort((a, b) => a - b)[Math.floor(steps.length / 2)];
  const out = [inc[0]];
  for (let i = 1; i < inc.length; i += 1) {
    const gap = inc[i].section - out[out.length - 1].section;
    if (gap > 1 && step > 4) {
      const per = (inc[i].y - out[out.length - 1].y) / gap;
      for (let s = out[out.length - 1].section + 1; s < inc[i].section; s += 1) {
        out.push({ section: s, y: out[out.length - 1].y + per });
      }
    }
    out.push(inc[i]);
  }
  return out;
}

function nearestIndex(anchors, value) {
  let best = 0;
  let dist = Infinity;
  anchors.forEach((a, i) => {
    const d = Math.abs(a - value);
    if (d < dist) { dist = d; best = i; }
  });
  return best;
}

/** 词是否"像课名"（开新行的信号）：不是房号/地点/周次/单双周。 */
function looksLikeCourseName(text) {
  const t = String(text).trim();
  if (ROOMNUM_RE.test(t)) return false;
  if (WEEKS_LINE_RE.test(t) || /^(单周|双周)$/.test(t)) return false;
  if (findWeeks(t) && !looksLikeRoom(t) && !/[（(]/.test(t)) return false; // "1-16周"、"第1-8周"
  return !looksLikeRoom(t);
}

const CJK_RE = /[\u4e00-\u9fff]/;
/** 组内文本按阅读序拼接：先聚行、行内按 x、行间按 y（OCR 词序在合并两遍后是乱的）。
 *  chi_sim 常把中文词拆成单字 token——相邻汉字 token 直接连写还原（"新 时 代"→"新时代"），
 *  拉丁/数字 token 之间保留空格。 */
function readInOrder(items) {
  return clusterRows(items)
    .map((r) => joinTokens([...r.items].sort((a, b) => a.bbox.x0 - b.bbox.x0).map((w) => w.text)))
    .join(' ');
}

function joinTokens(tokens) {
  let out = '';
  for (const t of tokens) {
    const prev = out[out.length - 1];
    out += out && CJK_RE.test(prev) && CJK_RE.test(t[0]) ? t : `${out ? ' ' : ''}${t}`;
  }
  return out;
}

/** 单元格文本 → 课名/地点：周次片段进 weeks，首个"像场所"或房号数字片段作地点。 */
export function cellToCourse(text) {
  const weeks = findWeeks(text);
  const segments = splitLine(text).filter((s) => hasWordChar(s));
  const roomSegs = [];
  const nameSegs = [];
  for (const seg of segments) {
    if (!roomSegs.length && looksLikeRoom(seg) && !findWeeks(seg)) { roomSegs.push(seg); continue; }
    if (!roomSegs.length && nameSegs.length && ROOMNUM_RE.test(seg)) { roomSegs.push(seg); continue; }
    if (findWeeks(seg) && !looksLikeRoom(seg)) continue; // 周次片段（"1-16周"）不进课名
    if (/^(单周|双周)$/.test(seg)) continue;
    nameSegs.push(seg);
  }
  return { name: nameSegs.join(' ').trim(), room: roomSegs[0] ?? '', weeks };
}

/** 列内分组：课名样式词开新课，其余词并入当前组；返回 [{words, section 区间}]。 */
export function groupColumnWords(words, colAnchors, headerY) {
  const ys = colAnchors.map((r) => r.y);
  const rowStep = ys.length > 1 ? (ys[ys.length - 1] - ys[0]) / (ys.length - 1) : 40;
  const bottomY = ys[ys.length - 1] + rowStep * 1.2; // 末行单元格可下探约一格；页脚在这之下
  const sorted = [...words].sort((a, b) => a.bbox.y0 - b.bbox.y0);
  const groups = [];
  const stray = [];
  for (const w of sorted) {
    if (cy(w) <= headerY + rowStep * 0.3 || cy(w) > bottomY) { stray.push(w); continue; } // 标题行/页脚
    if ((looksLikeCourseName(w.text) && groups.length && w.bbox.y0 - groups[groups.length - 1].lastY > rowStep * 0.2)
      || !groups.length) {
      groups.push({ items: [w], lastY: w.bbox.y1 });
      const anchor = nearestIndex(ys, cy(w));
      const g = groups[groups.length - 1];
      g.rowStart = colAnchors[anchor].section;
      g.rowEnd = colAnchors[anchor].section;
      continue;
    }
    const g = groups[groups.length - 1];
    g.items.push(w);
    g.lastY = w.bbox.y1;
    const anchor = nearestIndex(ys, cy(w));
    g.rowStart = Math.min(g.rowStart, colAnchors[anchor].section);
    g.rowEnd = Math.max(g.rowEnd, colAnchors[anchor].section);
  }
  return { groups, stray };
}

/** IoU>0.3 视为同一词：置信度不同留高者；持平留 a 表（先列者）——
 *  加强档里 a = 彩底块裁剪识别的词，小图识别更聚焦，同分时应压过整图识别结果。
 *  其余并存。纯函数可测。 */
export function mergeWordLists(a, b) {
  const out = [...(a ?? []).map((w) => ({ ...w, __fromA: true })), ...(b ?? [])]
    .filter((w) => w && w.bbox && w.text);
  const kept = [];
  const byConf = [...out].sort((x, y) => (y.confidence ?? 0) - (x.confidence ?? 0));
  for (const w of byConf) {
    const dupIdx = kept.findIndex((k) => iou(k.bbox, w.bbox) > 0.3);
    if (dupIdx >= 0) {
      const k = kept[dupIdx];
      const wins = (w.confidence ?? 0) > (k.confidence ?? 0)
        || ((w.confidence ?? 0) === (k.confidence ?? 0) && !k.__fromA && w.__fromA);
      if (wins && w.text !== k.text) kept[dupIdx] = { ...w, __fromA: k.__fromA };
      continue;
    }
    kept.push(w);
  }
  return kept.map((w) => {
    if (!('__fromA' in w)) return w;
    const { __fromA, ...rest } = w;
    return rest;
  });
}

function iou(p, q) {
  const x = Math.max(p.x0, q.x0);
  const y = Math.max(p.y0, q.y0);
  const x1 = Math.min(p.x1, q.x1);
  const y1 = Math.min(p.y1, q.y1);
  const inter = Math.max(0, x1 - x) * Math.max(0, y1 - y);
  if (!inter) return 0;
  const areaP = Math.max(1, (p.x1 - p.x0)) * Math.max(1, (p.y1 - p.y0));
  const areaQ = Math.max(1, (q.x1 - q.x0)) * Math.max(1, (q.y1 - q.y0));
  return inter / (areaP + areaQ - inter);
}

/** 锚点判不出、或网格内容过碎时的降级：整行词组退化成"只有课名/地点"的半自动候选。
 *  headerY 已知（星期表头定住了）时，表头以上的行都是手机状态栏/App 导航栏，不算候选。 */
function degradeToSemi(clean, headerY = 0) {
  // 纯锚点行（"一 二 三…"、竖排节次号）不是候选，其余行全保留给用户补全
  const rows = clusterRows(clean).filter((r) => !(headerY && r.y < headerY - 5) && !r.items.every(
    (w) => dayOfHeaderWord(w.text) || SECTION_RE_EXACT.test(String(w.text).trim()),
  ));
  const items = rows.map((row, i) => {
    const text = joinTokens([...row.items].sort((a, b) => a.bbox.x0 - b.bbox.x0).map((w) => w.text));
    const { name, room, weeks } = cellToCourse(text);
    return {
      raw: text, name: name || text, day: null, startSection: null, endSection: null,
      room, weeks, color: COURSE_COLORS[i % COURSE_COLORS.length],
      status: 'semiAuto', missing: ['day', 'section'],
    };
  });
  return { items, unparsed: [], gridFailed: true };
}

/**
 * @param {{text:string,confidence:number,bbox:{x0,y0,x1,y1}}[]} words Tesseract 词级输出
 * @param {{width?:number,height?:number}} size 图像尺寸（缺省用词 bbox 并集）
 * @returns {{ items: PreviewItem[], unparsed: string[], gridFailed: boolean }}
 */
export function itemsFromWords(words, size = {}) {
  // 表头单字"一…日"与节次号"1…14"在文字通道算噪声，但它们是网格锚点，
  // 必须先进入 clean，分组正文时再排除。
  const clean = (words ?? [])
    .map((w) => ({ ...w, text: String(w.text ?? '').trim() }))
    .filter((w) => w.text && hasWordChar(w.text));
  if (!clean.length) return { items: [], unparsed: [], gridFailed: true };

  const xs = clean.flatMap((w) => [w.bbox.x0, w.bbox.x1]);
  const ys = clean.flatMap((w) => [w.bbox.y0, w.bbox.y1]);
  const width = size.width ?? Math.max(...xs);
  const height = size.height ?? Math.max(...ys);

  const headerWords = clean.filter((w) => dayOfHeaderWord(w.text));
  const cols = findDayColumns(headerWords, height);
  const anchors = clean.filter((w) => SECTION_RE_EXACT.test(w.text));
  const firstColX = cols ? Math.min(...cols.map((c) => c.x)) : width * 0.2;
  const rowAnchors = findSectionRows(anchors, firstColX);
  const headerY = cols && clusterRows(headerWords)[0] ? clusterRows(headerWords)[0].y : 0;

  if (!cols || !rowAnchors) return degradeToSemi(clean, cols ? headerY : 0);

  const used = new Set([...headerWords, ...anchors]);
  const body = clean.filter((w) => !used.has(w) && !isNoiseLine(w.text));

  // 按列归属（x 中心最近锚点 + 半列距容差），列外/行外杂词进 leftover
  const colXs = cols.map((c) => c.x);
  const colHalfGap = colXs.length > 1
    ? (colXs[colXs.length - 1] - colXs[0]) / (colXs.length - 1) / 2
    : 400;
  const byCol = new Map();
  const leftover = [];
  for (const w of body) {
    const ci = nearestIndex(colXs, cx(w));
    if (Math.abs(cx(w) - colXs[ci]) > colHalfGap * 1.2) { leftover.push(w); continue; }
    if (!byCol.has(ci)) byCol.set(ci, []);
    byCol.get(ci).push(w);
  }

  const merged = new Map(); // day|name 同且节次区间重叠 → 并一条（长课名换行成两组的情况）
  for (const [ci, colWords] of byCol) {
    const { groups, stray } = groupColumnWords(colWords, rowAnchors, headerY);
    leftover.push(...stray);
    for (const g of groups) {
      const text = readInOrder(g.items);
      const { name, room, weeks } = cellToCourse(text);
      if (!name && !room) { leftover.push(...g.items); continue; }
      const day = cols[ci].day;
      const key = `${day}|${name || room}`;
      const prev = merged.get(key);
      if (prev) {
        prev.startSection = Math.min(prev.startSection, g.rowStart);
        prev.endSection = Math.max(prev.endSection, g.rowEnd);
        prev.raw += ` ${text}`;
        if (!prev.room && room) prev.room = room;
        if (!prev.weeks && weeks) prev.weeks = weeks;
      } else {
        merged.set(key, {
          raw: text, name, day, startSection: g.rowStart, endSection: g.rowEnd,
          room, weeks, missing: [],
        });
      }
    }
  }

  // 内容质量门（PRD"绝不硬猜"）：锚点认得出、但重建出的课名大半是 OCR 碎片
  // （彩色底白字只识出零星单字）时，逐条硬导只会把假课混进预览——整体降级半自动。
  // 整词判据：单个 ≥2 字连写词算整词；多词名要含 ≥3 字词且 1 字碎 token 占比 ≤40%。
  // '劳动'、'大学英语'这类短课名不会被误杀，'法 国歌 剧 史'这种碎片拼盘过不了关。
  const rebuilt = [...merged.values()];
  const solidItem = (it) => {
    if (!it.name) return !!it.room && it.room.length >= 2; // 只有地点的行：预览会标〔需修正〕
    const toks = String(it.name).split(/\s+/).filter(Boolean).map((t) => [...t].length);
    if (!toks.length) return false;
    if (toks.length === 1) return toks[0] >= 2; // 单个连写词：'劳动' 也是真课名
    const singles = toks.filter((l) => l <= 1).length;
    return Math.max(...toks) >= 3 && singles / toks.length <= 0.4;
  };
  if (rebuilt.length && rebuilt.filter(solidItem).length / rebuilt.length < 0.6) return degradeToSemi(clean, headerY);

  const items = rebuilt.map((it, i) => ({
    ...it,
    color: COURSE_COLORS[i % COURSE_COLORS.length],
    status: it.name ? 'ok' : 'needsFix',
    missing: it.name ? [] : ['name'],
  }));
  const covered = (t) => items.some((it) => it.raw.includes(t));
  const unparsed = [...new Set(leftover.map((w) => w.text).filter((t) => !covered(t)))];
  return { items, unparsed, gridFailed: false };
}
