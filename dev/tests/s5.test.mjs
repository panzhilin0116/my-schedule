// S5 完成标准里不需要浏览器的部分：分段口径、分类×状态组合、组内沉底、
// 顺延目标与快速添加的弱解析（识别不了必须留空，不许猜）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRow } from '../../functions/registry.mjs';
import { buildSeed } from '../seed.mjs';
import * as T from '../../web/lib/time.js';

const TODAY = '2026-09-20';
const TASKS = buildSeed(new Date(`${TODAY}T12:00:00`)).tasks;
const titles = (rows) => rows.map((row) => row.title);
const byTitle = (title) => TASKS.find((row) => row.title === title);

// ── 分段（DEV_PLAN S5 完成标准 1/3）─────────────────────────

test('S5 今日分段＝今天到期 + 逾期未完成，逾期在前、再按时间升序', () => {
  assert.deepEqual(titles(T.segmentTasks(TASKS, 'today', TODAY)), [
    '报销实验器材',            // 9/15，逾期 5 天
    '高等数学期中复习',        // 9/17
    '复现 Transformer 基线',   // 9/18
    '提交课程论文选题',        // 今天 12:00
    '操作系统实验报告',        // 今天 18:00
    '预约游泳池',              // 今天，无时间 → 排在有时间的后面
  ]);
});

test('S5 无日期条目只在「全部」里出现，任何时间分段都不含收集箱', () => {
  const inbox = byTitle('整理健身数据');
  assert.equal(inbox.due_date, null, '种子数据里的收集箱项应无日期');
  for (const segment of ['today', 'week', 'done']) {
    assert.ok(!titles(T.segmentTasks(TASKS, segment, TODAY)).includes('整理健身数据'), `${segment} 分段漏进了收集箱`);
  }
  assert.ok(titles(T.segmentTasks(TASKS, 'all', TODAY)).includes('整理健身数据'));
});

test('S5 本周分段含整周并带上前一周没做完的，跨周不能悄悄消失', () => {
  // 2026-09-20 是周日：本周一 9/14、本周日 9/20
  assert.equal(T.mondayOf(TODAY), '2026-09-14');
  const week = titles(T.segmentTasks(TASKS, 'week', TODAY));
  assert.deepEqual(week, [
    '数据结构：第 4 章习题',   // 9/19 已完成，仍算本周做过的事
    '操作系统实验报告',
    '提交课程论文选题',
    '预约游泳池',
    '复现 Transformer 基线',   // 9/18
    '高等数学期中复习',        // 9/17
    '报销实验器材',            // 9/15
    '图书馆还书',              // 9/16 已完成
  ], '本周＝本周一到周日 + 本周之前没做完的；分段保持表序，日期排序发生在分组那一步');
  assert.ok(!week.includes('和导师组会汇报'), '下周的条目不该出现在本周');
});

test('S5 已完成分段只列完成项，全部分段一条不少', () => {
  assert.deepEqual(titles(T.segmentTasks(TASKS, 'done', TODAY)), ['数据结构：第 4 章习题', '图书馆还书']);
  assert.equal(T.segmentTasks(TASKS, 'all', TODAY).length, TASKS.length);
  assert.deepEqual(T.segmentCounts(TASKS, TODAY), { today: 6, week: 8, all: 10, done: 2 });
});

// ── 筛选与组内次序 ─────────────────────────────────────────

test('S5 分类筛选与状态筛选取交集，组合结果与逐条判定一致', () => {
  const scoped = T.segmentTasks(TASKS, 'all', TODAY);
  assert.deepEqual(titles(T.filterTasks(scoped, { category: '科研' })), [
    '提交课程论文选题', '复现 Transformer 基线', '和导师组会汇报',
  ]);
  assert.deepEqual(titles(T.filterTasks(scoped, { category: '科研', status: 'overdue' })), ['复现 Transformer 基线']);
  assert.deepEqual(titles(T.filterTasks(scoped, { category: '科研', status: 'done' })), []);
  // filterTasks 只负责"留下谁"，顺序交给分组与组内排序，所以这里按表序断言
  assert.deepEqual(titles(T.filterTasks(scoped, { status: 'overdue' })), [
    '复现 Transformer 基线', '高等数学期中复习', '报销实验器材',
  ]);
  assert.deepEqual(titles(T.filterTasks(scoped, { status: 'open' })).length, 8);
  // 「不限」必须是恒等映射，否则清除筛选按钮会漏掉条目
  assert.deepEqual(titles(T.filterTasks(scoped, { category: 'all', status: 'all' })), titles(scoped));
});

test('S5 组内未完成在前、已完成沉底，逾期项按天数标注', () => {
  const group = [
    { title: '晚交', due_date: '2026-09-20', due_time: '23:00', done: false },
    { title: '已完成二', due_date: '2026-09-20', done: true, done_at: '2026-09-20T02:00:00.000Z' },
    { title: '早交', due_date: '2026-09-20', due_time: '08:00', done: false },
    { title: '已完成一', due_date: '2026-09-20', done: true, done_at: '2026-09-20T01:00:00.000Z' },
  ];
  assert.deepEqual(titles(T.orderGroupRows(group)), ['早交', '晚交', '已完成二', '已完成一'], '完成的要沉底并按完成时间倒序');
  assert.equal(T.overdueDays({ due_date: '2026-09-19', done: false }, TODAY), 1);
  assert.equal(T.overdueDays({ due_date: '2026-09-15', done: false }, TODAY), 5);
  assert.equal(T.overdueDays({ due_date: '2026-09-15', done: true }, TODAY), null, '已完成不再算逾期');
  assert.equal(T.overdueDays({ due_date: TODAY, done: false }, TODAY), null, '今天到期不算逾期');
});

test('S5 顺延给出今天/明天/下周三个确定日期，点完就脱离逾期判定', () => {
  assert.deepEqual(T.postponeTargets(TODAY), [
    { key: 'today', label: '顺延到今天', date: '2026-09-20' },
    { key: 'tomorrow', label: '顺延到明天', date: '2026-09-21' },
    { key: 'next_week', label: '顺延到下周', date: '2026-09-27' },
  ]);
  const overdue = byTitle('报销实验器材');
  assert.ok(titles(T.segmentTasks(TASKS, 'today', TODAY)).includes(overdue.title));
  const moved = { ...overdue, due_date: '2026-09-27' };
  assert.equal(T.overdueDays(moved, TODAY), null);
  assert.ok(!titles(T.segmentTasks([...TASKS.map((row) => (row.id === moved.id ? moved : row))], 'today', TODAY))
    .includes('报销实验器材'), '顺延后仍留在今日分段');
});

// ── 快速添加的弱解析（DEV_PLAN S5：只认三种写法）──────────────

test('S5 快速添加：日期、时间、时长各自识别，剩余部分才是标题', () => {
  assert.deepEqual(T.parseQuickAdd('数据结构作业 9月25日 20:00 45分钟', TODAY), {
    title: '数据结构作业', due_date: '2026-09-25', due_time: '20:00', duration_min: 45, found: ['9月25日', '20:00', '45分钟'],
  });
  assert.deepEqual(T.parseQuickAdd('交表 8:30 10分钟', TODAY), {
    title: '交表', due_date: null, due_time: '08:30', duration_min: 10, found: ['08:30', '10分钟'],
  });
  assert.deepEqual(T.parseQuickAdd('9月30号 组会', TODAY).due_date, '2026-09-30', '「号」也要认');
});

test('S5 快速添加认不出的写法一律留空，绝不猜日期', () => {
  const plain = T.parseQuickAdd('明晚把课件发群里', TODAY);
  assert.deepEqual(plain, { title: '明晚把课件发群里', due_date: null, due_time: null, duration_min: null, found: [] });
  // 2 月 30 日不存在：不解析，原文留在标题里由用户自己改
  assert.deepEqual(T.parseQuickAdd('聚餐 2月30日', TODAY).due_date, null);
  assert.equal(T.parseQuickAdd('聚餐 2月30日', TODAY).title, '聚餐 2月30日');
  assert.equal(T.parseQuickAdd('喝水 25:00', TODAY).due_time, null);
  assert.equal(T.parseQuickAdd('喝水 13:60', TODAY).due_time, null);
  assert.equal(T.parseQuickAdd('长跑 9999分钟', TODAY).duration_min, null, '超出库里 0–1440 的时长不能写进去');
  assert.equal(T.parseQuickAdd('   ', TODAY).title, '');
});

test('S5 只写了日期的那条不会变成空标题；今年已过这个日子按明年理解', () => {
  assert.deepEqual(T.parseQuickAdd('9月25日', TODAY), {
    title: '9月25日', due_date: '2026-09-25', due_time: null, duration_min: null, found: ['9月25日'],
  });
  const rolled = T.parseQuickAdd('器材续借 1月5日', TODAY);
  assert.equal(rolled.due_date, '2027-01-05');
  assert.deepEqual(rolled.found, ['2027年1月5日'], '跨年时读数要写明年份，否则用户以为记错了');
});

test('S5 快速添加的产物直接满足 Function 的字段校验', () => {
  const parsed = T.parseQuickAdd('组会材料 9月25日 20:00 30分钟', TODAY);
  const row = {
    title: parsed.title,
    done: false,
    due_date: parsed.due_date ?? TODAY,
    due_time: parsed.due_time,
    duration_min: parsed.duration_min,
  };
  const result = validateRow('tasks', row, { allowServer: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(row, { title: '组会材料', done: false, due_date: '2026-09-25', due_time: '20:00', duration_min: 30 });
  // 未识别的字段是 null：Function 视为清空，不会写出空字符串
  const bare = validateRow('tasks', { title: '还书', done: false, due_date: TODAY, due_time: null, duration_min: null }, { allowServer: true });
  assert.equal(bare.ok, true, JSON.stringify(bare));
});
