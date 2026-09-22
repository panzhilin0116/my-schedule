import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWeeks, weekContains, weeksOverlap, formatWeeks } from '../lib/weeks.js';

test('normalizeWeeks：缺省与非法一律归 null（= 全教学周）', () => {
  assert.equal(normalizeWeeks(undefined), null);
  assert.equal(normalizeWeeks(null), null);
  assert.equal(normalizeWeeks('1-16周'), null);
  assert.equal(normalizeWeeks({ from: 3, to: 2 }), null); // to < from
  assert.equal(normalizeWeeks({ from: 0, to: 5 }), null); // 越下界
  assert.equal(normalizeWeeks({ from: 1.5, to: 5 }), null); // 非整数
});

test('normalizeWeeks：合法值裁剪到 1–14，非法 parity 落 all', () => {
  assert.deepEqual(normalizeWeeks({ from: 1, to: 16 }), { from: 1, to: 14, parity: 'all' });
  assert.deepEqual(normalizeWeeks({ from: '3', to: '8', parity: 'odd' }), { from: 3, to: 8, parity: 'odd' });
  assert.deepEqual(normalizeWeeks({ from: 1, to: 14, parity: 'big' }), { from: 1, to: 14, parity: 'all' });
  assert.deepEqual(normalizeWeeks({ from: 2, to: 10 }), { from: 2, to: 10, parity: 'all' });
});

test('weekContains：无 weeks 恒真；范围与奇偶生效', () => {
  assert.equal(weekContains(undefined, 7), true);
  assert.equal(weekContains({ from: 2, to: 5, parity: 'all' }, 1), false);
  assert.equal(weekContains({ from: 2, to: 5, parity: 'all' }, 3), true);
  assert.equal(weekContains({ from: 1, to: 14, parity: 'odd' }, 3), true);
  assert.equal(weekContains({ from: 1, to: 14, parity: 'odd' }, 4), false);
  assert.equal(weekContains({ from: 1, to: 14, parity: 'even' }, 4), true);
});

test('weeksOverlap：odd×even 不相交；区间交但奇偶错开也不算交', () => {
  assert.equal(weeksOverlap(undefined, undefined), true);
  assert.equal(weeksOverlap({ from: 1, to: 8, parity: 'odd' }, { from: 1, to: 8, parity: 'even' }), false);
  assert.equal(weeksOverlap({ from: 1, to: 8, parity: 'odd' }, { from: 1, to: 8, parity: 'odd' }), true);
  assert.equal(weeksOverlap({ from: 1, to: 4, parity: 'all' }, { from: 5, to: 8, parity: 'all' }), false);
  assert.equal(weeksOverlap({ from: 2, to: 2, parity: 'even' }, { from: 1, to: 14, parity: 'odd' }), false); // 第2周无奇数周
  assert.equal(weeksOverlap({ from: 1, to: 14, parity: 'all' }, { from: 3, to: 3, parity: 'odd' }), true);
});

test('formatWeeks：缺省口径与旧展示一致', () => {
  assert.equal(formatWeeks(undefined), '本学期 1–14 周');
  assert.equal(formatWeeks({ from: 1, to: 16, parity: 'odd' }), '第1–14周 · 单周');
  assert.equal(formatWeeks({ from: 2, to: 10, parity: 'even' }), '第2–10周 · 双周');
});
