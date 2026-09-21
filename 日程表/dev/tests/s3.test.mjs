// S3 完成标准对应的自动化部分：
// 1) 数据客户端与真实契约打通（api.js 错误映射 / 结果未知判定）
// 2) store 的乐观更新、失败回滚、延后删除与撤销、偏好白名单、回读时机
// 3) time.js 是全站唯一统计口径（周次、逾期、连续天数、健身聚合）
// 4) seed 与 registry 校验一致；preview-server 端到端可用
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TABLE_NAMES, TABLES, validateRow } from '../../functions/registry.mjs';
import { handleApp } from '../../functions/handler.mjs';
import { createFakeSupabase } from '../fake-supabase.mjs';
import { buildSeed } from '../seed.mjs';
import { createPreviewServer } from '../preview-server.mjs';
import { read, assertModuleParses } from './helpers.mjs';
import * as T from '../../web/lib/time.js';
import { ApiError, MESSAGES, requestJson, isWriteOutcomeUnknown, createApi } from '../../web/lib/api.js';
import { createStore, PREF_KEYS } from '../../web/lib/store.js';

const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CFG = { start_date: '2026-09-07', total_weeks: 18 };

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
const uuid = () => crypto.randomUUID();

// ── 契约单一来源 ────────────────────────────────────────────

test('S3 前端 registry 是 functions/registry.mjs 的逐字节副本，不允许两份字段定义', async () => {
  const server = readFileSync(`${PROJECT}functions/registry.mjs`);
  const client = readFileSync(`${PROJECT}web/lib/registry.mjs`);
  assert.equal(client.equals(server), true, 'web/lib/registry.mjs 与 functions/registry.mjs 已漂移，请重新整体复制');
});

test('S3 前端模块都能编译，且导入应用外壳不需要 DOM（顶层不碰 document）', async () => {
  for (const file of [
    'web/lib/time.js', 'web/lib/api.js', 'web/lib/store.js', 'web/lib/ui.js', 'web/lib/registry.mjs',
    'web/lib/charts.js',
    'web/app.js', 'web/views/home.js', 'web/views/timetable.js', 'web/views/tasks.js',
    'web/views/research.js', 'web/views/workout.js', 'web/views/settings.js',
  ]) await assertModuleParses(`${PROJECT}${file}`);

  const app = await import('../../web/app.js');
  assert.equal(typeof app.start, 'function');
  assert.equal(typeof app.store.create, 'function');
  assert.equal(app.store.state.status, 'idle');
  assert.deepEqual(Object.keys(app.store.state.tables).sort(), [...TABLE_NAMES].sort());
});

// ── time.js：唯一统计口径 ──────────────────────────────────

test('S3 学期周次按 PRD 6 的公式推导，学期外为 null', () => {
  assert.equal(T.weekOf('2026-09-07', CFG), 1);
  assert.equal(T.weekOf('2026-09-13', CFG), 1);
  assert.equal(T.weekOf('2026-09-14', CFG), 2);
  assert.equal(T.weekOf('2026-09-06', CFG), null, '学期起始日之前没有周次');
  assert.equal(T.weekOf('2027-01-10', CFG), 18);
  assert.equal(T.weekOf('2027-01-11', CFG), null);
  assert.equal(T.weekOf('2026-09-20', null), null);
  assert.equal(T.parityOfWeek(1), 'odd');
  assert.equal(T.parityOfWeek(2), 'even');
  assert.deepEqual(T.weekRange(3, CFG), { start: '2026-09-21', end: '2026-09-27', week: 3 });
});

test('S3 课程是否上课由周次奇偶与起止周共同决定', () => {
  const course = { week_type: 'odd', start_week: 3, end_week: 9 };
  assert.equal(T.courseActiveOnWeek(course, 1), false, '早于起始周');
  assert.equal(T.courseActiveOnWeek(course, 3), true);
  assert.equal(T.courseActiveOnWeek(course, 4), false, '单周课在双周不上');
  assert.equal(T.courseActiveOnWeek(course, 11), false, '晚于结束周');
  assert.equal(T.courseActiveOnWeek({ week_type: 'all', start_week: 1, end_week: 18 }, 12), true);
  assert.equal(T.courseActiveOnWeek({ week_type: 'even', start_week: 2, end_week: 16 }, 16), true);
  assert.equal(T.courseActiveOnWeek({ week_type: 'even', start_week: 2, end_week: 16 }, 15), false);
  assert.equal(T.courseActiveOnWeek({ week_type: 'even', start_week: 2, end_week: 16 }, 1), false, '早于起始周');
  assert.equal(T.courseActiveOnWeek({ week_type: 'all', start_week: 1, end_week: 18 }, NaN), false);
});

test('S3 本周区间：学期内从今天截断，学期外退回自然周', () => {
  const inTerm = T.currentWeekRange(CFG, '2026-09-20');
  assert.equal(inTerm.week, 2);
  assert.equal(inTerm.start, '2026-09-14');
  assert.equal(inTerm.end, '2026-09-20', '本周健身统计只算到今天');
  const before = T.currentWeekRange(CFG, '2026-08-05');
  assert.equal(before.week, null);
  assert.equal(before.inTerm, false);
  assert.equal(before.start, '2026-08-03', '假期内仍按自然周统计');
  assert.equal(before.end, '2026-08-05');
});

test('S3 日期工具覆盖跨月、闰年与星期编号', () => {
  assert.equal(T.dayOfWeek('2026-09-07'), 1);
  assert.equal(T.dayOfWeek('2026-09-20'), 7);
  assert.equal(T.dayOfWeek('2026-09-06'), 7, '学期起始日前一天是上一周的周日');
  assert.equal(T.dayOfWeek('2026-09-05'), 6);
  assert.equal(T.addDays('2026-09-30', 1), '2026-10-01');
  assert.equal(T.addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(T.addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(T.mondayOf('2026-09-20'), '2026-09-14');
  assert.equal(T.diffDays('2026-09-19', '2026-09-20'), 1);
  assert.equal(T.diffDays('bad', '2026-09-20'), null);
  assert.equal(T.hhmmToMinutes('09:05'), 545);
  assert.equal(T.hhmmToMinutes('9:05'), null, '必须两位小时，否则与 registry 口径不一致');
  assert.equal(T.minutesToHhmm(1500), '23:59', '越界分钟被夹到合法区间而不是产生非法时间');
  assert.equal(T.toKey(new Date(2026, 8, 20, 23, 30)), '2026-09-20', '按本地时区取日历日');
  assert.equal(T.fmtDate('2026-09-20'), '9月20日 周日');
  assert.equal(T.fmtRemain(3 * 86400000 + 7200000), '3 天 2 小时');
  assert.equal(T.fmtRemain(45 * 60000), '45 分钟');
  assert.equal(T.fmtRemain(-1), '就在现在');
});

test('S3 今日待办 = 今天到期 + 逾期未完成，逾期优先且不含收集箱', () => {
  const tasks = [
    { id: 'a', title: '今天晚些', due_date: '2026-09-20', due_time: '20:00', done: false },
    { id: 'b', title: '逾期两天', due_date: '2026-09-18', done: false },
    { id: 'c', title: '今天早晨', due_date: '2026-09-20', due_time: '08:00', done: true },
    { id: 'd', title: '收集箱', due_date: null, done: false },
    { id: 'e', title: '早已完成', due_date: '2026-09-17', done: true },
    { id: 'f', title: '明天', due_date: '2026-09-21', done: false },
  ];
  assert.deepEqual(T.tasksForDay(tasks, '2026-09-20').map((item) => item.id), ['b', 'c', 'a']);
  assert.deepEqual(T.todayProgress(tasks, '2026-09-20'), { total: 3, done: 1, ratio: 33 });
  assert.deepEqual(T.todayProgress([], '2026-09-20'), { total: 0, done: 0, ratio: 0 });
  assert.equal(T.overdueDays(tasks[1], '2026-09-20'), 2);
  assert.equal(T.overdueDays(tasks[0], '2026-09-20'), null);
  assert.equal(T.overdueDays({ done: true, due_date: '2026-09-01' }, '2026-09-20'), null);
  assert.equal(T.isOverdue({ done: false, due_date: '2026-09-19' }, '2026-09-20'), true);
  assert.equal(T.remainingDays('2026-09-23', '2026-09-20'), 3);
  assert.equal(T.remainingDays(null, '2026-09-20'), null);
});

test('S3 下一站按最早未完成待办优先，其次最近未完成里程碑', () => {
  const tasks = [
    { id: 't1', title: '较晚', done: false, due_date: '2026-09-25', due_time: '10:00' },
    { id: 't2', title: '较早', done: false, due_date: '2026-09-22', due_time: null },
    { id: 't3', title: '已完成', done: true, due_date: '2026-09-21', due_time: '08:00' },
  ];
  const milestones = [
    { id: 'm1', title: '里程碑 A', status: 'done', target_date: '2026-09-21' },
    { id: 'm2', title: '里程碑 B', status: 'active', target_date: '2026-09-24' },
    { id: 'm3', title: '无期限', status: 'blocked', target_date: null },
  ];
  assert.deepEqual(T.nextDueItem(tasks, milestones, '2026-09-20'), {
    kind: 'task', id: 't2', title: '较早', date: '2026-09-22', time: null,
  });
  assert.equal(T.nextDueItem([], milestones, '2026-09-20').id, 'm2');
  assert.equal(T.nextDueItem([], [], '2026-09-20'), null);
  assert.deepEqual(T.recentMilestones(milestones, 3).map((item) => item.id), ['m2', 'm3']);
});

test('S3 连续天数：缺练归零、部分完成不清零、今天还没练不算断签', () => {
  const at = (offset) => T.addDays('2026-09-20', offset);
  const log = (offset, status) => ({ workout_date: at(offset), status, duration_min: 30, type: '力量' });
  const five = [log(0, 'done'), log(-1, 'done'), log(-2, 'done'), log(-3, 'partial'), log(-4, 'done')];
  assert.equal(T.streakOf(five, '2026-09-20'), 5, '部分完成不打断连续');
  assert.equal(T.streakOf(five.filter((row) => row.workout_date !== at(0)), '2026-09-20'), 4, '今天还没练从昨天往前数');
  const broken = [log(0, 'done'), log(-1, 'missed'), log(-2, 'done')];
  assert.equal(T.streakOf(broken, '2026-09-20'), 1, '缺练当天归零');
  assert.equal(T.streakOf([log(-1, 'done')], '2026-09-20'), 1);
  assert.equal(T.streakOf([], '2026-09-20'), 0);
  assert.equal(T.streakOf([log(-2, 'done')], '2026-09-20'), 0, '前天练过但昨天没记录 → 已断签');
  const multi = [log(-1, 'missed'), log(-1, 'done'), log(-2, 'done')];
  assert.equal(T.streakOf(multi, '2026-09-20'), 2, '同日多条取最强的一条');
});

test('S3 健身统计与热力格：首页和健身页用同一份算法', () => {
  const at = (offset) => T.addDays('2026-09-20', offset);
  const workouts = [
    { workout_date: at(0), type: '力量', duration_min: 45, status: 'done' },
    { workout_date: at(-1), type: '跑步', duration_min: 30, status: 'partial' },
    { workout_date: at(-2), type: '力量', duration_min: 0, status: 'missed' },
    { workout_date: at(-30), type: '游泳', duration_min: 60, status: 'done' },
  ];
  const week = T.workoutStats(workouts, T.currentWeekRange(CFG, '2026-09-20'));
  assert.equal(week.sessions, 3);
  assert.equal(week.minutes, 75);
  assert.deepEqual({ done: week.done, partial: week.partial, missed: week.missed }, { done: 1, partial: 1, missed: 1 });
  assert.equal(week.activeDays, 2, '缺练那天不算有效训练日');
  assert.deepEqual(week.byType.map((item) => [item.type, item.minutes, item.sessions]), [['力量', 45, 2], ['跑步', 30, 1]]);
  const all = T.workoutStats(workouts, { start: '2026-08-01', end: '2026-09-20' });
  assert.equal(all.sessions, 4);
  assert.equal(T.workoutStats(workouts, null).sessions, 0);

  const buckets = T.weeklyBuckets(workouts, { count: 5, today: '2026-09-20' });
  assert.equal(buckets.length, 5);
  assert.equal(buckets[0].start, '2026-08-17');
  assert.equal(buckets[0].minutes, 60);
  assert.deepEqual({ start: buckets[4].start, end: buckets[4].end, minutes: buckets[4].minutes, sessions: buckets[4].sessions },
    { start: '2026-09-14', end: '2026-09-20', minutes: 75, sessions: 2 }, '缺练的 0 分钟不计入柱高');
  assert.equal(buckets[4].label, '9/14');

  const cells = T.heatCells(workouts, { weeks: 5, today: '2026-09-20' });
  assert.equal(cells.length, 5);
  assert.equal(cells[0].weekStart, '2026-08-17');
  assert.equal(cells[4].days.length, 7);
  assert.deepEqual(cells[4].days.map((day) => [day.date, day.status]), [
    ['2026-09-14', null], ['2026-09-15', null], ['2026-09-16', null], ['2026-09-17', null],
    ['2026-09-18', 'missed'], ['2026-09-19', 'partial'], ['2026-09-20', 'done'],
  ], '热力格按周一在上排列，值取当日最强完成度');
  assert.equal(cells[4].days.every((day) => day.future === false), true);
  const nextWeek = T.heatCells(workouts, { weeks: 1, today: '2026-09-21' });
  assert.equal(nextWeek[0].days.filter((day) => day.future).length, 6, '今天之后的格子标记为未来');
  assert.equal(T.heatCells([], { weeks: 2, today: '2026-09-20' })[0].days.every((day) => day.status === null), true);
});

test('S3 课表坐标轴与分组：节次定位、同日课程并排、按日期分组', () => {
  const periods = [
    { label: '第 1 节', start: '08:00', end: '08:45', kind: 'class' },
    { label: '第 2 节', start: '08:55', end: '09:40', kind: 'class' },
    { label: '午休', start: '12:00', end: '14:00', kind: 'break' },
  ];
  assert.equal(T.periodIndexAt(periods, '08:10'), 0);
  assert.equal(T.periodIndexAt(periods, '09:40'), -1, '正好落在结束时刻不属于该节');
  assert.equal(T.periodIndexAt(periods, '13:59'), 2);
  assert.equal(T.periodIndexAt(periods, '25:00'), -1);
  assert.equal(T.periodIndexAt(null, '08:10'), -1);

  const courses = [
    { id: 'c1', name: 'A', day_of_week: 1, start_time: '08:00', end_time: '09:40', week_type: 'all', start_week: 1, end_week: 18 },
    { id: 'c2', name: 'B', day_of_week: 1, start_time: '08:55', end_time: '10:30', week_type: 'all', start_week: 1, end_week: 18 },
    { id: 'c3', name: 'C', day_of_week: 1, start_time: '14:00', end_time: '15:40', week_type: 'all', start_week: 1, end_week: 18 },
    { id: 'c4', name: 'D', day_of_week: 3, start_time: '08:00', end_time: '09:00', week_type: 'all', start_week: 1, end_week: 18 },
  ];
  const laid = T.coursesOverlapping(courses, 1, '2026-09-07');
  assert.deepEqual(laid.map((item) => [item.name, item.layout.total, item.layout.index]),
    [['A', 2, 0], ['B', 2, 1], ['C', 1, 0]]);
  const onDay = T.coursesOnDay(courses, 1, '2026-09-09');
  assert.deepEqual(onDay.map((item) => item.id), ['c4']);
  assert.equal(onDay[0].active, true);

  const groups = T.groupByDate([
    { due_date: '2026-09-21' }, { due_date: null }, { due_date: '2026-09-19' }, { due_date: '2026-09-20' },
  ], (row) => row.due_date, { descending: true });
  assert.deepEqual(groups.map((group) => group.date), ['2026-09-21', '2026-09-20', '2026-09-19', null]);
  assert.deepEqual(T.groupByDate([], (row) => row.due_date), []);
});

test('S3 进度口径：里程碑进度取整并夹在 0–100，项目进度为其平均值', () => {
  assert.equal(T.progressOf({ progress: 120 }), 100);
  assert.equal(T.progressOf({ progress: -5 }), 0);
  assert.equal(T.progressOf({ progress: null }), 0);
  assert.equal(T.projectProgress([{ progress: 25 }, { progress: 67 }, { progress: 15 }]), 36);
  assert.equal(T.projectProgress([]), null, '没有里程碑时不显示 0%');
});

// ── api.js：错误语义 ───────────────────────────────────────

test('S3 服务端错误码全部有中文文案，且带字段与可读消息', async () => {
  const fetchImpl = async () => json({ ok: false, error: 'invalid_input', field: 'title', message: '标题 最长 80 个字符' }, 400);
  await assert.rejects(requestJson('/x', {}, { fetchImpl }), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, 'invalid_input');
    assert.equal(error.field, 'title');
    assert.equal(error.message, '标题 最长 80 个字符');
    return true;
  });
  const registryCodes = ['invalid_input', 'invalid_json', 'invalid_table', 'invalid_id', 'not_found', 'too_large',
    'method_not_allowed', 'unsupported_media_type', 'table_full', 'confirm_required', 'import_partial', 'database_request_failed'];
  for (const code of registryCodes) {
    assert.ok(typeof MESSAGES[code] === 'string' && /[一-龥]/.test(MESSAGES[code]), `${code} 缺少中文文案`);
    const error = await requestJson('/x', {}, { fetchImpl: async () => json({ ok: false, error: code }, 400) })
      .then(() => null, (caught) => caught);
    assert.equal(error.code, code);
    assert.equal(error.message, MESSAGES[code], `${code} 未使用映射文案`);
  }
  const handlerSource = readFileSync(`${PROJECT}functions/handler.mjs`, 'utf8');
  const serverCodes = [...handlerSource.matchAll(/ApplicationError\('(\w+)'/g)].map((match) => match[1]);
  serverCodes.push('database_request_failed');
  for (const code of new Set(serverCodes)) {
    assert.ok(code in MESSAGES, `服务端会返回 ${code}，但前端没有对应文案`);
  }
});

test('S3 无消息或未知码时退回通用文案，绝不显示英文/异常堆栈', async () => {
  const bare = await requestJson('/x', {}, { fetchImpl: async () => json({ ok: false }, 200) }).then(() => null, (e) => e);
  assert.equal(bare.code, 'request_failed');
  assert.equal(bare.message, MESSAGES.request_failed);
  const long = await requestJson('/x', {}, {
    fetchImpl: async () => json({ ok: false, error: 'invalid_input', message: 'x'.repeat(500) }, 400),
  }).then(() => null, (e) => e);
  assert.equal(long.message, MESSAGES.invalid_input, '超长服务端文本不参与渲染');
});

test('S3 401/403、非 JSON、重定向与断网分别映射成可判定结果', async () => {
  const cases = [
    [async () => new Response('', { status: 401 }), 'access_denied'],
    [async () => new Response('', { status: 403 }), 'access_denied'],
    [async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'invalid_response'],
    // 重定向只能来自真实 fetch：这里给出同形状的响应对象，验证前端不把 HTML 跳转当数据
    [async () => ({
      status: 200, ok: true, redirected: true,
      headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ ok: true }),
    }), 'invalid_response'],
    [async () => new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }), 'invalid_response'],
    [async () => { throw new TypeError('Failed to fetch'); }, 'network_error'],
  ];
  for (const [fetchImpl, code] of cases) {
    const error = await requestJson('/x', {}, { fetchImpl }).then(() => null, (caught) => caught);
    assert.equal(error?.code, code, `${code} 判定错误`);
    assert.equal(/[一-龥]/.test(error.message), true, `${code} 需要中文文案`);
  }
});

test('S3 写结果未知只发生在网络/响应/数据服务不可用时，且不自动重放', () => {
  const make = (code) => new ApiError('m', code);
  assert.equal(isWriteOutcomeUnknown(make('network_error'), 'create'), true);
  assert.equal(isWriteOutcomeUnknown(make('invalid_response'), 'update'), true);
  assert.equal(isWriteOutcomeUnknown(make('database_request_failed'), 'remove'), true);
  assert.equal(isWriteOutcomeUnknown(make('write_result_unknown'), 'import'), true);
  assert.equal(isWriteOutcomeUnknown(make('not_found'), 'create'), false, '明确失败可以提示重试');
  assert.equal(isWriteOutcomeUnknown(make('invalid_input'), 'create'), false);
  assert.equal(isWriteOutcomeUnknown(make('network_error'), 'bootstrap'), false, '读请求无所谓重放');
  assert.equal(isWriteOutcomeUnknown(new Error('boom'), 'create'), false);
});

test('S3 请求出口：GET 不带请求体，写请求固定 POST + JSON，URL 只指向同源 Function', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), method: init.method ?? 'GET', body: init.body, type: init.headers?.get?.('content-type') ?? null });
    return json({ ok: true, row: { id: uuid() }, data: { tables: Object.fromEntries(TABLE_NAMES.map((name) => [name, []])), config: null, limits: {} }, counts: {}, deleted: {}, serverTime: new Date().toISOString() });
  };
  const api = createApi({ baseUrl: '/functions/v1/app', fetchImpl });
  await api.bootstrap();
  await api.create('tasks', { title: 'x', done: false });
  await api.update('tasks', 'id-1', { done: true });
  await api.remove('tasks', 'id-1');
  await api.importSnapshot({ tasks: [] });
  await api.wipe();
  assert.deepEqual(seen.map((item) => item.url.split('?action=')[1]),
    ['bootstrap', 'create', 'update', 'remove', 'import', 'wipe']);
  assert.deepEqual(seen.map((item) => item.method), ['GET', 'POST', 'POST', 'POST', 'POST', 'POST']);
  assert.equal(seen[0].body, undefined, 'GET 不得携带请求体');
  for (const item of seen.slice(1)) {
    assert.equal(item.type, 'application/json');
    assert.doesNotThrow(() => JSON.parse(item.body));
  }
  assert.equal(JSON.parse(seen[2].body).id, 'id-1');
  assert.equal(JSON.parse(seen[5].body).confirm, 'DELETE_ALL', '清空必须由前端明确确认');
  assert.equal(seen.every((item) => !/supabase|postgres|token/i.test(item.url)), true);
});

test('S3 bootstrap 结构不完整时报错而不是渲染空白页', async () => {
  const bad = [
    { ok: true, data: {} },
    { ok: true, data: { tables: { courses: [] } } },
    { ok: true, data: { tables: Object.fromEntries(TABLE_NAMES.map((name) => [name, name === 'tasks' ? {} : []])) } },
  ];
  for (const payload of bad) {
    const api = createApi({ fetchImpl: async () => json(payload) });
    const error = await api.bootstrap().then(() => null, (caught) => caught);
    assert.equal(error?.code, 'invalid_response', `${JSON.stringify(payload)} 本该被拒绝`);
  }
  const api = createApi({ fetchImpl: async () => json({
    ok: true, data: { tables: Object.fromEntries(TABLE_NAMES.map((name) => [name, []])), config: null, limits: {} },
    serverTime: '2026-09-20T00:00:00.000Z',
  }) });
  const result = await api.bootstrap();
  assert.equal(result.data.tables.tasks.length, 0);
});

// ── store.js：乐观更新、回滚与延后删除 ─────────────────────

const baseTables = () => ({
  semester_config: [{ id: uuid(), start_date: '2026-09-07', total_weeks: 18, periods: [], updated_at: '2026-09-01T00:00:00.000Z' }],
  courses: [],
  tasks: [
    { id: uuid(), title: '旧的', done: false, due_date: '2026-09-20', due_time: null, duration_min: null, category: null, note: null, done_at: null },
  ],
  research_projects: [{ id: uuid(), name: '项目', description: null, status: 'active', sort: 0 }],
  milestones: [],
  subtasks: [],
  workouts: [],
});

function stubStore({ overrides = {}, prefs, events } = {}) {
  const tables = baseTables();
  const calls = [];
  const timers = { pending: new Map(), next: 0, fired: [] };
  // 桩时钟可以由用例推着走，这样"时间戳有没有刷新"才是可断言的
  const clock = { now: new Date('2026-09-20T08:00:00.000Z') };
  const api = {
    async bootstrap() { calls.push('bootstrap'); return { ok: true, serverTime: '2026-09-20T00:00:00.000Z', data: { tables, config: tables.semester_config[0], limits: { tasks: 5000 } } }; },
    async create(table, row) { calls.push(`create:${table}`); const record = { ...row, id: uuid(), created_at: '2026-09-20T00:00:00.000Z', updated_at: '2026-09-20T00:00:00.000Z' }; tables[table] = [...tables[table], record]; return { ok: true, row: record }; },
    async update(table, id, patch) {
      calls.push(`update:${table}`);
      const record = tables[table].find((item) => item.id === id);
      if (!record) throw new ApiError('这条记录已不存在', 'not_found');
      const merged = { ...record, ...patch };
      return { ok: true, row: merged };
    },
    async remove(table, id) { calls.push(`remove:${table}`); tables[table] = tables[table].filter((item) => item.id !== id); return { ok: true, id }; },
    async importSnapshot() { calls.push('import'); return { ok: true, counts: {} }; },
    async wipe() { calls.push('wipe'); for (const name of TABLE_NAMES) tables[name] = []; return { ok: true, deleted: {} }; },
    ...overrides,
  };
  const store = createStore({
    api,
    prefs,
    events,
    undoMs: 5000,
    now: () => clock.now,
    timer: {
      set: (fn, ms) => { const handle = ++timers.next; timers.pending.set(handle, { fn, ms }); return handle; },
      clear: (handle) => { timers.pending.delete(handle); },
    },
  });
  const fire = async (handle) => {
    const entry = timers.pending.get(handle);
    timers.pending.delete(handle);
    timers.fired.push({ handle, ms: entry.ms });
    await entry.fn();
    await tick();
  };
  return { store, api, tables, calls, timers, fire, clock };
}

test('S3 load 建立快照，读写都经过同一份内存表', async () => {
  const { store, calls } = stubStore();
  const seen = [];
  store.subscribe((state) => seen.push(state.status));
  const result = await store.load();
  assert.equal(result.status, 'ready');
  assert.equal(store.table('tasks').length, 1);
  assert.equal(store.row('tasks', store.table('tasks')[0].id).title, '旧的');
  assert.equal(store.state.config.total_weeks, 18);
  assert.equal(store.state.limits.tasks, 5000);
  assert.equal(store.state.serverTime, '2026-09-20T00:00:00.000Z');
  assert.equal(store.row('tasks', 'missing-id'), null);
  assert.equal(store.table('nope').length, 0);
  await store.load();
  assert.deepEqual(calls, ['bootstrap', 'bootstrap']);
  // 并发只发一次请求
  const before = calls.length;
  await Promise.all([store.refresh(), store.refresh()]);
  assert.equal(calls.length, before + 1, '并发回读被合并成一次');
  assert.ok(seen.includes('loading') && seen.every((status) => ['idle', 'loading', 'ready'].includes(status)));
});

test('S3 加载失败进入错误态并可重试，不显示空数据', async () => {
  const { store } = stubStore({ overrides: {
    bootstrap: async () => { throw new ApiError('数据服务暂时不可用，请稍后重试', 'database_request_failed'); },
  } });
  const state = await store.load();
  assert.equal(state.status, 'error');
  assert.equal(state.error.code, 'database_request_failed');
  assert.equal(state.error.retry, true);
  assert.match(state.error.message, /稍后重试/);
});

test('S3 首屏的静默回读失败也要落到错误态，绝不停在骨架屏', async () => {
  // 骨架屏阶段就切到后台再切回来（visibilitychange → refresh()）走的是这条路
  const { store, api } = stubStore();
  const online = api.bootstrap;
  api.bootstrap = async () => { throw new ApiError('网络连接中断', 'network_error'); };
  const state = await store.refresh();
  assert.equal(state.status, 'error', `静默回读失败后停在 ${state.status}，界面就是一张永远转不完的骨架屏`);
  assert.equal(state.error.retry, true, '错误态必须带可重试标记，外壳才知道要不要挂重试按钮');
  // 重试路径确实能走通
  api.bootstrap = online;
  const retried = await store.load();
  assert.equal(retried.status, 'ready');
  assert.equal(retried.error, null);
});

test('S3 已有数据时回读失败：继续用旧数据并标成陈旧，既不闪骨架屏也不静默假装最新', async () => {
  for (const silent of [true, false]) {
    const { store, api, clock } = stubStore();
    const online = api.bootstrap;
    const loaded = await store.load();
    const before = loaded.loadedAt;
    assert.equal(store.table('tasks').length, 1);
    api.bootstrap = async () => { throw new ApiError('网络连接中断', 'network_error'); };
    const state = silent ? await store.refresh() : await store.load();
    assert.equal(state.status, 'ready', `silent=${silent}：有缓存可读时不该把界面打回${state.status}`);
    assert.equal(store.table('tasks').length, 1, '旧数据要留在屏幕上，不能清空成空白页');
    assert.equal(state.loadedAt, before, '这一轮没同步上，时间戳不能假装往前走');
    assert.equal(state.error?.stale, true, `silent=${silent}：必须留下"这次没同步上"的标记，否则用户以为看到的是最新的`);
    assert.equal(state.error.retry, true);
    assert.equal(state.error.code, 'network_error');
    // 下一次成功回读要把它清掉
    clock.now = new Date('2026-09-20T08:05:00.000Z');
    api.bootstrap = online;
    const recovered = await store.refresh();
    assert.equal(recovered.error, null, '同步恢复后陈旧标记还挂着');
    assert.equal(recovered.loadedAt, '2026-09-20T08:05:00.000Z', '成功回读要把时间戳推到这一轮');
  }
});

test('S3 新建立即出现在列表里，落库后换成服务端行并回读', async () => {
  const { store, calls } = stubStore();
  await store.load();
  let created = null;
  const promise = store.create('tasks', { title: '新任务', done: false, due_date: '2026-09-21' })
    .then((row) => { created = row; });
  const optimistic = store.table('tasks').find((item) => item.title === '新任务');
  assert.ok(optimistic, '请求发出前就该看到新行');
  assert.match(optimistic.id, /^tmp_/, '临时 ID 必须与服务端 ID 区分');
  assert.equal(optimistic.created_at, '2026-09-20T08:00:00.000Z');
  await promise;
  assert.match(created.id, UUID_RE, '以服务端返回的行为准');
  assert.notEqual(created.id, optimistic.id);
  assert.equal(store.table('tasks').filter((item) => item.title === '新任务').length, 1);
  assert.equal(store.table('tasks').some((item) => item.id.startsWith('tmp_')), false, '临时行必须被替换掉');
  assert.ok(calls.filter((name) => name === 'bootstrap').length >= 2, '写后回读，以服务端为准');
  assert.equal(store.state.writeError, null);
  assert.equal(store.state.inflight, 0);
});

test('S3 写失败回滚到原值，并给出字段级可重试错误', async () => {
  const task = { id: uuid(), title: '实验报告', done: false, due_date: '2026-09-20' };
  const failure = new ApiError('截止日期 需为 YYYY-MM-DD', 'invalid_input', { field: 'due_date' });
  const { store } = stubStore({ overrides: {
    bootstrap: async () => ({ ok: true, serverTime: '', data: { tables: { ...baseTables(), tasks: [task] }, config: null, limits: {} } }),
    update: async () => { throw failure; },
  } });
  await store.load();
  await assert.rejects(store.update('tasks', task.id, { done: true, due_date: 'bad' }), (error) => error === failure);
  const current = store.row('tasks', task.id);
  assert.deepEqual(current, task, '界面回到原值');
  assert.equal(store.state.writeError.code, 'invalid_input');
  assert.equal(store.state.writeError.field, 'due_date');
  assert.equal(store.state.writeError.unknown, false);
  store.clearWriteError();
  assert.equal(store.state.writeError, null);
});

test('S3 网络中断下的写入标记为结果未知，提示刷新而不是自动重放', async () => {
  const task = { id: uuid(), title: '组会', done: false, due_date: '2026-09-20' };
  const { store } = stubStore({ overrides: {
    bootstrap: async () => ({ ok: true, serverTime: '', data: { tables: { ...baseTables(), tasks: [task] }, config: null, limits: {} } }),
    update: async () => { throw new ApiError('网络连接中断', 'network_error'); },
  } });
  await store.load();
  await assert.rejects(store.update('tasks', task.id, { done: true }));
  assert.equal(store.state.writeError.unknown, true);
  assert.match(store.state.writeError.message, /网络/);
  assert.deepEqual(store.row('tasks', task.id), task);
});

test('S3 更新一条已被其他设备删除的记录：提示已不存在，本地不再留下幽灵行', async () => {
  const { store } = stubStore();
  await store.load();
  const id = uuid();
  await assert.rejects(store.update('tasks', id, { done: true }), (error) => {
    assert.equal(error.code, 'not_found');
    return true;
  });
  assert.equal(store.row('tasks', id), null);
});

test('S3 临时 ID 不允许直接更新，避免把 tmp_ 发给服务端', async () => {
  const { store, calls } = stubStore();
  await store.load();
  const pending = store.create('tasks', { title: '并发', done: false });
  const tempId = store.table('tasks').find((item) => item.id.startsWith('tmp_')).id;
  await assert.rejects(store.update('tasks', tempId, { done: true }), /临时记录/);
  assert.equal(calls.includes('update:tasks'), false);
  await pending;
  await tick();
});

test('S3 删除在 5 秒撤销窗口内不写服务端，撤销后原 ID 与级联子孙都回来', async () => {
  const tables = baseTables();
  const project = tables.research_projects[0];
  const milestone = { id: uuid(), project_id: project.id, title: '里程碑', status: 'active', progress: 50, manual_progress: false, sort: 0 };
  const subtask = { id: uuid(), milestone_id: milestone.id, title: '子任务', done: false, sort: 0 };
  tables.milestones.push(milestone);
  tables.subtasks.push(subtask);
  const { store, calls, timers, fire } = stubStore({ overrides: {
    bootstrap: async () => ({ ok: true, serverTime: '', data: { tables, config: tables.semester_config[0], limits: {} } }),
  } });
  await store.load();
  const { token, entry } = store.remove('research_projects', project.id, {
    related: { milestones: [milestone], subtasks: [subtask] },
  });
  assert.equal(store.row('research_projects', project.id), null);
  assert.equal(store.row('milestones', milestone.id), null);
  assert.equal(store.row('subtasks', subtask.id), null);
  assert.equal(calls.includes('remove:research_projects'), false, '撤销窗口内不得写服务端');
  assert.equal(store.hasPendingRemove(token), true);
  assert.deepEqual(timers.fired, []);
  assert.equal(timers.pending.size, 1);

  await store.refresh();
  assert.equal(store.row('research_projects', project.id), null, '回读期间仍然保持隐藏');

  assert.equal(store.undoRemove(token), true);
  assert.deepEqual(timers.pending.size, 0, '撤销要取消已排定的删除');
  assert.equal(store.row('research_projects', project.id).id, project.id);
  assert.equal(store.row('milestones', milestone.id).id, milestone.id);
  assert.equal(store.row('subtasks', subtask.id).id, subtask.id);
  assert.equal(store.undoRemove(token), false, '同一令牌不能撤销两次');
  assert.equal(calls.includes('remove:research_projects'), false);
  assert.equal(entry.error, null);

  const again = store.remove('tasks', tables.tasks[0].id);
  await fire(again.entry.handle);
  assert.equal(calls.filter((name) => name === 'remove:tasks').length, 1);
  assert.equal(store.hasPendingRemove(again.token), false);
  await tick();
  assert.equal(store.state.inflight, 0);
});

test('S3 窗口结束后才发删除请求；请求失败时行重新出现并提示，不留下未处理拒绝', async () => {
  const { store, calls, fire } = stubStore();
  await store.load();
  const task = store.table('tasks')[0];
  const first = store.remove('tasks', task.id);
  await fire(first.entry.handle);
  assert.equal(calls.filter((name) => name === 'remove:tasks').length, 1);
  assert.equal(first.entry.error, null);
  await store.refresh();
  assert.equal(store.row('tasks', task.id), null, '删除已落库，回读后不再出现');

  const failing = stubStore({ overrides: {
    remove: async () => { throw new ApiError('数据服务暂时不可用', 'database_request_failed'); },
  } });
  await failing.store.load();
  const created = await failing.store.create('tasks', { title: '删不掉', done: false });
  const second = failing.store.remove('tasks', created.id);
  await failing.fire(second.entry.handle);
  assert.ok(failing.store.row('tasks', created.id), '删除未生效时行要回到列表里');
  assert.equal(failing.store.state.writeError.code, 'database_request_failed');
  assert.equal(failing.store.state.writeError.unknown, true);
  assert.equal(second.entry.error.code, 'database_request_failed');
  assert.equal(failing.store.state.inflight, 0);
});

// ── 偏好与刷新时机 ─────────────────────────────────────────

test('S3 本地只允许三项 UI 偏好，业务数据不落本地', async () => {
  const saved = new Map();
  const prefs = { get: (key) => saved.get(key), set: (key, value) => saved.set(key, value) };
  const { store } = stubStore({ prefs });
  assert.deepEqual(PREF_KEYS, ['ui.rail', 'ui.timetableView', 'ui.homeCardOrder']);
  assert.equal(store.pref('ui.rail', false), false);
  store.setPref('ui.rail', true);
  store.setPref('ui.timetableView', 'grid');
  store.setPref('ui.homeCardOrder', ['courses', 'tasks', 'milestones', 'workouts']);
  assert.deepEqual([...saved.keys()], PREF_KEYS, 'localStorage 键集合越界');
  assert.equal(store.pref('ui.rail', false), true);
  assert.deepEqual(store.pref('ui.homeCardOrder', []), ['courses', 'tasks', 'milestones', 'workouts']);
  assert.equal(store.pref('ui.timetableView', 'list'), 'grid');
  for (const key of ['tasks', 'semester_config', 'ui.token', 'supabase.url']) {
    assert.throws(() => store.pref(key, null), /不允许的本地偏好键/);
    assert.throws(() => store.setPref(key, 1), /不允许的本地偏好键/);
  }
});

test('S3 浏览器禁用本地存储时偏好退回默认值，功能不崩', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true, writable: true });
  try {
    const { store } = stubStore();
    assert.equal(store.pref('ui.rail', false), false);
    store.setPref('ui.timetableView', 'grid');
    assert.equal(store.pref('ui.timetableView', 'list'), 'list', '存不下就用默认值，不抛错');
    assert.equal(store.state.status, 'idle');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});

test('S3 切回前台即回读服务端（手机与电脑看到同一份数据）', async () => {
  const handlers = new Map();
  const doc = {
    visibilityState: 'hidden',
    addEventListener: (name, fn) => handlers.set(name, fn),
  };
  const { store, calls } = stubStore({ events: { document: doc } });
  await store.load();
  assert.equal(handlers.has('visibilitychange'), true);
  const before = calls.length;
  doc.visibilityState = 'visible';
  handlers.get('visibilitychange')();
  await tick();
  assert.equal(calls.length, before + 1, '前台回读');
  doc.visibilityState = 'hidden';
  handlers.get('visibilitychange')();
  await tick();
  assert.equal(calls.length, before + 1, '切到后台不回读');
});

test('S3 导入与清空以服务端为准重建内存表', async () => {
  const { store, calls } = stubStore();
  await store.load();
  await store.importSnapshot({ tasks: [] });
  assert.ok(calls.includes('import') && calls.filter((name) => name === 'bootstrap').length >= 2);
  await store.wipeAll();
  assert.equal(store.table('tasks').length, 0);
  assert.equal(store.state.config, null, '学期配置也被清空');
  assert.ok(calls.includes('wipe'));
});

test('S3 清空与导入完成后「最近同步」要跟着走：这行说的是云端现在的样子', async () => {
  // 各用例自己的库：预览服务器那份 db 是模块级的，清空会连累同文件其他用例
  const db = createFakeSupabase(buildSeed(new Date('2026-09-20T12:00:00')));
  const api = createApi({
    baseUrl: 'http://localhost/functions/v1/app',
    fetchImpl: (input, options) => handleApp({ request: new Request(input, options), supabase: db }),
  });
  const clock = { now: new Date('2026-09-20T08:00:00.000Z') };
  const store = createStore({ api, now: () => clock.now, timer: { set: () => 0, clear: () => {} } });
  await store.load();
  assert.equal(store.state.loadedAt, '2026-09-20T08:00:00.000Z');
  const backup = structuredClone(store.state.tables);
  assert.ok(backup.courses.length > 0 && backup.semester_config.length > 0, 'seed 要够，否则清空前后比不出差别');

  clock.now = new Date('2026-09-20T08:01:00.000Z');
  await store.wipeAll();
  assert.equal(store.table('courses').length, 0);
  assert.equal(store.state.config, null);
  assert.equal(store.state.loadedAt, '2026-09-20T08:01:00.000Z',
    '清空完成后这行还停在清空之前，用户读到的是"我刚才那一下没生效"');

  clock.now = new Date('2026-09-20T08:02:00.000Z');
  await store.importSnapshot(backup);
  assert.equal(store.table('courses').length, backup.courses.length, '导入以后课程数要回到导入前');
  assert.equal(store.state.config?.total_weeks, 18, '学期基准跟着备份一起回来');
  assert.equal(store.state.loadedAt, '2026-09-20T08:02:00.000Z');
});

test('S3 导入不能被上一次在飞的回读糊回旧数据：那次回读拿到的是导入前的云端', async () => {
  const { store, api, tables } = stubStore();
  await store.load();
  const imported = {
    ...Object.fromEntries(TABLE_NAMES.map((name) => [name, []])),
    tasks: [{ id: uuid(), title: '导入的', due_date: '2026-09-21', due_time: null, done: false, category: '作业', duration_min: 30, note: null, created_at: '2026-09-20T00:00:00.000Z', updated_at: '2026-09-20T00:00:00.000Z' }],
    semester_config: tables.semester_config,
  };
  // 上一次写入留下的静默回读还在路上：真实服务端会返回"请求发出那一刻"的快照
  const online = api.bootstrap;
  let reads = 0;
  api.bootstrap = async () => {
    reads += 1;
    const atRequest = structuredClone(tables);
    if (reads === 1) await new Promise((resolve) => setTimeout(resolve, 30));
    const result = await online();
    return {
      ...result,
      data: { tables: atRequest, config: atRequest.semester_config[0] ?? null, limits: result.data.limits },
    };
  };
  api.importSnapshot = async (next) => {
    for (const name of TABLE_NAMES) tables[name] = structuredClone(next[name] ?? []);
    return { ok: true, counts: {} };
  };

  const inflight = store.refresh();
  await tick();
  await store.importSnapshot(imported);
  await inflight;
  assert.equal(store.table('tasks').length, 1);
  assert.equal(store.table('tasks')[0].title, '导入的',
    '导入结果被导入前的那份回读覆盖掉了：跟着在飞的请求走会拿到写之前的云端');
});

// ── seed 与预览服务器 ──────────────────────────────────────

test('S3 seed 的每一行都能通过服务端校验（字段与取值同一来源）', () => {
  const seed = buildSeed(new Date('2026-09-20T12:00:00'));
  const seenIds = new Set();
  for (const table of TABLE_NAMES) {
    const rows = seed[table];
    assert.ok(Array.isArray(rows) && rows.length > 0, `${table} 缺少演示数据`);
    assert.deepEqual(Object.keys(rows[0]), Object.keys(TABLES[table].columns), `${table} 的列集合与 registry 不一致`);
    for (const row of rows) {
      const result = validateRow(table, row, { allowServer: true });
      assert.equal(result.ok, true, `${table}「${row.name ?? row.title}」校验失败：${result.error}（${result.field}）`);
      assert.match(row.id, UUID_RE, `${table} 的 ID 不是合法 uuid`);
      assert.equal(seenIds.has(row.id), false, `${row.id} 重复`);
      seenIds.add(row.id);
    }
  }
  const ids = new Set(seed.research_projects.map((item) => item.id));
  for (const milestone of seed.milestones) assert.ok(ids.has(milestone.project_id), '里程碑指向不存在的项目');
  const milestoneIds = new Set(seed.milestones.map((item) => item.id));
  for (const subtask of seed.subtasks) assert.ok(milestoneIds.has(subtask.milestone_id), '子任务指向不存在的里程碑');
  // 自动进度与子任务一致，避免预览页自相矛盾
  for (const milestone of seed.milestones) {
    if (milestone.manual_progress) continue;
    const children = seed.subtasks.filter((item) => item.milestone_id === milestone.id);
    const expected = Math.round((children.filter((item) => item.done).length / children.length) * 100);
    assert.equal(milestone.progress, expected, `${milestone.title} 的进度与子任务不符`);
  }
  assert.equal(T.weekOf('2026-09-20', seed.semester_config[0]), 5, 'seed 让今天落在第 5 周');
  assert.equal(seed.courses.length, 13, 'PRD 5：约 13 门课');
  assert.equal(seed.workouts.length >= 8, true);
  assert.equal(seed.tasks.filter((task) => !task.due_date).length, 1, '收集箱一条');
  const today = T.tasksForDay(seed.tasks, '2026-09-20');
  assert.ok(today.length >= 3 && today.some((task) => T.isOverdue(task, '2026-09-20')), '预览要能看出逾期态');
});

test('S3 预览服务器把静态资源与真实 Function 一起提供（六个页面 + 一次真实写入）', async () => {
  const server = createPreviewServer({ port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const page = await fetch(`${base}/`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    for (const id of ['rail', 'topbar', 'view', 'modal-root', 'toast-root']) assert.ok(html.includes(`id="${id}"`));
    for (const asset of ['/styles.css', '/app.js', '/lib/registry.mjs', '/lib/time.js', '/views/home.js']) {
      const res = await fetch(`${base}${asset}`);
      assert.equal(res.status, 200, `${asset} 取不到`);
      assert.match(res.headers.get('content-type'), /(text\/css|text\/javascript)/, `${asset} 的 MIME 不对`);
    }
    const missing = await fetch(`${base}/nope.js`);
    assert.equal(missing.status, 404);

    const boot = await (await fetch(`${base}/functions/v1/app?action=bootstrap`)).json();
    assert.equal(boot.ok, true);
    assert.equal(boot.data.tables.courses.length, 13);
    assert.equal(boot.data.config.total_weeks, 18);

    const api = createApi({ baseUrl: `${base}/functions/v1/app` });
    const created = await api.create('tasks', { title: '预览里新建的待办', done: false, due_date: '2026-09-21' });
    assert.match(created.row.id, UUID_RE);
    const after = await api.bootstrap();
    assert.ok(after.data.tables.tasks.some((item) => item.id === created.row.id), '写入后从同一端点读回');
    await api.remove('tasks', created.row.id);
    const gone = await api.bootstrap();
    assert.equal(gone.data.tables.tasks.some((item) => item.id === created.row.id), false);

    const rejected = await fetch(`${base}/functions/v1/app?action=create`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ table: 'tasks', row: { title: '', done: 'x' } }),
    });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error, 'invalid_input');
    assert.equal((await fetch(`${base}/functions/v1/app?action=nope`)).status, 404);
    assert.equal((await fetch(`${base}/functions/v1/app?action=bootstrap`, { method: 'POST' })).status, 405);

    const escaped = await fetch(`${base}/%2e%2e/%2e%2e/DEV_PLAN.md`);
    assert.ok([400, 403, 404].includes(escaped.status), '目录穿越不得读到仓库其他文件');
    assert.match(await escaped.text(), /^(not found|bad path|preview server error)$/, '错误响应不回显路径内容');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ── ui.js 与样式钩子 ───────────────────────────────────────

test('S3 表单字段只来自 registry，且不会出现库里没有的字段', async () => {
  const { fieldsFor, PALETTE } = await import('../../web/lib/ui.js');
  const taskFields = fieldsFor('tasks');
  assert.deepEqual(taskFields.map((field) => field.name),
    ['title', 'due_date', 'due_time', 'duration_min', 'category', 'note', 'done']);
  assert.equal(taskFields.find((field) => field.name === 'title').rules.required, true);
  assert.equal(taskFields.find((field) => field.name === 'title').rules.max, 80);
  assert.equal(taskFields.find((field) => field.name === 'due_date').type, 'date');
  assert.equal(taskFields.find((field) => field.name === 'due_time').type, 'time');
  assert.deepEqual(taskFields.find((field) => field.name === 'duration_min').rules.between, [0, 1440]);
  assert.deepEqual(taskFields.find((field) => field.name === 'category').options.map((item) => item.value), ['作业', '科研', '生活', '其它']);
  assert.equal(taskFields.find((field) => field.name === 'done').type, 'switch');
  assert.equal(taskFields.some((field) => ['id', 'created_at', 'updated_at', 'done_at', 'sort'].includes(field.name)), false,
    '服务端字段与排序字段不进表单');

  const courseFields = fieldsFor('courses', { except: ['note'], overrides: { name: { placeholder: '课程全称' } } });
  assert.equal(courseFields.some((field) => field.name === 'note'), false);
  assert.equal(courseFields.find((field) => field.name === 'name').placeholder, '课程全称');
  assert.equal(courseFields.find((field) => field.name === 'color').type, 'swatches');
  assert.deepEqual(courseFields.find((field) => field.name === 'color').options, PALETTE);
  assert.equal(courseFields.find((field) => field.name === 'week_type').options.map((item) => item.label).join('/'), '每周/单周/双周');
  assert.equal(courseFields.find((field) => field.name === 'day_of_week').rules.between[1], 7);
  assert.throws(() => fieldsFor('nope'), /未知的数据表/);

  const workoutFields = fieldsFor('workouts');
  assert.equal(workoutFields.find((field) => field.name === 'status').options.length, 3);
  assert.equal(workoutFields.find((field) => field.name === 'duration_min').type, 'stepper');
  assert.equal(fieldsFor('semester_config').map((field) => field.name).join(','), 'start_date,total_weeks',
    '节次表由 S4 的专用编辑器负责，不生成普通输入框');
});

test('S3 字段规则的 required/区间/长度与服务端 registry 完全同步', async () => {
  const { fieldsFor } = await import('../../web/lib/ui.js');
  for (const [table, fields] of [['tasks', fieldsFor('tasks')], ['workouts', fieldsFor('workouts')], ['courses', fieldsFor('courses')], ['milestones', fieldsFor('milestones')]]) {
    for (const field of fields) {
      const col = TABLES[table].columns[field.name];
      assert.ok(col, `${table}.${field.name} 不在 registry 里`);
      assert.equal(field.label, col.label, `${table}.${field.name} 用了自己的字段名`);
      assert.equal(field.rules.required, Boolean(col.required), `${table}.${field.name} required 不同步`);
      if (col.kind === 'int') assert.deepEqual(field.rules.between, [col.min, col.max], `${table}.${field.name} 区间不同步`);
      if (col.kind === 'text' && col.enum) assert.deepEqual(field.options.map((item) => item.value), col.enum);
      if (col.max && field.type === 'text') assert.equal(field.rules.max, col.max);
    }
  }
});

test('S3 样式表补齐了浮层、抽屉、左滑与下拉刷新所需钩子', async () => {
  const css = await read('../../web/styles.css');
  for (const selector of ['.layer-veil', '.layer-head', '.layer-body', '.layer-foot', '.grabber',
    '.field-stack', '.field-grid', '.field.invalid', '.list-delete', '.swipeable',
    '.list-row.swiping', '.pull-hint', '.toast', '.skeleton', '.empty', '.notice.danger']) {
    assert.ok(css.includes(selector), `样式缺少 ${selector}`);
  }
  assert.equal((css.match(/\{/g) ?? []).length, (css.match(/\}/g) ?? []).length, '花括号不配对');
  const mobile = css.slice(css.indexOf('@media (max-width: 639px)'));
  assert.match(mobile, /\.layer\s*\{[^}]*width:\s*100%/, '手机视口下浮层必须是底部抽屉');
  assert.match(mobile, /\.grabber\s*\{\s*display:\s*block/, '抽屉要露出下拉把手');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});
