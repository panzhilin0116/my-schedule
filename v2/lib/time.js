import { SEMESTER, PERIODS, WEEK_LABELS } from '../data/semester.js';
import { COURSES } from '../data/courses.js';

const MS_DAY = 86400000;

export function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

export function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

export function dayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(date, n) {
  const d = startOfDay(date);
  d.setDate(d.getDate() + n);
  return d;
}

export function diffDays(a, b) {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / MS_DAY);
}

function atTime(dayDate, hhmm) {
  const [hh, mm] = hhmm.split(':').map(Number);
  return new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), hh, mm, 0, 0);
}

export function weekdayOf(date) {
  return ((date.getDay() + 6) % 7) + 1;
}

export function weekOf(date) {
  const monday = parseDate(SEMESTER.week1Monday);
  const diff = Math.floor((startOfDay(date).getTime() - monday.getTime()) / MS_DAY);
  if (diff < 0) return null;
  const week = Math.floor(diff / 7) + 1;
  if (week > SEMESTER.totalWeeks) return null;
  return week;
}

export function isTeachingWeek(date) {
  return weekOf(date) !== null;
}

export function rawWeekNumber(date) {
  const monday = parseDate(SEMESTER.week1Monday);
  const diff = Math.floor((startOfDay(date).getTime() - monday.getTime()) / MS_DAY);
  return Math.floor(diff / 7) + 1;
}

export function weekMonday(date) {
  const w = weekOf(date);
  if (w === null) return null;
  return addDays(parseDate(SEMESTER.week1Monday), (w - 1) * 7);
}

export function periodStart(dayDate, section) {
  const p = PERIODS[section - 1];
  return atTime(dayDate, p.start);
}

export function periodEnd(dayDate, section) {
  const p = PERIODS[section - 1];
  return atTime(dayDate, p.end);
}

export function courseTimes(course, date) {
  const day = startOfDay(date);
  return { start: atTime(day, PERIODS[course.startSection - 1].start), end: atTime(day, PERIODS[course.endSection - 1].end) };
}

export function coursesOn(date) {
  if (!isTeachingWeek(date)) return [];
  const wd = weekdayOf(date);
  return COURSES.filter((c) => c.day === wd).sort((a, b) => a.startSection - b.startSection);
}

export function currentCourse(date, now) {
  for (const c of coursesOn(date)) {
    const { start, end } = courseTimes(c, date);
    if (start <= now && now < end) return c;
  }
  return null;
}

export function nextCourse(date, now) {
  let best = null;
  for (const c of coursesOn(date)) {
    const { start } = courseTimes(c, date);
    if (start > now && (!best || start < best.at)) best = { course: c, at: start };
  }
  return best;
}

export function fmtClock(date) {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function fmtCountdown(ms) {
  if (ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const hh = String(Math.floor(total / 3600)).padStart(2, '0');
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function fmtDateCN(date) {
  return `${date.getMonth() + 1}月${date.getDate()}日 ${WEEK_LABELS[weekdayOf(date) - 1]}`;
}

export function weekLabel(date) {
  const w = weekOf(date);
  return w === null ? '非教学周' : `第${w}周`;
}

export { COURSES, PERIODS, SEMESTER, WEEK_LABELS };
