// S5 的界面部分：分段/筛选切换后列表真的换了、逾期行真的给出顺延入口、
// 快速添加的识别读数与最终写出去的字段一致，最后再用真 store + 真 Function 走一遍全链路。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewServer } from '../preview-server.mjs';
import * as T from '../../web/lib/time.js';
import { createApi } from '../../web/lib/api.js';
import { createStore } from '../../web/lib/store.js';
import {
  withDom, seedState, fakeCtx, viewArgs, texts, assertNoBlankLabels, fieldWrap,
  toastTexts, waitUntil, settle,
} from './render-harness.mjs';

const TODAY = '2026-09-20';
const root = () => globalThis.document.getElementById('modal-root');
const openLayers = () => root().querySelectorAll('.layer');
const layerWith = (eyebrow) => openLayers().find((layer) => layer.querySelector('.eyebrow')?.textContent === eyebrow);
const formOf = (layer) => layer.querySelector('form');
const controlOf = (layer, label) => fieldWrap(formOf(layer), label)?.querySelector('input,select,textarea');
const click = (node) => node.click();
const seg = (node, label) => node.querySelectorAll('.seg button').find((item) => item.textContent.startsWith(label));
const segLabel = (node) => node.querySelectorAll('.seg button').find((item) => item.getAttribute('aria-pressed') === 'true')?.textContent;
const heads = (node) => node.querySelectorAll('.group-head h3').map((item) => item.textContent);
const rows = (node) => node.querySelectorAll('.list-row');
const titleOf = (row) => row.querySelector('.title').textContent;
const rowTitles = (node) => rows(node).map(titleOf);
const rowOf = (node, title) => rows(node).find((row) => titleOf(row) === title);
const filterAt = (node, label) => node.querySelectorAll('.filter-item').find((item) => item.textContent === label);
const chipsIn = (row) => row.querySelectorAll('.postpone .chip').map((chip) => chip.textContent);
const type = (input, value) => { input.value = value; input.fire('input'); };
const buttonByText = (node, pattern) => node.querySelectorAll('button').find((item) => pattern.test(item.textContent));
/** 分段状态存在模块里（刷新才回默认），所以每个用例都显式声明从哪一叠看起。 */
const openSegment = (node, label) => {
  const button = seg(node, label);
  assert.ok(button, `分段按钮「${label}」没渲染出来`);
  click(button);
  return node;
};

const withTasks = (tasks) => {
  const base = seedState(TODAY);
  return { ...base, tables: { ...base.tables, tasks } };
};
const task = (title, patch = {}) => ({ id: `t_${title}`, title, done: false, due_date: TODAY, ...patch });

// ── 分段 ──────────────────────────────────────────────────

test('S5 默认落在今日分段：只有逾期与今天的条目，收集箱与下周都不出现', async () => {
  await withDom(async () => {
    const { renderTasks } = await import('../../web/views/tasks.js');
    const { ctx } = fakeCtx();
    const node = renderTasks(viewArgs.tasks(seedState(TODAY), ctx));
    assert.equal(segLabel(node), '今日6', '默认分段应是今日，并带上条数');
    assert.deepEqual(heads(node), ['9月15日 周二 · 已逾期', '9月17日 周四 · 已逾期', '9月18日 周五 · 已逾期', '今天']);
    assert.deepEqual(rowTitles(node), [
      '报销实验器材', '高等数学期中复习', '复现 Transformer 基线',
      '提交课程论文选题', '操作系统实验报告', '预约游泳池',
    ]);
    assert.ok(!texts(node).includes('整理健身数据'), '无日期的收集箱条目不该出现在今日');
    assert.ok(!texts(node).includes('和导师组会汇报'), '明天的条目不该出现在今日');
    assertNoBlankLabels(node, '日程页');
  });
});

test('S5 切到已完成：只看完成项，并且不再挂状态筛选（必然筛出空列表）', async () => {
  await withDom(async () => {
    const { renderTasks } = await import('../../web/views/tasks.js');
    const { ctx } = fakeCtx();
    const node = renderTasks(viewArgs.tasks(seedState(TODAY), ctx));
    click(seg(node, '已完成'));
    assert.equal(segLabel(node), '已完成2');
    assert.deepEqual(rowTitles(node), ['图书馆还书', '数据结构：第 4 章习题'], '按日期分组，早的在前；分段内不再按完成时间排序');
    const columns = node.querySelectorAll('.filters .filter-col h4').map((item) => item.textContent);
    assert.deepEqual(columns, ['分类'], '已完成分段下状态筛选没有意义');
    // 再切回全部，状态筛选要回来
    click(seg(node, '全部'));
    assert.deepEqual(node.querySelectorAll('.filters .filter-col h4').map((item) => item.textContent), ['分类', '状态']);
  });
});

test('S5 分组计数与沉底：未完成在前、已完成划线置灰，组头报 已完成/总数', async () => {
  await withDom(async () => {
    const { renderTasks } = await import('../../web/views/tasks.js');
    const { ctx } = fakeCtx();
    const mixed = [
      task('晚交', { due_time: '23:00' }),
      task('已经交完', { done: true, done_at: `${TODAY}T02:00:00.000Z` }),
      task('早交', { due_time: '08:00' }),
      task('无日期备忘', { due_date: null }),
    ];
    const node = renderTasks(viewArgs.tasks(withTasks(mixed), ctx));
    openSegment(node, '今日');
    assert.deepEqual(rowTitles(node), ['早交', '晚交', '已经交完']);
    const doneRow = rowOf(node, '已经交完');
    assert.ok(doneRow.classList.contains('is-done'), '已完成行要有 is-done，由 CSS 划掉并变暗');
    assert.equal(doneRow.querySelector('.tick').getAttribute('aria-checked'), 'true');
    assert.equal(node.querySelector('.group-head .count').textContent, '1/3');
    // 收集箱只在「全部」里出现，标题单独一组
    click(seg(node, '全部'));
    assert.deepEqual(heads(node), ['今天', '收集箱 · 未定日期']);
    assert.equal(texts(node).split('无日期备忘').length - 1, 1);
  });
});

// ── 筛选与空态 ────────────────────────────────────────────

test('S5 分类 × 状态组合筛选，清除筛选按一次就回到分段全量', async () => {
  await withDom(async () => {
    const { renderTasks } = await import('../../web/views/tasks.js');
    const { ctx } = fakeCtx();
    const node = renderTasks(viewArgs.tasks(seedState(TODAY), ctx));
    click(seg(node, '全部'));
    click(filterAt(node, '科研'));
    assert.equal(rowTitles(node).length, 3);
    assert.ok(rowOf(node, '复现 Transformer 基线'));
    assert.equal(filterAt(node, '科研').getAttribute('aria-pressed'), 'true');
    click(filterAt(node, '逾期'));
    assert.deepEqual(rowTitles(node), ['复现 Transformer 基线']);
    assert.ok(/隐去 9 条/.test(texts(node.querySelector('.controls'))), '全部 10 条只剩 1 条，应说明被筛掉了 9 条');
    click(buttonByText(node, /清除筛选/));
    assert.equal(rowTitles(node).length, 10, '清除筛选后应回到全部 10 条');
    assert.equal(filterAt(node, '全部分类').getAttribute('aria-pressed'), 'true');
  });
});

test('S5 筛到没有结果时给引导，不是白屏；无数据时给新增引导', async () => {
  await withDom(async () => {
    const { renderTasks } = await import('../../web/views/tasks.js');
    const { ctx } = fakeCtx();
    const node = renderTasks(viewArgs.tasks(seedState(TODAY), ctx));
    openSegment(node, '今日');
    click(filterAt(node, '生活'));
    click(filterAt(node, '已完成'));
    assert.equal(node.querySelector('.empty p').textContent, '这些条件下没有条目');
    click(buttonByText(node, /^清除筛选$/));
    assert.equal(segLabel(node), '今日6', '清除筛选只清条件，不换分段');

    const empty = renderTasks(viewArgs.tasks(withTasks([]), ctx));
    assert.equal(empty.querySelector('.empty p').textContent, '还没有日程');
    assert.ok(empty.querySelector('.empty button'));
  });
});

// ── 逾期与顺延（C9）────────────────────────────────────────

test('S5 逾期行：橙色徽标写明逾期几天，并给出三个顺延目标', async () => {
  await withDom(async () => {
    const { renderTasks } = await import('../../web/views/tasks.js');
    const { calls, ctx } = fakeCtx();
    const node = renderTasks(viewArgs.tasks(seedState(TODAY), ctx));
    openSegment(node, '今日');
    const row = rowOf(node, '报销实验器材');
    assert.ok(row.classList.contains('is-overdue'), '逾期行要有 is-overdue（CSS 给橙色左边框）');
    assert.equal(row.querySelector('.badge.orange').textContent, '逾期 5 天');
    assert.deepEqual(chipsIn(row), ['顺延到今天', '顺延到明天', '顺延到下周']);
    assert.deepEqual(chipsIn(rowOf(node, '提交课程论文选题')), [], '未逾期的行不该有顺延入口');

    click(row.querySelectorAll('.postpone .chip')[1]);
    await settle(6);
    assert.equal(calls[0], 'update:tasks');
    assert.deepEqual(calls[1], { due_date: '2026-09-21' });
    assert.ok(toastTexts().some((text) => text.includes('已顺延到 9月21日 周一')), toastTexts().join('|'));
  });
});

test('S5 顺延写回后重绘：该行离开逾期分组，逾期徽标消失', async () => {
  await withDom(async () => {
    const { renderTasks } = await import('../../web/views/tasks.js');
    const { ctx } = fakeCtx();
    const original = seedState(TODAY);
    const target = original.tables.tasks.find((item) => item.title === '报销实验器材');
    const node = openSegment(renderTasks(viewArgs.tasks(original, ctx)), '今日');
    assert.ok(rowOf(node, '报销实验器材'), '顺延前在今日分组里');

    const moved = withTasks(original.tables.tasks.map((item) => (item.id === target.id
      ? { ...item, due_date: T.addDays(TODAY, 1) } : item)));
    const after = openSegment(renderTasks(viewArgs.tasks(moved, ctx)), '今日');
    assert.ok(!rowOf(after, '报销实验器材'), '顺延到明天后仍留在今日分段');
    assert.ok(!heads(after).some((head) => head.includes('9月15日')), '逾期分组应当整组消失');
  });
});

// ── 勾选、表单与删除 ───────────────────────────────────────

test('S5 勾选与取消勾选都同步 done_at，写入的是这一条而不是别的', async () => {
  await withDom(async () => {
    const { renderTasks } = await import('../../web/views/tasks.js');
    const { calls, ctx } = fakeCtx();
    const state = seedState(TODAY);
    const target = state.tables.tasks.find((item) => item.title === '操作系统实验报告');
    // 只看 patch 分不清点的是哪一条，这里把 id 也记下来
    const writes = [];
    const update = ctx.store.update;
    ctx.store.update = async (table, id, patch) => { writes.push({ table, id }); return update(table, id, patch); };
    const node = openSegment(renderTasks(viewArgs.tasks(state, ctx)), '今日');

    click(rowOf(node, '操作系统实验报告').querySelector('.tick'));
    await settle(4);
    assert.equal(calls[0], 'update:tasks');
    assert.equal(calls[1].done, true);
    assert.ok(!Number.isNaN(Date.parse(calls[1].done_at)), '勾选完成要写入完成时间');
    assert.deepEqual(writes[0], { table: 'tasks', id: target.id });

    // 真 store 会写回状态并重绘，第二次点击看到的才是「已完成」的那条；这里手工补上这一步
    Object.assign(target, calls[1]);
    calls.length = 0;
    const again = openSegment(renderTasks(viewArgs.tasks(state, ctx)), '今日');
    click(rowOf(again, '操作系统实验报告').querySelector('.tick'));
    await settle(4);
    assert.deepEqual(calls[1], { done: false, done_at: null }, '取消完成要把完成时间清掉');
    assert.deepEqual(writes[1], { table: 'tasks', id: target.id });
  });
});

test('S5 编辑浮层：字段来自 registry，保存时保留原完成时间，改勾选才换时间', async () => {
  await withDom(async () => {
    const { renderTasks } = await import('../../web/views/tasks.js');
    const { calls, ctx } = fakeCtx();
    // done_at 来自 buildSeed 里的 new Date()：整段只取一次状态，否则两次调用就有毫秒差
    const state = seedState(TODAY);
    const node = openSegment(renderTasks(viewArgs.tasks(state, ctx)), '全部');
    click(rowOf(node, '数据结构：第 4 章习题').querySelector('.iconbtn'));
    const layer = layerWith('TASK');
    assert.equal(layer.querySelector('h2').textContent, '编辑日程');
    assert.deepEqual(formOf(layer).querySelectorAll('.field label').map((item) => item.textContent),
      ['标题', '截止日期', '截止时间', '预计时长(分钟)', '分类', '备注', '完成状态']);
    assert.equal(controlOf(layer, '截止日期').value, '2026-09-19');
    type(controlOf(layer, '备注'), '已交给助教');
    click(layer.querySelectorAll('.layer-foot button').at(-1));
    assert.equal(await waitUntil(() => !openLayers().includes(layer)), true);
    assert.equal(calls[1].done, true);
    assert.equal(calls[1].note, '已交给助教');
    assert.equal(calls[1].done_at, state.tables.tasks.find((item) => item.title === '数据结构：第 4 章习题').done_at,
      '原本已完成不该被这次编辑改时间');

    calls.length = 0;
    click(rowOf(node, '预约游泳池').querySelector('.iconbtn'));
    const second = layerWith('TASK');
    click(buttonByText(second, /^未完成$/));
    click(second.querySelectorAll('.layer-foot button').at(-1));
    await waitUntil(() => !openLayers().includes(second));
    assert.equal(calls[1].done, true);
    assert.ok(calls[1].done_at, '勾选完成后要补上完成时间');
  });
});

test('S5 删除走 store.remove 并给 5 秒撤销，撤销回调接的是同一次删除', async () => {
  await withDom(async () => {
    const { renderTasks } = await import('../../web/views/tasks.js');
    const { calls, ctx } = fakeCtx();
    const node = openSegment(renderTasks(viewArgs.tasks(seedState(TODAY), ctx)), '今日');
    click(rowOf(node, '预约游泳池').querySelector('.iconbtn.danger'));
    assert.ok(calls.includes('remove:tasks'));
    const toastNode = document.getElementById('toast-root').querySelector('.toast');
    assert.equal(toastNode.querySelector('button').textContent, '撤销');
    click(toastNode.querySelector('button'));
    assert.ok(calls.some((item) => String(item).startsWith('undo:')), '撤销按钮没有调 undoRemove');
  });
});

test('S5 完整表单：预填识别到的内容，保存即建条；留空日期就进收集箱', async () => {
  await withDom(async () => {
    const { renderTasks } = await import('../../web/views/tasks.js');
    const { calls, ctx } = fakeCtx();
    const node = renderTasks(viewArgs.tasks(seedState(TODAY), ctx));
    const input = node.querySelector('input');
    type(input, '组会材料 9月25日 14:00 60分钟');
    assert.equal(node.querySelector('.quick-read').textContent, '识别到 9月25日 · 14:00 · 60分钟 → 标题「组会材料」');
    click(buttonByText(node, /^完整表单$/));
    const layer = layerWith('TASK');
    assert.equal(layer.querySelector('h2').textContent, '新增日程');
    assert.equal(controlOf(layer, '标题').value, '组会材料');
    assert.equal(controlOf(layer, '截止日期').value, '2026-09-25');
    assert.equal(controlOf(layer, '截止时间').value, '14:00');
    type(controlOf(layer, '截止日期'), '');
    click(layer.querySelectorAll('.layer-foot button').at(-1));
    await waitUntil(() => !openLayers().includes(layer));
    assert.equal(calls[0], 'create:tasks');
    assert.equal(calls[1].due_date, null, '清空日期就是收集箱，不能偷偷填回今天');
    assert.equal(calls[1].done, false);
    assert.equal(calls[1].done_at, null);
    assert.equal(calls[1].duration_min, 60);
  });
});

// ── 快速添加 ──────────────────────────────────────────────

test('S5 快速添加：识别不到的部分整句留在标题，回车即写今天', async () => {
  await withDom(async () => {
    const { renderTasks } = await import('../../web/views/tasks.js');
    const { calls, ctx } = fakeCtx();
    const node = renderTasks(viewArgs.tasks(seedState(TODAY), ctx));
    const input = node.querySelector('input');
    type(input, '明晚把课件发群里');
    assert.equal(node.querySelector('.quick-read').textContent, '没有识别出日期或时间，整句作为标题');
    input.fire('keydown', { key: 'Enter' });
    await settle(6);
    assert.deepEqual(calls.slice(0, 2), ['create:tasks', {
      title: '明晚把课件发群里', done: false, due_date: TODAY, due_time: null, duration_min: null,
    }]);
    assert.equal(input.value, '', '写入后要清空输入框');
    assert.equal(node.querySelector('.quick-read').textContent.startsWith('只认'), true, '读数要回到提示语');
  });
});

test('S5 快速添加带全三种记号：写出去的就是解析结果，标题里不残留', async () => {
  await withDom(async () => {
    const { renderTasks } = await import('../../web/views/tasks.js');
    const { calls, ctx } = fakeCtx();
    const node = renderTasks(viewArgs.tasks(seedState(TODAY), ctx));
    const input = node.querySelector('input');
    type(input, '实验报告 9月25日 20:00 45分钟');
    input.fire('keydown', { key: 'Enter' });
    await settle(6);
    assert.deepEqual(calls[1], {
      title: '实验报告', done: false, due_date: '2026-09-25', due_time: '20:00', duration_min: 45,
    });
  });
});

test('S5 快速添加不给空标题：只有日期时提示先写内容，不发写请求', async () => {
  await withDom(async () => {
    const { renderTasks } = await import('../../web/views/tasks.js');
    const { calls, ctx } = fakeCtx();
    const node = renderTasks(viewArgs.tasks(seedState(TODAY), ctx));
    const input = node.querySelector('input');
    type(input, '   ');
    input.fire('keydown', { key: 'Enter' });
    await settle(6);
    assert.deepEqual(calls, [], '空白输入不该产生写入');
    assert.equal(node.querySelector('.quick-read').textContent, '先写一句要做什么');
  });
});

// ── 真实后端往返（DEV_PLAN S5 完成标准 1）────────────────────

test('S5 真 store + 真 Function：新增 → 勾选 → 顺延 → 撤销删除，回读后状态保持', async () => {
  const server = createPreviewServer({ port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const api = createApi({ baseUrl: `http://127.0.0.1:${server.address().port}/functions/v1/app` });
  const store = createStore({ api });
  await store.load();
  const today = T.todayKey();
  const time = { today, now: new Date(`${today}T12:00:00`) };
  const title = 'S5 往返验收项';
  try {
    await withDom(async () => {
      const { renderTasks } = await import('../../web/views/tasks.js');
      const ctx = { store, navigate: () => {} };
      const args = () => ({ state: store.state, ctx, time });
      const row = () => rowOf(renderTasks(args()), title);

      // 分段状态是模块内的，切到「全部」以免受前面用例的影响（这条测的是跨分段可见）
      openSegment(renderTasks(args()), '全部');
      const input = renderTasks(args()).querySelector('input');
      type(input, title);
      input.fire('keydown', { key: 'Enter' });
      assert.equal(await waitUntil(() => store.state.tables.tasks.some((item) => item.title === title && !item.id.startsWith('tmp_'))), true, '新增没有落到服务端');
      const id = store.state.tables.tasks.find((item) => item.title === title).id;

      click(row().querySelector('.tick'));
      assert.equal(await waitUntil(() => store.row('tasks', id)?.done === true), true, '勾选未写回服务端');
      assert.ok(store.row('tasks', id).done_at);
      click(row().querySelector('.tick'));
      assert.equal(await waitUntil(() => store.row('tasks', id)?.done === false), true, '取消勾选未写回服务端');
      assert.equal(store.row('tasks', id).done_at, null, '取消勾选要把完成时间清掉');

      // 人为造成逾期：走表单改截止日期
      click(row().querySelector('.iconbtn'));
      const layer = layerWith('TASK');
      type(controlOf(layer, '截止日期'), T.addDays(today, -2));
      click(layer.querySelectorAll('.layer-foot button').at(-1));
      assert.equal(await waitUntil(() => !openLayers().includes(layer)), true);
      assert.equal(await waitUntil(() => store.row('tasks', id).due_date === T.addDays(today, -2)), true);

      const overdue = row();
      assert.ok(overdue.classList.contains('is-overdue'), '改成前天却没标成逾期');
      assert.equal(overdue.querySelector('.badge.orange').textContent, '逾期 2 天');
      click(overdue.querySelectorAll('.postpone .chip')[1]);
      assert.equal(await waitUntil(() => store.row('tasks', id).due_date === T.addDays(today, 1)), true, '顺延没有写回');
      assert.ok(!row().classList.contains('is-overdue'), '顺延后仍在逾期态');

      click(row().querySelector('.iconbtn.danger'));
      assert.equal(await waitUntil(() => !store.state.tables.tasks.some((item) => item.id === id)), true, '删除后界面立刻还有这条');
      const toastNode = document.getElementById('toast-root').querySelector('.toast');
      click(toastNode.querySelector('button'));
      assert.equal(await waitUntil(() => store.state.tables.tasks.some((item) => item.id === id)), true, '撤销没能把条目带回来');

      await store.refresh();
      assert.ok(store.row('tasks', id), '回读后条目应当还在');
      assert.ok(rowOf(renderTasks(args()), title));
    });
  } finally {
    const leftover = store.state.tables.tasks.find((item) => item.title === title);
    if (leftover) await api.remove('tasks', leftover.id);
    server.close();
  }
});
