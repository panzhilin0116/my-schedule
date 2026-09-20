import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { handleApp } from '../../functions/handler.mjs';
import { createFakeSupabase } from '../fake-supabase.mjs';
import { TABLE_NAMES } from '../../functions/registry.mjs';

const call = async (supabase, action, { method = 'GET', body, headers, raw } = {}) => {
  const request = new Request(`http://localhost/functions/v1/app?action=${action}`, {
    method,
    ...(raw !== undefined
      ? { headers: { 'content-type': 'application/json', ...headers }, body: raw }
      : body !== undefined
        ? { headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }
        : {}),
  });
  const response = await handleApp({ request, supabase });
  return { status: response.status, json: await response.json().catch(() => null) };
};

const freshDb = () => createFakeSupabase(Object.fromEntries(TABLE_NAMES.map((table) => [table, []])));

const PROJECT = { name: '深度学习目标检测', status: 'active' };
const MILESTONE = { title: '数据采集', status: 'active', progress: 0, manual_progress: false, target_date: '2026-10-01' };
const COURSE = {
  name: '数据结构', teacher: '王老师', location: 'A302', day_of_week: 1,
  start_time: '08:00', end_time: '09:40', week_type: 'odd', start_week: 1, end_week: 16, color: '#3DD6F5',
};

test('S2 bootstrap 一次返回 7 张表且不含统计派生值', async () => {
  const supabase = freshDb();
  const { status, json } = await call(supabase, 'bootstrap');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.deepEqual(Object.keys(json.data.tables).sort(), [...TABLE_NAMES].sort());
  assert.equal(json.data.config, null, '首次使用没有学期配置时返回 null 而不是报错');
  assert.equal(json.data.tables.courses.length, 0);
  assert.ok(Object.keys(json.data.limits).length === 7);
  assert.ok(!('stats' in json.data), '聚合口径只在 web/lib/time.js 实现');
  assert.ok(!Number.isNaN(Date.parse(json.serverTime)));
});

test('S2 六张业务表都能 create→读→update→读→remove→读', async () => {
  const supabase = freshDb();
  const create = async (table, row) => (await call(supabase, 'create', { method: 'POST', body: { table, row } })).json.row;
  // 每轮都重建父记录：上一轮结尾的 wipe 会连带清掉旧父行，引用不能跨轮复用
  const cases = {
    courses: async () => COURSE,
    tasks: async () => ({ title: '交作业', due_date: '2026-09-21', done: false, category: '作业' }),
    research_projects: async () => PROJECT,
    milestones: async () => ({ ...MILESTONE, project_id: (await create('research_projects', PROJECT)).id }),
    subtasks: async () => ({
      milestone_id: (await create('milestones', { ...MILESTONE, project_id: (await create('research_projects', PROJECT)).id })).id,
      title: '采集脚本', done: false,
    }),
    workouts: async () => ({ workout_date: '2026-09-20', type: '跑步', duration_min: 45, status: 'done' }),
  };
  // 每张表用它真实存在的可选列，避免把契约里没写的字段当成应该接受
  const patches = {
    courses: { note: '改过' },
    tasks: { done: true },
    research_projects: { description: '改过' },
    milestones: { note: '改过' },
    subtasks: { done: true },
    workouts: { duration_min: 60 },
  };
  for (const [table, build] of Object.entries(cases)) {
    const created = await call(supabase, 'create', { method: 'POST', body: { table, row: await build() } });
    assert.equal(created.status, 200, `${table} 创建失败：${JSON.stringify(created.json)}`);
    assert.match(created.json.row.id, /^[0-9a-f-]{36}$/, `${table} 未生成 ID`);
    assert.ok(created.json.row.created_at && created.json.row.updated_at, `${table} 缺少服务端时间戳`);

    const readBack = await call(supabase, 'bootstrap');
    assert.ok(readBack.json.data.tables[table].some((item) => item.id === created.json.row.id), `${table} 新建后读不到`);

    const updated = await call(supabase, 'update', { method: 'POST', body: { table, id: created.json.row.id, patch: patches[table] } });
    assert.equal(updated.status, 200, `${table} 更新失败：${JSON.stringify(updated.json)}`);
    assert.equal(updated.json.row.id, created.json.row.id);
    assert.equal(updated.json.row.created_at, created.json.row.created_at, `${table} created_at 被改动`);
    assert.ok(updated.json.row.updated_at >= created.json.row.updated_at);

    const removed = await call(supabase, 'remove', { method: 'POST', body: { table, id: created.json.row.id } });
    assert.equal(removed.status, 200, `${table} 删除失败`);
    assert.equal(removed.json.id, created.json.row.id);
    const after = await call(supabase, 'bootstrap');
    assert.equal(
      after.json.data.tables[table].filter((item) => item.id === created.json.row.id).length, 0,
      `${table} 删除后仍能读到，说明删的不是真实行`,
    );
    await call(supabase, 'wipe', { method: 'POST', body: { confirm: 'DELETE_ALL' } });
  }
});

test('S2 服务端生成 ID 与时间戳，拒绝浏览器提交', async () => {
  const supabase = freshDb();
  for (const row of [
    { ...COURSE, id: '00000000-0000-4000-8000-000000000000' },
    { ...COURSE, created_at: '2020-01-01T00:00:00Z' },
    { ...COURSE, recurrence: 'weekly' },
  ]) {
    const result = await call(supabase, 'create', { method: 'POST', body: { table: 'courses', row } });
    assert.equal(result.status, 400, `本该拒绝：${JSON.stringify(Object.keys(row))}`);
    assert.equal(result.json.error, 'invalid_input');
  }
  assert.equal((await call(supabase, 'bootstrap')).json.data.tables.courses.length, 0, '非法请求不得落库');
});

test('S2 缺练带时长的记录在入口就被拒，0 分缺练能落库', async () => {
  const supabase = freshDb();
  const base = { workout_date: '2026-09-19', type: '力量', note: null };
  const rejected = await call(supabase, 'create', {
    method: 'POST', body: { table: 'workouts', row: { ...base, duration_min: 30, status: 'missed' } },
  });
  assert.equal(rejected.status, 400, '缺练还带 30 分钟，两种时长口径必然对不上');
  assert.equal(rejected.json.field, 'duration_min', '提示要挂在时长字段上，用户才知道改哪里');
  assert.match(rejected.json.message, /缺练/);
  const missed = await call(supabase, 'create', {
    method: 'POST', body: { table: 'workouts', row: { ...base, duration_min: 0, status: 'missed' } },
  });
  assert.equal(missed.status, 200, missed.json.message ?? '');
  const trained = await call(supabase, 'create', {
    method: 'POST', body: { table: 'workouts', row: { ...base, duration_min: 30, status: 'done' } },
  });
  assert.equal(trained.status, 200, trained.json.message ?? '');
  // 编辑同样拦：把一笔 30 分钟改成缺练，不能把 30 分悄悄留在库里
  const patched = await call(supabase, 'update', {
    method: 'POST', body: { table: 'workouts', id: trained.json.row.id, patch: { status: 'missed' } },
  });
  assert.equal(patched.status, 400, 'partial 更新绕过了跨字段校验');
  const after = await call(supabase, 'bootstrap');
  const stored = after.json.data.tables.workouts.find((item) => item.id === trained.json.row.id);
  assert.equal(stored.status, 'done', '被拒的更新不得改动已有行');
  assert.equal(stored.duration_min, 30);
});

test('S2 四种非法取值各自返回 400 与字段名', async () => {
  const supabase = freshDb();
  const cases = [
    [{ ...COURSE, day_of_week: 9 }, 'day_of_week'],
    [{ ...COURSE, week_type: 'xyz' }, 'week_type'],
    [{ ...COURSE, name: '课'.repeat(41) }, 'name'],
    [{ teacher: '王老师', day_of_week: 1, start_time: '08:00', end_time: '09:00', week_type: 'all', start_week: 1, end_week: 2 }, 'name'],
    [{ ...COURSE, start_time: '10:00', end_time: '09:00' }, 'end_time'],
  ];
  for (const [row, field] of cases) {
    const result = await call(supabase, 'create', { method: 'POST', body: { table: 'courses', row } });
    assert.equal(result.status, 400, `${field} 应被拒绝`);
    assert.equal(result.json.field, field);
    assert.equal(typeof result.json.message, 'string');
  }
});

test('S2 方法与动作校验：GET 不能写，未知动作 404', async () => {
  const supabase = freshDb();
  for (const action of ['create', 'update', 'remove', 'import', 'wipe']) {
    const result = await call(supabase, action, { method: 'GET' });
    assert.equal(result.status, 405, `${action} 拒绝 GET`);
    assert.equal(result.json.error, 'method_not_allowed');
  }
  assert.equal((await call(supabase, 'bootstrap', { method: 'POST', body: {} })).status, 405);
  assert.equal((await call(supabase, 'nope', { method: 'POST', body: {} })).status, 404);
  assert.equal((await call(supabase, null, { method: 'POST', body: {} })).status, 404);
  const put = await call(supabase, 'create', { method: 'PUT', body: { table: 'courses', row: COURSE } });
  assert.equal(put.status, 405);
  assert.equal((await call(supabase, 'create', { method: 'POST', body: { table: 'nope', row: {} } })).json.error, 'invalid_table');
});

test('S2 请求体：非 JSON 415、坏 JSON 400、超 64KB 413', async () => {
  const supabase = freshDb();
  const request = new Request('http://localhost/functions/v1/app?action=create', {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello',
  });
  assert.equal((await handleApp({ request, supabase })).status, 415);

  const broken = new Request('http://localhost/functions/v1/app?action=create', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ not json',
  });
  const brokenResult = await handleApp({ request: broken, supabase });
  assert.equal(brokenResult.status, 400);
  assert.equal(brokenResult.json?.error ?? (await brokenResult.json()).error, 'invalid_json');

  const huge = await call(supabase, 'create', { method: 'POST', body: { table: 'tasks', row: { title: 'x'.repeat(70000), done: false } } });
  assert.ok([400, 413].includes(huge.status), `超大请求体需被拒，实际 ${huge.status}`);
  if (huge.status === 400) assert.equal(huge.json.field, 'title');
  assert.equal((await call(supabase, 'bootstrap')).json.data.tables.tasks.length, 0);
});

test('S2 update/remove 对不存在的行返回 404 而不是假成功', async () => {
  const supabase = freshDb();
  const missing = '11111111-1111-4111-8111-111111111111';
  const updated = await call(supabase, 'update', { method: 'POST', body: { table: 'courses', id: missing, patch: { name: '改' } } });
  assert.equal(updated.status, 404);
  assert.equal(updated.json.error, 'not_found');
  const removed = await call(supabase, 'remove', { method: 'POST', body: { table: 'courses', id: missing } });
  assert.equal(removed.status, 404);
  assert.equal((await call(supabase, 'update', { method: 'POST', body: { table: 'courses', id: 'not-a-uuid', patch: { name: '改' } } })).json.error, 'invalid_id');
  assert.equal((await call(supabase, 'update', { method: 'POST', body: { table: 'courses', id: missing, patch: {} } })).json.error, 'invalid_input');
});

test('S2 父子引用必须存在', async () => {
  const supabase = freshDb();
  const orphan = await call(supabase, 'create', {
    method: 'POST', body: { table: 'milestones', row: { ...MILESTONE, project_id: '22222222-2222-4222-8222-222222222222' } },
  });
  assert.equal(orphan.status, 400);
  assert.equal(orphan.json.error, 'invalid_parent');
  assert.equal(orphan.json.field, 'project_id');
  assert.equal((await call(supabase, 'bootstrap')).json.data.tables.milestones.length, 0);
});

test('S2 C10：子任务变化重算里程碑进度，手动值不被覆盖', async () => {
  const supabase = freshDb();
  const project = (await call(supabase, 'create', { method: 'POST', body: { table: 'research_projects', row: PROJECT } })).json.row;
  const milestone = (await call(supabase, 'create', {
    method: 'POST', body: { table: 'milestones', row: { ...MILESTONE, project_id: project.id } },
  })).json.row;
  const subs = [];
  for (const title of ['采集脚本', '标注 500 张', '数据清洗管线', '特征验证']) {
    subs.push((await call(supabase, 'create', {
      method: 'POST', body: { table: 'subtasks', row: { milestone_id: milestone.id, title, done: false } },
    })).json.row);
  }
  await call(supabase, 'update', { method: 'POST', body: { table: 'subtasks', id: subs[0].id, patch: { done: true } } });
  await call(supabase, 'update', { method: 'POST', body: { table: 'subtasks', id: subs[1].id, patch: { done: true } } });
  let current = (await call(supabase, 'bootstrap')).json.data.tables.milestones.find((row) => row.id === milestone.id);
  assert.equal(current.progress, 50, '2/4 应为 50%');

  await call(supabase, 'update', { method: 'POST', body: { table: 'milestones', id: milestone.id, patch: { progress: 80, manual_progress: true } } });
  await call(supabase, 'update', { method: 'POST', body: { table: 'subtasks', id: subs[2].id, patch: { done: true } } });
  current = (await call(supabase, 'bootstrap')).json.data.tables.milestones.find((row) => row.id === milestone.id);
  assert.equal(current.progress, 80, '手动进度 80% 必须保留');
  assert.equal(current.manual_progress, true);

  await call(supabase, 'update', { method: 'POST', body: { table: 'milestones', id: milestone.id, patch: { manual_progress: false } } });
  current = (await call(supabase, 'bootstrap')).json.data.tables.milestones.find((row) => row.id === milestone.id);
  assert.equal(current.progress, 75, '重新锁定后按 3/4 自动计算');
});

test('S2 C11：删除项目级联删里程碑与子任务，删除里程碑级联删子任务', async () => {
  const supabase = freshDb();
  const keep = (await call(supabase, 'create', { method: 'POST', body: { table: 'research_projects', row: { ...PROJECT, name: '保留项目' } } })).json.row;
  const doomed = (await call(supabase, 'create', { method: 'POST', body: { table: 'research_projects', row: PROJECT } })).json.row;
  const msA = (await call(supabase, 'create', { method: 'POST', body: { table: 'milestones', row: { ...MILESTONE, project_id: doomed.id } } })).json.row;
  const msB = (await call(supabase, 'create', { method: 'POST', body: { table: 'milestones', row: { ...MILESTONE, project_id: keep.id, title: '另一个里程碑' } } })).json.row;
  for (const title of ['子任务 1', '子任务 2', '子任务 3']) {
    await call(supabase, 'create', { method: 'POST', body: { table: 'subtasks', row: { milestone_id: msA.id, title, done: false } } });
  }
  await call(supabase, 'create', { method: 'POST', body: { table: 'subtasks', row: { milestone_id: msB.id, title: '别的项目的子任务', done: false } } });

  const result = await call(supabase, 'remove', { method: 'POST', body: { table: 'research_projects', id: doomed.id } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json.deleted, { research_projects: 1, milestones: 1, subtasks: 3 });
  const { tables } = (await call(supabase, 'bootstrap')).json.data;
  assert.equal(tables.milestones.length, 1);
  assert.equal(tables.milestones[0].id, msB.id);
  assert.equal(tables.subtasks.length, 1, '只删属于被删里程碑的子任务');

  const msResult = await call(supabase, 'remove', { method: 'POST', body: { table: 'milestones', id: msB.id } });
  assert.deepEqual(msResult.json.deleted, { milestones: 1, subtasks: 1 });
  assert.equal((await call(supabase, 'bootstrap')).json.data.tables.subtasks.length, 0);
});

test('S2 排序值自动追加且显式重排被接受', async () => {
  const supabase = freshDb();
  const project = (await call(supabase, 'create', { method: 'POST', body: { table: 'research_projects', row: PROJECT } })).json.row;
  const row = (title, extra) => ({ ...MILESTONE, project_id: project.id, title, ...extra });
  const first = (await call(supabase, 'create', { method: 'POST', body: { table: 'milestones', row: row('数据采集') } })).json.row;
  const second = (await call(supabase, 'create', { method: 'POST', body: { table: 'milestones', row: row('模型选型') } })).json.row;
  const third = (await call(supabase, 'create', { method: 'POST', body: { table: 'milestones', row: row('实验复现') } })).json.row;
  assert.deepEqual([first.sort, second.sort, third.sort], [0, 1, 2], '新增项依次落到末尾且互不覆盖');

  // 界面上移一位 = 把后面的项重排到前面，服务端必须原样接受显式值
  const renumber = [[third.id, 0], [first.id, 1], [second.id, 2]];
  for (const [id, sort] of renumber) {
    const moved = await call(supabase, 'update', { method: 'POST', body: { table: 'milestones', id, patch: { sort } } });
    assert.equal(moved.status, 200, JSON.stringify(moved.json));
    assert.equal(moved.json.row.sort, sort);
  }
  const { tables } = (await call(supabase, 'bootstrap')).json.data;
  assert.deepEqual(
    [...tables.milestones].sort((a, b) => a.sort - b.sort).map((item) => [item.title, item.sort]),
    [['实验复现', 0], ['数据采集', 1], ['模型选型', 2]],
  );

  const outOfRange = await call(supabase, 'create', { method: 'POST', body: { table: 'milestones', row: row('越界', { sort: 99999 }) } });
  assert.equal(outOfRange.status, 400);
  assert.equal(outOfRange.json.field, 'sort');
  const negative = await call(supabase, 'update', { method: 'POST', body: { table: 'milestones', id: second.id, patch: { sort: -1 } } });
  assert.equal(negative.status, 400, 'schema 里 sort 的下界必须被服务端守住');
  assert.equal(negative.json.field, 'sort');
});

test('S2 数据库故障映射为固定应用码，不外传内部信息', async () => {
  const supabase = freshDb();
  await call(supabase, 'create', { method: 'POST', body: { table: 'tasks', row: { title: '正常项', done: false } } });
  supabase.__db.setFailNext(true);
  const result = await call(supabase, 'bootstrap');
  assert.equal(result.status, 503);
  assert.equal(result.json.error, 'database_request_failed');
  assert.deepEqual(Object.keys(result.json).sort(), ['error', 'message', 'ok']);
  assert.equal(JSON.stringify(result.json).includes('simulated'), false, '不得泄漏驱动错误');
  supabase.__db.setFailNext(true);
  const write = await call(supabase, 'create', { method: 'POST', body: { table: 'tasks', row: { title: '写失败', done: false } } });
  assert.equal(write.status, 503);
  assert.equal(write.json.error, 'database_request_failed', '写入失败要与"读失败"区分给上层重试策略');
});

test('S2 未知表名的数据库错误也走安全包装', async () => {
  const supabase = createFakeSupabase({ courses: [] });
  const result = await call(supabase, 'create', { method: 'POST', body: { table: 'tasks', row: { title: 'x', done: false } } });
  assert.equal(result.status, 503);
  assert.equal(result.json.error, 'database_request_failed');
  assert.equal(JSON.stringify(result.json).includes('42P01'), false);
});

test('S2 导出→清空→导入可完整还原，且引用与重复 ID 会被拒', async () => {
  const supabase = freshDb();
  const project = (await call(supabase, 'create', { method: 'POST', body: { table: 'research_projects', row: PROJECT } })).json.row;
  const milestone = (await call(supabase, 'create', { method: 'POST', body: { table: 'milestones', row: { ...MILESTONE, project_id: project.id } } })).json.row;
  await call(supabase, 'create', { method: 'POST', body: { table: 'subtasks', row: { milestone_id: milestone.id, title: '写脚本', done: true } } });
  await call(supabase, 'create', { method: 'POST', body: { table: 'courses', row: COURSE } });
  await call(supabase, 'create', { method: 'POST', body: { table: 'semester_config', row: { start_date: '2026-09-07', total_weeks: 18, periods: [{ label: '第1节', start: '08:00', end: '08:45', kind: 'class' }] } } });
  const snapshot = (await call(supabase, 'bootstrap')).json.data.tables;

  assert.equal((await call(supabase, 'wipe', { method: 'POST', body: { confirm: 'nope' } })).json.error, 'confirm_required');
  const wiped = await call(supabase, 'wipe', { method: 'POST', body: { confirm: 'DELETE_ALL' } });
  assert.equal(wiped.status, 200);
  assert.equal(wiped.json.deleted.research_projects, 1);
  assert.equal((await call(supabase, 'bootstrap')).json.data.tables.subtasks.length, 0);

  const imported = await call(supabase, 'import', { method: 'POST', body: { tables: snapshot } });
  assert.equal(imported.status, 200, JSON.stringify(imported.json));
  const after = (await call(supabase, 'bootstrap')).json.data.tables;
  for (const table of TABLE_NAMES) {
    assert.deepEqual(after[table], snapshot[table], `${table} 未原样还原`);
  }

  const orphan = await call(supabase, 'import', {
    method: 'POST',
    body: { tables: { milestones: [{ ...snapshot.milestones[0], project_id: '33333333-3333-4333-8333-333333333333' }] } },
  });
  assert.equal(orphan.status, 400);
  assert.equal(orphan.json.error, 'invalid_parent');

  const duplicated = await call(supabase, 'import', {
    method: 'POST',
    body: { tables: { courses: [snapshot.courses[0], snapshot.courses[0]] } },
  });
  assert.equal(duplicated.status, 503);
  assert.equal(duplicated.json.error, 'import_partial');
  assert.deepEqual(duplicated.json.counts.courses, 0);
});

test('S2 达到条数上限时拒绝继续写入', async () => {
  const supabase = freshDb();
  supabase.__db.tables.workouts = Array.from({ length: 5000 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    workout_date: '2026-09-20', type: '跑步', duration_min: 30, status: 'done', note: null,
    created_at: '2026-09-20T00:00:00.000Z', updated_at: '2026-09-20T00:00:00.000Z',
  }));
  const result = await call(supabase, 'create', {
    method: 'POST', body: { table: 'workouts', row: { workout_date: '2026-09-20', type: '力量', duration_min: 30, status: 'done' } },
  });
  assert.equal(result.status, 409);
  assert.equal(result.json.error, 'table_full');
});

test('S2 adapter.mjs 与平台提供的文件保持逐字节一致', () => {
  const platform = 'D:/Qoder CN/resources/extensions/qoder.sites/cli/sites/skills/sites-building/assets/database-function/adapter.mjs';
  if (!existsSync(platform)) return; // 本机之外不做此项检查
  const local = readFileSync(fileURLToPath(new URL('../../functions/adapter.mjs', import.meta.url)));
  assert.deepEqual([...local], [...readFileSync(platform)], '适配器被改动过，数据库凭据处理将失去平台保证');
});

test('S2 入口文件只做装配且锁定 SDK 版本', async () => {
  const entry = readFileSync(fileURLToPath(new URL('../../functions/index.ts', import.meta.url)), 'utf8');
  assert.match(entry, /npm:@supabase\/supabase-js@2\.57\.4/);
  assert.match(entry, /Deno\.serve\(serveSite\(handleApp/);
  assert.equal(/SUPABASE_(URL|ANON_KEY)|Deno\.env\.get\(['"](?!SUPABASE)/.test(entry.replace(/env: \(name: string\) => Deno\.env\.get\(name\)/, '')), false,
    '入口不得出现凭据名或额外环境变量读取');
});
