// §5.7 文字通道的底层 token 识别：星期 / 节次 / 时间段→节次换算 / 周次 / 地点。
// 全部纯函数、零依赖，供 parseText.js 与网格重建（OCR 通道）复用。
import { PERIODS, SEMESTER } from '../../data/semester.js';

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

const DAY_RE = /(?:周|星期|礼拜)([一二三四五六日天1-7])/g;
const TIME_RANGE_RE = /(\d{1,2})[:：](\d{2})\s*[-–~～至]\s*(\d{1,2})[:：](\d{2})/;
const SECTION_RANGE_RE = /第?\s*(\d{1,2})\s*[-–~～至]\s*(\d{1,2})\s*节/;
const SECTION_ONE_RE = /第\s*(\d{1,2})\s*节/;
const SECTION_STACK_RE = /第?\s?((?:\d{2}){2,})\s*节/; // 030405节 → 3~5
const WEEKS_RANGE_RE = /第?[（(]?(\d{1,2})[)）]?\s*[-–~～至]\s*第?[（(]?(\d{1,2})[)）]?\s*周/;
const WEEKS_ONE_RE = /第\s*(\d{1,2})\s*周/;

// 表头/分隔噪声行：星期表头、节次号竖排、日期小字（9.21）、纯分隔线等
const NOISE_EXACT = new Set(['星期', '时间', '节次', '上午', '下午', '晚上', '课程', '教室', '地点', '教师', '备注', '学期', '学年', '周次', '星期节次']);

export function findDays(line) {
  const out = [];
  for (const m of line.matchAll(new RegExp(DAY_RE))) {
    const d = CN_NUM[m[1]] ?? Number(m[1]);
    if (d >= 1 && d <= 7) out.push({ day: d, index: m.index });
  }
  return out;
}

export function hasDayToken(line) {
  return findDays(line).length > 0;
}

export function hasTimeToken(line) {
  return TIME_RANGE_RE.test(line) || SECTION_RANGE_RE.test(line)
    || SECTION_ONE_RE.test(line) || SECTION_STACK_RE.test(line);
}

function toMin(hhmm) {
  const [hh, mm] = hhmm.split(':').map(Number);
  return hh * 60 + mm;
}

function nearestSection(anchorKind, minutes, tolerance = 20) {
  let best = null;
  for (const p of PERIODS) {
    const anchor = toMin(anchorKind === 'start' ? p.start : p.end);
    const dist = Math.abs(anchor - minutes);
    if (dist <= tolerance && (!best || dist < best.dist)) best = { section: p.section, dist };
  }
  return best ? best.section : null;
}

/** 节次识别：`3-4节`、`030405节`、`第6节`，或时间段 `08:00-09:35` 按 §5.1 模板换算（就近匹配，容差 20 分钟）。识别不出返回 null。 */
export function findSections(line) {
  const range = line.match(SECTION_RANGE_RE);
  if (range) return { start: Number(range[1]), end: Number(range[2]) };
  const stack = line.match(SECTION_STACK_RE);
  if (stack) {
    const nums = stack[1].match(/\d{2}/g).map(Number);
    return { start: Math.min(...nums), end: Math.max(...nums) };
  }
  const one = line.match(SECTION_ONE_RE);
  if (one) return { start: Number(one[1]), end: Number(one[1]) };
  const time = line.match(TIME_RANGE_RE);
  if (time) {
    const start = nearestSection('start', toMin(`${time[1]}:${time[2]}`));
    const end = nearestSection('end', toMin(`${time[3]}:${time[4]}`));
    if (start !== null && end !== null) return { start, end };
  }
  return null;
}

/** 周次识别：`第(1)-(16)周`、`1-16周`、`第3周`、`单周/双周`。识别不出返回 null。 */
export function findWeeks(line) {
  let from = null;
  let to = null;
  const range = line.match(WEEKS_RANGE_RE);
  if (range) {
    from = Number(range[1]);
    to = Number(range[2]);
  } else {
    const one = line.match(WEEKS_ONE_RE);
    if (one) { from = Number(one[1]); to = from; }
  }
  const parity = /单周/.test(line) ? 'odd' : /双周/.test(line) ? 'even' : 'all';
  if (from === null) return parity === 'all' ? null : { from: 1, to: SEMESTER.totalWeeks, parity };
  return { from, to, parity };
}

const ROOM_SUFFIX = /(楼|教室|机房|实验室|实验中心|中心|馆|场|园区|画室|琴房|房|室|基地)$/;
const ROOM_HINT = /(楼|室|房|馆|区|中心|操场|田径场|机房|实验|体育场馆)/;

/** 是否像"地点"片段（课名里的"体育(1)"等不含场所后缀，不会误判）。 */
export function looksLikeRoom(segment) {
  const s = String(segment).trim();
  if (!s) return false;
  if (/(节|周)$/.test(s)) return false;
  return ROOM_SUFFIX.test(s) || (ROOM_HINT.test(s) && !/^[一二三四五六七八九十\s]+$/.test(s));
}

/** 切段：空白/制表符/逗号/分号/顿号/竖线（Excel 粘贴是 \t 分隔，教务常见空格分隔）。 */
export function splitLine(line) {
  return line.split(/[\s\t ,，;；|、、]+/).map((s) => s.trim()).filter(Boolean);
}

const DAY_ONLY_RE = /^(?:周|星期|礼拜)[一二三四五六日天1-7]$/;

/** 剥掉行内星期/节次/时间段/周次片段后返回 { name, room }：
 *  地点 = 第一个"像场所"的片段；课名 = 剩下的第一段（难分时由上层标〔需修正〕）。 */
export function extractNameRoom(segments) {
  const rest = [];
  let room = '';
  for (const seg of segments) {
    if (DAY_ONLY_RE.test(seg)) continue;
    if (findSections(seg) && /(节|[:：])/.test(seg)) continue;
    if (TIME_RANGE_RE.test(seg)) continue;
    if (findWeeks(seg) && !looksLikeRoom(seg)) continue;
    if (!room && looksLikeRoom(seg)) { room = seg; continue; }
    rest.push(seg);
  }
  if (!room && rest.length > 1 && looksLikeRoom(rest[rest.length - 1])) room = rest.pop();
  return { name: rest.join(' ').trim(), room };
}

export function isNoiseLine(line) {
  const s = String(line).trim();
  if (!s) return true;
  if (NOISE_EXACT.has(s)) return true;
  if (/^[一二三四五六日天]$/.test(s)) return true; // 表头单字星期（一/二/…）
  if (/^\d{1,2}([.．]\d{1,2})?$/.test(s)) return true; // 节次号竖排、日期小字 9.21
  if (/^[-—–=~＝\s*_·]+$/i.test(s)) return true; // 纯分隔线
  return false;
}
