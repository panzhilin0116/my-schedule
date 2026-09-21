// S6 的界面部分：三视图与周次切换真的换了画面、pref 写对且刷新后保持、
// 空白时段预填、冲突橙色警告与并排红描边、详情/编辑/删除撤销，最后真 store + 真 Function 走一遍。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewServer } from '../preview-server.mjs';
import { validateRow } from '../../functions/registry.mjs';
import * as T from '../../web/lib/time.js';
import { createApi } from '../../web/lib/api.js';
import { createStore } from '../../web/lib/store.js';
import {
  withDom, seedState, emptyAppState, fakeCtx, texts, assertNoBlankLabels, fieldWrap,
  TIME, TODAY, toastTexts, waitUntil, settle,
} from './render-harness.mjs';

const root = () => globalThis.document.getElementById('modal-root');
const openLayers = () => root().querySelectorAll('.layer');
const layerWith = (eyebrow) => openLayers().find((layer) => layer.querySelector('.eyebrow')?.textContent === eyebrow);
const formOf = (layer) => layer.querySelector('form');
const controlOf = (layer, label) => fieldWrap(formOf(layer), label)?.querySelector('input,select,textarea');
const click = (node) => node.click();
const seg = (node, label) => node.querySelectorAll('.seg button').find((item) => item.textContent.startsWith(label));
const segLabel = (node) => node.querySelectorAll('.seg button').find((item) => item.getAttribute('aria-pressed') === 'true')?.textContent;
const buttonByText = (node, pattern) => node.querySelectorAll('button').find((item) => pattern.test(item.textContent));
const footButtons = (layer) => layer.querySelectorAll('.layer-foot button');
const submit = (layer) => click(footButtons(layer).at(-1));
const blocks = (node) => node.querySelectorAll('.tt-course');
const courseNames = (node) => blocks(node).map((item) => item.querySelector('b').textContent);
const blockOf = (node, name) => blocks(node).find((item) => item.querySelector('b').textContent === name);
const selectedOption = (select) => select.querySelectorAll('option').find((item) => item.hasAttribute('selected'))?.textContent;
const ghostNames = (node) => node.querySelectorAll('.tt-course.is-ghost').map((item) => item.querySelector('b').textContent);
const type = (input, value) => { input.value = value; input.fire('input'); };
/** 屏幕上可能同时挂着好几条提示（强制保存的报错 + 删除的撤销），必须按文案找。 */
const toastNode = (pattern) => document.getElementById('toast-root').querySelectorAll('.toast')
  .find((node) => pattern.test(node.textContent));
/** 提交失败时浮层不会关，错误文案就写在 .notice.danger 里，不读出来就只能等一个天书般的超时。 */
const layerError = (layer) => (layer.querySelector('.notice.danger')?.hidden ? null : texts(layer.querySelector('.notice.danger')));
const choose = (select, value) => { select.value = value; select.fire('change'); };

/** 视图模式存在偏好里，用例要能自己扮演"上次选过列表视图"。 */
function ctxWith(pref = {}) {
  const { calls, ctx } = fakeCtx();
  ctx.store.pref = (key, fallback) => (key in pref ? pref[key] : fallback);
  ctx.store.setPref = (key, value) => { pref[key] = value; calls.push(`pref:${key}=${String(value)}`); };
  return { calls, ctx, pref };
}

const args = (state, ctx, query = new URLSearchParams()) => ({ state, ctx, time: TIME, query });
const at = (week, extra = {}) => new URLSearchParams({ week: String(week), ...extra });

const withCourses = (extra) => {
  const base = seedState(TODAY);
  return { ...base, tables: { ...base.tables, courses: [...base.tables.courses, ...extra] } };
};

/** 一门压住「数据结构与算法」（周一 08:00–09:40）的试验课。 */
const clashCourse = (patch = {}) => ({
  id: 'x_clash', name: '冲突试验课', teacher: null, location: '临时教室',
  day_of_week: 1, start_time: '09:00', end_time: '10:00',
  week_type: 'all', start_week: 1, end_week: 16, color: '#F2555A', note: null, sort: 99,
  created_at: `${TODAY}T00:00:00.000Z`, updated_at: `${TODAY}T00:00:00.000Z`, ...patch,
});

const view = async (run) => withDom(async () => {
  const { renderTimetable } = await import('../../web/views/timetable.js');
  return run(renderTimetable);
});

// ── 网格视图（DEV_PLAN S6 完成标准 1）────────────────────────

test('S6 网格：13 门课各占一天一栏，两门双周课画成 ghost，今天列带当前时刻线', async () => {
  await view(async (renderTimetable) => {
    const { ctx } = ctxWith();
    const node = renderTimetable(args(seedState(TODAY), ctx));
    assert.equal(texts(node.querySelector('.week-picker .current')), '第 5 / 18 周', '默认停在今天所在的第 5 周');
    assert.equal(courseNames(node).length, 13);
    assert.equal(node.querySelectorAll('.tt-cell').length, 7, '一周七列');
    assert.equal(node.querySelectorAll('.tt-day').length, 7);
    assert.equal(node.querySelectorAll('.tt-slot').length, 70, '10 节 × 7 天都要能点');
    assert.equal(node.querySelectorAll('.tt-tick').length, 10);
    assert.deepEqual(ghostNames(node), ['大学英语（四）', '人工智能基础'], '第 5 周是单周，两门双周课要画出来但标明不上');
    assert.ok(blockOf(node, '大学英语（四）').getAttribute('aria-label').includes('本周不上'));
    assert.equal(node.querySelectorAll('.tt-course.is-conflict').length, 0, '种子课程互不冲突');
    assert.equal(node.querySelectorAll('.tt-now').length, 1, '当前时刻线只在今天那一列');
    assert.equal(node.querySelectorAll('.tt-cell.is-today').length, 1);
    assert.equal(node.querySelector('.tt-now').style.top, '35.53%', '12:30 在 08:00–20:40 轴上的位置');
    assert.match(texts(node.querySelector('.panel.tight')), /本周 11 节，另有 2 门本周不上/);
    assertNoBlankLabels(node, '课表页');
  });
});

test('S6 第 12 周换的是 ghost 集合与日期范围，点单周才改 hash', async () => {
  await view(async (renderTimetable) => {
    const { calls, ctx } = ctxWith();
    const state = seedState(TODAY);
    const node = renderTimetable(args(state, ctx, at(12)));
    assert.deepEqual(ghostNames(node), ['计算机网络', '线性代数', '软件工程导论', '创新创业实践']);
    assert.match(texts(node.querySelector('.panel.tight')), /本周 9 节，另有 4 门本周不上/);
    const range = T.weekRange(12, state.config);
    assert.ok(texts(node).includes(`${T.fmtDate(range.start)} — ${T.fmtDate(range.end)}`), '第 12 周的日期范围没跟上');
    click(buttonByText(node, /^单周$/));
    assert.deepEqual(calls, ['navigate:#/timetable?week=13&dow=1'], '第 12 周是双周，点单周应跳到第 13 周');
  });
});

test('S6 周次越界与边界保护：week=99 收回第 18 周，第一周禁用上一周', async () => {
  await view(async (renderTimetable) => {
    const { calls, ctx } = ctxWith();
    const state = seedState(TODAY);
    const far = renderTimetable(args(state, ctx, at(99)));
    assert.equal(texts(far.querySelector('.week-picker .current')), '第 18 / 18 周');
    assert.equal(buttonByText(far, /^双周$/).getAttribute('aria-pressed'), 'true', '第 18 周是双周');
    assert.equal(far.querySelectorAll('.week-picker .iconbtn')[1].disabled, true, '已经在最后一周');
    assert.deepEqual(ghostNames(far).length, 10, '第 18 周只剩三门课');

    const first = renderTimetable(args(state, ctx, at(0)));
    assert.equal(texts(first.querySelector('.week-picker .current')), '第 1 / 18 周', '0 周按第 1 周处理');
    assert.equal(first.querySelectorAll('.week-picker .iconbtn')[0].disabled, true);
    assert.deepEqual(ghostNames(first), ['大学英语（四）', '人工智能基础', '操作系统', '创新创业实践'],
      '第 1 周：双周课与第 3 周起的课、第 5 周起的课都还没上');
    calls.length = 0;
    click(buttonByText(first, /^单周$/));
    assert.deepEqual(calls, ['navigate:#/timetable?week=1&dow=1'], '已经在单周就原地不动，不能把用户甩走');
  });
});

// ── 冲突（完成标准 2）───────────────────────────────────────

test('S6 制造重叠课：工具条报几门课冲突，网格上两课并排且都描红边', async () => {
  await view(async (renderTimetable) => {
    const { ctx } = ctxWith();
    const node = renderTimetable(args(withCourses([clashCourse()]), ctx));
    assert.equal(node.querySelector('.badge.orange').textContent, '2 门课时间冲突');
    const a = blockOf(node, '数据结构与算法');
    const b = blockOf(node, '冲突试验课');
    assert.ok(a.classList.contains('is-conflict'), '被压住的那门也要描边');
    assert.ok(b.classList.contains('is-conflict'));
    assert.equal(a.style.width, 'calc(50% - 4px)');
    assert.equal(b.style.width, 'calc(50% - 4px)');
    assert.equal(a.style.left, 'calc(0% + 2px)');
    assert.equal(b.style.left, 'calc(50% + 2px)', '两课必须左右并排，不能叠在一起');
    assert.equal(a.style.top, '0%');
    assert.equal(b.style.top, '7.89%');
    assert.ok(b.getAttribute('aria-label').includes('与其他课时间冲突'));
    assert.ok(!a.classList.contains('is-ghost'), '描边与 ghost 是两回事');
  });
});

test('S6 列表视图同样标出冲突，本周不上的课挂"本周不上"徽标', async () => {
  await view(async (renderTimetable) => {
    const { ctx } = ctxWith({ 'ui.timetableView': 'list' });
    const node = renderTimetable(args(withCourses([clashCourse()]), ctx));
    assert.equal(node.querySelector('.tt-grid'), null, '列表视图不画网格');
    assert.equal(segLabel(node.querySelector('.tt-toolbar')), '列表', '切换器要显示当前视图');
    assert.equal(node.querySelectorAll('.list-row').length, 14);
    assert.equal(node.querySelectorAll('.list-row.is-conflict').length, 2);
    assert.equal(node.querySelectorAll('.list-row.is-past').length, 2);
    assert.deepEqual(node.querySelectorAll('.list-row .badge.red').map((item) => item.textContent), ['冲突', '冲突']);
    assert.deepEqual(node.querySelectorAll('.list-row .badge.grey').map((item) => item.textContent),
      ['本周不上', '本周不上']);
    assert.deepEqual(node.querySelectorAll('.group-head .count').map((item) => item.textContent).slice(0, 3),
      ['3/3 节', '2/2 节', '1/2 节'], '周一多了试验课 → 3/3；周三双周课只占一半');
    assert.equal(node.querySelectorAll('.group').length, 7, '七天都要有分组，没课的日子也要说明');
  });
});

// ── 视图切换（完成标准 3）───────────────────────────────────

test('S6 三视图切换写 ui.timetableView，重绘后停在同一个视图', async () => {
  await view(async (renderTimetable) => {
    const state = seedState(TODAY);
    const { calls, ctx } = ctxWith();
    const node = renderTimetable(args(state, ctx));
    assert.ok(node.querySelector('.tt-grid'), '宽屏默认网格');
    assert.equal(node.querySelector('.tt-grid').classList.contains('is-day'), false);
    click(seg(node, '日'));
    assert.deepEqual(calls, ['pref:ui.timetableView=day']);

    const day = renderTimetable(args(state, ctx));
    assert.ok(day.querySelector('.tt-grid.is-day'), '日视图仍走网格，但只有一列');
    assert.equal(day.querySelectorAll('.tt-cell').length, 1);
    assert.equal(day.querySelectorAll('.tt-slot').length, 10);
    assert.equal(day.querySelectorAll('.tt-day').length, 1);
    assert.deepEqual(courseNames(day), ['创新创业实践'], '日视图默认停在今天（9/20 周日），不是周一');
    assert.equal(segLabel(day.querySelector('.tt-toolbar')), '日');
    click(day.querySelectorAll('.day-strip button')[4]);
    assert.ok(calls.includes('navigate:#/timetable?week=5&dow=5'), calls.join('|'));
  });
});

test('S6 375px 窄屏没选过视图时默认日视图，不产生七天横向网格', async () => {
  await view(async (renderTimetable) => {
    const saved = globalThis.matchMedia;
    globalThis.matchMedia = (query) => ({ matches: /max-width:\s*639px/.test(query), addEventListener() {}, removeEventListener() {} });
    try {
      const { ctx } = ctxWith();
      const node = renderTimetable(args(seedState(TODAY), ctx));
      assert.ok(node.querySelector('.tt-grid.is-day'), '窄屏默认日视图');
      assert.equal(node.querySelectorAll('.tt-cell').length, 1, '七天并排会横向溢出');
      assert.equal(node.querySelectorAll('.day-strip button').length, 7, '靠星期条横向选择');
      assert.equal(segLabel(node.querySelector('.tt-toolbar')), '日');
    } finally {
      globalThis.matchMedia = saved;
    }
  });
});

// ── 空白时段预填（完成标准 4）───────────────────────────────

test('S6 点周四第 3 节空白：星期与起止时间按那一节预填，直接改名就能存', async () => {
  await view(async (renderTimetable) => {
    const { calls, ctx } = ctxWith();
    const node = renderTimetable(args(seedState(TODAY), ctx));
    const thursday = node.querySelectorAll('.tt-cell')[3];
    const slots = thursday.querySelectorAll('.tt-slot');
    assert.equal(slots.length, 10);
    assert.equal(slots[2].getAttribute('aria-label'), '9月17日 周四 第 3 节 10:00–10:45，点击按这一节新增课程');
    click(slots[2]);
    const layer = layerWith('COURSE');
    assert.equal(layer.querySelector('h2').textContent, '新增课程');
    assert.equal(selectedOption(controlOf(layer, '星期')), '周四');
    assert.equal(controlOf(layer, '开始时间').value, '10:00');
    assert.equal(controlOf(layer, '结束时间').value, '10:45');
    assert.deepEqual(formOf(layer).querySelectorAll('.field label').map((item) => item.textContent),
      ['课程名称', '星期', '开始时间', '结束时间', '周型', '起始周', '结束周', '教师', '上课地点', '颜色', '备注']);
    assert.equal(controlOf(layer, '结束周').value, '18', '周次范围预填整学期');
    assert.equal(layer.querySelector('.notice.warn').hidden, true, '周四这个时段没有课，不该报警');
    type(controlOf(layer, '课程名称'), '班会');
    submit(layer);
    await settle(4);
    assert.equal(calls[0], 'create:courses');
    assert.deepEqual(calls[1], {
      name: '班会', day_of_week: 4, start_time: '10:00', end_time: '10:45',
      week_type: 'all', start_week: 1, end_week: 18, color: '#3DD6F5',
    }, '星期的下拉值必须转成整数再交出去');
    assert.equal(validateRow('courses', calls[1], { allowServer: true }).ok, true, JSON.stringify(calls[1]));
  });
});

test('S6 编辑已有课程：交回的只有表单字段，服务端列不跟着发', async () => {
  await view(async (renderTimetable) => {
    const { calls, ctx } = ctxWith();
    // 只看 patch 分不清改的是哪一门，这里把 id 也记下来
    const writes = [];
    const update = ctx.store.update;
    ctx.store.update = async (table, id, patch) => { writes.push({ table, id }); return update(table, id, patch); };
    const state = seedState(TODAY);
    const target = state.tables.courses.find((item) => item.name === '数据结构与算法');
    const node = renderTimetable(args(state, ctx));
    click(blockOf(node, '数据结构与算法'));
    const detail = layerWith('COURSE');
    assert.equal(detail.querySelector('h2').textContent, '数据结构与算法');
    assert.equal(formOf(detail).querySelectorAll('.field').length, 0, '详情是只读的，不该有输入框');
    assert.deepEqual(detail.querySelectorAll('.kv-row .k').map((item) => item.textContent),
      ['星期', '时间', '周次', '周型', '教师', '地点', '备注']);
    assert.deepEqual(detail.querySelectorAll('.kv-row .v').map((item) => item.textContent),
      ['周一', '08:00–09:40', '第 1–16 周', '每周', '王立群', 'A302', '期中考第 9 周']);
    assert.ok(texts(detail).includes('本周（第 5 周）上这门课'));
    assert.equal(detail.querySelector('.notice.warn'), null);
    assert.deepEqual(footButtons(detail).map((item) => item.textContent), ['取消', '编辑这门课', '删除课程']);

    click(buttonByText(detail, /^编辑这门课$/));
    assert.equal(await waitUntil(() => openLayers().length === 1), true, '详情层应当让位给编辑层');
    const edit = layerWith('COURSE');
    assert.equal(edit.querySelector('h2').textContent, '编辑课程');
    assert.equal(controlOf(edit, '课程名称').value, '数据结构与算法');
    assert.equal(selectedOption(controlOf(edit, '周型')), '每周');
    type(controlOf(edit, '上课地点'), 'A305');
    submit(edit);
    assert.equal(await waitUntil(() => openLayers().length === 0), true);
    assert.deepEqual([calls[0], writes[0]], ['update:courses', { table: 'courses', id: target.id }]);
    assert.equal(calls[1].location, 'A305');
    assert.equal(validateRow('courses', calls[1], { allowServer: true }).ok, true, JSON.stringify(calls[1]));
    for (const key of ['id', 'created_at', 'updated_at', 'sort']) assert.ok(!(key in calls[1]), `${key} 不该被交回`);
  });
});

// ── 冲突警告与强制保存 ──────────────────────────────────────

test('S6 填到一半就出现橙色警告并列出课名；警告不拦保存，保存后说明是强制', async () => {
  await view(async (renderTimetable) => {
    const { calls, ctx } = ctxWith();
    const node = renderTimetable(args(seedState(TODAY), ctx));
    click(buttonByText(node, /^新增课程$/));
    const layer = layerWith('COURSE');
    const warn = layer.querySelector('.notice.warn');
    assert.equal(warn.hidden, true, '刚打开时起止时间还空着，不该有警告');
    type(controlOf(layer, '课程名称'), '试验冲突课');
    choose(controlOf(layer, '星期'), '1');
    type(controlOf(layer, '开始时间'), '09:00');
    type(controlOf(layer, '结束时间'), '10:00');
    assert.equal(warn.hidden, false, '时间与 08:00–09:40 的课压住了就要提醒');
    assert.ok(texts(warn).includes('数据结构与算法'), texts(warn));
    assert.ok(texts(warn).includes('保存后两课在网格上并排显示'));
    assert.equal(footButtons(layer).at(-1).disabled, false, '警告只提示，不能拦强制保存');
    type(controlOf(layer, '开始时间'), '13:00');
    type(controlOf(layer, '结束时间'), '14:00');
    assert.equal(warn.hidden, true, '改到周一的空档后仍报警就是判定写死了');
    type(controlOf(layer, '开始时间'), '09:00');
    type(controlOf(layer, '结束时间'), '10:00');
    submit(layer);
    assert.equal(await waitUntil(() => !openLayers().includes(layer)), true);
    assert.equal(calls[0], 'create:courses');
    assert.equal(calls[1].day_of_week, 1, '下拉交回的 "1" 必须转成数字 1');
    assert.equal(await waitUntil(() => toastTexts().some((text) => text.includes('已强制保存：与 数据结构与算法 时间重叠'))), true,
      toastTexts().join('|'));
  });
});

test('S6 详情里也列出既有冲突，删除走 store.remove + 撤销', async () => {
  await view(async (renderTimetable) => {
    const { calls, ctx } = ctxWith();
    const node = renderTimetable(args(withCourses([clashCourse()]), ctx));
    click(blockOf(node, '冲突试验课'));
    const detail = layerWith('COURSE');
    assert.ok(detail.querySelector('.notice.warn'), '详情层要说明和谁重叠');
    assert.equal(texts(detail.querySelector('.notice.warn')).includes('数据结构与算法'), true);
    click(buttonByText(detail, /^删除课程$/));
    assert.deepEqual(calls.slice(0, 2), ['remove:courses', 'x_clash'], '删除没有走 store.remove');
    assert.equal(openLayers().length, 0, '删除后两层浮层都要收掉');
    const toastNode = document.getElementById('toast-root').querySelector('.toast');
    assert.equal(toastNode.querySelector('button').textContent, '撤销');
    click(toastNode.querySelector('button'));
    assert.ok(calls.includes('undo:rm_test'), '撤销按钮没接 undoRemove');
  });
});

// ── 三态与快捷键 ────────────────────────────────────────────

test('S6 没有课程给录入引导，没有学期基准给去设置的引导', async () => {
  await view(async (renderTimetable) => {
    const { ctx } = ctxWith();
    const state = seedState(TODAY);
    const empty = renderTimetable(args({ ...state, tables: { ...state.tables, courses: [] } }, ctx));
    assert.equal(empty.querySelector('.empty p').textContent, '还没有课程');
    assert.ok(buttonByText(empty, /^录入第一门课$/));
    assert.ok(empty.querySelector('.week-picker'), '空课表也要保留周次工具条');
    assert.ok(texts(empty.querySelector('.panel.tight')).includes('本周 0 节'), '空课表仍要有本周节数读数');
    assert.ok(!texts(empty.querySelector('.panel.tight')).includes('门本周不上'), '没有课程时不该报 ghost');
    assert.equal(empty.querySelector('.tt-grid'), null);

    const noConfig = renderTimetable(args(emptyAppState(), ctx));
    assert.equal(noConfig.querySelector('.empty p').textContent, '还没有学期基准');
    click(buttonByText(noConfig, /^去设置$/));
    assert.equal(globalThis.location.hash, '#/settings');
  });
});

test('S6 快捷键 N 在课表页开新增课程浮层，星期预填今天', async () => {
  await view(async (renderTimetable) => {
    assert.equal(typeof renderTimetable.onNew, 'function');
    const { ctx } = ctxWith();
    renderTimetable.onNew({ ctx, state: seedState(TODAY), time: TIME });
    const layer = layerWith('COURSE');
    assert.equal(layer.querySelector('h2').textContent, '新增课程');
    assert.equal(selectedOption(controlOf(layer, '星期')), '周日', '2026-09-20 是周日');
    renderTimetable.onNew({ ctx, state: emptyAppState(), time: TIME });
    assert.ok(toastTexts().some((text) => text.includes('请先在设置里建立学期与节次')));
  });
});

// ── 真实后端往返（完成标准 1/2/4）──────────────────────────

test('S6 真 store + 真 Function：点空白建课 → 冲突描边 → 改周型变 ghost → 撤销 → 删除保持', async () => {
  const server = createPreviewServer({ port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const api = createApi({ baseUrl: `http://127.0.0.1:${server.address().port}/functions/v1/app` });
  const store = createStore({ api });
  await store.load();
  const today = T.todayKey();
  const time = { today, now: new Date(`${today}T12:00:00`) };
  const name = 'S6 往返验收课';
  const argsOf = (query) => ({ state: store.state, ctx: { store, navigate: () => {} }, time, query });
  try {
    await withDom(async () => {
      const { renderTimetable } = await import('../../web/views/timetable.js');
      const week = T.weekOf(today, store.state.config);
      assert.equal(week, 5, '种子数据把今天摆在第 5 周（单周）');
      const render = (query = new URLSearchParams()) => renderTimetable(argsOf(query));

      // 周一第 3 节 10:00–10:45 与「毛概」10:00–11:40 正好压住
      const slot = render().querySelectorAll('.tt-cell')[0].querySelectorAll('.tt-slot')[2];
      click(slot);
      const layer = layerWith('COURSE');
      type(controlOf(layer, '课程名称'), name);
      assert.equal(layer.querySelector('.notice.warn').hidden, false, '预填时间已经撞课，就该先报警');
      submit(layer);
      assert.equal(await waitUntil(() => !openLayers().includes(layer)), true, layerError(layer) || '浮层没有关掉');
      const created = store.state.tables.courses.find((item) => item.name === name);
      assert.ok(created && !String(created.id).startsWith('tmp_'), '新课程没落到服务端');
      assert.equal(created.day_of_week, 1);
      assert.equal(created.end_week, store.state.config.total_weeks);
      assert.ok(toastNode(/已强制保存：与 .*时间重叠/), '带冲突保存时没有给出强制保存说明');

      const after = render();
      const mine = blockOf(after, name);
      const holder = blockOf(after, '毛泽东思想和中国特色社会主义理论体系概论');
      assert.ok(mine.classList.contains('is-conflict'), '新课没标冲突');
      assert.ok(holder.classList.contains('is-conflict'), '被压住的老课没标冲突');
      assert.equal(after.querySelector('.badge.orange').textContent, '2 门课时间冲突');
      assert.notEqual(mine.style.left, holder.style.left, '真库里也没并排显示');

      // 改成双周：单周里它变成 ghost，且不再算冲突
      click(mine);
      const detail = layerWith('COURSE');
      assert.ok(texts(detail).includes('与「毛泽东思想和中国特色社会主义理论体系概论」时间重叠'), texts(detail));
      click(buttonByText(detail, /^编辑这门课$/));
      assert.equal(await waitUntil(() => openLayers().length === 1), true);
      const edit = layerWith('COURSE');
      choose(controlOf(edit, '周型'), 'even');
      submit(edit);
      assert.equal(await waitUntil(() => !openLayers().includes(edit)), true, layerError(edit) || '编辑层没有关掉');
      assert.equal(await waitUntil(() => store.row('courses', created.id)?.week_type === 'even'), true, '周型没写回服务端');
      const ghosts = render();
      assert.ok(blockOf(ghosts, name).classList.contains('is-ghost'), '单周里的双周课该画成 ghost');
      assert.equal(ghosts.querySelectorAll('.tt-course.is-conflict').length, 0, '本周不上的课不该算进冲突');
      assert.equal(ghosts.querySelector('.badge.orange'), null);

      // 删除 → 撤销 → 回读仍在
      click(blockOf(ghosts, name));
      click(buttonByText(layerWith('COURSE'), /^删除课程$/));
      assert.equal(await waitUntil(() => !store.state.tables.courses.some((item) => item.id === created.id)), true,
        '删除后界面上应当立刻消失（乐观更新）');
      click(toastNode(/已删除「/).querySelector('button'));
      assert.ok(store.row('courses', created.id), '撤销没把课带回来');
      await store.refresh();
      assert.ok(store.row('courses', created.id), '撤销后的课回读应当还在');

      // 再删除并等延后删除真正提交，回读才见得到结果
      click(blockOf(render(), name));
      click(buttonByText(layerWith('COURSE'), /^删除课程$/));
      assert.equal(await waitUntil(() => !store.state.tables.courses.some((item) => item.id === created.id)), true);
      assert.equal(await waitUntil(() => store.state.pending.length === 0, 9000), true, '撤销窗口结束后删除请求仍未落定');
      await store.refresh();
      assert.equal(store.row('courses', created.id), null, '删除没写进服务端');
      assert.equal(store.state.tables.courses.length, 13, '种子课程不能被连带删掉');
      assert.equal(render().querySelectorAll('.tt-course').length, 13);
    });
  } finally {
    const leftover = store.state.tables.courses.find((item) => item.name === name);
    if (leftover) await api.remove('courses', leftover.id);
    server.close();
  }
});
