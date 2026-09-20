// S4 完成标准的界面部分：在桩 DOM 里真的点按钮、真的填表单，
// 断言的是"界面上出现了什么文字、哪个字段被拦住、最后写出去的是什么"。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewServer } from '../preview-server.mjs';
import * as T from '../../web/lib/time.js';
import { createApi } from '../../web/lib/api.js';
import { createStore } from '../../web/lib/store.js';
import { snapshotText } from '../../web/lib/snapshot.js';
import {
  withDom, seedState, emptyAppState, fakeCtx, viewArgs, texts, assertNoBlankLabels,
  fieldWrap, toastTexts, waitUntil, settle,
} from './render-harness.mjs';

const root = () => globalThis.document.getElementById('modal-root');
const openLayers = () => root().querySelectorAll('.layer');
const layerWith = (eyebrow) => openLayers().find((layer) => layer.querySelector('.eyebrow')?.textContent === eyebrow);
const formOf = (layer) => layer.querySelector('form');
const footButtons = (layer) => layer.querySelectorAll('.layer-foot .btn');
const submitOf = (layer) => footButtons(layer).at(-1);
const controlOf = (layer, label) => fieldWrap(formOf(layer), label)?.querySelector('input,select,textarea');
const errorOf = (layer, label) => fieldWrap(formOf(layer), label)?.querySelector('.err').textContent;
const invalidFields = (layer) => formOf(layer).querySelectorAll('.field.invalid label').map((node) => node.textContent);
const impactLines = (layer) => layer.querySelectorAll('.impact .impact-line').map((node) => node.textContent);
const buttonByText = (node, text) => node.querySelectorAll('button').find((item) => item.textContent === text);

const type = (layer, label, value) => {
  const input = controlOf(layer, label);
  assert.ok(input, `浮层里没有字段「${label}」`);
  input.value = value;
  input.fire('input');
};
const choose = (layer, label, value) => {
  const select = controlOf(layer, label);
  select.value = value;
  select.fire('change');
};
const click = (node) => node.click();
const periodRow = (node, index) => node.querySelectorAll('.card-list .list-row')[index];

/** 真的点"保存"那颗按钮（它在 form 外面，靠 form 属性关联），再等浮层关掉。 */
async function submitLayer(layer) {
  click(submitOf(layer));
  return waitUntil(() => !openLayers().includes(layer));
}

/** 回车等直达表单的提交路径也必须被拦住：绕过按钮的禁用态再试一次。 */
async function submitBlocked(layer, calls) {
  assert.equal(submitOf(layer).disabled, true, '非法输入时保存按钮应当是禁用状态');
  formOf(layer).fire('submit');
  await settle(8);
  assert.ok(openLayers().includes(layer), '非法值不该提交成功');
  assert.deepEqual(calls, [], '被拦住的表单不能产生写请求');
}

// ── 学期基准 ──────────────────────────────────────────────

test('S4 编辑学期：改起始日为上周一，读数立刻 +1，保存写回的就是新起始日', async () => {
  await withDom(async () => {
    const { renderSettings } = await import('../../web/views/settings.js');
    const { calls, ctx } = fakeCtx();
    const node = renderSettings(viewArgs.settings(seedState(), ctx));
    assert.ok(texts(node).includes('当前周次'));
    click(buttonByText(node, '编辑学期'));

    const layer = layerWith('SEMESTER');
    assert.ok(layer, '点「编辑学期」没有打开浮层');
    assert.equal(layer.querySelector('h2').textContent, '编辑学期基准');
    assert.deepEqual(impactLines(layer), ['今天是第 5 周 / 共 18 周 · 单周']);
    assert.equal(submitOf(layer).disabled, false);

    type(layer, '起始日（第一周周一）', '2026-08-10');
    assert.deepEqual(impactLines(layer), ['今天是第 6 周 / 共 18 周 · 双周'], '实时读数没跟着草稿走');

    type(layer, '总周数', '1');
    assert.deepEqual(impactLines(layer), ['今天不在该学期范围内（假期或学期外）']);
    type(layer, '总周数', '20');
    assert.deepEqual(impactLines(layer), ['今天是第 6 周 / 共 20 周 · 双周']);

    assert.equal(await submitLayer(layer), true, '合法输入却被拦住提交');
    assert.deepEqual(calls, ['update:semester_config', { start_date: '2026-08-10', total_weeks: 20 }]);
    assert.ok(toastTexts().some((text) => text.includes('学期基准已更新，周次已重算')), toastTexts().join('|'));
    assertNoBlankLabels(layer.querySelector('.layer-body'), '学期浮层');
  });
});

test('S4 学期基准非法值：越界周数在字段上报错且提交禁用', async () => {
  await withDom(async () => {
    const { renderSettings } = await import('../../web/views/settings.js');
    const { calls, ctx } = fakeCtx();
    const node = renderSettings(viewArgs.settings(seedState(), ctx));
    click(buttonByText(node, '编辑学期'));
    const layer = layerWith('SEMESTER');
    type(layer, '总周数', '99');
    assert.equal(errorOf(layer, '总周数'), '总周数需在 1–60 之间');
    assert.deepEqual(invalidFields(layer), ['总周数']);
    assert.equal(submitOf(layer).disabled, true);
    type(layer, '总周数', '');
    assert.equal(errorOf(layer, '总周数'), '总周数不能为空');
    await submitBlocked(layer, calls);
  });
});

test('S4 首次初始化学期：预填本周一与 18 周，保存即带上常见节次模板', async () => {
  await withDom(async () => {
    const { renderSettings } = await import('../../web/views/settings.js');
    const { calls, ctx } = fakeCtx();
    const node = renderSettings(viewArgs.settings(emptyAppState(), ctx));
    assert.equal(node.querySelector('.empty p').textContent, '还没有学期基准');
    click(buttonByText(node.querySelector('.empty'), '初始化学期'));

    const layer = layerWith('SEMESTER');
    assert.equal(layer.querySelector('h2').textContent, '初始化学期基准');
    assert.equal(controlOf(layer, '起始日（第一周周一）').value, '2026-09-14', '应预填本周的周一');
    assert.equal(controlOf(layer, '总周数').value, '18');
    assert.deepEqual(impactLines(layer), ['今天是第 1 周 / 共 18 周 · 单周']);
    assert.equal(submitOf(layer).textContent, '保存并开始');

    assert.equal(await submitLayer(layer), true);
    assert.equal(calls[0], 'create:semester_config');
    const row = calls[1];
    assert.equal(row.start_date, '2026-09-14');
    assert.equal(row.total_weeks, 18);
    assert.equal(row.periods.length, 10);
    assert.deepEqual(row.periods[4], { label: '午休', start: '12:00', end: '14:00', kind: 'break' });
    assert.ok(toastTexts().some((text) => text.includes('节次表用了常见模板')), toastTexts().join('|'));
  });
});

// ── 节次表编辑器 ──────────────────────────────────────────

test('S4 节次表逐行列出，每行都有编辑与删除入口', async () => {
  await withDom(async () => {
    const { renderSettings } = await import('../../web/views/settings.js');
    const { ctx } = fakeCtx();
    const node = renderSettings(viewArgs.settings(seedState(), ctx));
    const rows = node.querySelectorAll('.card-list .list-row');
    assert.equal(rows.length, 10);
    assert.equal(rows[0].querySelector('.t').textContent, '第 1 行');
    assert.equal(rows[0].querySelector('.title').textContent, '第 1 节');
    assert.equal(rows[0].querySelector('.num').textContent, '08:00–08:45');
    assert.equal(texts(rows[4]).includes('（休息）'), true, '午休要标出是休息段');
    assert.equal(rows[4].querySelectorAll('.badge').length, 1);
    for (const row of rows) {
      assert.equal(row.querySelectorAll('.iconbtn').length, 2, '每行都要有编辑与删除');
      assert.equal(row.querySelectorAll('.iconbtn').at(-1).classList.contains('danger'), true);
    }
    assertNoBlankLabels(node, '设置页节次表');
  });
});

test('S4 新增一节：时间倒置与行重叠都精确拦在字段上，改正后才允许保存', async () => {
  await withDom(async () => {
    const { renderSettings } = await import('../../web/views/settings.js');
    const { calls, ctx } = fakeCtx();
    const node = renderSettings(viewArgs.settings(seedState(), ctx));
    click(buttonByText(node, '新增一节'));
    const layer = layerWith('PERIOD');
    assert.ok(layer, '点「新增一节」没有打开浮层');

    assert.equal(controlOf(layer, '名称').value, '第 10 节', '休息段不占节次编号');
    assert.equal(controlOf(layer, '开始时间').value, '20:50');
    assert.equal(controlOf(layer, '结束时间').value, '21:35');
    assert.deepEqual(impactLines(layer), ['将新增「第 10 节」 20:50–21:35']);
    assert.equal(submitOf(layer).disabled, false);

    type(layer, '开始时间', '08:00');
    assert.equal(errorOf(layer, '开始时间'), '与「第 1 节」时间重叠');
    assert.deepEqual(invalidFields(layer), ['开始时间']);
    assert.equal(submitOf(layer).disabled, true);

    type(layer, '结束时间', '08:45');
    assert.deepEqual(impactLines(layer), ['将新增「第 10 节」 08:00–08:45']);
    assert.equal(errorOf(layer, '开始时间'), '与「第 1 节」时间重叠', '改成完全重合的一节，重叠依旧成立');
    await submitBlocked(layer, calls);

    type(layer, '开始时间', '20:50');
    type(layer, '结束时间', '08:30');
    assert.equal(errorOf(layer, '结束时间'), '结束时间需晚于开始时间');
    assert.deepEqual(invalidFields(layer), ['结束时间']);
    assert.equal(submitOf(layer).disabled, true);
    await submitBlocked(layer, calls);

    type(layer, '结束时间', '21:35');
    assert.equal(errorOf(layer, '结束时间'), '');
    assert.deepEqual(invalidFields(layer), []);
    assert.equal(submitOf(layer).disabled, false);
    // 收在 11:45–12:00：位置在节次表中间，写回时没排序就会露出来
    type(layer, '开始时间', '11:45');
    type(layer, '结束时间', '12:00');
    assert.deepEqual(impactLines(layer), ['将新增「第 10 节」 11:45–12:00']);
    choose(layer, '类型', 'break');
    assert.deepEqual(impactLines(layer), ['将新增「第 10 节」 11:45–12:00（休息）']);

    assert.equal(await submitLayer(layer), true, '合法改动被拦住');
    assert.equal(calls.length, 2);
    assert.equal(calls[0], 'update:semester_config');
    const periods = calls[1].periods;
    assert.equal(periods.length, 11);
    assert.deepEqual(periods.map((period) => period.start), T.sortPeriods(periods).map((period) => period.start), '写回的节次表必须按时间递增');
    assert.equal(periods[4].label, '第 10 节', '新一节没有插到正确的位置');
    assert.equal(periods[5].label, '午休');
    assert.deepEqual(periods[4], { label: '第 10 节', start: '11:45', end: '12:00', kind: 'break' });
    assert.ok(toastTexts().some((text) => text.includes('课表纵轴同步为 11 行')), toastTexts().join('|'));
  });
});

test('S4 编辑已有的一节：改动前给出"影响几门课"，未改动就明说没有变化', async () => {
  await withDom(async () => {
    const { renderSettings } = await import('../../web/views/settings.js');
    const { calls, ctx } = fakeCtx();
    const node = renderSettings(viewArgs.settings(seedState(), ctx));
    click(periodRow(node, 4).querySelectorAll('.iconbtn')[0]);
    const layer = layerWith('PERIOD');
    assert.equal(layer.querySelector('h2').textContent, '编辑「午休」');
    assert.deepEqual(impactLines(layer), ['节次表没有实质变化']);

    type(layer, '开始时间', '11:00');
    assert.equal(errorOf(layer, '开始时间'), '与「第 4 节」时间重叠', '11:00 落在第 4 节 10:55–11:40 里');
    type(layer, '开始时间', '13:00');
    assert.equal(errorOf(layer, '开始时间'), '');
    assert.deepEqual(impactLines(layer), ['「午休」将从 12:00–14:00（休息） 移到 13:00–14:00（休息），影响 0 门课']);
    assert.equal(await submitLayer(layer), true);
    const periods = calls[1].periods;
    assert.equal(periods.length, 10, '编辑一行不应该多出一行');
    assert.deepEqual(periods.find((period) => period.label === '午休'), { label: '午休', start: '13:00', end: '14:00', kind: 'break' });
  });
});

test('S4 删除一节：先点名受影响的课程，取消不写、确认才写回九行', async () => {
  await withDom(async () => {
    const { renderSettings } = await import('../../web/views/settings.js');
    const { calls, ctx } = fakeCtx();
    const node = renderSettings(viewArgs.settings(seedState(), ctx));
    const trash = (index) => periodRow(node, index).querySelectorAll('.iconbtn')[1];

    click(trash(0));
    let layer = layerWith('CONFIRM');
    assert.equal(layer.querySelector('h2').textContent, '删除「第 1 节」');
    assert.ok(texts(layer).includes('08:00–08:45'));
    assert.ok(texts(layer).includes('受影响：数据结构与算法、面向对象程序设计'), texts(layer));
    click(buttonByText(layer, '返回'));
    await waitUntil(() => openLayers().length === 0);
    assert.deepEqual(calls, [], '取消后不能写云端');

    click(trash(4));
    layer = layerWith('CONFIRM');
    assert.ok(texts(layer).includes('当前没有课程落在这节时间里。'), texts(layer));
    click(buttonByText(layer, '删除这一节'));
    // 浮层关掉只说明确认完成了，写云端与 toast 还在后面：等的是提示，不是"层没了"
    assert.equal(await waitUntil(() => toastTexts().length > 0), true, '确认后既没有写请求也没有提示');
    assert.equal(calls[0], 'update:semester_config');
    const periods = calls[1].periods;
    assert.equal(periods.length, 9);
    assert.equal(periods.some((period) => period.label === '午休'), false);
    assert.equal(periods[0].label, '第 1 节', '删除不能打乱其余节次顺序');
    assert.ok(toastTexts().some((text) => text.includes('已删除「午休」')), toastTexts().join('|'));
  });
});

// ── 数据进出口 ────────────────────────────────────────────

test('S4 导出：点按钮真的产出一个内容为七表快照的文件', async () => {
  await withDom(async () => {
    const { renderSettings } = await import('../../web/views/settings.js');
    const { ctx } = fakeCtx();
    const state = seedState();
    const node = renderSettings(viewArgs.settings(state, ctx));

    const seen = { blobs: [], revoked: 0 };
    const created = [];
    const originCreate = globalThis.document.createElement.bind(globalThis.document);
    globalThis.document.createElement = (tag) => {
      const element = originCreate(tag);
      if (tag === 'a') created.push(element);
      return element;
    };
    globalThis.URL = {
      createObjectURL: (blob) => { seen.blobs.push(blob); return 'blob://schedule-backup'; },
      revokeObjectURL: () => { seen.revoked += 1; },
    };

    click(buttonByText(node, '导出全量备份'));
    assert.equal(created.length, 1, '没有生成下载用的链接');
    assert.equal(created[0].href, 'blob://schedule-backup');
    assert.equal(created[0].download, '日程任务舱-备份-2026-09-20.json');
    assert.equal(seen.blobs.length, 1);
    const payload = JSON.parse(await seen.blobs[0].text());
    assert.equal(payload.kind, 'my-schedule-snapshot');
    assert.equal(Object.keys(payload.tables).length, 7);
    assert.equal(payload.counts.courses, 13);
    assert.equal(payload.tables.tasks.length, state.tables.tasks.length);
    assert.ok(toastTexts().some((text) => text.includes('备份文件已开始下载')), toastTexts().join('|'));
  });
});

test('S4 导入：坏文件只给报告与返回，好文件报清条数后才写云端', async () => {
  await withDom(async () => {
    const { renderSettings } = await import('../../web/views/settings.js');
    const { calls, ctx } = fakeCtx();
    ctx.store.importSnapshot = async (tables) => { calls.push('importSnapshot', tables); };
    const state = seedState();
    const node = renderSettings(viewArgs.settings(state, ctx));
    const picker = node.querySelector('input.file-picker');
    assert.ok(picker, '导入入口不在界面上');

    picker.files = [{ name: 'bad.json', text: async () => '{ 这不是 JSON' }];
    picker.fire('change');
    assert.equal(await waitUntil(() => layerWith('IMPORT')), true, '坏文件没有给出报告');
    let layer = layerWith('IMPORT');
    assert.equal(layer.querySelector('h2').textContent, '导入被拦住');
    assert.equal(submitOf(layer).textContent, '返回');
    assert.match(impactLines(layer).join(';'), /不是合法的 JSON/);
    assert.equal(await submitLayer(layer), true);
    assert.equal(calls.includes('importSnapshot'), false, '自检不过就不能写云端');

    picker.files = [{ name: 'ok.json', text: async () => snapshotText(state.tables) }];
    picker.fire('change');
    assert.equal(await waitUntil(() => layerWith('IMPORT')), true);
    layer = layerWith('IMPORT');
    assert.equal(layer.querySelector('h2').textContent, '确认导入备份');
    assert.equal(submitOf(layer).textContent, '清空并导入');
    const lines = impactLines(layer);
    assert.equal(lines[0], '共 58 条记录：学期配置 1 条、课程 13 条、日程 10 条、科研项目 2 条、里程碑 4 条、子任务 8 条、健身记录 20 条');
    assert.match(lines[1], /导入会先清空云端现有的 7 类记录/);
    assert.equal(await submitLayer(layer), true);
    assert.equal(calls[0], 'importSnapshot');
    assert.equal(calls[1].courses.length, 13);
    assert.equal(calls[1].subtasks.length, 8);
    assert.ok(toastTexts().some((text) => text.includes('备份已导入，数据已还原')), toastTexts().join('|'));
  });
});

test('S4 空备份与缺表的文件不给导入按钮', async () => {
  await withDom(async () => {
    const { renderSettings } = await import('../../web/views/settings.js');
    const { calls, ctx } = fakeCtx();
    ctx.store.importSnapshot = async (tables) => { calls.push('importSnapshot', tables); };
    const node = renderSettings(viewArgs.settings(seedState(), ctx));
    const picker = node.querySelector('input.file-picker');
    picker.files = [{ text: async () => JSON.stringify({ tables: { courses: [] } }) }];
    picker.fire('change');
    assert.equal(await waitUntil(() => layerWith('IMPORT')), true);
    const layer = layerWith('IMPORT');
    assert.equal(submitOf(layer).textContent, '返回');
    assert.match(impactLines(layer).join(';'), /没有任何记录/);
    assert.equal(calls.includes('importSnapshot'), false);
  });
});

test('S4 清空全部数据：不输入 DELETE 就按不下去，输错也不行', async () => {
  await withDom(async () => {
    const { renderSettings } = await import('../../web/views/settings.js');
    const { calls, ctx } = fakeCtx();
    ctx.store.wipeAll = async () => { calls.push('wipeAll'); };
    const node = renderSettings(viewArgs.settings(seedState(), ctx));
    click(buttonByText(node, '清空全部数据'));
    const layer = layerWith('CONFIRM');
    assert.equal(layer.querySelector('h2').textContent, '清空全部数据');
    assert.ok(texts(layer).includes('无法恢复'));
    const input = layer.querySelector('.field input');
    const confirm = submitOf(layer);
    assert.equal(confirm.disabled, true, '还没确认就已经可以清空');

    input.value = 'delete';
    input.fire('input');
    assert.equal(confirm.disabled, true, '大小写不同不该算确认');
    input.value = 'DELETE';
    input.fire('input');
    assert.equal(confirm.disabled, false);
    click(confirm);
    assert.equal(await waitUntil(() => calls.includes('wipeAll')), true, '确认后没有真的清空');
    assert.ok(toastTexts().some((text) => text.includes('已清空全部数据')), toastTexts().join('|'));
  });
});

// ── 真实链路：写云端 → 回读 → 周次读数 +1 ──────────────────

test('S4 真 store + 真 Function：保存学期基准后，首页与设置页的周次同步 +1', async () => {
  const server = createPreviewServer({ port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const api = createApi({ baseUrl: `http://127.0.0.1:${server.address().port}/functions/v1/app` });
  const store = createStore({ api });
  await store.load();
  const original = store.state.config;
  // 用一个必定落在学期内的日子，避免用例依赖真实时钟
  const today = T.addDays(original.start_date, 28);
  const time = { today, now: new Date(`${today}T12:00:00`) };
  assert.equal(T.weekOf(today, original), 5);
  const previousMonday = T.addDays(original.start_date, -7);
  try {
    await withDom(async () => {
      const { renderSettings } = await import('../../web/views/settings.js');
      const { renderHome } = await import('../../web/views/home.js');
      const ctx = { store, navigate: () => {} };
      const args = () => ({ state: store.state, ctx, time });
      const homeWeek = () => renderHome(args()).querySelector('.week').textContent;
      const settingsWeek = () => renderSettings(args()).querySelectorAll('.readout-cell')
        .find((cell) => cell.querySelector('.k').textContent === '当前周次').querySelector('.v').textContent;
      assert.equal(homeWeek(), '第 5 周 / 共 18 周 · 单周');
      assert.equal(settingsWeek(), '第 5 周');

      const node = renderSettings(args());
      click(buttonByText(node, '编辑学期'));
      const layer = layerWith('SEMESTER');
      assert.deepEqual(impactLines(layer), ['今天是第 5 周 / 共 18 周 · 单周']);
      type(layer, '起始日（第一周周一）', previousMonday);
      assert.deepEqual(impactLines(layer), ['今天是第 6 周 / 共 18 周 · 双周'], '界面读数没有 +1');
      assert.equal(await submitLayer(layer), true);
      assert.equal(await waitUntil(() => store.state.config.start_date === previousMonday), true, '云端回读后起始日没有变');

      assert.equal(homeWeek(), '第 6 周 / 共 18 周 · 双周', '首页周次没有跟随学期基准');
      assert.equal(settingsWeek(), '第 6 周');
      assert.equal(store.state.tables.semester_config[0].periods.length, 10, '改起始日不能动掉节次表');

      await store.update('semester_config', original.id, { start_date: original.start_date });
      assert.equal(await waitUntil(() => store.state.config.start_date === original.start_date), true);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
