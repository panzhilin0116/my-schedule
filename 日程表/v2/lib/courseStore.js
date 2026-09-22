import { getSpaceKey } from './space.js';
import { StoreError } from './store.js';
import { normalizeWeeks, weeksOverlap } from './weeks.js';
import { PERIODS } from '../data/semester.js';

export const COURSE_KEY_BASE = 'schedule.courses.v1';
export const COURSE_COLORS = ['blue', 'purple', 'green', 'orange', 'cyan', 'pink'];

export { StoreError };

function storageKey(storage) {
  // 测试模式：传入自定义 storage 时，直接用 base key（不隔离空间）
  if (storage !== undefined) return COURSE_KEY_BASE;
  return getSpaceKey(COURSE_KEY_BASE);
}

function backend(storage) {
  const s = storage !== undefined ? storage : globalThis.localStorage;
  if (!s) throw new StoreError('localStorage 不可用');
  return s;
}

export function newCourseId() {
  return 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

export function loadCourses(storage) {
  const s = backend(storage);
  const raw = s.getItem(storageKey(storage));
  if (raw == null) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new StoreError('课表数据已损坏，无法读取');
  }
  if (!Array.isArray(parsed)) throw new StoreError('课表数据格式不正确');
  return parsed;
}

export function saveCourses(courses, storage) {
  const s = backend(storage);
  try {
    s.setItem(storageKey(storage), JSON.stringify(courses));
  } catch (e) {
    if (e.name === 'QuotaExceededError' || e.code === 22) {
      throw new StoreError('本机存储空间已满，请先删除部分课程');
    }
    throw new StoreError('保存失败：' + e.message);
  }
  return courses;
}

export function upsertCourse(course, storage) {
  const { weeks, ...rest } = course;
  const normalized = normalizeWeeks(weeks);
  const record = normalized ? { ...rest, weeks: normalized } : rest;
  const list = loadCourses(storage).slice();
  const idx = list.findIndex((c) => c.id === record.id);
  if (idx >= 0) list[idx] = record;
  else list.push(record);
  return saveCourses(list, storage);
}

export function removeCourse(id, storage) {
  const list = loadCourses(storage).filter((c) => c.id !== id);
  return saveCourses(list, storage);
}

/** §5.7：清除本空间全部带导入标记的课，手加课不动；返回被删的课供上层提示。 */
export function removeImportedCourses(storage) {
  const list = loadCourses(storage);
  const removed = list.filter((c) => c.importedFrom);
  if (removed.length) saveCourses(list.filter((c) => !c.importedFrom), storage);
  return removed;
}

export function hasImportedCourses(storage) {
  return loadCourses(storage).some((c) => c.importedFrom);
}

function intInRange(v, lo, hi) {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi;
}

export function validateCourse(draft, allCourses = []) {
  const errors = {};
  const day = Number(draft.day);
  const startSection = Number(draft.startSection);
  const endSection = Number(draft.endSection);
  if (!draft.name || !String(draft.name).trim()) errors.name = '课程名称不能为空';
  if (!intInRange(day, 1, 7)) errors.day = '请选择星期';
  if (!intInRange(startSection, 1, PERIODS.length)) errors.startSection = '节次无效';
  if (!intInRange(endSection, 1, PERIODS.length)) errors.endSection = '节次无效';
  if (!errors.startSection && !errors.endSection && startSection > endSection) {
    errors.endSection = '结束节次不能早于开始节次';
  }
  if (draft.color && !COURSE_COLORS.includes(draft.color)) errors.color = '颜色无效';

  if (!Object.keys(errors).length) {
    // §5.7 冲突升级：星期相同 && 节次区间重叠 && 周次范围有交集 才算冲突
    const conflict = allCourses.find(
      (c) => c.id !== draft.id && Number(c.day) === day
        && Number(c.startSection) <= endSection && startSection <= Number(c.endSection)
        && weeksOverlap(c.weeks, draft.weeks),
    );
    if (conflict) errors.startSection = `与「${conflict.name}」时间冲突`;
  }

  return { ok: Object.keys(errors).length === 0, errors };
}
