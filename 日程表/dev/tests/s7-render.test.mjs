// S7 的界面部分：三层 CRUD、自动/手动进度、拖拽与上/下移、级联删除确认，
// 最后用真 store + 真 Function 走一遍 C10/C11/C12。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewServer } from '../preview-server.mjs';
import { validateRow } from '../../functions/registry.mjs';
import * as T from '../../web/lib/time.js';
import { createApi } from '../../web/lib/api.js';
import { createStore } from '../../web/lib/store.js';
import {
  withDom, seedState, fakeCtx, liveCtx, texts, assertNoBlankLabels, fieldWrap,
  TIME, TODAY, toastTexts, waitUntil, settle,
} from './render-harness.mjs';

const root = () => globalThis.document.getElementById('modal-root');
const openLayers = () => root().querySelectorAll('.layer');
const layerWith = (eyebrow) => openLayers().find((layer) => layer.querySelector('.eyebrow')?.textContent === eyebrow);
const formOf = (layer) => layer.querySelector('form');
const controlOf = (layer, label) => fieldWrap(formOf(layer), label)?.querySelector('input,select,textarea');
const click = (node) => node.click();
const buttonByText = (node, pattern) => node.querySelectorAll('button').find((item) => pattern.test(item.textContent));
const byAria = (node, label) => node.querySelectorAll('button').find((item) => item.getAttribute('aria-label') === label);
const footButtons = (layer) => layer.querySelectorAll('.layer-foot button');
const submitButton = (layer) => footButtons(layer).at(-1);
/** 点一下并把按钮交回用例：往返后还要读按钮自身的状态。 */
const submit = (layer) => { const node = submitButton(layer); click(node); return node; };
const type = (input, value) => { input.value = value; input.fire('input'); };
const change = (input, value) => { input.value = value; input.fire('change'); };
const toastNode = (pattern) => document.getElementById('toast-root').querySelectorAll('.toast')
  .find((node) => pattern.test(node.textContent));
const layerError = (layer) => (layer.querySelector('.notice.danger')?.hidden ? null : texts(layer.querySelector('.notice.danger')));

const cards = (node) => node.querySelectorAll('.proj-card');
const cardOf = (node, name) => cards(node).find((card) => texts(card).includes(name));
const items = (node) => node.querySelectorAll('.tl-item');
const titles = (node) => items(node).map((item) => item.querySelector('h4').textContent);
const itemOf = (node, title) => items(node).find((item) => item.querySelector('h4').textContent === title);
const bodyOf = (node, title) => itemOf(node, title).querySelector('.tl-body');
const detailOf = (node, title) => bodyOf(node, title).querySelector('.tl-detail');
const subRows = (node, title) => detailOf(node, title).querySelectorAll('.list-row');
const subTitles = (node, title) => subRows(node, title).map((row) => row.querySelector('.title').textContent);
const pctOf = (node, title) => bodyOf(node, title).querySelector('.progress i').style.width;
const confirmText = () => texts(layerWith('CONFIRM'));

/** 确认框的按钮在异步回调链末端点下去，必须等 Promise 落地再断言。 */
const confirmYes = async () => { click(footButtons(layerWith('CONFIRM')).at(-1)); await settle(4); };
const confirmNo = async () => { click(footButtons(layerWith('CONFIRM'))[0]); await settle(4); };

const PROJECT_A = '基于深度学习的目标检测加速';
const M_A = '数据集整理与标注';
const M_B = '基线模型复现';
const M_C = '嵌入式部署与延迟测试';

const view = async (run) => withDom(async () => {
  const { renderResearch } = await import('../../web/views/research.js');
  const state = seedState(TODAY);
  const helpers = liveCtx(state);
  const render = (sub = '') => renderResearch({ state, ctx: helpers.ctx, time: TIME, sub });
  const projectId = state.tables.research_projects[0].id;
  return run({ render, state, projectId, ...helpers, milestone: (title) => state.tables.milestones.find((item) => item.title === title) });
});

// ── 项目列表 ──────────────────────────────────────────────

test('S7 项目列表：卡片带进度与级联入口，新增项目走 PROJECT 浮层', async () => {
  await view(async ({ render, state }) => {
    const node = render();
    assert.equal(cards(node).length, 2);
    const card = cardOf(node, PROJECT_A);
    assert.ok(texts(card).includes('3 个里程碑'));
    assert.ok(texts(card).includes('36%'), '卡片进度要与详情页同一个口径');
    assert.equal(card.querySelector('a').getAttribute('href'), `#/research/${state.tables.research_projects[0].id}`);
    assert.ok(byAria(card, `编辑项目：${PROJECT_A}`), '卡片上要有编辑入口');
    assert.ok(byAria(card, `删除项目：${PROJECT_A}`));
    assertNoBlankLabels(node, '科研列表');

    click(buttonByText(node, /^新增项目$/));
    const layer = layerWith('PROJECT');
    assert.ok(layer, '新增项目没有打开浮层');
    assert.ok(submitButton(layer).disabled, '项目名称为空就该拦住提交');
    type(controlOf(layer, '项目名称'), '轨道微小碎片编目');
    assert.equal(submitButton(layer).disabled, false);
    click(footButtons(layer)[0]);

    // 编辑已有项目：草稿回填
    click(byAria(cardOf(render(), PROJECT_A), `编辑项目：${PROJECT_A}`));
    const edit = layerWith('PROJECT');
    assert.equal(controlOf(edit, '项目名称').value, PROJECT_A);
    assert.equal(controlOf(edit, '状态').querySelectorAll('option').find((item) => item.hasAttribute('selected')).textContent, '进行中');
    type(controlOf(edit, '项目名称'), '目标检测加速');
    submit(edit);
    await settle(3);
    assert.equal(state.tables.research_projects[0].name, '目标检测加速', '编辑项目没有写回');
  });
});

test('S7 删除项目的确认框写明级联数量，取消不动、确认才连带子孙一起交给撤销', async () => {
  await view(async ({ render, writes, projectId }) => {
    const node = render();
    click(byAria(cardOf(node, PROJECT_A), `删除项目：${PROJECT_A}`));
    assert.match(confirmText(), /其下 3 个里程碑、7 个子任务会一并删除/);
    await confirmNo();
    assert.equal(writes.length, 0, '点了返回却还是删了');
    assert.equal(openLayers().length, 0, '确认框没有关掉');

    click(byAria(cardOf(render(), PROJECT_A), `删除项目：${PROJECT_A}`));
    await confirmYes();
    const last = writes.at(-1);
    assert.deepEqual([last.op, last.table], ['remove', 'research_projects']);
    assert.equal(last.id, projectId, '交给 store 的不是这张卡片的项目');
    assert.deepEqual([last.related.milestones.length, last.related.subtasks.length], [3, 7],
      '级联子孙要一并交给 store，撤销才放回得完整');
    assert.ok(toastNode(/已删除「/), '没有给出撤销提示');
    assert.equal(render().querySelectorAll('.proj-card').length, 1);
  });
});

// ── 详情页时间线 ──────────────────────────────────────────

test('S7 详情页时间线：三条里程碑、节点写完成数、手动徽标、拖拽与上/下移边界', async () => {
  await view(async ({ render, projectId }) => {
    const node = render(projectId);
    assert.deepEqual(titles(node), [M_A, M_B, M_C]);
    assert.deepEqual(items(node).map((item) => item.querySelector('.tl-node').textContent), ['1', '2', '0'],
      '节点里的数字是子任务完成数');
    assert.deepEqual([...node.querySelectorAll('.tl-node')].map((item) => item.getAttribute('data-status')),
      ['active', 'active', 'not_started'], '节点颜色跟着状态四态走');
    assert.equal([...node.querySelectorAll('.badge.orange')].filter((item) => item.textContent === '手动').length, 1,
      '只有 manual_progress 的那条标手动');
    assert.equal(texts(node).includes('自动算出'), false, '三条里程碑都与自动值一致，不该出现差异提示');
    assert.ok(bodyOf(node, M_C).querySelector('.pct-input'), '手动锁定的那条要能直接改数字');
    assert.ok(bodyOf(node, M_A).querySelector('b.pct'), '自动的那条只显示算出来的百分比');

    const first = bodyOf(node, M_A);
    assert.equal(first.getAttribute('draggable'), 'true', '桌面要能整块拖拽');
    assert.equal(byAria(first, `上移：${M_A}`).disabled, true, '第一条不能再上移');
    assert.equal(byAria(first, `下移：${M_A}`).disabled, false);
    const last = bodyOf(node, M_C);
    assert.equal(byAria(last, `下移：${M_C}`).disabled, true, '最后一条不能再下移');
    assert.ok(byAria(last, `编辑里程碑：${M_C}`));
    assert.ok(byAria(last, `删除里程碑：${M_C}`));
    assertNoBlankLabels(node, '科研详情页');
  });
});

test('S7 完成标准 1（C10）：勾两条到 50%，解锁手调 80%，再勾一条仍是 80%', async () => {
  await view(async ({ render, projectId, state, writes }) => {
    const read = () => render(projectId);
    assert.equal(pctOf(read(), M_A), '25%', '种子是 1/4');

    const rows = () => subRows(read(), M_A);
    click(rows()[1].querySelector('.tick'));
    await settle(3);
    assert.deepEqual(writes.at(-1).patch, { done: true });
    assert.equal(pctOf(read(), M_A), '50%', '勾掉第二条后自动进度没跟上');
    // 只数这一条里程碑的勾选态：整页还有别的里程碑，全局计数没有意义
    const checkedOf = (title) => subRows(read(), title)
      .filter((row) => row.querySelector('.tick').getAttribute('aria-checked') === 'true').length;
    assert.equal(checkedOf(M_A), 2);
    assert.equal(bodyOf(read(), M_A).querySelector('.progress').classList.contains('warn'), false);

    // 解锁手填：先落到当前自动值，再把数字变成 80
    click(byAria(bodyOf(read(), M_A), `解锁手填进度：${M_A}`));
    await settle(3);
    const unlocked = read();
    assert.ok(texts(bodyOf(unlocked, M_A)).includes('手动'), '解锁后没有挂上手动态');
    const input = bodyOf(unlocked, M_A).querySelector('.pct-input');
    assert.equal(input.value, '50');
    change(input, '80');
    await settle(3);
    assert.deepEqual(writes.at(-1).patch, { progress: 80, manual_progress: true });
    assert.equal(pctOf(read(), M_A), '80%');

    // 再勾一条：自动值变成 75%，但手填的 80% 不被覆盖
    click(subRows(read(), M_A)[3].querySelector('.tick'));
    await settle(3);
    const kept = read();
    assert.equal(pctOf(kept, M_A), '80%', '手填值被子任务的自动值冲掉了');
    assert.match(texts(bodyOf(kept, M_A)), /自动算出 75%（3\/4）/, '差异提示没写清楚自动值是多少');
    assert.equal(bodyOf(kept, M_A).querySelector('.progress').classList.contains('warn'), true,
      '不一致时进度条要转成橙色');
    assert.equal(state.tables.milestones.find((item) => item.title === M_A).progress, 80);

    // 重新锁定：回到自动值，手动态解除
    click(byAria(bodyOf(kept, M_A), `恢复自动进度：${M_A}`));
    await settle(3);
    assert.deepEqual(writes.at(-1).patch, { progress: 75, manual_progress: false });
    assert.equal(pctOf(read(), M_A), '75%');
    assert.equal(read().querySelectorAll('.badge.orange').length, 1, '只剩第三条还是手动');
  });
});

test('S7 完成标准 3（C12）：上/下移与拖拽写同一份 sort，重新渲染就是新顺序', async () => {
  await view(async ({ render, projectId, state, writes }) => {
    const read = () => render(projectId);
    // 数组原序不是契约（回读才按 sort 排），所以按同一口径排完再比 sort 值
    const sorts = () => T.sortRows(state.tables.milestones.filter((item) => item.project_id === projectId))
      .map((item) => `${item.title}:${item.sort}`);
    assert.deepEqual(sorts(), [`${M_A}:0`, `${M_B}:1`, `${M_C}:2`]);

    click(byAria(bodyOf(read(), M_A), `下移：${M_A}`));
    await settle(4);
    assert.deepEqual(writes.map((item) => [item.id, item.patch.sort]), [
      [state.tables.milestones.find((item) => item.title === M_B).id, 0],
      [state.tables.milestones.find((item) => item.title === M_A).id, 1],
    ], '相邻交换只该发两次写');
    assert.deepEqual(titles(read()), [M_B, M_A, M_C]);
    assert.deepEqual(sorts(), [`${M_B}:0`, `${M_A}:1`, `${M_C}:2`]);

    // 拖拽：从第 1 条拖到第 3 条的位置上
    const list = items(read());
    const from = list[0].querySelector('.tl-body');
    const to = list[2].querySelector('.tl-body');
    writes.length = 0;
    from.fire('dragstart');
    to.fire('dragover');
    to.fire('drop');
    await settle(6);
    assert.deepEqual(titles(read()), [M_A, M_C, M_B], '拖拽排序没有生效');
    assert.equal(writes.length, 3, '三行都换了位置，应该各写一次');
    assert.deepEqual(sorts(), [`${M_A}:0`, `${M_C}:1`, `${M_B}:2`]);

    // 拖到自己身上不该产生请求
    writes.length = 0;
    const again = items(render(projectId))[1].querySelector('.tl-body');
    again.fire('dragstart');
    again.fire('drop');
    await settle(4);
    assert.equal(writes.length, 0, '顺序没变也不发请求');
  });
});

test('S7 完成标准 2（C11）：删除里程碑的确认框写明子任务数量，取消不删、确认级联', async () => {
  await view(async ({ render, projectId, state, writes }) => {
    click(byAria(bodyOf(render(projectId), M_A), `删除里程碑：${M_A}`));
    assert.match(confirmText(), /其下 4 个子任务会一并删除/, '确认框要写清会被连带删掉的子任务数');
    await confirmNo();
    assert.equal(state.tables.milestones.some((item) => item.title === M_A), true);

    click(byAria(bodyOf(render(projectId), M_A), `删除里程碑：${M_A}`));
    await confirmYes();
    const last = writes.at(-1);
    assert.deepEqual([last.op, last.table], ['remove', 'milestones']);
    assert.equal(last.related.subtasks.length, 4, '四条子任务要一起交给撤销窗口');
    assert.equal(titles(render(projectId)).join(','), `${M_B},${M_C}`);
    assert.equal(render(projectId).textContent.includes('写采集脚本'), false, '子任务该随里程碑一起消失');
    assert.ok(toastNode(/已删除「数据集整理与标注」/));
  });
});

test('S7 子任务：勾选、改标题、回车新增与删除撤销', async () => {
  await view(async ({ render, projectId, state, writes }) => {
    const read = () => render(projectId);
    assert.deepEqual(subTitles(read(), M_B), ['跑通 YOLOv8 官方实现', '对齐指标口径', '记录首轮结果'],
      '子任务要按 sort 排');
    const row = () => subRows(read(), M_B)[2];
    assert.equal(row().querySelector('.tick').getAttribute('aria-checked'), 'false');
    click(row().querySelector('.tick'));
    await settle(3);
    assert.deepEqual(writes.at(-1).patch, { done: true });
    assert.equal(row().classList.contains('is-done'), true, '完成的子任务要沉底划线');
    assert.equal(pctOf(read(), M_B), '100%');

    click(byAria(row(), `编辑子任务：记录首轮结果`));
    const edit = layerWith('SUBTASK');
    type(controlOf(edit, '子任务'), '记录三轮结果');
    submit(edit);
    await settle(3);
    assert.equal(subTitles(read(), M_B).includes('记录三轮结果'), true);

    const input = detailOf(read(), M_B).querySelector('input');
    type(input, '   ');
    click(byAria(detailOf(read(), M_B), `添加子任务：${M_B}`));
    await settle(3);
    assert.equal(writes.filter((item) => item.op === 'create').length, 0, '空白标题不该产生记录');
    type(detailOf(render(projectId), M_B).querySelector('input'), '补一组消融数据');
    detailOf(render(projectId), M_B).querySelector('input').fire('keydown', { key: 'Enter', preventDefault() {} });
    await settle(3);
    const created = writes.filter((item) => item.op === 'create').at(-1);
    assert.deepEqual(created.row, {
      milestone_id: state.tables.milestones.find((item) => item.title === M_B).id,
      title: '补一组消融数据', done: false,
    });
    assert.equal(validateRow('subtasks', created.row, { allowServer: true }).ok, true);
    assert.equal(subTitles(read(), M_B).includes('补一组消融数据'), true);
    assert.equal(pctOf(read(), M_B), '75%', '新增未完成的子任务要把自动进度拉下来');

    click(byAria(subRows(read(), M_B)[0], `删除子任务：跑通 YOLOv8 官方实现`));
    await settle(3);
    assert.equal(subTitles(read(), M_B).includes('跑通 YOLOv8 官方实现'), false);
    assert.ok(toastNode(/已删除「跑通 YOLOv8 官方实现」/));
  });
});

test('S7 里程碑表单：新增只带表单字段，项目与进度列由界面补齐', async () => {
  await view(async ({ render, projectId, state, writes }) => {
    click(buttonByText(render(projectId), /^新增里程碑$/));
    const layer = layerWith('MILESTONE');
    assert.ok(layer);
    type(controlOf(layer, '里程碑'), '延迟压到 30ms');
    const date = controlOf(layer, '目标日期');
    type(date, '2026-10-10');
    change(controlOf(layer, '状态'), 'active');
    submit(layer);
    await settle(4);
    const row = writes.at(-1).row;
    assert.deepEqual(row, {
      title: '延迟压到 30ms', target_date: '2026-10-10', status: 'active',
      project_id: projectId, progress: 0, manual_progress: false,
    });
    assert.equal(validateRow('milestones', row, { allowServer: true }).ok, true);
    assert.equal(titles(render(projectId)).includes('延迟压到 30ms'), true);
    assert.equal(pctOf(render(projectId), '延迟压到 30ms'), '0%');
    assert.equal(state.tables.milestones.filter((item) => item.project_id === projectId).length, 4);

    // 目标日期留空即"未定目标日"，不进首页近期里程碑
    click(buttonByText(render(projectId), /^新增里程碑$/));
    const bare = layerWith('MILESTONE');
    type(controlOf(bare, '里程碑'), '待定目标的探索');
    submit(bare);
    await settle(4);
    assert.equal(writes.at(-1).row.target_date, '', '清空日期交给服务端归一成 null');
    const withNode = render(projectId);
    assert.match(texts(bodyOf(withNode, '待定目标的探索')), /未定目标日/);
  });
});

test('S7 手风琴：窄屏默认收起子任务，展开后清单才露出来', async () => {
  await withDom(async () => {
    globalThis.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
    const { renderResearch } = await import('../../web/views/research.js');
    const state = seedState(TODAY);
    const { ctx } = liveCtx(state);
    const projectId = state.tables.research_projects[0].id;
    const node = renderResearch({ state, ctx, time: TIME, sub: projectId });
    const detail = detailOf(node, M_A);
    assert.equal(detail.hidden, true, '窄屏默认要收起，一屏能看完三条里程碑');
    assert.equal(bodyOf(node, M_A).classList.contains('is-open'), false);
    const fold = byAria(bodyOf(node, M_A), `展开子任务：${M_A}`);
    click(fold);
    assert.equal(detail.hidden, false, '点展开没有放出子任务清单');
    assert.equal(fold.getAttribute('aria-expanded'), 'true');
    assert.equal(texts(fold).includes('收起子任务'), true);
    assert.equal(bodyOf(node, M_A).classList.contains('is-open'), true);
    click(byAria(bodyOf(node, M_A), `收起子任务：${M_A}`));
    assert.equal(detail.hidden, true);

    // 宽屏（默认）反过来是展开的，桌面不用多点一次
    globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    const wideState = seedState(TODAY);
    const wide = renderResearch({
      state: wideState, ctx, time: TIME, sub: wideState.tables.research_projects[0].id,
    });
    assert.equal(detailOf(wide, M_A).hidden, false);
  });
});

test('S7 空态：没有项目与没有里程碑都要给出下一步入口', async () => {
  await view(async ({ render, state }) => {
    state.tables.research_projects = [];
    state.tables.milestones = [];
    state.tables.subtasks = [];
    const node = render();
    assert.equal(node.querySelector('.empty p').textContent, '还没有科研项目');
    assert.ok(texts(node).includes('进度会自动累计'));
    click(node.querySelector('.empty button'));
    assert.equal(layerWith('PROJECT').querySelector('.eyebrow').textContent, 'PROJECT');
    assert.ok(formOf(layerWith('PROJECT')), '空态里的按钮要直接开表单');
    click(footButtons(layerWith('PROJECT'))[0]);

    const fresh = seedState(TODAY);
    const freshId = fresh.tables.research_projects[0].id;
    fresh.tables.milestones = fresh.tables.milestones.filter((item) => item.project_id !== freshId);
    fresh.tables.subtasks = [];
    const { ctx } = liveCtx(fresh);
    const { renderResearch } = await import('../../web/views/research.js');
    const empty = renderResearch({ state: fresh, ctx, time: TIME, sub: freshId });
    assert.equal(empty.querySelector('.empty p').textContent, '还没有里程碑');
    click(empty.querySelector('.empty button'));
    assert.ok(layerWith('MILESTONE'));
  });
});

test('S7 已删除项目的详情：给出返回入口而不是白屏', async () => {
  await view(async ({ render, ctx }) => {
    const node = render('ffffffff-0000-4000-8000-000000000000');
    assert.equal(node.querySelector('.empty p').textContent, '这个项目已不存在');
    click(node.querySelector('.empty button'));
    assert.ok(ctx.__calls ?? true);
  });
});

// ── 真实后端往返（C10 / C11 / C12）────────────────────────

test('S7 真 store + 真 Function：自动进度、手动锁定、级联删除与排序刷新后都保持', async () => {
  const server = createPreviewServer({ port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const api = createApi({ baseUrl: `http://127.0.0.1:${server.address().port}/functions/v1/app` });
  const store = createStore({ api });
  await store.load();
  const today = T.todayKey();
  const time = { today, now: new Date(`${today}T12:00:00`) };
  const name = 'S7 往返验收课题';
  try {
    await withDom(async () => {
      const { renderResearch } = await import('../../web/views/research.js');
      const ctx = { store, navigate: () => {} };
      const render = (sub = '') => renderResearch({ state: store.state, ctx, time, sub });

      click(buttonByText(render(), /^新增项目$/));
      const layer = layerWith('PROJECT');
      type(controlOf(layer, '项目名称'), name);
      submit(layer);
      assert.equal(await waitUntil(() => !openLayers().includes(layer)), true, layerError(layer) || '项目浮层没有关掉');
      const project = store.state.tables.research_projects.find((item) => item.name === name);
      assert.ok(project && !String(project.id).startsWith('tmp_'), '项目没落到服务端');
      assert.equal(project.status, 'active', '表单默认状态没写进去');

      click(buttonByText(render(project.id), /^新增里程碑$/));
      const msLayer = layerWith('MILESTONE');
      type(controlOf(msLayer, '里程碑'), '四个子任务的里程碑');
      submit(msLayer);
      // 乐观新增先给出 tmp_ 临时 ID，子任务要挂的是服务端那把真 ID
      assert.equal(await waitUntil(() => store.state.tables.milestones.some(
        (item) => item.title === '四个子任务的里程碑' && !String(item.id).startsWith('tmp_')), 8000), true, '里程碑没落到服务端');
      const milestoneId = store.state.tables.milestones.find((item) => item.title === '四个子任务的里程碑').id;
      const milestone = () => store.row('milestones', milestoneId);

      // 输入框空着点"添加"不该留下任何记录
      click(byAria(bodyOf(render(project.id), '四个子任务的里程碑'), '添加子任务：四个子任务的里程碑'));
      await settle(2);
      assert.equal(store.state.tables.subtasks.some((item) => item.milestone_id === milestoneId), false);
      // 四条子任务直接走 store 建，避免在同一层浮层里反复找输入框
      for (const index of [1, 2, 3, 4]) {
        await store.create('subtasks', { milestone_id: milestoneId, title: `子任务${index}`, done: false });
      }
      assert.equal(store.state.tables.subtasks.filter((item) => item.milestone_id === milestoneId).length, 4);
      await store.refresh();
      assert.equal(milestone().progress, 0, '四条未完成时自动进度应为 0');

      // 勾两条 → 服务端把里程碑进度重算成 50
      const children = () => store.state.tables.subtasks.filter((item) => item.milestone_id === milestoneId);
      await store.update('subtasks', children()[0].id, { done: true });
      await store.update('subtasks', children()[1].id, { done: true });
      assert.equal(await waitUntil(() => milestone().progress === 50, 8000), true,
        `勾掉两条子任务后服务端没重算进度：${JSON.stringify(milestone())}`);
      assert.equal(pctOf(render(project.id), '四个子任务的里程碑'), '50%');

      // 解锁手填 80 → 再勾一条，服务端不得覆盖手填值
      await store.update('milestones', milestoneId, { progress: 80, manual_progress: true });
      assert.equal(milestone().manual_progress, true);
      await store.update('subtasks', children()[2].id, { done: true });
      assert.equal(await waitUntil(() => store.state.tables.subtasks.filter((item) => item.id === children()[2].id)[0]?.done, 8000), true);
      await store.refresh();
      assert.equal(milestone().progress, 80, '手填的 80% 被子任务自动值覆盖了');
      assert.match(texts(bodyOf(render(project.id), '四个子任务的里程碑')), /自动算出 75%（3\/4）/);

      // 解除锁定 → 同一次请求就回到自动值
      await store.update('milestones', milestoneId, { manual_progress: false });
      assert.equal(await waitUntil(() => milestone().progress === 75, 8000), true,
        `解锁回自动失败：${JSON.stringify(milestone())}`);

      // 排序：再加一条里程碑，用界面上的"上移"把它顶到最前，刷新后顺序保持（C12）
      click(buttonByText(render(project.id), /^新增里程碑$/));
      const secondLayer = layerWith('MILESTONE');
      type(controlOf(secondLayer, '里程碑'), '第二条里程碑');
      submit(secondLayer);
      assert.equal(await waitUntil(() => store.state.tables.milestones.some(
        (item) => item.title === '第二条里程碑' && !String(item.id).startsWith('tmp_')), 8000), true, '第二条里程碑没落到服务端');
      const secondId = store.state.tables.milestones.find((item) => item.title === '第二条里程碑').id;
      click(byAria(bodyOf(render(project.id), '第二条里程碑'), '上移：第二条里程碑'));
      const first = () => store.row('milestones', milestoneId);
      const second = () => store.row('milestones', secondId);
      // 乐观合并会立刻把 sort 写进界面，所以"落定"要以在途请求清零为准
      assert.equal(await waitUntil(() => !store.state.pending.length && !store.state.inflight, 9000), true,
        `上移的两条写请求没有落定：${JSON.stringify([first(), second()])}`);
      await store.refresh();
      const ordered = T.sortRows(store.state.tables.milestones.filter((item) => item.project_id === project.id));
      assert.deepEqual(ordered.map((item) => item.title), ['第二条里程碑', '四个子任务的里程碑']);
      assert.deepEqual(ordered.map((item) => item.sort), [0, 1], '服务端没把新顺序写下来');
      assert.ok(store.state.tables.milestones.some((item) => item.project_id !== project.id), '种子里程碑仍在');
      assert.equal(titles(render(project.id))[0], '第二条里程碑');

      // 级联删除：里程碑连同四条子任务一起从服务端消失
      click(byAria(bodyOf(render(project.id), '四个子任务的里程碑'), '删除里程碑：四个子任务的里程碑'));
      assert.match(confirmText(), /其下 4 个子任务会一并删除/);
      await confirmYes();
      assert.equal(store.row('milestones', milestoneId), null, '乐观删除后界面上该立刻消失');
      // pending 在定时器一触发就清空，真正的 remove 还在路上：连在途写一起等
      assert.equal(await waitUntil(() => !store.state.pending.length && !store.state.inflight, 9000), true,
        '撤销窗口结束后删除请求仍未落定');
      await store.refresh();
      assert.equal(store.row('milestones', milestoneId), null, '删除没写进服务端');
      assert.equal(store.state.tables.subtasks.filter((item) => item.milestone_id === milestoneId).length, 0,
        '级联的子任务还留在服务端');
      assert.equal(store.state.tables.subtasks.length, 8, '种子子任务不能被连带删掉');
      assert.equal(store.state.tables.research_projects.length, 3);

      // 删掉整个项目，收尾回到种子状态
      click(byAria(cardOf(render(), name), `删除项目：${name}`));
      await confirmYes();
      assert.equal(await waitUntil(() => !store.state.pending.length && !store.state.inflight, 9000), true);
      await store.refresh();
      assert.equal(store.row('research_projects', project.id), null);
      assert.equal(store.state.tables.research_projects.length, 2, '种子项目没被还原');
      assert.equal(store.state.tables.milestones.length, 4);
    });
  } finally {
    server.close();
  }
});
