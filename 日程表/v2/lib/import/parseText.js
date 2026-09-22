// §5.7 文字粘贴主解析器：整段文本 → PreviewItem 清单 + 未识别原文 + 来源探测。
// PreviewItem 是文字通道与 OCR 网格重建共用的契约（P6 输出同构结构）：
//   { raw, name, day, startSection, endSection, room, weeks, color, status, missing }
//   status: 'ok' | 'needsFix'（缺哪项在 missing）| 'semiAuto'（丢位文本的课名+地点候选）
import { COURSE_COLORS } from '../courseStore.js';
import {
  findDays, findSections, findWeeks, extractNameRoom, splitLine,
  isNoiseLine, hasDayToken, hasTimeToken, looksLikeRoom,
} from './tokenize.js';

const DAY_TOKEN_GLOBAL = /(?:周|星期|礼拜)[一二三四五六日天1-7]/g;

/** 连一个文字/数字都没有的行（纯符号）：不进预览，也不静默丢弃 → 未识别区。 */
const hasAnyWord = (line) => /\p{L}|\p{N}/u.test(line);

/**
 * @param {string} text 用户粘贴的原文
 * @returns {{ items: PreviewItem[], unparsed: string[], positionLoss: boolean }}
 */
export function parseImportText(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim());
  const candidates = lines.filter((l) => l && !isNoiseLine(l));

  // 来源探测（样例 1）：全文没有任何星期/节次/时间 token → 网格复制丢位形态，
  // 不进逐行预览，改为"课名↵地点"两行一对的半自动候选。
  if (candidates.length >= 2 && candidates.every((l) => !hasDayToken(l) && !hasTimeToken(l))) {
    const { items, unparsed } = pairNameRoom(candidates);
    return { items, unparsed, positionLoss: true };
  }

  const items = [];
  const unparsed = [];
  let colorIdx = 0;
  for (const line of candidates) {
    if (!hasAnyWord(line)) { unparsed.push(line); continue; } // 纯符号行：不静默丢弃
    const days = findDays(line);
    const rows = [];
    if (days.length >= 2) {
      // 一行含多个上课日（教务"班课表"整行）→ 拆为多条预览行，共享其余字段
      for (const { day } of days) rows.push(buildItem(line.replace(DAY_TOKEN_GLOBAL, ' '), day));
    } else {
      rows.push(buildItem(line, days[0]?.day ?? null));
    }
    for (const row of rows) {
      row.status = computeStatus(row);
      if (!row.name && !row.room && !row.day && !row.startSection) {
        unparsed.push(row.raw); // 永不静默丢弃
        continue;
      }
      row.color = COURSE_COLORS[colorIdx % COURSE_COLORS.length];
      colorIdx += 1;
      items.push(row);
    }
  }
  return { items, unparsed, positionLoss: false };
}

function buildItem(line, day) {
  const sections = findSections(line);
  const weeks = findWeeks(line);
  const { name, room } = extractNameRoom(splitLine(line));
  return {
    raw: line,
    name,
    day,
    startSection: sections ? sections.start : null,
    endSection: sections ? sections.end : null,
    room,
    weeks,
    color: null,
    status: 'needsFix',
    missing: [],
  };
}

function computeStatus(item) {
  const missing = [];
  if (!item.name) missing.push('name');
  if (!(item.day >= 1 && item.day <= 7)) missing.push('day');
  if (!(item.startSection >= 1 && item.endSection >= item.startSection)) missing.push('section');
  item.missing = missing;
  return missing.length ? 'needsFix' : 'ok';
}

/** 丢位文本："课名行 + 紧随其后的地点行"合成一条半自动候选；单独的课名行也可成条。 */
function pairNameRoom(candidates) {
  const items = [];
  const unparsed = [];
  let colorIdx = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    const line = candidates[i];
    const { name, room } = extractNameRoom(splitLine(line));
    if (!name) {
      // 纯地点行：并入上一条还没地点的候选，否则不静默丢弃
      const prev = items[items.length - 1];
      if (prev && !prev.room && room) prev.room = room;
      else if (room || line) unparsed.push(line);
      continue;
    }
    let finalRoom = room;
    if (!finalRoom) {
      const next = candidates[i + 1];
      if (next && looksLikeRoom(next.trim())) {
        finalRoom = next.trim();
        i += 1;
      }
    }
    items.push({
      raw: line,
      name,
      day: null,
      startSection: null,
      endSection: null,
      room: finalRoom,
      weeks: null,
      color: COURSE_COLORS[colorIdx % COURSE_COLORS.length],
      status: 'semiAuto',
      missing: ['day', 'section'],
    });
    colorIdx += 1;
  }
  return { items, unparsed };
}
