// 周次区间（§5.7 weeks 字段）的纯计算：归一化、单周命中、区间是否真的有交集。
// 缺省/非法一律视为"全教学周"，与旧数据（无 weeks 字段）行为完全一致。
import { SEMESTER } from '../data/semester.js';

export const WEEK_PARITIES = ['all', 'odd', 'even'];

/** 非法结构 → null（= 全教学周）；合法则返回裁剪到教学周范围内的对象。 */
export function normalizeWeeks(weeks) {
  if (!weeks || typeof weeks !== 'object') return null;
  const from = Number(weeks.from);
  const to = Number(weeks.to);
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  let parity = weeks.parity ?? 'all';
  if (!WEEK_PARITIES.includes(parity)) parity = 'all';
  if (from < 1 || to < 1 || to < from) return null;
  return {
    from: Math.min(from, SEMESTER.totalWeeks),
    to: Math.min(to, SEMESTER.totalWeeks),
    parity,
  };
}

function fullRange(weeks) {
  return normalizeWeeks(weeks) ?? { from: 1, to: SEMESTER.totalWeeks, parity: 'all' };
}

function matchesParity(parity, week) {
  if (parity === 'odd') return week % 2 === 1;
  if (parity === 'even') return week % 2 === 0;
  return true;
}

/** 某个教学周 week 这节课是否在上（无 weeks 字段的课恒为真）。 */
export function weekContains(weeks, week) {
  const w = fullRange(weeks);
  if (!(week >= w.from && week <= w.to)) return false;
  return matchesParity(w.parity, week);
}

/** 两个周次范围是否存在同一周都命中（odd∩even=假；区间相交但奇偶错开也算不相交）。 */
export function weeksOverlap(a, b) {
  const x = fullRange(a);
  const y = fullRange(b);
  const lo = Math.max(x.from, y.from);
  const hi = Math.min(x.to, y.to);
  for (let w = lo; w <= hi; w += 1) {
    if (matchesParity(x.parity, w) && matchesParity(y.parity, w)) return true;
  }
  return false;
}

export function formatWeeks(weeks) {
  const w = normalizeWeeks(weeks);
  if (!w) return `本学期 1–${SEMESTER.totalWeeks} 周`;
  const parityLabel = w.parity === 'odd' ? ' · 单周' : w.parity === 'even' ? ' · 双周' : '';
  return `第${w.from}–${w.to}周${parityLabel}`;
}
