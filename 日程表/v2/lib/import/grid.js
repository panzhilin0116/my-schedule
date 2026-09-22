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
    const cols = [...seen.entries()].map(([day, x]) => ({ day, x })).sort((a, b) => a.x - b.x);
    if (!best || row.y < best.y) best = { y: row.y, cols };
  }
  if (!best || best.y > imgHeight * 0.5) return null;
  return best.cols;
}

/** 左列节次号 → [{section,y}]：x 在首列锚点左侧、编号沿 y 单调递增，≥2 个才认。 */
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
  return inc.length >= 2 ? inc : null;
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

/** 组内文本按阅读序拼接：先聚行、行内按 x、行间按 y（OCR 词序在合并两遍后是乱的）。 */
function readInOrder(items) {
  return clusterRows(items)
    .map((r) => [...r.items].sort((a, b) => a.bbox.x0 - b.bbox.x0).map((w) => w.text).join(' '))
    .join(' ');
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

/** 正相/反相两遍词合并：IoU>0.3 视为同一词，留置信度高者；其余并存。纯函数可测。 */
export function mergeWordLists(a, b) {
  const out = [...(a ?? []), ...(b ?? [])].filter((w) => w && w.bbox && w.text);
  const kept = [];
  const byConf = [...out].sort((x, y) => (y.confidence ?? 0) - (x.confidence ?? 0));
  for (const w of byConf) {
    const dupIdx = kept.findIndex((k) => iou(k.bbox, w.bbox) > 0.3);
    if (dupIdx >= 0) {
      const k = kept[dupIdx];
      if ((w.confidence ?? 0) > (k.confidence ?? 0) && w.text !== k.text) kept[dupIdx] = w;
      continue;
    }
    kept.push(w);
  }
  return kept;
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

/** 锚点判不出、或网格内容过碎时的降级：整行词组退化成"只有课名/地点"的半自动候选。 */
function degradeToSemi(clean) {
  // 纯锚点行（"一 二 三…"、竖排节次号）不是候选，其余行全保留给用户补全
  const rows = clusterRows(clean).filter((r) => !r.items.every(
    (w) => dayOfHeaderWord(w.text) || SECTION_RE_EXACT.test(String(w.text).trim()),
  ));
  const items = rows.map((row, i) => {
    const text = [...row.items].sort((a, b) => a.bbox.x0 - b.bbox.x0).map((w) => w.text).join(' ');
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

  if (!cols || !rowAnchors) return degradeToSemi(clean);

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
  if (rebuilt.length && rebuilt.filter(solidItem).length / rebuilt.length < 0.6) return degradeToSemi(clean);

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
