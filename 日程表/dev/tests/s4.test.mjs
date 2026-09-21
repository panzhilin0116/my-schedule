// S4 完成标准里不需要浏览器的部分：节次合法性、影响预览、快照自检，
// 以及"导出 → 清空 → 导入"在真实 Function 上把七张表原样还原（验收 C17）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { TABLE_NAMES, validateRow } from '../../functions/registry.mjs';
import { buildSeed } from '../seed.mjs';
import { createPreviewServer } from '../preview-server.mjs';
import * as T from '../../web/lib/time.js';
import { createApi } from '../../web/lib/api.js';
import { createStore } from '../../web/lib/store.js';
import {
  SNAPSHOT_KIND, SNAPSHOT_VERSION, TABLE_LABELS, buildSnapshot, snapshotText, snapshotFilename, parseSnapshot, tableLabel,
} from '../../web/lib/snapshot.js';
import { DEFAULT_PERIODS } from '../../web/views/settings.js';

const TODAY = '2026-09-20';
const seedTables = buildSeed(new Date(`${TODAY}T12:00:00`));
const uuid = () => crypto.randomUUID();
const clone = (value) => structuredClone(value);

// ── 节次合法性：与 Function 侧 periods 校验同口径 ────────────

test('S4 合法节次表没有错误，首尾相接（上一节结束即下一节开始）不算重叠', () => {
  assert.deepEqual(T.periodErrors(T.sortPeriods(DEFAULT_PERIODS)), {});
  const touching = [
    { label: '第 1 节', start: '08:00', end: '08:45', kind: 'class' },
    { label: '第 2 节', start: '08:45', end: '09:30', kind: 'class' },
  ];
  assert.deepEqual(T.periodErrors(touching), {});
});

test('S4 时间倒置、格式非法、重名空名各自落到具体字段上', () => {
  const inverted = T.periodErrors([
    { label: '第 1 节', start: '08:00', end: '08:45', kind: 'class' },
    { label: '第 2 节', start: '10:00', end: '09:00', kind: 'class' },
  ]);
  assert.deepEqual(Object.keys(inverted), ['1.end']);
  assert.equal(inverted['1.end'], '结束时间需晚于开始时间');

  const malformed = T.periodErrors([{ label: '第 1 节', start: '8:00', end: '', kind: 'class' }]);
  assert.equal(malformed['0.start'], '开始时间格式应为 08:00');
  assert.equal(malformed['0.end'], '结束时间格式应为 08:00');

  const named = T.periodErrors([{ label: '   ', start: '08:00', end: '08:45' }, { label: '一'.repeat(21), start: '09:00', end: '09:45' }]);
  assert.equal(named['0.label'], '名称不能为空');
  assert.equal(named['1.label'], '名称最长 20 个字符');
});

test('S4 行与行时间重叠：错误挂在开始更晚的那一行上，并点名与哪一节冲突', () => {
  const errors = T.periodErrors([
    { label: '第 1 节', start: '08:00', end: '09:40', kind: 'class' },
    { label: '第 2 节', start: '09:00', end: '09:45', kind: 'class' },
    { label: '第 3 节', start: '08:30', end: '08:50', kind: 'class' },
  ]);
  assert.deepEqual(Object.keys(errors).sort(), ['1.start', '2.start']);
  assert.equal(errors['2.start'], '与「第 1 节」时间重叠');
  assert.equal(errors['1.start'], '与「第 1 节」时间重叠', '只比相邻一行会漏掉长节课盖住的那一行');

  const nestedRows = [
    { label: '第 1 节', start: '08:00', end: '11:00', kind: 'class' },
    { label: '第 2 节', start: '09:00', end: '09:30', kind: 'class' },
    { label: '第 3 节', start: '10:00', end: '10:30', kind: 'class' },
    { label: '第 4 节', start: '11:00', end: '11:45', kind: 'class' },
  ];
  const nested = T.periodErrors(nestedRows);
  assert.deepEqual(Object.keys(nested).sort(), ['1.start', '2.start']);
  assert.equal(nested['3.start'], undefined, '第 4 节正好接在第 1 节后面，不该被误报');

  // Function 侧是同一条规则的最终裁判：绕过界面直接写库也过不去
  const result = validateRow('semester_config', {
    id: uuid(), start_date: '2026-08-17', total_weeks: 18, periods: nestedRows, updated_at: '2026-09-01T00:00:00.000Z',
  }, { allowServer: true });
  assert.equal(result.ok, false);
  assert.equal(result.error, '第 2 节与上一节时间重叠');
  assert.equal(result.field, 'periods');
});

test('S4 节次表写回前按开始时间排序，休息段保留在坐标轴上', () => {
  const shuffled = [DEFAULT_PERIODS[4], DEFAULT_PERIODS[0], DEFAULT_PERIODS[9], DEFAULT_PERIODS[1]];
  const sorted = T.sortPeriods(shuffled);
  assert.deepEqual(sorted.map((period) => period.label), ['第 1 节', '第 2 节', '午休', '晚自习']);
  assert.deepEqual(shuffled.map((period) => period.label), ['午休', '第 1 节', '晚自习', '第 2 节'], '排序不改原数组');
});

// ── 影响预览（PRD C16：保存前必须说清影响）──────────────────

test('S4 影响预览逐条说明新增/删除/移动，并点名受影响的课程', () => {
  const courses = seedTables.courses;
  const before = T.sortPeriods(DEFAULT_PERIODS);

  const moved = T.periodImpact(before, before.map((period) => (period.label === '第 3 节' ? { ...period, start: '14:20', end: '15:05' } : period)), courses);
  assert.equal(moved.changed, true);
  assert.equal(moved.lines.length, 1);
  assert.equal(moved.lines[0].text, '「第 3 节」将从 10:00–10:45 移到 14:20–15:05，影响 8 门课');
  assert.deepEqual(moved.affected.slice().sort(), [
    '毛泽东思想和中国特色社会主义理论体系概论', '高等数学（下）', '计算机网络', '数据库系统原理',
    '大学英语（四）', '软件工程导论', '人工智能基础', '操作系统',
  ].sort(), '跨过的时间带上里有课就要全部点出来');

  const added = T.periodImpact(before, [...before, { label: '第 9 节', start: '20:50', end: '21:35', kind: 'class' }], courses);
  assert.deepEqual(added.lines.map((line) => line.text), ['将新增「第 9 节」 20:50–21:35']);
  assert.deepEqual(added.affected, [], '晚间空档没有课，不该谎称影响');

  const removed = T.periodImpact(before, before.filter((period) => period.label !== '第 1 节'), courses);
  assert.deepEqual(removed.lines.map((line) => line.text), ['将删除「第 1 节」 08:00–08:45']);
  assert.deepEqual(removed.affected, ['数据结构与算法', '面向对象程序设计']);
});

test('S4 没改动就不产生提示；休息段改成上课要在影响里体现', () => {
  const before = T.sortPeriods(DEFAULT_PERIODS);
  const same = T.periodImpact(before, clone(before), seedTables.courses);
  assert.equal(same.changed, false);
  assert.deepEqual(same.lines, []);

  const breakToClass = T.periodImpact(before, before.map((period) => (period.kind === 'break' ? { ...period, kind: 'class' } : period)), seedTables.courses);
  assert.equal(breakToClass.lines.length, 1);
  assert.equal(breakToClass.lines[0].text, '「午休」将从 休息 改为 上课，影响 0 门课', '只改类型时不能说成"移到"');
});

test('S4 节次区间命中的课程按时间交集计算，端点相接不算命中', () => {
  const courses = seedTables.courses;
  const names = (span) => T.coursesInSpan(courses, ...span).map((course) => course.name);
  assert.deepEqual(names(['08:00', '08:55']), ['数据结构与算法', '面向对象程序设计']);
  assert.deepEqual(names(['09:40', '10:00']), ['高等数学（下）', '软件工程导论'],
    '08:00–09:40 的课正好在 09:40 结束，不能算进 09:40 开始的这一节');
  assert.deepEqual(names(['bad', '10:00']), []);
});

// ── 快照导出与导入自检 ─────────────────────────────────────

test('S4 导出的备份是完整七表快照，条数与内存表一致', () => {
  const snapshot = buildSnapshot(seedTables, { exportedAt: '2026-09-20T12:00:00.000Z' });
  assert.equal(snapshot.kind, SNAPSHOT_KIND);
  assert.equal(snapshot.version, SNAPSHOT_VERSION);
  assert.equal(snapshot.exportedAt, '2026-09-20T12:00:00.000Z');
  assert.deepEqual(Object.keys(snapshot.tables), TABLE_NAMES);
  for (const name of TABLE_NAMES) {
    assert.equal(snapshot.counts[name], seedTables[name].length, `${name} 条数不对`);
    assert.deepEqual(snapshot.tables[name], seedTables[name], `${name} 内容要逐字段一致（含 id 与时间戳）`);
  }
  assert.equal(snapshotFilename(TODAY), '日程任务舱-备份-2026-09-20.json');
  assert.equal(TABLE_NAMES.every((name) => TABLE_LABELS[name] && tableLabel(name) === TABLE_LABELS[name]), true, '七类数据都要有中文名');
  assert.match(snapshotText(seedTables), /\n$/);
});

test('S4 自检通过的备份能与内存表逐行还原（C17 的内容一致性）', () => {
  const report = parseSnapshot(snapshotText(seedTables));
  assert.equal(report.ok, true, report.problems.join(';'));
  assert.equal(report.truncated, false);
  assert.equal(report.total, 58);
  assert.deepEqual(report.counts, {
    semester_config: 1, courses: 13, tasks: 10, research_projects: 2, milestones: 4, subtasks: 8, workouts: 20,
  });
  assert.deepEqual(report.tables, buildSnapshot(seedTables).tables);
});

test('S4 非法备份判定为不可导入，并给出中文问题清单', () => {
  const cases = [
    ['不是 JSON', 'puts(', /不是合法的 JSON/],
    ['是个数组', '[1,2,3]', /不符合备份格式/],
    ['来源不是本应用', JSON.stringify({ kind: 'other-app', tables: {} }), /来源与本应用导出的备份不一致/],
    ['含未知表', JSON.stringify({ tables: { semester_config: [], gossip: [] } }), /未知的数据表：gossip/],
    ['表内容不是列表', JSON.stringify({ tables: { courses: {} } }), /课程：内容必须是列表/],
  ];
  for (const [where, text, pattern] of cases) {
    const report = parseSnapshot(text);
    assert.equal(report.ok, false, `${where} 竟然允许导入`);
    assert.match(report.problems.join(';'), pattern, where);
  }
  // 连结构都不成立的备份不能给出"可写入的数据"，否则界面上会剩一个能点的导入按钮
  for (const text of ['puts(', '[1,2,3]']) {
    assert.equal(parseSnapshot(text).tables, null);
  }
});

test('S4 逐行自检与 Function 的 import 判据一致：缺字段、越界、假 ID、悬空父级、空备份', () => {
  const base = () => clone(buildSnapshot(seedTables).tables);

  const missing = base();
  delete missing.tasks[0].done;
  assert.match(parseSnapshot(JSON.stringify({ tables: missing })).problems.join(';'), /日程 第 1 条 缺少字段 done/);

  const tooLong = base();
  tooLong.tasks[0].title = '很'.repeat(200);
  assert.match(parseSnapshot(JSON.stringify({ tables: tooLong })).problems.join(';'), /日程 第 1 条/);

  const fakeId = base();
  fakeId.courses[0].id = 'tmp_abc123';
  assert.match(parseSnapshot(JSON.stringify({ tables: fakeId })).problems.join(';'), /课程 第 1 条：记录标识 必须是合法 ID/);

  const dangling = base();
  dangling.milestones[0].project_id = uuid();
  assert.match(parseSnapshot(JSON.stringify({ tables: dangling })).problems.join(';'), /里程碑：1 条的所属项目不在这份备份里/);

  const orphanSub = base();
  const lostId = orphanSub.subtasks[0].milestone_id;
  const lostCount = orphanSub.subtasks.filter((row) => row.milestone_id === lostId).length;
  orphanSub.milestones = orphanSub.milestones.filter((row) => row.id !== lostId);
  const orphanReport = parseSnapshot(JSON.stringify({ tables: orphanSub }));
  assert.ok(orphanReport.problems.includes(`子任务：${lostCount} 条的所属里程碑不在这份备份里`), orphanReport.problems.join(';'));

  const empty = parseSnapshot(JSON.stringify(buildSnapshot(Object.fromEntries(TABLE_NAMES.map((name) => [name, []])))));
  assert.equal(empty.ok, false);
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.problems, ['这份备份里没有任何记录，导入等于清空']);
});

test('S4 问题超过十条只列前十，并明确告知还有更多', () => {
  const tables = clone(buildSnapshot(seedTables).tables);
  for (const row of tables.tasks) row.title = 'x'.repeat(200);
  for (const row of tables.workouts) row.duration_min = 9999;
  const report = parseSnapshot(JSON.stringify({ tables }));
  assert.equal(report.ok, false);
  assert.equal(report.problems.length, 10);
  assert.equal(report.truncated, true);
});

// ── 真实 Function：导出 → 清空 → 导入还原 ──────────────────

test('S4 云端往返：导出全量 → 清空 → 导入，条数与内容逐行还原（C17）', async () => {
  const server = createPreviewServer({ port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const api = createApi({ baseUrl: `http://127.0.0.1:${server.address().port}/functions/v1/app` });
  try {
    const store = createStore({ api });
    await store.load();
    const before = store.state.tables;
    const text = snapshotText(before, { exportedAt: '2026-09-20T12:00:00.000Z' });
    const report = parseSnapshot(text);
    assert.equal(report.ok, true, report.problems.join(';'));

    await store.wipeAll();
    const wiped = await api.bootstrap();
    assert.equal(TABLE_NAMES.reduce((sum, name) => sum + wiped.data.tables[name].length, 0), 0, '清空后必须真的没有数据');
    assert.equal(wiped.data.config, null);

    const result = await api.importSnapshot(report.tables);
    assert.equal(result.ok, true);
    assert.deepEqual(result.counts, report.counts, '服务端写入条数与备份自检不一致');

    const after = await api.bootstrap();
    for (const name of TABLE_NAMES) {
      const sort = (rows) => rows.map((row) => row.id).sort();
      assert.deepEqual(sort(after.data.tables[name]), sort(before[name]), `${name} 的记录标识没有原样还原`);
      const pick = (rows) => rows.slice().sort((a, b) => a.id.localeCompare(b.id));
      assert.deepEqual(pick(after.data.tables[name]), pick(before[name]), `${name} 的字段内容与备份不一致`);
    }
    assert.deepEqual(after.data.config, before.semester_config[0], '学期基准（含节次表）也在同一份快照里还原');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('S4 缺字段的备份在入口就被拒，云端数据保持原样', async () => {
  const server = createPreviewServer({ port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/functions/v1/app`;
  const api = createApi({ baseUrl });
  try {
    const boot = await api.bootstrap();
    assert.equal(boot.ok, true);
    const broken = await fetch(`${baseUrl}?action=import`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tables: { courses: [{ id: uuid(), name: 'x' }] } }),
    });
    assert.equal(broken.status, 400);
    assert.equal((await broken.json()).error, 'invalid_input');
    const untouched = await api.bootstrap();
    assert.equal(untouched.data.tables.courses.length, boot.data.tables.courses.length, '自检不过就不能动云端数据');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
