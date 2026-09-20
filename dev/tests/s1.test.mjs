import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { read, parseSql, assertModuleParses } from './helpers.mjs';
import { TABLES, TABLE_NAMES, validateRow, editableColumns } from '../../functions/registry.mjs';

const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const sql = await read('../../schema/v1.sql');
const sqlCode = sql.replace(/--[^\n]*/g, '');
const policies = JSON.parse(await read('../../schema/v1.policies.json'));
const parsed = parseSql(sql);

test('S1 迁移 SQL 只使用平台支持的受限 DDL 子集', () => {
  const forbidden = [
    [/\bDEFAULT\b/i, 'DEFAULT 不受支持'],
    [/\bREFERENCES\b/i, '外键不受支持'],
    [/\bFOREIGN KEY\b/i, '外键不受支持'],
    [/\bCHECK\s*\(/i, 'CHECK 不受支持'],
    [/\bCREATE OR REPLACE\b/i, '不支持'],
    [/\bGRANT\b/i, '权限需用 accessPolicies'],
    [/\bPOLICY\b/i, 'RLS 语句不受支持'],
    [/\bTRIGGER\b/i, '触发器不受支持'],
    [/\bGENERATED\b/i, '生成列不受支持'],
    [/^\s*INSERT\s/mi, '迁移里不得含业务数据'],
    [/\bNOW\(\)/i, '函数默认值不受支持'],
  ];
  for (const [re, why] of forbidden) assert.equal(re.test(sqlCode), false, `${why}：${re}`);
  const statements = sqlCode.split(';').map((s) => s.trim()).filter(Boolean);
  for (const statement of statements) {
    assert.match(statement, /^(CREATE TABLE app\.\w+|CREATE INDEX \w+ ON app\.\w+)/, `不支持的语句：${statement.slice(0, 40)}`);
  }
});

test('S1 索引定义为普通列索引，无排序、表达式与谓词', () => {
  for (const index of parsed.indexes) {
    assert.equal(/\b(ASC|DESC|NULLS|USING|WHERE)\b/i.test(index.columns), false, `${index.name} 含不受支持的索引选项`);
    assert.equal(index.columns.includes('('), false, `${index.name} 不得使用表达式`);
    assert.ok(parsed.tables.has(index.table), `${index.name} 指向不存在的表`);
    for (const column of index.columns.split(',').map((c) => c.trim())) {
      assert.ok(parsed.tables.get(index.table).has(column), `${index.name} 引用了不存在的列 ${column}`);
    }
  }
  assert.equal(parsed.indexes.length, 5);
});

test('S1 schema 与 registry 的表和列完全一致', () => {
  assert.deepEqual([...parsed.tables.keys()].sort(), [...TABLE_NAMES].sort());
  for (const table of TABLE_NAMES) {
    const sqlColumns = parsed.tables.get(table);
    const registryColumns = Object.keys(TABLES[table].columns);
    assert.deepEqual([...sqlColumns.keys()], registryColumns, `${table} 列清单不一致`);
  }
});

test('S1 列类型符合平台支持类型且与 registry 声明一致', () => {
  const allowed = new Set(['uuid', 'text', 'integer', 'boolean', 'timestamptz', 'jsonb']);
  const kindToSql = {
    uuid: 'uuid', text: 'text', int: 'integer', bool: 'boolean',
    date: 'text', hhmm: 'text', timestamptz: 'timestamptz', stringList: 'jsonb', periods: 'jsonb',
  };
  for (const [table, spec] of Object.entries(TABLES)) {
    for (const [column, col] of Object.entries(spec.columns)) {
      assert.ok(allowed.has(col.kind) || kindToSql[col.kind], `${table}.${column} 用了不支持的类型 ${col.kind}`);
      const entry = parsed.tables.get(table).get(column);
      assert.equal(entry.type, kindToSql[col.kind], `${table}.${column} SQL 类型与 registry 不符`);
      const notNull = /NOT NULL/.test(entry.constraints);
      const expectsNull = Boolean(col.required) || col.server === true;
      if (column === 'id') {
        assert.match(entry.constraints, /PRIMARY KEY/, `${table}.id 必须是主键`);
        assert.equal(notNull, false, `${table}.id 不需要额外 NOT NULL（主键已隐含）`);
        assert.equal(col.server, true, `${table}.id 必须由服务端生成，不接受浏览器提交`);
      } else {
        assert.equal(notNull, expectsNull, `${table}.${column} 的 NOT NULL 与 required 声明不符`);
        assert.equal(entry.constraints.replace(/NOT NULL/g, '').trim(), '', `${table}.${column} 含多余约束`);
      }
    }
  }
});

test('S1 accessPolicies 覆盖全部 7 张表且为完整的托管状态', () => {
  assert.deepEqual(policies.map((p) => p.table).sort(), [...TABLE_NAMES].sort());
  for (const policy of policies) {
    assert.equal(policy.principal, 'anonymous');
    assert.equal(policy.template, 'public');
    assert.equal(policy.owner_column, undefined);
    assert.deepEqual(policy.actions, ['select', 'insert', 'update', 'delete']);
  }
});

test('S1 validateRow 拒绝缺失必填、越界与非法格式', () => {
  const cases = [
    ['courses', { name: '高等数学' }, 'day_of_week'],
    ['courses', { name: 'x', day_of_week: 9, start_time: '10:00', end_time: '11:00', week_type: 'all', start_week: 1, end_week: 2 }, 'day_of_week'],
    ['courses', { name: 'x', day_of_week: 1, start_time: '10:00', end_time: '11:00', week_type: 'every', start_week: 1, end_week: 2 }, 'week_type'],
    ['courses', { name: 'x', day_of_week: 1, start_time: '25:00', end_time: '26:00', week_type: 'all', start_week: 1, end_week: 2 }, 'start_time'],
    ['courses', { name: 'x', day_of_week: 1, start_time: '12:00', end_time: '11:00', week_type: 'all', start_week: 1, end_week: 2 }, 'end_time'],
    ['courses', { name: 'x', day_of_week: 1, start_time: '10:00', end_time: '11:00', week_type: 'all', start_week: 9, end_week: 3 }, 'end_week'],
    ['courses', { name: '高'.repeat(41), day_of_week: 1, start_time: '10:00', end_time: '11:00', week_type: 'all', start_week: 1, end_week: 2 }, 'name'],
    ['courses', { name: 'x', day_of_week: 1, start_time: '10:00', end_time: '11:00', week_type: 'all', start_week: 1, end_week: 2, color: 'red' }, 'color'],
    ['tasks', { title: '交作业', due_date: '2026-13-40', done: false }, 'due_date'],
    ['tasks', { title: '交作业', due_time: '9:30', done: false }, 'due_time'],
    ['tasks', { title: '交作业', duration_min: 5000, done: false }, 'duration_min'],
    ['tasks', { title: 'x', done: 'yes' }, 'done'],
    ['tasks', { title: 'x', category: '打游戏', done: false }, 'category'],
    ['milestones', { project_id: 'not-a-uuid', title: 'x', status: 'active', progress: 0, manual_progress: false }, 'project_id'],
    ['milestones', { project_id: '00000000-0000-4000-8000-000000000000', title: 'x', status: 'active', progress: 120, manual_progress: false }, 'progress'],
    ['workouts', { workout_date: '2026-09-20', type: '跑步', duration_min: 30, status: 'skipped' }, 'status'],
  ];
  for (const [table, input, field] of cases) {
    const result = validateRow(table, input);
    assert.equal(result.ok, false, `${table} 本该拒绝：${JSON.stringify(input)}`);
    assert.equal(result.field, field, `${table} 报错字段应为 ${field}，实际 ${result.field}`);
    assert.ok(typeof result.error === 'string' && result.error.length > 0, `${field} 缺少可读错误文案`);
  }
});

test('S1 契约：缺练这条记录不带时长', () => {
  const missed = validateRow('workouts', { workout_date: '2026-09-19', type: '力量', duration_min: 0, status: 'missed' });
  assert.equal(missed.ok, true, missed.error);
  const inflated = validateRow('workouts', { workout_date: '2026-09-19', type: '力量', duration_min: 30, status: 'missed' });
  assert.equal(inflated.ok, false, '缺练还带 30 分钟，页面里的总时长和分组时长必然对不上');
  assert.equal(inflated.field, 'duration_min', '提示要挂在时长字段上，用户才知道改哪里');
  assert.match(inflated.error, /缺练/, `文案没点名缺练：${inflated.error}`);
  // 编辑路径同理：只把完成度改成缺练，合并后的行仍带着旧时长，也要拦
  const edited = validateRow('workouts', { status: 'missed' }, {
    partial: true, existing: { workout_date: '2026-09-19', type: '力量', duration_min: 30, status: 'done' },
  });
  assert.equal(edited.ok, false, '把一笔 30 分钟改成缺练，不能把 30 分悄悄留在库里');
  // 练过的那两类不受影响
  for (const status of ['done', 'partial']) {
    assert.equal(validateRow('workouts', { workout_date: '2026-09-19', type: '力量', duration_min: 45, status }).ok, true, `${status} 不该被这条规则挡住`);
  }
});

test('S1 validateRow 拒绝未知字段与服务端专属字段', () => {
  assert.equal(validateRow('courses', { name: 'x', password: 'y' }).ok, false);
  assert.equal(validateRow('tasks', { title: 'x', done: false, id: '00000000-0000-4000-8000-000000000000' }).ok, false);
  assert.equal(validateRow('tasks', { title: 'x', done: false, created_at: '2026-01-01T00:00:00Z' }).ok, false);
  assert.equal(validateRow('nope', { a: 1 }).ok, false);
});

test('S1 validateRow 接受合法行并做归一化', () => {
  const result = validateRow('courses', {
    name: '  数据结构  ', teacher: '王老师', location: 'A302', day_of_week: 1,
    start_time: '08:00', end_time: '09:40', week_type: 'odd', start_week: 1, end_week: 16, color: '#3DD6F5',
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.row.name, '数据结构');
  assert.equal(result.row.note, undefined);
  assert.ok(!('id' in result.row));
  for (const column of ['title', 'due_date', 'done']) assert.ok(editableColumns('tasks').includes(column));
});

test('S1 validateRow 在 partial 模式下只校验提交的字段', () => {
  const existing = { title: '交作业', due_date: '2026-09-20', due_time: null, done: false, category: '作业' };
  const result = validateRow('tasks', { done: true }, { partial: true, existing });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.row, { done: true });
  assert.equal(validateRow('tasks', { category: '打游戏' }, { partial: true, existing }).ok, false);
  assert.equal(validateRow('courses', { end_time: '08:00' }, {
    partial: true, existing: { start_time: '08:00', end_time: '09:00' },
  }).ok, false, '跨字段校验应使用合并后的行');
});

test('S1 节次时间表规则：时间递增且不重叠', () => {
  const good = [
    { label: '第1节', start: '08:00', end: '08:45', kind: 'class' },
    { label: '第2节', start: '08:55', end: '09:40', kind: 'class' },
    { label: '午休', start: '12:00', end: '14:00', kind: 'break' },
  ];
  assert.equal(validateRow('semester_config', { start_date: '2026-09-07', total_weeks: 18, periods: good }).ok, true);
  assert.equal(validateRow('semester_config', { start_date: '2026-09-07', total_weeks: 18,
    periods: [...good, { label: '第3节', start: '09:00', end: '09:50', kind: 'class' }] }).ok, false);
  assert.equal(validateRow('semester_config', { start_date: '2026-09-07', total_weeks: 18,
    periods: [{ label: 'x', start: '10:00', end: '09:00', kind: 'class' }] }).ok, false);
  assert.equal(validateRow('semester_config', { start_date: '2026-09-07', total_weeks: 99, periods: good }).ok, false);
});

test('S1 样式表声明了 PRD 2.4 的全部设计 token 且无损坏取值', async () => {
  const css = await read('../../web/styles.css');
  for (const token of ['--void', '--panel', '--line', '--cyan', '--orange', '--green', '--ink-dim', '--red']) {
    assert.match(css, new RegExp(`${token}:\\s*#[0-9a-f]{3,8}`, 'i'), `缺少颜色 token ${token}`);
  }
  for (const token of ['--tap', '--mono', '--sans', '--rail-w', '--tabbar-h']) {
    assert.match(css, new RegExp(`${token}:\\s*[^;]+;`, 'i'), `缺少 token ${token}`);
  }
  assert.match(css, /--tap:\s*44px/, '触控目标需为 44px');
  assert.match(css, /#070B14/i);
  assert.match(css, /#0E1524/i);
  assert.match(css, /#3DD6F5/i);
  assert.ok(css.includes('var(--tap)'), '触控尺寸未使用 --tap');
  // 声明块必须闭合
  assert.equal((css.match(/\{/g) ?? []).length, (css.match(/\}/g) ?? []).length, '花括号不配对');
  // 颜色与长度取值不得写坏
  for (const match of css.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)) {
    const [, prop, value] = match;
    for (const hash of value.match(/#[0-9a-zA-Z]+/g) ?? []) {
      assert.match(hash, /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/,
        `${prop}: ${value} 含非法颜色值 ${hash}`);
    }
    assert.equal(/murky|TODO|FIXME|placeholder/i.test(value), false, `${prop}: ${value} 取值可疑`);
  }
  for (const bp of ['max-width: 1023px', 'max-width: 639px', 'prefers-reduced-motion']) {
    assert.ok(css.includes(bp), `缺少响应式/动效约束 ${bp}`);
  }
});

test('S1 路由表覆盖 6 个页面且与 PRD 2.1 一致', async () => {
  const { ROUTES, parseHash, keyBindings, navRoutes } = await import('../../web/routes.js');
  assert.deepEqual(ROUTES.map((r) => r.key), ['home', 'timetable', 'tasks', 'research', 'workout', 'settings']);
  assert.equal(navRoutes.length, 5, '底部导航应为 5 项');
  assert.equal(keyBindings.length, 6);
  assert.equal(parseHash('').key, 'home');
  assert.equal(parseHash('#/').key, 'home');
  assert.equal(parseHash('#/tasks').key, 'tasks');
  const detail = parseHash('#/research/00000000-0000-4000-8000-000000000000');
  assert.equal(detail.key, 'research');
  assert.equal(detail.sub, '00000000-0000-4000-8000-000000000000');
  assert.equal(parseHash('#/nope').key, 'home');
  assert.equal(parseHash('#/nope').unknown, true);
});

test('S1 dom 构建器不解释 HTML 字符串（防注入）', async () => {
  const source = await read('../../web/lib/dom.js');
  assert.match(source, /throw new Error\('h\(\) 不接受 html/);
  assert.equal(/\.innerHTML\s*=/.test(source), false, '不得使用 innerHTML');
  assert.equal(/document\.write/.test(source), false);
});

test('S1 前端骨架文件存在且可编译', async () => {
  for (const file of ['web/index.html', 'web/styles.css', 'web/lib/dom.js', 'web/routes.js']) {
    assert.ok(existsSync(`${PROJECT}${file}`), `${file} 缺失`);
  }
  const html = await read('../../web/index.html');
  for (const id of ['rail', 'tabbar', 'topbar', 'view', 'modal-root', 'toast-root']) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺少 #${id}`);
  }
  assert.ok(/type="module"/.test(html));
  for (const file of ['web/lib/dom.js', 'web/routes.js']) {
    await assertModuleParses(`${PROJECT}${file}`);
  }
});
