// S7 完成标准里不需要浏览器的部分：进度算式（自动/手动/差异）、排序原语
// （拖拽与上/下移共用）、级联文案口径，以及三层记录的写入契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRow } from '../../functions/registry.mjs';
import { buildSeed } from '../seed.mjs';
import * as T from '../../web/lib/time.js';

const TODAY = '2026-09-20';
const SEED = buildSeed(new Date(`${TODAY}T12:00:00`));
const PROJECT_A = SEED.research_projects[0].id;
const PROJECT_B = SEED.research_projects[1].id;
const byTitle = (title) => SEED.milestones.find((item) => item.title === title);
const kidsOf = (milestoneId) => SEED.subtasks.filter((item) => item.milestone_id === milestoneId);
const sub = (title, done) => ({ id: title, title, done, milestone_id: 'm1', sort: 0 });

// ── 自动进度（PRD 5.3 规则 1）──────────────────────────────

test('S7 自动进度 = 子任务完成比例：四舍五入到整数百分比，没有子任务算 0', () => {
  assert.equal(T.autoProgress([]), 0, '空清单不能显示成 NaN%');
  assert.equal(T.autoProgress([sub('a', false)]), 0);
  assert.equal(T.autoProgress([sub('a', true)]), 100);
  assert.equal(T.autoProgress([sub('a', true), sub('b', true), sub('c', false), sub('d', false)]), 50);
  assert.equal(T.autoProgress([sub('a', true), sub('b', true), sub('c', false)]), 67, '2/3 要与服务端 syncMilestoneProgress 同为 67');
  assert.equal(T.autoProgress([sub('a', true), sub('b', false), sub('c', false), sub('d', false)]), 25);
});

test('S7 种子里程碑的显示值与库里存的进度一致，客户端与服务端不会各说一套', () => {
  for (const milestone of SEED.milestones) {
    const read = T.milestoneProgress(milestone, kidsOf(milestone.id));
    assert.equal(read.value, milestone.progress, `${milestone.title} 的显示进度对不上库里的值`);
    if (!milestone.manual_progress) {
      assert.equal(read.auto, milestone.progress, `${milestone.title} 的自动算法与服务端不同`);
    }
  }
  assert.equal(byTitle('嵌入式部署与延迟测试').manual_progress, true, '种子里得有一条手动锁定的');
  assert.equal(T.autoProgress(kidsOf(byTitle('嵌入式部署与延迟测试').id)), 0, '它没有子任务，自动值应为 0');
  assert.equal(T.milestoneProgress(byTitle('数据集整理与标注'), kidsOf(byTitle('数据集整理与标注').id)).total, 4);
  assert.equal(T.projectProgress(SEED.milestones.filter((item) => item.project_id === PROJECT_A)), 36,
    '项目进度 = 里程碑平均：round((25+67+15)/3)');
});

test('S7 手动锁：手填值优先显示，与自动值不一致时给出差异提示', () => {
  const milestone = { id: 'm1', progress: 80, manual_progress: true };
  const children = [sub('a', true), sub('b', true), sub('c', false), sub('d', false)];
  const read = T.milestoneProgress(milestone, children);
  assert.deepEqual({ value: read.value, auto: read.auto, manual: read.manual, differs: read.differs },
    { value: 80, auto: 50, manual: true, differs: true });
  assert.deepEqual({ done: read.done, total: read.total }, { done: 2, total: 4 });

  const same = T.milestoneProgress({ id: 'm1', progress: 50, manual_progress: true }, children);
  assert.equal(same.differs, false, '手填值恰好等于自动值时不该喊不一致');

  const auto = T.milestoneProgress({ id: 'm1', progress: 99, manual_progress: false }, children);
  assert.equal(auto.value, 50, '未解锁时库里的旧数字不算数，一切以子任务比例为准');
  assert.equal(auto.manual, false);
  assert.equal(auto.differs, false);

  const missing = T.milestoneProgress({ id: 'm1', progress: null, manual_progress: false }, []);
  assert.equal(missing.value, 0, '进度为空的自动里程碑显示 0%');
});

// ── 排序（DEV_PLAN S7 完成标准 3）──────────────────────────

test('S7 sortRows 与服务端一致：先按 sort，再按 id 兜底', () => {
  const rows = [{ id: 'b', sort: 1 }, { id: 'c', sort: 0 }, { id: 'a', sort: 1 }];
  assert.deepEqual(T.sortRows(rows).map((item) => item.id), ['c', 'a', 'b']);
  assert.deepEqual(T.sortRows(rows).map((item) => item.sort), [0, 1, 1]);
  assert.equal(rows[0].id, 'b', '排序不能改动传入的数组');
  assert.deepEqual(T.sortRows([{ id: 'x' }, { id: 'y', sort: 3 }]).map((item) => item.id), ['x', 'y'],
    '缺 sort 的行按 0 处理，不能抛异常');
});

test('S7 reorder 只做数组搬迁，越界与坏参数原样返回', () => {
  const rows = ['a', 'b', 'c', 'd'];
  assert.deepEqual(T.reorder(rows, 0, 2), ['b', 'c', 'a', 'd'], '取出来后插到目标位');
  assert.deepEqual(T.reorder(rows, 3, 1), ['a', 'd', 'b', 'c']);
  assert.deepEqual(T.reorder(rows, 1, 1), ['a', 'b', 'c', 'd']);
  assert.deepEqual(T.reorder(rows, -1, 2), rows);
  assert.deepEqual(T.reorder(rows, 0, 9), rows);
  assert.deepEqual(T.reorder(rows, null, 2), rows);
  assert.deepEqual(T.reorder(rows, 0, NaN), rows);
  assert.deepEqual(rows, ['a', 'b', 'c', 'd'], '原数组不能被改动');
});

test('S7 sortPatches 只发真正变了的行，并把 sort 收敛成连续序号', () => {
  const rows = [{ id: 'a', sort: 0 }, { id: 'b', sort: 1 }, { id: 'c', sort: 2 }];
  assert.deepEqual(T.sortPatches(rows), [], '已经是 0/1/2 就不必写');
  assert.deepEqual(T.sortPatches(T.reorder(rows, 0, 1)), [
    { id: 'b', sort: 0 }, { id: 'a', sort: 1 },
  ], '相邻交换只牵动两行');
  const sparse = [{ id: 'a', sort: 4 }, { id: 'b', sort: 9 }, { id: 'c', sort: 12 }];
  assert.deepEqual(T.sortPatches(sparse), [
    { id: 'a', sort: 0 }, { id: 'b', sort: 1 }, { id: 'c', sort: 2 },
  ], '稀疏的 sort 会在第一次重排时被收敛，此后不再重复写');
  assert.deepEqual(T.sortPatches(T.reorder(sparse, 2, 0)), [
    { id: 'c', sort: 0 }, { id: 'a', sort: 1 }, { id: 'b', sort: 2 },
  ], '顶到最前要重排三行');
});

// ── 三层写入契约（字段只能来自 registry）───────────────────

test('S7 新建里程碑/子任务的载荷只带表单字段也能通过 Function 校验', () => {
  const milestone = {
    project_id: PROJECT_A, title: '消融实验', target_date: null,
    status: 'not_started', progress: 0, manual_progress: false,
  };
  const ok = validateRow('milestones', milestone, { allowServer: true });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.row.target_date, null, '清空的可选日期按 null 存，不能留空串');

  assert.equal(validateRow('milestones', { ...milestone, manual_progress: 'false' }, { allowServer: true }).ok, false,
    '布尔列交字符串会被拒');
  assert.equal(validateRow('milestones', { ...milestone, progress: 101 }, { allowServer: true }).ok, false,
    '进度超出 0–100 会被拒');
  assert.equal(validateRow('milestones', { ...milestone, sort: '2' }, { allowServer: true }).ok, false,
    'sort 必须是数字');
  assert.equal(validateRow('milestones', { ...milestone, status: 'pausing' }, { allowServer: true }).ok, false,
    '状态四态之外不接受');

  const child = { milestone_id: '00000000-0000-4000-8000-000000000000', title: '跑第二轮', done: false };
  assert.equal(validateRow('subtasks', child, { allowServer: true }).ok, true);
  assert.equal(validateRow('subtasks', { ...child, done: undefined }, { allowServer: true }).ok, false,
    '必填的完成状态不能缺');
  const project = { name: '新课题', description: null, status: 'active' };
  assert.equal(validateRow('research_projects', project, { allowServer: true }).ok, true);
  assert.equal(validateRow('research_projects', { ...project, project_id: PROJECT_B }, { allowServer: true }).ok, false,
    '白名单外的字段要挡在客户端');
});

test('S7 时间线只画本项目自己的里程碑，首页近期里程碑跨项目取最近三个未完成', () => {
  const mine = T.sortRows(SEED.milestones.filter((item) => item.project_id === PROJECT_A));
  assert.deepEqual(mine.map((item) => item.title), ['数据集整理与标注', '基线模型复现', '嵌入式部署与延迟测试']);
  assert.deepEqual(T.recentMilestones(SEED.milestones, 3).map((item) => item.title),
    ['数据集整理与标注', '能耗数据接入', '基线模型复现'],
    '已完成的排除在外，其余按目标日由近到远（种子里四条都排在将来）');
  const done = SEED.milestones.map((item) => ({ ...item, status: 'done' }));
  assert.deepEqual(T.recentMilestones(done, 3), [], '全部完成后首页不再催');
});

test('S7 剩余天数：目标日已过要读成逾期，未定目标日不参与催办', () => {
  assert.equal(T.remainingDays('2026-09-23', TODAY), 3);
  assert.equal(T.remainingDays('2026-09-17', TODAY), -3);
  assert.equal(T.remainingDays(TODAY, TODAY), 0, '今天到期是 0 天，不是逾期');
  assert.equal(T.remainingDays(null, TODAY), null);
  assert.deepEqual(SEED.milestones.map((item) => item.target_date > TODAY), [true, true, true, true],
    '种子里四条目标日都在将来，卡片上才会显示"最近目标 N 天后"');
});
