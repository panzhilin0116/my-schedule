// S6 完成标准里不需要浏览器的部分：冲突口径、周次判定与越界保护、
// 分钟→纵轴百分比映射，以及种子 13 门课在第 5 周 / 第 12 周的可见集合。
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRow } from '../../functions/registry.mjs';
import { buildSeed, SEED_PERIODS } from '../seed.mjs';
import * as T from '../../web/lib/time.js';

const TODAY = '2026-09-20';
const SEED = buildSeed(new Date(`${TODAY}T12:00:00`));
const COURSES = SEED.courses;
const CONFIG = SEED.semester_config[0];
const names = (rows) => rows.map((row) => row.name);
const find = (name) => COURSES.find((row) => row.name === name);

// ── 周次判定（DEV_PLAN S6 完成标准 1）────────────────────────

test('S6 种子 13 门课：第 5 周上 11 节，两门双周课只是"这周没"', () => {
  assert.equal(T.weekOf(TODAY, CONFIG), 5, '种子数据把今天摆在第 5 周');
  const active = COURSES.filter((course) => T.courseActiveOnWeek(course, 5));
  assert.deepEqual(names(active).filter((name) => name.includes('大学英语')), [], '双周课在单周不上');
  assert.deepEqual(names(COURSES.filter((course) => !T.courseActiveOnWeek(course, 5))), [
    '大学英语（四）',           // even，第 2–16 周
    '人工智能基础',             // even，第 2–16 周
  ]);
  assert.equal(active.length, 11);
});

test('S6 第 12 周：第 1–8 周的课消失，双周课出现，第 1–12 周的课还在', () => {
  assert.deepEqual(names(COURSES.filter((course) => !T.courseActiveOnWeek(course, 12))), [
    '计算机网络',               // odd
    '线性代数',                 // odd
    '软件工程导论',             // 第 1–8 周已经结束
    '创新创业实践',             // odd
  ]);
  assert.equal(COURSES.filter((course) => T.courseActiveOnWeek(course, 12)).length, 9);
  assert.ok(T.courseActiveOnWeek(find('数据库系统原理'), 12), '数据库第 12 周仍在 end_week 内');
  assert.ok(!T.courseActiveOnWeek(find('数据库系统原理'), 13));
  assert.ok(T.courseActiveOnWeek(find('大学英语（四）'), 12), '双周课到第 12 周就该出现');
  assert.deepEqual(T.weekRange(12, CONFIG), { week: 12, start: T.addDays(CONFIG.start_date, 77), end: T.addDays(CONFIG.start_date, 83) });
});

test('S6 周次越界一律收回学期范围内，单双周跳转不会跳出学期', () => {
  assert.equal(T.clampWeek(0, 18), 1);
  assert.equal(T.clampWeek(-3, 18), 1);
  assert.equal(T.clampWeek(19, 18), 18);
  assert.equal(T.clampWeek(NaN, 18), 1);
  assert.equal(T.clampWeek(5.4, 18), 5);
  assert.equal(T.clampWeek(5, 18), 5);
  assert.equal(T.nextWeekOfParity(5, 'odd', 18), 5, '已经在单周就原地不动');
  assert.equal(T.nextWeekOfParity(5, 'even', 18), 6);
  assert.equal(T.nextWeekOfParity(18, 'odd', 18), 18, '学期最后一周没有下一周可跳');
});

// ── 冲突口径 ────────────────────────────────────────────────

const c = (id, extra) => ({
  id, name: `课${id}`, day_of_week: 1, start_time: '10:00', end_time: '11:40',
  week_type: 'all', start_week: 1, end_week: 16, ...extra,
});

test('S6 冲突＝同星期 + 时间真有交集 + 周型与周次范围都碰上', () => {
  const base = c('a');
  const overlaps = [
    c('b', { start_time: '11:00', end_time: '12:00' }),  // 尾部压住
    c('d', { start_time: '09:00', end_time: '10:30' }),  // 头部压住
    c('e', { start_time: '08:00', end_time: '15:00' }),  // 整个包住
  ];
  for (const other of overlaps) {
    assert.deepEqual(names(T.findConflicts(base, [base, other])), [other.name], `${other.start_time}–${other.end_time} 应判为重叠`);
    assert.deepEqual(names(T.findConflicts(other, [base, other])), [base.name], '冲突必须双向成立');
  }
});

test('S6 端点相接、换星期、周型互斥、周次不重叠都不算冲突', () => {
  const base = c('a');
  const cases = [
    ['上一节正好接上', c('x', { start_time: '11:40', end_time: '12:40' })],
    ['下一节正好被接上', c('y', { start_time: '08:00', end_time: '10:00' })],
    ['换了星期', c('z', { day_of_week: 2 })],
    ['周次范围不相交', c('v', { start_week: 17, end_week: 18, start_time: '10:30' })],
  ];
  for (const [label, other] of cases) {
    assert.deepEqual(T.findConflicts(base, [base, other]), [], `${label}：不该判成冲突`);
  }
  // 单周与双周永远错开，时间再重合也不算
  const odd = c('a2', { week_type: 'odd', start_time: '10:30' });
  const even = c('w', { week_type: 'even', start_time: '10:30' });
  assert.deepEqual(T.findConflicts(odd, [odd, even]), [], '单周对双周：不该判成冲突');
  // 每周课与单周课仍然可能撞上：周型判定不是"全都算"
  assert.deepEqual(names(T.findConflicts(base, [base, c('u', { week_type: 'odd', start_time: '10:30' })])), ['课u']);
});

test('S6 时间缺失或格式不对时不报错，只是没有冲突可读', () => {
  assert.deepEqual(T.findConflicts(c('a', { start_time: null }), [c('a'), c('b')]), []);
  assert.deepEqual(T.findConflicts(c('a', { end_time: '99:99' }), [c('a'), c('b')]), []);
  assert.deepEqual(T.findConflicts(undefined, []), []);
});

test('S6 种子 13 门课本身互不冲突，课表首屏不该一进来就报警', () => {
  const clashes = COURSES.filter((course) => T.findConflicts(course, COURSES).length);
  assert.deepEqual(names(clashes), [], '种子数据一旦自带冲突，"冲突徽标"就再也测不出增量了');
});

test('S6 人为制造的三门重叠课在网格上并排三列', () => {
  const monday = T.weekRange(5, CONFIG).start;   // 第 5 周周一，day_of_week＝1
  const group = [c('a'), c('b', { start_time: '10:30', end_time: '12:00' }), c('e', { start_time: '08:00', end_time: '15:00' })];
  const laid = T.coursesOverlapping(group, 5, monday);
  assert.deepEqual(names(laid), ['课e', '课a', '课b'], '列内按开始时间升序，窄格才不会互相盖住');
  assert.deepEqual(laid.map((row) => row.layout), [
    { total: 3, index: 0 }, { total: 3, index: 1 }, { total: 3, index: 2 },
  ]);
  assert.equal(new Set(laid.map((row) => row.layout.index)).size, 3, '三列必须各占一格，不能叠在一起');
  // 独立的一节课只有一列，且带 active 标记供 ghost 用
  const alone = T.coursesOverlapping([c('k', { start_time: '19:00', end_time: '20:40' })], 5, monday);
  assert.deepEqual(alone.map((row) => row.layout), [{ total: 1, index: 0 }]);
  assert.equal(alone[0].active, true);
  // 本周不上的课仍然要画出来（ghost），只是不参与列宽的"真冲突"分组
  const ghost = T.coursesOverlapping([c('g', { week_type: 'even', start_time: '19:00' })], 5, monday);
  assert.equal(ghost[0].active, false);
});

// ── 纵轴映射 ────────────────────────────────────────────────

test('S6 纵轴跨度取自节次表：08:00–20:40 映射成 0–100%', () => {
  assert.deepEqual(T.axisSpan(SEED_PERIODS), { start: 480, end: 1240 });
  assert.deepEqual(T.axisSpan([]), { start: 420, end: 1320 }, '没有节次表时不能塌成零高');
  const box = T.axisBox(SEED_PERIODS, '08:00', '20:40');
  assert.equal(box.top, 0);
  assert.equal(box.height, 100);
  assert.equal(box.clipped, false);
  // 第 1 节 08:00–08:45：跨度 760 分钟里的 45 分钟
  const first = T.axisBox(SEED_PERIODS, '08:00', '08:45');
  assert.ok(Math.abs(first.height - (45 / 760) * 100) < 1e-9);
  // 午休 12:00–14:00 落在中段
  const noon = T.axisBox(SEED_PERIODS, '12:00', '14:00');
  assert.ok(Math.abs(noon.top - (240 / 760) * 100) < 1e-9);
});

test('S6 超出坐标轴的课贴边显示并标出 clipped', () => {
  const early = T.axisBox(SEED_PERIODS, '06:00', '08:30');
  assert.equal(early.top, 0);
  assert.equal(early.clipped, true);
  const late = T.axisBox(SEED_PERIODS, '20:00', '23:00');
  assert.equal(late.top + late.height, 100);
  assert.equal(late.clipped, true);
  assert.equal(T.axisBox(SEED_PERIODS, null, '09:00'), null);
  assert.equal(T.axisBox(SEED_PERIODS, '09:00', 'bad'), null);
});

// ── 表单产物与 Function 契约 ────────────────────────────────

test('S6 星期下拉交回字符串，整数列必须转成 number 才过得了校验', () => {
  const raw = {
    name: '冲突试验课', day_of_week: '3', start_time: '10:30', end_time: '12:00',
    week_type: 'all', start_week: '2', end_week: '16', teacher: '', location: null,
    color: '#3DD6F5', note: '',
  };
  const bad = validateRow('courses', raw, { allowServer: true });
  assert.equal(bad.ok, false, '原样交上去必须被 Function 拒掉');
  assert.equal(bad.field, 'day_of_week');
  const fixed = {
    ...raw,
    day_of_week: Number(raw.day_of_week),
    start_week: Number(raw.start_week),
    end_week: Number(raw.end_week),
    teacher: null,
    note: null,
  };
  assert.equal(validateRow('courses', fixed, { allowServer: true }).ok, true);
  assert.equal(validateRow('courses', { ...fixed, end_week: null }, { allowServer: true }).ok, false,
    '必填的周次清空后 Function 会拒收，客户端要先把红字标出来而不是发出去');
});

test('S6 新增课只带表单字段也能写入，服务端列一律不交', () => {
  const row = {
    name: '新试验课', day_of_week: 5, start_time: '19:00', end_time: '20:40',
    week_type: 'odd', start_week: 5, end_week: 15, color: '#4ADE80',
  };
  const result = validateRow('courses', row, { allowServer: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  for (const key of ['id', 'created_at', 'updated_at']) assert.ok(!(key in row));
});
