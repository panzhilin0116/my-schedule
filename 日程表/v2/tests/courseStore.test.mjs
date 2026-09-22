import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadCourses, saveCourses, upsertCourse, removeCourse,
  removeImportedCourses, hasImportedCourses,
  validateCourse, newCourseId, COURSE_KEY_BASE, COURSE_COLORS, StoreError,
} from '../lib/courseStore.js';

function fakeStorage(initial) {
  const map = new Map(initial ? Object.entries(initial) : []);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

test('空存储返回 []', () => {
  assert.deepEqual(loadCourses(fakeStorage()), []);
});

test('upsert / remove 往返', () => {
  const st = fakeStorage();
  const c = { id: 'c1', name: '高等数学', day: 1, startSection: 1, endSection: 2, room: '一号楼', color: 'blue', createdAt: 1 };
  upsertCourse(c, st);
  assert.deepEqual(loadCourses(st), [c]);

  upsertCourse({ ...c, room: '二号楼' }, st);
  assert.equal(loadCourses(st).length, 1);
  assert.equal(loadCourses(st)[0].room, '二号楼');

  removeCourse('c1', st);
  assert.deepEqual(loadCourses(st), []);
});

test('坏 JSON / 非数组 抛 StoreError', () => {
  assert.throws(() => loadCourses(fakeStorage({ [COURSE_KEY_BASE]: '{broken' })), StoreError);
  assert.throws(() => loadCourses(fakeStorage({ [COURSE_KEY_BASE]: '{"a":1}' })), StoreError);
});

test('存储写满抛 StoreError', () => {
  const st = {
    getItem: () => null,
    setItem: () => { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; },
    removeItem: () => {},
  };
  assert.throws(() => saveCourses([{ id: 'c1' }], st), StoreError);
});

test('validateCourse：名称、星期、节次边界', () => {
  const base = { name: '数学', day: 1, startSection: 1, endSection: 2 };
  assert.equal(validateCourse({ ...base, name: ' ' }).errors.name, '课程名称不能为空');
  assert.equal(validateCourse({ ...base, day: 8 }).errors.day, '请选择星期');
  assert.equal(validateCourse({ ...base, day: 0 }).errors.day, '请选择星期');
  assert.equal(validateCourse({ ...base, startSection: 0 }).errors.startSection, '节次无效');
  assert.equal(validateCourse({ ...base, startSection: 15 }).errors.startSection, '节次无效');
  assert.equal(validateCourse({ ...base, startSection: 3, endSection: 2 }).errors.endSection, '结束节次不能早于开始节次');
  assert.equal(validateCourse({ ...base, color: 'red' }).errors.color, '颜色无效');
  assert.equal(validateCourse(base).ok, true);
  // 字符串数字（来自表单 select）同样有效
  assert.equal(validateCourse({ ...base, day: '2', startSection: '1', endSection: '2' }).ok, true);
});

test('validateCourse：同星期节次重叠判冲突', () => {
  const existing = [{ id: 'c1', name: '大学计算机基础', day: 2, startSection: 3, endSection: 5 }];
  const overlap = validateCourse({ id: 'new', name: '新课程', day: 2, startSection: 5, endSection: 6 }, existing);
  assert.equal(overlap.ok, false);
  assert.equal(overlap.errors.startSection, '与「大学计算机基础」时间冲突');

  // 不同星期不冲突
  assert.equal(validateCourse({ id: 'new', name: '新课程', day: 3, startSection: 3, endSection: 5 }, existing).ok, true);
  // 紧挨着不冲突（5-6 与 3-5 在 5 重叠；3-4 不重叠）
  assert.equal(validateCourse({ id: 'new', name: '新课程', day: 2, startSection: 6, endSection: 7 }, existing).ok, true);
  // 编辑自己不算冲突
  assert.equal(validateCourse({ ...existing[0] }, existing).ok, true);
});

test('newCourseId 唯一', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newCourseId()));
  assert.equal(ids.size, 200);
});

test('COURSE_COLORS 与样式色板一致', () => {
  assert.deepEqual(COURSE_COLORS, ['blue', 'purple', 'green', 'orange', 'cyan', 'pink']);
});

// ---- §5.7 P1：weeks 字段 + 周次感知冲突 + 导入标记 ----

test('upsertCourse：合法 weeks 归一化保存，非法 weeks 落回缺省（不存字段）', () => {
  const st = fakeStorage();
  const base = { id: 'c1', name: '数学', day: 1, startSection: 1, endSection: 2, color: 'blue', createdAt: 1 };
  upsertCourse({ ...base, weeks: { from: 1, to: 16, parity: 'odd' } }, st);
  assert.deepEqual(loadCourses(st)[0].weeks, { from: 1, to: 14, parity: 'odd' });
  upsertCourse({ ...base, weeks: { from: 9, to: 2 } }, st);
  assert.equal('weeks' in loadCourses(st)[0], false);
  upsertCourse({ ...base, importedFrom: 'import' }, st);
  assert.equal(loadCourses(st)[0].importedFrom, 'import');
});

test('validateCourse：周次感知冲突（§5.7 升级）', () => {
  const existing = [{ id: 'c1', name: '单周法语', day: 2, startSection: 3, endSection: 4, weeks: { from: 1, to: 14, parity: 'odd' } }];
  // 同星期同节次但 odd vs even → 不冲突、可并存
  assert.equal(validateCourse({ id: 'x', name: '双周体育', day: 2, startSection: 3, endSection: 4, weeks: { from: 1, to: 14, parity: 'even' } }, existing).ok, true);
  // 同星期同节次同为 odd → 冲突
  const clash = validateCourse({ id: 'x', name: '另一门', day: 2, startSection: 4, endSection: 5, weeks: { from: 1, to: 14, parity: 'odd' } }, existing);
  assert.equal(clash.ok, false);
  assert.equal(clash.errors.startSection, '与「单周法语」时间冲突');
  // 周次范围无共同周（1–2 的双周 vs 1–14 的单周：只有第 2 周相遇，但对方是单周课）→ 不冲突
  assert.equal(validateCourse({ id: 'x', name: '双周短课', day: 2, startSection: 3, endSection: 4, weeks: { from: 1, to: 2, parity: 'even' } }, existing).ok, true);
  // 区间完全不相交 → 不冲突
  assert.equal(validateCourse({ id: 'x', name: '后段课', day: 2, startSection: 3, endSection: 4, weeks: { from: 8, to: 14, parity: 'all' } }, [{ ...existing[0], weeks: { from: 1, to: 5, parity: 'all' } }]).ok, true);
  // 旧口径：双方都无 weeks → 与升级前行为一致，重叠即冲突
  assert.equal(validateCourse({ id: 'x', name: '普通课', day: 2, startSection: 3, endSection: 4 }, [{ id: 'c0', name: '无周次课', day: 2, startSection: 3, endSection: 4 }]).ok, false);
  // 无 weeks（全周）与单周课重叠 → 冲突
  assert.equal(validateCourse({ id: 'x', name: '全周课', day: 2, startSection: 3, endSection: 4 }, existing).ok, false);
});

test('removeImportedCourses：只删带标记课，手加课不动，返回被删清单', () => {
  const st = fakeStorage();
  upsertCourse({ id: 'a', name: '导入A', day: 1, startSection: 1, endSection: 2, color: 'blue', createdAt: 1, importedFrom: 'import' }, st);
  upsertCourse({ id: 'b', name: '手加B', day: 3, startSection: 3, endSection: 4, color: 'green', createdAt: 2 }, st);
  upsertCourse({ id: 'c', name: '导入C', day: 5, startSection: 5, endSection: 6, color: 'orange', createdAt: 3, importedFrom: 'import' }, st);
  assert.equal(hasImportedCourses(st), true);
  const removed = removeImportedCourses(st);
  assert.deepEqual(removed.map((c) => c.id).sort(), ['a', 'c']);
  assert.deepEqual(loadCourses(st).map((c) => c.id), ['b']);
  assert.equal(hasImportedCourses(st), false);
  assert.deepEqual(removeImportedCourses(st), []); // 幂等
});
