// S9 不需要浏览器的部分：卡片顺序这份本地偏好的容错，和「下一站」倒计时的算式。
// 顺序只能存 4 张已知卡片；倒计时文字在视图与外壳定时器里必须是同一份算式。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSeed } from '../seed.mjs';
import * as T from '../../web/lib/time.js';
import { normalizeOrder } from '../../web/views/home.js';

const TODAY = '2026-09-20';
const SEED = buildSeed(new Date(`${TODAY}T12:00:00`));
const DEFAULT = ['courses', 'tasks', 'milestones', 'workouts'];

test('S9 卡片顺序：没存过就用默认顺序，桌面 2×2 的读法', () => {
  assert.deepEqual(normalizeOrder(null), DEFAULT);
  assert.deepEqual(normalizeOrder(undefined), DEFAULT);
  assert.deepEqual(normalizeOrder([]), DEFAULT);
  // 偏好不是业务数据，但也可能被手改坏：非数组一概当没存过
  assert.deepEqual(normalizeOrder('workouts,courses'), DEFAULT);
  assert.deepEqual(normalizeOrder(0), DEFAULT);
});

test('S9 卡片顺序：只认已知卡片，重复与陌生键丢掉，缺的按默认顺序补在末尾', () => {
  assert.deepEqual(normalizeOrder(['workouts', 'courses']), ['workouts', 'courses', 'tasks', 'milestones']);
  assert.deepEqual(normalizeOrder(['tasks', 'tasks', 'courses']), ['tasks', 'courses', 'milestones', 'workouts']);
  assert.deepEqual(normalizeOrder(['bogus', 42, null, 'milestones']), ['milestones', 'courses', 'tasks', 'workouts']);
  // 完整的一整套顺序原样保留，不做任何"纠正"
  assert.deepEqual(normalizeOrder(['workouts', 'milestones', 'tasks', 'courses']),
    ['workouts', 'milestones', 'tasks', 'courses']);
});

test('S9 下一站倒计时：剩余时间按天/小时/分钟逐级读，过期就说"就在现在"', () => {
  assert.equal(T.countdownText('2026-09-25T08:00:00', new Date(`${TODAY}T12:30:00`)), '4 天 19 小时');
  assert.equal(T.countdownText(`${TODAY}T13:00:00`, new Date(`${TODAY}T12:30:00`)), '30 分钟');
  assert.equal(T.countdownText(`${TODAY}T12:45:00`, new Date(`${TODAY}T12:30:00`)), '15 分钟');
  assert.equal(T.countdownText('2026-09-20T08:00:00', new Date(`${TODAY}T12:30:00`)), '就在现在',
    '已经过去了不该报负数，也不能显示成还在倒计时');
});

test('S9 下一站倒计时：跨过 00:00 数字要跟着走，日期串读不出来时留空而不是 NaN', () => {
  const stamp = '2026-09-22T10:00:00';
  const before = T.countdownText(stamp, new Date(`${TODAY}T23:50:00`));
  const after = T.countdownText(stamp, new Date('2026-09-21T00:10:00'));
  assert.equal(before, '1 天 10 小时');
  assert.equal(after, '1 天 9 小时', '过 00:00 之后剩余量必须重算，不能沿用昨天那一句');
  assert.notEqual(before, after);
  assert.equal(T.countdownText('', new Date()), '');
  assert.equal(T.countdownText('不是日期', new Date()), '');
  assert.equal(T.countdownText(undefined, new Date()), '');
});

test('S9 今日完成环：分母恒等于今日卡片行数，勾一条前进一格', () => {
  const tasks = SEED.tasks;
  const list = T.segmentTasks(tasks, 'today', TODAY);
  const progress = T.todayProgress(tasks, TODAY);
  assert.equal(progress.total, list.length, '首页环和日程页今日段用了两套取数，数字就会各说各话');
  assert.deepEqual([progress.done, progress.ratio], [0, 0], '种子里今日待办一条都没完成');

  const dueToday = list.find((task) => task.due_date === TODAY && !task.done);
  assert.ok(dueToday, '种子里要有今天到期的待办');
  const ticked = tasks.map((task) => (task.id === dueToday.id ? { ...task, done: true } : task));
  const next = T.todayProgress(ticked, TODAY);
  assert.deepEqual([next.done, next.total, next.ratio], [1, progress.total, Math.round(100 / progress.total)],
    '勾掉一条今天到期的待办：它仍在今日列表里，分母不该跟着缩');

  // 逾期项一完成就离开今日列表（PRD 6），额度同步让出去，而不是留下永远填不满的分母
  const overdue = list.find((task) => task.due_date < TODAY && !task.done);
  assert.ok(overdue, '种子里要有逾期的待办');
  const cleared = tasks.map((task) => (task.id === overdue.id ? { ...task, done: true } : task));
  const after = T.todayProgress(cleared, TODAY);
  assert.deepEqual([after.done, after.total], [0, progress.total - 1]);

  assert.equal(T.todayProgress([], TODAY).ratio, 0, '一条都没有时是 0 而不是除零得到的 NaN');
});
