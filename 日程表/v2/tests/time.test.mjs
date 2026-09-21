import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDate, weekOf, weekdayOf, coursesOn, currentCourse, nextCourse,
  fmtCountdown, fmtDateCN, weekLabel, dayKey, addDays, diffDays, courseTimes,
} from '../lib/time.js';
import { FIX_COURSES } from './course-fixture.mjs';

test('weekOf 边界', () => {
  assert.equal(weekOf(parseDate('2026-09-06')), null); // 开学前
  assert.equal(weekOf(parseDate('2026-09-07')), 1);    // 第1周周一
  assert.equal(weekOf(parseDate('2026-09-13')), 1);    // 第1周周日
  assert.equal(weekOf(parseDate('2026-09-14')), 2);    // 第2周周一
  assert.equal(weekOf(parseDate('2026-09-20')), 2);    // 第2周周日
  assert.equal(weekOf(parseDate('2026-12-28')), null); // 期末后
});

test('weekdayOf 周一=1 周日=7', () => {
  assert.equal(weekdayOf(parseDate('2026-09-07')), 1);
  assert.equal(weekdayOf(parseDate('2026-09-13')), 7);
});

test('coursesOn 按星期过滤并排序', () => {
  const mon = coursesOn(parseDate('2026-09-07'), FIX_COURSES);
  assert.equal(mon.length, 4);
  assert.deepEqual(mon.map((c) => c.startSection), [1, 3, 6, 8]);
  assert.equal(mon[0].name, '法国歌剧史与作品赏析');

  const thu = coursesOn(parseDate('2026-09-10'), FIX_COURSES);
  assert.equal(thu.length, 3);
  assert.ok(thu.some((c) => c.name === '综合法语(1)' && c.startSection === 11));

  const sun = coursesOn(parseDate('2026-09-13'), FIX_COURSES);
  assert.equal(sun.length, 0);
});

test('非教学周 coursesOn 返回空', () => {
  assert.deepEqual(coursesOn(parseDate('2026-12-28'), FIX_COURSES), []);
});

test('空课表 coursesOn 返回空', () => {
  assert.deepEqual(coursesOn(parseDate('2026-09-07'), []), []);
  assert.deepEqual(coursesOn(parseDate('2026-09-07')), []);
});

test('nextCourse / currentCourse 固定 now', () => {
  const date = parseDate('2026-09-07'); // 周一
  const now = new Date(2026, 8, 7, 9, 0, 0); // 09:00
  const nx = nextCourse(date, now, FIX_COURSES);
  assert.equal(nx.course.name, '综合法语实训(1)'); // 第三节 09:50
  assert.equal(nx.at.getHours(), 9);
  assert.equal(nx.at.getMinutes(), 50);

  const cur = currentCourse(date, new Date(2026, 8, 7, 8, 20, 0), FIX_COURSES);
  assert.equal(cur.name, '法国歌剧史与作品赏析'); // 第一节进行中

  assert.equal(currentCourse(date, new Date(2026, 8, 7, 9, 40, 0), FIX_COURSES), null); // 块间课间(09:35-09:50)无进行中

  const late = nextCourse(date, new Date(2026, 8, 7, 23, 0, 0), FIX_COURSES);
  assert.equal(late, null); // 全天结束
});

test('courseTimes 连堂起止', () => {
  const date = parseDate('2026-09-08'); // 周二
  const cs = coursesOn(date, FIX_COURSES).find((c) => c.name === '大学计算机基础');
  const { start, end } = courseTimes(cs, date);
  assert.equal(start.getHours(), 9); assert.equal(start.getMinutes(), 50); // 第3节
  assert.equal(end.getHours(), 12); assert.equal(end.getMinutes(), 15);    // 第5节
});

test('fmtCountdown', () => {
  assert.equal(fmtCountdown(0), '00:00:00');
  assert.equal(fmtCountdown(92000), '00:01:32');
  assert.equal(fmtCountdown(9200000), '02:33:20');
  assert.equal(fmtCountdown(-5), '00:00:00');
});

test('格式化与日期工具', () => {
  assert.equal(fmtDateCN(parseDate('2026-09-20')), '9月20日 周日');
  assert.equal(weekLabel(parseDate('2026-09-20')), '第2周');
  assert.equal(weekLabel(parseDate('2026-12-28')), '非教学周');
  assert.equal(dayKey(parseDate('2026-09-07')), '2026-09-07');
  assert.equal(dayKey(addDays(parseDate('2026-09-07'), 7)), '2026-09-14');
  assert.equal(diffDays(parseDate('2026-09-20'), parseDate('2026-09-23')), 3);
  assert.equal(diffDays(parseDate('2026-09-20'), parseDate('2026-09-19')), -1);
});
