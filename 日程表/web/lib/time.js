// 全站唯一的时间与聚合口径来源（PRD 6 节 + DEV_PLAN S2 修订）：
// 首页、课表、健身的统计数字都必须调用这里，禁止在别处再算一遍。
// 本文件不碰 DOM，也不碰网络，纯函数便于本地测试。

export const DAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const MS_PER_DAY = 86400000;
const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (value) => String(value).padStart(2, '0');

/** 日历日期按浏览器本地时区取值（PRD 7.4：不做时区换算）。 */
export function toKey(value) {
  if (typeof value === 'string') return KEY_RE.test(value) ? value : null;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

export function todayKey(now = new Date()) {
  return toKey(now);
}

/** 日历日期的天数差；只用 UTC 数值做整日算术，避免夏令时抖动。 */
export function diffDays(fromKey, toKey_) {
  const a = Date.parse(`${fromKey}T00:00:00Z`);
  const b = Date.parse(`${toKey_}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / MS_PER_DAY);
}

export function addDays(key, days) {
  const base = Date.parse(`${key}T00:00:00Z`);
  if (Number.isNaN(base)) return null;
  return new Date(base + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** 1=周一 … 7=周日，与 courses.day_of_week 同一套编号。 */
export function dayOfWeek(key) {
  const parts = key.split('-').map(Number);
  const dow = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDay();
  return dow === 0 ? 7 : dow;
}

export function mondayOf(key) {
  return addDays(key, 1 - dayOfWeek(key));
}

export function hhmmToMinutes(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

export const hm2min = hhmmToMinutes;

export function minutesToHhmm(minutes) {
  if (!Number.isFinite(minutes)) return null;
  const total = Math.max(0, Math.min(1439, Math.round(minutes)));
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

export const min2hm = minutesToHhmm;

/** PRD 6：floor((今天 - 学期起始日) / 7) + 1；学期外返回 null。 */
export function weekOf(key, config) {
  if (!config || !config.start_date || !Number.isFinite(config.total_weeks)) return null;
  const offset = diffDays(config.start_date, key);
  if (offset === null) return null;
  const week = Math.floor(offset / 7) + 1;
  return week >= 1 && week <= config.total_weeks ? week : null;
}

export function parityOfWeek(week) {
  return week % 2 === 1 ? 'odd' : 'even';
}

/** 该课程在这一周是否真的上课。 */
export function courseActiveOnWeek(course, week) {
  if (!Number.isFinite(week)) return false;
  if (week < course.start_week || week > course.end_week) return false;
  return course.week_type === 'all' || course.week_type === parityOfWeek(week);
}

export function weekRange(week, config) {
  if (!config || !Number.isFinite(week)) return null;
  const start = addDays(config.start_date, (week - 1) * 7);
  return { start, end: addDays(start, 6), week };
}

/** 本周区间：本周一到今天（PRD 6：本周健身 = 本周一至今日）。 */
export function currentWeekRange(config, today = todayKey()) {
  const week = weekOf(today, config);
  if (week !== null) {
    const range = weekRange(week, config);
    return { ...range, end: today < range.end ? today : range.end, inTerm: true };
  }
  const monday = mondayOf(today);
  return { start: monday, end: today, week: null, inTerm: false };
}

export function fmtDate(key) {
  if (!key) return '';
  const [y, m, d] = key.split('-').map(Number);
  return `${m}月${d}日 ${DAY_NAMES[dayOfWeek(key) - 1]}`;
}

export function fmtDateShort(key) {
  if (!key) return '';
  const [, m, d] = key.split('-').map(Number);
  return `${m}/${d}`;
}

/** 距此刻的可读剩余时间，用于"下一站"倒计时。 */
export function fmtRemain(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return '就在现在';
  const minutes = Math.floor(ms / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes % 60} 分`;
  return `${minutes} 分钟`;
}

/**
 * 「下一站」倒计时的唯一算式：界面上那段文字带 data-countdown，
 * 外壳定时只重写它，不整页重绘（重绘会打断正在进行的长按排序）。
 */
export function countdownText(stamp, now = new Date()) {
  const target = Date.parse(stamp);
  return Number.isFinite(target) ? fmtRemain(target - now.getTime()) : '';
}

export function overdueDays(task, today = todayKey()) {
  if (task.done || !task.due_date) return null;
  const days = diffDays(task.due_date, today);
  return days !== null && days > 0 ? days : null;
}

export const isOverdue = (task, today) => overdueDays(task, today) !== null;

export function sortByDateTime(a, b) {
  const ka = `${a.due_date ?? '9999-12-31'}T${a.due_time ?? '23:59'}`;
  const kb = `${b.due_date ?? '9999-12-31'}T${b.due_time ?? '23:59'}`;
  return ka.localeCompare(kb);
}

/** PRD 6：今日待办 = 今天到期 + 已逾期未完成；逾期优先，再按时间升序。无日期项属于收集箱。 */
export function tasksForDay(tasks, today = todayKey()) {
  const overdue = [];
  const dueToday = [];
  for (const task of tasks) {
    if (!task.due_date) continue;
    if (task.due_date === today) dueToday.push(task);
    else if (!task.done && task.due_date < today) overdue.push(task);
  }
  overdue.sort(sortByDateTime);
  dueToday.sort(sortByDateTime);
  return [...overdue, ...dueToday];
}

export function todayProgress(tasks, today = todayKey()) {
  const list = tasksForDay(tasks, today);
  const total = list.length;
  const done = list.filter((task) => task.done).length;
  return { total, done, ratio: total === 0 ? 0 : Math.round((done / total) * 100) };
}

export const TASK_SEGMENTS = [
  { key: 'today', label: '今日' },
  { key: 'week', label: '本周' },
  { key: 'all', label: '全部' },
  { key: 'done', label: '已完成' },
];

/**
 * 分段取数。今日沿用 PRD 6 的口径；本周额外并入逾期未完成——
 * 一条周三没做完的事不会因为今天已经是周一就从计划里消失。
 * 无日期的条目只属于「全部」（收集箱），任何时间分段都不显示它。
 */
export function segmentTasks(tasks, segment = 'today', today = todayKey()) {
  if (segment === 'all') return [...tasks];
  if (segment === 'done') return tasks.filter((task) => task.done);
  if (segment === 'week') {
    const start = mondayOf(today);
    const end = addDays(start, 6);
    return tasks.filter((task) => (task.due_date && task.due_date >= start && task.due_date <= end)
      || (!task.done && task.due_date && task.due_date < start));
  }
  return tasksForDay(tasks, today);
}

export function segmentCounts(tasks, today = todayKey()) {
  return Object.fromEntries(TASK_SEGMENTS.map(({ key }) => [key, segmentTasks(tasks, key, today).length]));
}

export const TASK_STATUS_FILTERS = [
  { key: 'all', label: '不限' },
  { key: 'open', label: '未完成' },
  { key: 'done', label: '已完成' },
  { key: 'overdue', label: '逾期' },
];

/** 分类与状态是两个独立条件，取交集；category 'all'/'all' 表示不设筛选。 */
export function filterTasks(rows, { category = 'all', status = 'all' } = {}, today = todayKey()) {
  return rows.filter((task) => {
    if (category !== 'all' && (task.category ?? '') !== category) return false;
    if (status === 'open') return !task.done;
    if (status === 'done') return Boolean(task.done);
    if (status === 'overdue') return overdueDays(task, today) !== null;
    return true;
  });
}

/** 组内次序：未完成按截止升序在前，已完成沉到组底（PRD 5.2）。 */
export function orderGroupRows(rows) {
  const open = rows.filter((row) => !row.done).sort(sortByDateTime);
  const done = rows.filter((row) => row.done)
    .sort((a, b) => String(b.done_at ?? '').localeCompare(String(a.done_at ?? '')));
  return [...open, ...done];
}

/** 顺延只给三个确定值：列表里塞日期选择器既占位又容易点错。 */
export function postponeTargets(today = todayKey()) {
  return [
    { key: 'today', label: '顺延到今天', date: today },
    { key: 'tomorrow', label: '顺延到明天', date: addDays(today, 1) },
    { key: 'next_week', label: '顺延到下周', date: addDays(today, 7) },
  ];
}

const QUICK_DATE_RE = /(\d{1,2})月(\d{1,2})[日号]/;
// 前面不许再贴一个数字：否则「25:00」会被读成 5:00，把不合法的写法当成合法时间
const QUICK_TIME_RE = /(^|[^\d:])((?:[01]?\d|2[0-3])[:：][0-5]\d)/;
const QUICK_MINUTES_RE = /(\d{1,4})分钟/;

/** 「9月25日」→ 具体日期；今年这个日子已经过了就按明年，读数里会写全年份。 */
function monthDayKey(month, day, today) {
  const m = Number(month);
  const d = Number(day);
  const year = Number(today.slice(0, 4));
  const stamp = Date.UTC(year, m - 1, d);
  const date = new Date(stamp);
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  const key = `${year}-${pad(m)}-${pad(d)}`;
  return key < today ? `${year + 1}-${pad(m)}-${pad(d)}` : key;
}

/**
 * 快速添加的弱解析（DEV_PLAN S5）：只认「X月X日」「HH:MM」「N分钟」三种写法，
 * 认不出的部分原样留在标题里，绝不猜；三项都识别成功时标题可能为空，退回原文。
 */
export function parseQuickAdd(text, today = todayKey()) {
  const raw = String(text ?? '').trim();
  let rest = ` ${raw} `;
  const found = [];
  const result = { title: raw, due_date: null, due_time: null, duration_min: null, found };

  const dateMatch = rest.match(QUICK_DATE_RE);
  if (dateMatch) {
    const key = monthDayKey(dateMatch[1], dateMatch[2], today);
    if (key) {
      rest = rest.replace(dateMatch[0], ' ');
      result.due_date = key;
      found.push(key.slice(0, 4) === today.slice(0, 4) ? dateMatch[0] : `${key.slice(0, 4)}年${dateMatch[0]}`);
    }
  }
  const timeMatch = rest.match(QUICK_TIME_RE);
  if (timeMatch) {
    const [hour, minute] = timeMatch[2].split(/[:：]/);
    rest = rest.replace(timeMatch[2], ' ');
    result.due_time = `${pad(Number(hour))}:${pad(Number(minute))}`;
    found.push(result.due_time);
  }
  const minutesMatch = rest.match(QUICK_MINUTES_RE);
  if (minutesMatch) {
    const value = Number(minutesMatch[1]);
    if (value >= 1 && value <= 1440) {
      rest = rest.replace(minutesMatch[0], ' ');
      result.duration_min = value;
      found.push(minutesMatch[0]);
    }
  }
  result.title = rest.replace(/\s+/g, ' ').trim() || raw;
  return result;
}

/** 课程按开始时间排序，用于首页与课表日视图。 */
export function coursesOnDay(courses, week, dayKey) {
  const dow = dayOfWeek(dayKey);
  return courses
    .filter((course) => course.day_of_week === dow)
    .sort((a, b) => (hm2min(a.start_time) ?? 0) - (hm2min(b.start_time) ?? 0))
    .map((course) => ({ ...course, active: courseActiveOnWeek(course, week) }));
}

/** 节次表按分钟映射到行；找不到落在最近一节之前。 */
export function periodIndexAt(periods, hhmm) {
  const minutes = hhmmToMinutes(hhmm);
  if (minutes === null || !Array.isArray(periods)) return -1;
  for (const [index, period] of periods.entries()) {
    const start = hhmmToMinutes(period.start);
    const end = hhmmToMinutes(period.end);
    if (start !== null && end !== null && minutes >= start && minutes < end) return index;
  }
  return -1;
}

/** 与这一节时间区间有交集的课程（节次表是全天通用坐标轴，所以不分星期）。 */
export function coursesInSpan(courses, start, end) {
  const from = hm2min(start);
  const to = hm2min(end);
  if (from === null || to === null) return [];
  return courses.filter((course) => {
    const cs = hm2min(course.start_time);
    const ce = hm2min(course.end_time);
    return cs !== null && ce !== null && cs < to && ce > from;
  });
}

const byStart = (a, b) => (hm2min(a.start) ?? 0) - (hm2min(b.start) ?? 0);

/** 保存前的合法性检查：返回 `{下标.字段: 错误文案}`，与 Function 侧的 periods 校验同口径。 */
export function periodErrors(periods) {
  const errors = {};
  const parsed = [];
  for (const [index, period] of (periods ?? []).entries()) {
    const label = String(period?.label ?? '').trim();
    if (!label) errors[`${index}.label`] = '名称不能为空';
    else if (label.length > 20) errors[`${index}.label`] = '名称最长 20 个字符';
    const start = hm2min(period?.start);
    const end = hm2min(period?.end);
    if (start === null) errors[`${index}.start`] = '开始时间格式应为 08:00';
    if (end === null) errors[`${index}.end`] = '结束时间格式应为 08:00';
    if (start !== null && end !== null && end <= start) errors[`${index}.end`] = '结束时间需晚于开始时间';
    if (start !== null && end !== null) parsed.push({ index, start, end, label });
  }
  parsed.sort((a, b) => a.start - b.start);
  // 跟"到目前为止结束最晚的那一节"比，而不是只比相邻一行：
  // 08:00–11:00 之后跟两节小时间段，只比相邻就会漏掉后两节与第一节的重叠
  let holder = null;
  for (const row of parsed) {
    if (holder && row.start < holder.end) {
      const key = `${row.index}.start`;
      if (!errors[key]) errors[key] = `与「${holder.label}」时间重叠`;
    }
    if (!holder || row.end > holder.end) holder = row;
  }
  return errors;
}

/** 按开始时间排好序的节次表：课表纵轴与 Function 侧都要求时间递增。 */
export const sortPeriods = (periods) => [...periods].sort(byStart);

/**
 * 节次表改动的影响预览：逐条说明哪一节新增/删除/移动，以及会牵动哪几门课。
 * 以名称为身份匹配（课表按名称显示，改名等同于换一节）。
 */
export function periodImpact(before = [], after = [], courses = []) {
  const oldRows = sortPeriods(before ?? []);
  const newRows = sortPeriods(after ?? []);
  const labelOf = (row) => String(row.label ?? '').trim();
  const lines = [];
  const affected = new Set();
  const take = (list, other) => list.filter((row) => !other.some((item) => labelOf(item) === labelOf(row)));
  const spanText = (row) => `${row.start}–${row.end}${row.kind === 'break' ? '（休息）' : ''}`;
  const push = (text, hits) => {
    lines.push({ text, courses: hits.map((course) => course.name) });
    for (const course of hits) affected.add(course.name);
  };
  for (const row of take(newRows, oldRows)) push(`将新增「${labelOf(row)}」 ${spanText(row)}`, coursesInSpan(courses, row.start, row.end));
  for (const row of take(oldRows, newRows)) push(`将删除「${labelOf(row)}」 ${spanText(row)}`, coursesInSpan(courses, row.start, row.end));
  for (const row of newRows) {
    const old = oldRows.find((item) => labelOf(item) === labelOf(row));
    if (!old) continue;
    if (old.start === row.start && old.end === row.end) {
      if ((old.kind ?? 'class') === (row.kind ?? 'class')) continue;
      const kindText = (item) => (item.kind === 'break' ? '休息' : '上课');
      const hits = coursesInSpan(courses, row.start, row.end);
      push(`「${labelOf(row)}」将从 ${kindText(old)} 改为 ${kindText(row)}，影响 ${hits.length} 门课`, hits);
      continue;
    }
    const from = min2hm(Math.min(hm2min(old.start), hm2min(row.start)));
    const to = min2hm(Math.max(hm2min(old.end), hm2min(row.end)));
    const hits = coursesInSpan(courses, from, to);
    push(`「${labelOf(row)}」将从 ${spanText(old)} 移到 ${spanText(row)}，影响 ${hits.length} 门课`, hits);
  }
  return { changed: lines.length > 0, lines, affected: [...affected] };
}

export function coursesOverlapping(courses, week, dayKey) {
  const list = coursesOnDay(courses, week, dayKey);
  const columns = new Map();
  const groups = [];
  for (const course of list) {
    const start = hm2min(course.start_time) ?? 0;
    const end = hm2min(course.end_time) ?? 0;
    const cluster = groups.find((item) => item.items.some((other) => {
      const os = hm2min(other.start_time) ?? 0;
      const oe = hm2min(other.end_time) ?? 0;
      return start < oe && os < end;
    }));
    if (cluster) {
      cluster.items.push(course);
    } else {
      groups.push({ items: [course] });
    }
  }
  for (const group of groups) {
    group.items.forEach((course, index) => columns.set(course.id, { total: group.items.length, index }));
  }
  return list.map((course) => ({ ...course, layout: columns.get(course.id) ?? { total: 1, index: 0 } }));
}

/** 周型能否落在同一周：单周与双周永远不会同时上课。 */
export function weekTypesClash(a, b) {
  return a === 'all' || b === 'all' || a === b;
}

export function weekRangesIntersect(a, b) {
  return Math.max(a.start_week, b.start_week) <= Math.min(a.end_week, b.end_week);
}

/**
 * DEV_PLAN S6 的冲突口径：同一星期 + 时间区间真的有交集 + 周型与周次范围都能碰上。
 * 端点相接（上一节 11:40 结束、下一节 11:40 开始）不算冲突。
 */
export function findConflicts(course, all = []) {
  const start = hm2min(course?.start_time);
  const end = hm2min(course?.end_time);
  if (start === null || end === null) return [];
  return all.filter((other) => other.id !== course.id
    && other.day_of_week === course.day_of_week
    && weekTypesClash(course.week_type, other.week_type)
    && weekRangesIntersect(course, other)
    && start < (hm2min(other.end_time) ?? 0)
    && (hm2min(other.start_time) ?? Infinity) < end);
}

/** 课表纵轴 = 节次表最早开始到晚结束；没有节次表时退回 07:00–22:00，网格不能塌成零高。 */
export function axisSpan(periods) {
  const starts = (periods ?? []).map((item) => hm2min(item?.start)).filter((value) => value !== null);
  const ends = (periods ?? []).map((item) => hm2min(item?.end)).filter((value) => value !== null);
  if (!starts.length || !ends.length) return { start: 420, end: 1320 };
  return { start: Math.min(...starts), end: Math.max(...ends) };
}

/** 把一对时刻映射成纵轴上的百分比位置；超出坐标轴的部分贴边并标出 clipped。 */
export function axisBox(periods, startTime, endTime) {
  const { start, end } = axisSpan(periods);
  const from = hm2min(startTime);
  const to = hm2min(endTime);
  if (from === null || to === null || end <= start) return null;
  const clamp = (minutes) => Math.max(start, Math.min(end, minutes));
  const pct = (minutes) => ((clamp(minutes) - start) / (end - start)) * 100;
  return {
    top: pct(from),
    height: Math.max(pct(to) - pct(from), 0),
    clipped: from < start || to > end,
  };
}

/** 单周/双周快捷跳转：已经在这一类周就原地不动，否则到下一周（不超过总周数）。 */
export function nextWeekOfParity(week, parity, total) {
  if (!Number.isFinite(week)) return 1;
  if (parityOfWeek(week) === parity) return week;
  return Math.min(week + 1, total);
}

/** 周次越界保护：1..total 之外一律收回边界。 */
export function clampWeek(week, total) {
  const max = Math.max(1, Number(total) || 1);
  if (!Number.isFinite(week)) return 1;
  return Math.max(1, Math.min(max, Math.round(week)));
}

/** 按日期分组，无日期的行落到最后的 null 组（收集箱）。 */
export function groupByDate(rows, keyOf = (row) => row.due_date, { descending = false } = {}) {
  const map = new Map();
  for (const row of rows) {
    const key = keyOf(row) || null;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  const keys = [...map.keys()].filter((key) => key !== null);
  keys.sort((a, b) => (descending ? b.localeCompare(a) : a.localeCompare(b)));
  if (map.has(null)) keys.push(null);
  return keys.map((key) => ({ date: key, rows: map.get(key) }));
}

const ACTIVE_STATUS = new Set(['not_started', 'active', 'blocked']);

export function openMilestones(milestones) {
  return milestones.filter((milestone) => milestone.status !== 'done');
}

/** PRD 3："下一站" = 最早未完成待办 → 最近未完成里程碑 → 空。 */
export function nextDueItem(tasks, milestones, today = todayKey()) {
  const pending = tasks.filter((task) => !task.done && task.due_date).sort(sortByDateTime);
  if (pending.length) {
    return { kind: 'task', id: pending[0].id, title: pending[0].title, date: pending[0].due_date, time: pending[0].due_time ?? null };
  }
  const upcoming = openMilestones(milestones).filter((item) => item.target_date).sort((a, b) => a.target_date.localeCompare(b.target_date));
  if (upcoming.length) {
    return { kind: 'milestone', id: upcoming[0].id, title: upcoming[0].title, date: upcoming[0].target_date, time: null };
  }
  return null;
}

/** PRD 6：近期里程碑 = 全部项目中未完成、target_date 最近的 3 个（无日期的排最后）。 */
export function recentMilestones(milestones, count = 3) {
  return openMilestones(milestones)
    .sort((a, b) => `${a.target_date ?? '9999-12-31'}`.localeCompare(`${b.target_date ?? '9999-12-31'}`))
    .slice(0, count);
}

const STATUS_RANK = { done: 2, partial: 1, missed: 0 };

/** 同一天多条记录时取最强的一条：done > partial > missed。 */
function bestStatusByDate(workouts) {
  const map = new Map();
  for (const row of workouts) {
    if (!row.workout_date) continue;
    const prev = map.get(row.workout_date);
    if (prev === undefined || (STATUS_RANK[row.status] ?? -1) > (STATUS_RANK[prev] ?? -1)) {
      map.set(row.workout_date, row.status);
    }
  }
  return map;
}

/**
 * 连续天数（PRD 8 健身）：缺练（missed）当天归零，部分完成（partial）不清零。
 * 今天还没有记录时从昨天往前数，避免"还没练"就显示断签。
 */
export function streakOf(workouts, today = todayKey()) {
  const byDate = bestStatusByDate(workouts);
  let cursor = byDate.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (byDate.has(cursor) && byDate.get(cursor) !== 'missed') {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

export function workoutsIn(workouts, range) {
  if (!range) return [];
  return workouts.filter((item) => item.workout_date >= range.start && item.workout_date <= range.end);
}

/** 区间统计：次数/时长/完成度/类型分布，首页与健身页共用同一份算法。 */
export function workoutStats(workouts, range) {
  const rows = workoutsIn(workouts, range);
  const stats = { sessions: rows.length, minutes: 0, done: 0, partial: 0, missed: 0, byType: [], days: new Set() };
  const types = new Map();
  for (const row of rows) {
    // 缺练只是时间线上的占位：这里如果不排除，头部总时长就会比周分组和柱状图各算一套
    const minutes = row.status === 'missed' ? 0 : Number(row.duration_min) || 0;
    stats.minutes += minutes;
    if (row.status in stats) stats[row.status] += 1;
    if (row.status !== 'missed') stats.days.add(row.workout_date);
    const key = row.type || '其它';
    const entry = types.get(key) ?? { type: key, sessions: 0, minutes: 0 };
    entry.sessions += 1;
    entry.minutes += minutes;
    types.set(key, entry);
  }
  stats.byType = [...types.values()].sort((a, b) => b.minutes - a.minutes || b.sessions - a.sessions);
  stats.activeDays = stats.days.size;
  return stats;
}

/** 近 N 个 ISO 周的分桶，用于柱状图。 */
export function weeklyBuckets(workouts, { count = 8, today = todayKey() } = {}) {
  const thisMonday = mondayOf(today);
  const buckets = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const start = addDays(thisMonday, -7 * back);
    const end = addDays(start, 6);
    const rows = workoutsIn(workouts, { start, end });
    buckets.push({
      start, end, label: fmtDateShort(start),
      minutes: rows.reduce((sum, row) => sum + (row.status === 'missed' ? 0 : Number(row.duration_min) || 0), 0),
      sessions: rows.filter((row) => row.status !== 'missed').length,
    });
  }
  return buckets;
}

/** 近 N 周热力格：按周分列、每列 7 格（周一在上），值取当日最强完成度。 */
export function heatCells(workouts, { weeks = 13, today = todayKey() } = {}) {
  const byDate = bestStatusByDate(workouts);
  const first = addDays(mondayOf(today), -7 * (weeks - 1));
  const columns = [];
  for (let week = 0; week < weeks; week += 1) {
    const days = [];
    for (let dow = 0; dow < 7; dow += 1) {
      const date = addDays(first, week * 7 + dow);
      days.push({ date, status: byDate.get(date) ?? null, future: date > today });
    }
    columns.push({ weekStart: days[0].date, days });
  }
  return columns;
}

/** 本月区间：1 号到今天，和 currentWeekRange 一样不把未来算进区间。 */
export function monthlyRange(today = todayKey()) {
  return { start: `${today.slice(0, 7)}-01`, end: today };
}

/** 最近 weeks 个自然周里最早的那天，决定记录列表与「更早」段的分界。 */
export function windowStart(today = todayKey(), weeks = 4) {
  return addDays(mondayOf(today), -7 * (weeks - 1));
}

/**
 * 记录列表按自然周分组，周和周内日期都从新到旧。
 * 没有记录的日子也留一格：看得见"空档"才补得回来，这是 PRD 5.4 把缺练当数据的用意。
 */
export function weekGroups(rows, { today = todayKey(), weeks = 4 } = {}) {
  const byDate = new Map();
  for (const row of rows ?? []) {
    if (!row.workout_date) continue;
    const list = byDate.get(row.workout_date);
    if (list) list.push(row); else byDate.set(row.workout_date, [row]);
  }
  const groups = [];
  for (let back = 0; back < weeks; back += 1) {
    const start = addDays(mondayOf(today), -7 * back);
    const end = addDays(start, 6);
    const last = today < end ? today : end;
    const days = [];
    for (let date = last; date >= start; date = addDays(date, -1)) {
      days.push({ date, rows: byDate.get(date) ?? [] });
    }
    groups.push({ start, end: last, days });
  }
  return groups;
}

/** 落在周分组窗口之外的记录：列表要另起一段收尾，不能悄悄丢掉。 */
export function outsideWeekGroups(rows, { today = todayKey(), weeks = 4 } = {}) {
  const earliest = windowStart(today, weeks);
  return (rows ?? []).filter((row) => row.workout_date && row.workout_date < earliest);
}

export function progressOf(milestone) {
  return Math.max(0, Math.min(100, Number(milestone.progress) || 0));
}

/** 自动进度 = 子任务完成比例，与服务端 rules.mjs 的 syncMilestoneProgress 同一个算式。 */
export function autoProgress(subtasks) {
  if (!subtasks.length) return 0;
  return Math.round((subtasks.filter((item) => item.done).length / subtasks.length) * 100);
}

/** 进度条画多少、要不要挂「手动」徽标、差异提示怎么写，都从这一处取。 */
export function milestoneProgress(milestone, subtasks = []) {
  const auto = autoProgress(subtasks);
  const manual = milestone.manual_progress === true;
  return {
    auto,
    manual,
    value: manual ? progressOf(milestone) : auto,
    // 没有子任务时自动值恒为 0，拿它去和手填值报警是噪声，只有真能对比时才提示
    differs: manual && subtasks.length > 0 && auto !== progressOf(milestone),
    done: subtasks.filter((item) => item.done).length,
    total: subtasks.length,
  };
}

/** 服务端按 sort 升序 + id 兜底回读，客户端重排后要按同一口径排。 */
export const sortRows = (rows) => [...rows].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)
  || String(a.id).localeCompare(String(b.id)));

/** 拖拽与上/下移共用：把 from 位的行挪到 to 位，越界与非整数原样返回。 */
export function reorder(rows, from, to) {
  const next = [...rows];
  if (!Number.isInteger(from) || !Number.isInteger(to)) return next;
  if (from < 0 || from >= next.length || to < 0 || to >= next.length) return next;
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** 新顺序下只给真正变了 sort 的行发请求。 */
export function sortPatches(rows) {
  return rows.map((item, index) => ({ id: item.id, sort: index }))
    .filter((patch, index) => rows[index].sort !== patch.sort);
}

/** 项目进度 = 其里程碑进度的平均，与详情页同一口径。 */
export function projectProgress(milestones) {
  if (!milestones.length) return null;
  return Math.round(milestones.reduce((sum, item) => sum + progressOf(item), 0) / milestones.length);
}

export function remainingDays(dateKey, today = todayKey()) {
  if (!dateKey) return null;
  return diffDays(today, dateKey);
}
