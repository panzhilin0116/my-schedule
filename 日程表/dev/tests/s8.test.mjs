// S8 完成标准里不需要浏览器的部分：连续天数（C13 的归零与不清零）、区间统计口径、
// 周分组与热力格的分桶规则、图表元件的纯几何计算（数值→角度/长度）。
// 首页与健身页必须逐项相等（C14），所以这些算式只允许有一份实现。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSeed } from '../seed.mjs';
import * as T from '../../web/lib/time.js';
import { ringMetrics, donutArcs, barGeometry, HEAT_STATES } from '../../web/lib/charts.js';

const TODAY = '2026-09-20';
const SEED = buildSeed(new Date(`${TODAY}T12:00:00`));
const day = (back) => T.addDays(TODAY, -back);
const row = (back, patch = {}) => ({
  id: `w${back}${patch.status ?? ''}${patch.duration_min ?? ''}`,
  workout_date: day(back), type: '跑步', duration_min: 30, status: 'done', note: null, ...patch,
});

// ── 连续天数（PRD 5.4 规则 2 / C13）────────────────────────

test('S8 连续天数：缺练当天归零，只从最近一段不断的天数重新算（C13）', () => {
  const rows = [row(0), row(1), row(2), row(4), row(5)];
  assert.equal(T.streakOf(rows, TODAY), 3, '连了 3 天后第 4 天什么都没有，应当只算 3');
  const broken = [row(0), row(1), row(2, { status: 'missed' }), row(3), row(4)];
  assert.equal(T.streakOf(broken, TODAY), 2, '中间插一天缺练要归零重算，不能继续数到 5');
  assert.equal(T.streakOf([row(0, { status: 'missed' }), row(1), row(2)], TODAY), 0, '今天缺练就是 0');
});

test('S8 连续天数：部分完成不清零，缺练才清零；今天没记录就从昨天往回数', () => {
  assert.equal(T.streakOf([row(0, { status: 'partial' }), row(1, { status: 'partial' }), row(2)], TODAY), 3,
    '部分完成也算练过，不能把连续打断');
  assert.equal(T.streakOf([row(1), row(2)], TODAY), 2, '今天还没记录不应该让已经连上的天数归零');
  assert.equal(T.streakOf([], TODAY), 0);
});

test('S8 同一天多条记录取最强的一条：完成 > 部分 > 缺练', () => {
  const weak = [row(0, { status: 'missed', duration_min: 0 }), row(0, { status: 'partial', duration_min: 20 })];
  assert.equal(T.streakOf(weak, TODAY), 1, '先记了缺练又补了部分完成，这天要算练过');
  assert.equal(T.streakOf([row(0, { status: 'missed' }), row(0, { status: 'partial' }), row(0, { status: 'done' })], TODAY), 1);
});

// ── 区间口径：本周 / 本月 / 自定义 ─────────────────────────

test('S8 本月区间从 1 号起到今天为止，跨月与跨年都不越界', () => {
  assert.deepEqual({ start: T.monthlyRange('2026-09-20').start, end: T.monthlyRange('2026-09-20').end },
    { start: '2026-09-01', end: '2026-09-20' });
  assert.equal(T.monthlyRange('2026-01-05').start, '2026-01-01');
  assert.equal(T.monthlyRange('2026-12-31').end, '2026-12-31');
  // 本月包含本周：本月的次数不会比本周少
  const month = T.workoutStats(SEED.workouts, T.monthlyRange(TODAY));
  const week = T.workoutStats(SEED.workouts, T.currentWeekRange(SEED.semester_config[0], TODAY));
  assert.ok(month.sessions >= week.sessions, `${month.sessions} < ${week.sessions}`);
});

test('S8 自定义区间把起止原样接住，起止颠倒时按空区间处理而不是算出负数', () => {
  const range = { start: day(6), end: day(2) };
  const stats = T.workoutStats(SEED.workouts, range);
  assert.equal(stats.sessions, SEED.workouts.filter((item) => item.workout_date >= range.start && item.workout_date <= range.end).length);
  assert.equal(T.workoutStats(SEED.workouts, { start: day(2), end: day(6) }).sessions, 0, '颠倒的区间不该捞到数据');
  assert.equal(T.workoutStats(SEED.workouts, null).sessions, 0);
});

test('S8 区间统计逐项：次数/时长/三态/活跃天数/类型分布', () => {
  const rows = [
    row(0, { type: '力量', duration_min: 50 }),
    row(1, { type: '力量', duration_min: 40 }),
    row(2, { type: '跑步', duration_min: 60 }),
    row(3, { type: '跑步', duration_min: 90, status: 'partial' }),
    row(4, { type: '骑行', duration_min: 0, status: 'missed' }),
  ];
  const stats = T.workoutStats(rows, { start: day(30), end: TODAY });
  assert.equal(stats.sessions, 5, '缺练也是一条记录，次数要算进去');
  assert.equal(stats.minutes, 240);
  assert.deepEqual([stats.done, stats.partial, stats.missed], [3, 1, 1]);
  assert.equal(stats.activeDays, 4, '缺练那天不算活跃天数');
  assert.deepEqual(stats.byType.map((item) => [item.type, item.minutes, item.sessions]),
    [['跑步', 150, 2], ['力量', 90, 2], ['骑行', 0, 1]], '类型分布按时长优先，再按次数');
});

test('S8 缺练不计时长：头部总时长、周分组、柱状图用的是同一个口径', () => {
  // 契约已不允许缺练带时长入库，但读数口径不能靠上游保证来对齐：
  // 一条缺练带着分钟数时，页面三处必须同时不认它，否则就出现"总时长 215 / 分组 185"
  const rows = [
    row(0, { type: '力量', duration_min: 50 }),
    row(1, { type: '力量', duration_min: 30, status: 'partial' }),
    row(2, { type: '跑步', duration_min: 40, status: 'missed' }),
    row(3, { type: '骑行', duration_min: 25, status: 'missed' }),
  ];
  const range = { start: day(30), end: TODAY };
  const stats = T.workoutStats(rows, range);
  assert.equal(stats.minutes, 80, '缺练那两笔的 65 分钟不该进总时长');
  assert.equal(stats.sessions, 4, '缺练仍是一条记录，次数照算');
  assert.equal(stats.activeDays, 2, '缺练那天不算有练');
  assert.deepEqual(stats.byType.map((item) => [item.type, item.minutes]),
    [['力量', 80], ['跑步', 0], ['骑行', 0]], '类型分布的分钟数也要排除缺练，不然环形图与总时长又对不上');
  const buckets = T.weeklyBuckets(rows, { count: 8, today: TODAY });
  assert.equal(buckets.reduce((sum, item) => sum + item.minutes, 0), stats.minutes, '近 8 周柱状之和要等于头部总时长');
  const groups = T.weekGroups(rows, { today: TODAY, weeks: 4 });
  const grouped = groups.reduce((sum, group) => sum + group.days.flatMap((cell) => cell.rows)
    .reduce((part, item) => part + (item.status === 'missed' ? 0 : Number(item.duration_min) || 0), 0), 0);
  assert.equal(grouped, stats.minutes, '按周分组的分标题时长要与总时长同一口径');
});

test('S8 本周口径两处一致：柱状最后一根 = 本周时长统计（C14 的前提）', () => {
  const week = T.currentWeekRange(SEED.semester_config[0], TODAY);
  const stats = T.workoutStats(SEED.workouts, week);
  const buckets = T.weeklyBuckets(SEED.workouts, { count: 8, today: TODAY });
  assert.equal(buckets.length, 8);
  assert.equal(buckets.at(-1).start, week.start, '最后一根柱子就是本周');
  assert.equal(buckets.at(-1).minutes, stats.minutes, '同一页的两个时长读数不该再需要"减去缺练"这种修正项');
  assert.equal(buckets.at(-1).label, T.fmtDateShort(week.start));
  assert.equal(buckets[0].start, T.addDays(week.start, -49));
});

// ── 记录列表的周分组与热力格 ───────────────────────────────

test('S8 周分组：周与周内日期都从新到旧，没记录的日子也要占位', () => {
  const rows = [row(0), row(1), row(9), row(20)];
  const groups = T.weekGroups(rows, { today: TODAY, weeks: 4 });
  assert.equal(groups.length, 4, '近 4 个自然周都要出现，中间的空周正是占位的意义');
  assert.deepEqual(groups.map((group) => group.start), [0, 7, 14, 21].map((back) => T.addDays(T.mondayOf(TODAY), -back)));
  const first = groups[0];
  assert.equal(first.days[0].date, TODAY, '本周从今天开始往回数，未来的日子不占位');
  assert.equal(first.days.some((cell) => cell.date > TODAY), false, '还没到的日子不能提前显示成空档');
  assert.deepEqual(first.days.map((cell) => cell.rows.length).slice(0, 2), [1, 1]);
  assert.equal(first.days[2].rows.length, 0, '9/18 没有记录，要留一格空档');
  assert.equal(first.days.length, 7, '今天正好是周日，本周仍是完整 7 格');
  assert.equal(groups[1].days.length, 7);
  assert.equal(groups.reduce((sum, group) => sum + group.days.filter((cell) => !cell.rows.length).length, 0) > 0, true);
});

test('S8 周分组只捞窗口内的记录，更早的记录留给「更早」段而不是被丢掉', () => {
  const rows = [row(0), row(50)];
  const groups = T.weekGroups(rows, { today: TODAY, weeks: 4 });
  const inWindow = groups.flatMap((group) => group.days).flatMap((cell) => cell.rows);
  assert.deepEqual(inWindow.map((item) => item.workout_date), [day(0)]);
  assert.deepEqual(T.outsideWeekGroups(rows, { today: TODAY, weeks: 4 }).map((item) => item.workout_date), [day(50)]);
  assert.deepEqual(T.weekGroups([], { today: TODAY, weeks: 4 }).flatMap((group) => group.days).map((cell) => cell.rows.length),
    new Array(28).fill(0), '一条记录都没有也要摆出格子，否则新页面看着像坏了');
});

test('S8 热力格：13 周一列 7 格，周一在上，今天之后标为未来', () => {
  const columns = T.heatCells([row(0, { status: 'partial' }), row(20)], { weeks: 13, today: TODAY });
  assert.equal(columns.length, 13);
  assert.equal(columns.at(-1).days.length, 7);
  assert.equal(T.dayOfWeek(columns.at(-1).weekStart), 1, '每列都从周一起');
  const future = columns.at(-1).days.filter((cell) => cell.future).map((cell) => cell.date);
  assert.deepEqual(future, [], '今天是周日，本周没有未来格');
  assert.equal(columns.at(-1).days[6].status, 'partial');
  assert.equal(columns.at(-1).days[5].status, null);
  const cells = columns.flatMap((column) => column.days);
  assert.equal(cells.find((cell) => cell.date === day(20)).status, 'done', '20 天前那一格是完成');
  assert.equal(cells.filter((cell) => cell.future).length, 0, '13 周窗口截止今天，不铺到未来');
  assert.equal(cells.length, 91, '热力格是 13 列 × 7 格');
});

// ── 图表元件的几何：数值→角度/长度 ─────────────────────────

test('S8 进度环：0–100 映射到整圈周长，越界值夹住而不是画出断裂', () => {
  const half = ringMetrics(50, 40);
  assert.equal(Math.round(half.dash), Math.round(half.circumference / 2));
  assert.equal(ringMetrics(0, 40).dash, 0);
  assert.equal(ringMetrics(140, 40).dash, ringMetrics(100, 40).dash);
  assert.equal(ringMetrics(-5, 40).dash, 0);
  assert.ok(ringMetrics(100, 40).circumference > 2 * Math.PI * 39, '半径要按描边内缩');
});

test('S8 环形分量图：扇区首尾相接且合计一整圈，零时长类型不占角度', () => {
  const arcs = donutArcs([
    { type: '跑步', minutes: 150 }, { type: '力量', minutes: 90 }, { type: '骑行', minutes: 0 },
  ]);
  assert.deepEqual(arcs.map((arc) => arc.type), ['跑步', '力量']);
  assert.equal(arcs[0].from, 0);
  assert.equal(arcs[1].from, arcs[0].to, '扇区要首尾相接，中间不留缝也不重叠');
  assert.equal(arcs.at(-1).to, 360, '最后一扇要收满一整圈');
  assert.equal(arcs[0].percent, 63);
  assert.equal(arcs[0].minutes, 150);
  assert.deepEqual(donutArcs([]), [], '没有数据时交给空态，不画一圈假数据');
});

test('S8 柱状：最高一根占满绘图高度，全零时不出现除零得到的 NaN 高度', () => {
  const bars = barGeometry([
    { label: '8/17', minutes: 60 }, { label: '8/24', minutes: 120 }, { label: '8/31', minutes: 0 },
  ], { valueKey: 'minutes', height: 100 });
  assert.deepEqual(bars.map((bar) => [bar.label, bar.height]), [['8/17', 50], ['8/24', 100], ['8/31', 0]]);
  assert.equal(barGeometry([{ label: 'x', minutes: 0 }], { valueKey: 'minutes', height: 100 })[0].height, 0);
  assert.equal(barGeometry([], { valueKey: 'minutes', height: 100 }).length, 0);
  assert.equal(barGeometry([{ label: 'x', minutes: null }], { valueKey: 'minutes', height: 100 })[0].height, 0);
});

test('S8 热力格取值只有四档：完成/部分/缺练/空，未来另算', () => {
  assert.deepEqual(HEAT_STATES, ['done', 'partial', 'missed', 'none']);
  assert.equal(HEAT_STATES.includes('future'), false, '未来不是完成度，不能混进同一组取值');
});
