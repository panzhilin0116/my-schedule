// §5.7 导入浮层（P3 文字线 + P5 半自动）：输入→预览→写库全链路，
// 覆盖 PRD 验收项 22–30 中不依赖 OCR 的部分。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { installDom, mountShell } from './dom-stub.mjs';

installDom();
const doc = mountShell();
globalThis.location = { hash: '#/timetable' };
globalThis.confirm = () => true;

const HERE = dirname(fileURLToPath(import.meta.url));
const sample1 = readFileSync(join(HERE, 'fixtures', 'sample1-mobile-lossy.txt'), 'utf8');

function makeStorage(init = {}) {
  const map = new Map(Object.entries(init));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}
globalThis.localStorage = makeStorage();

const { COURSE_KEY_BASE, loadCourses } = await import('../lib/courseStore.js');
const { getSpaceKey } = await import('../lib/space.js');
const { closeOverlay } = await import('../lib/feedback.js');
const { openImportOverlay } = await import('../components/importOverlay.js');

// ---------- 工具 ----------

function seedCourses(list) {
  globalThis.localStorage = makeStorage();
  globalThis.localStorage.setItem(getSpaceKey(COURSE_KEY_BASE), JSON.stringify(list));
}

function open(opts = {}) {
  closeOverlay();
  return openImportOverlay(opts);
}

const panel = () => doc.querySelector('.overlay-panel');
const rowsInView = () => doc.querySelectorAll('.imp-row');
const toasts = () => doc.querySelectorAll('.toast .toast-msg').map((n) => n.textContent);

function setSelect(sel, v) {
  sel.value = v;
  sel.fire('change');
}

function parseText(text, opts = {}) {
  const api = open(opts);
  const ta = doc.querySelector('.imp-area');
  ta.value = text;
  ta.fire('input');
  assert.equal(doc.querySelector('.imp-parse').disabled, false, '有内容后解析按钮应可用');
  doc.querySelector('.imp-parse').click();
  return api;
}

const selectsOf = (el) => el.querySelectorAll('select');

// ---------- 步骤 1：输入 ----------

test('输入态：提示文案逐字、无图片分段、空内容点解析不响应', () => {
  open();
  assert.equal(doc.querySelector('.overlay-title').textContent, '一键导入课表');
  assert.equal(doc.querySelector('.imp-hint').textContent, '请复制您的课表并粘贴');
  assert.match(doc.querySelector('.imp-note').textContent, /内容仅在本机解析，不会上传/);
  assert.deepEqual(doc.querySelectorAll('.seg-btn').map((b) => b.textContent), ['文字'], '未接 OCR 时不给图片入口');
  const btn = doc.querySelector('.imp-parse');
  assert.equal(btn.disabled, true);
  btn.click(); // 桩里禁用按钮的 click 仍会派发处理器：验证自守卫
  assert.ok(doc.querySelector('.imp-area'), '空内容点击后仍停在输入态');
  closeOverlay();
});

// ---------- 步骤 2：预览 + 写库 ----------

test('结构化粘贴 → 预览全绿 → 确认写库：importedFrom 标记、Toast、关浮层', () => {
  seedCourses([]);
  parseText([
    '高等数学 周一 第1-2节 教学一号楼101',
    '大学英语 周二 08:00-09:35 外语楼202',
  ].join('\n'));
  assert.equal(rowsInView().length, 2);
  for (const row of rowsInView()) {
    assert.equal(row.querySelector('.imp-badge').textContent, '已识别');
  }
  const submit = doc.querySelector('.imp-confirm');
  assert.equal(submit.textContent, '确认导入 2 门课');
  submit.click();
  assert.equal(panel(), null, '导入完成后浮层关闭');
  const saved = loadCourses();
  assert.equal(saved.length, 2);
  assert.ok(saved.every((c) => c.importedFrom === 'import'));
  assert.equal(saved[0].name, '高等数学');
  assert.equal(saved[0].day, 1);
  assert.deepEqual({ s: saved[0].startSection, e: saved[0].endSection }, { s: 1, e: 2 });
  assert.equal(saved[1].startSection, 1);
  assert.equal(saved[1].endSection, 2);
  assert.ok(toasts().some((t) => /已导入 2 门课 · 可随时编辑/.test(t)));
});

test('needsFix 行：勾选框禁用不可导入；补选星期后转已识别', () => {
  seedCourses([]);
  parseText('线性代数 教学一号楼303 第5-6节'); // 缺星期
  const row = rowsInView()[0];
  assert.equal(row.querySelector('.imp-badge').textContent, '需修正：缺星期');
  const cb = row.querySelector('.imp-check');
  assert.equal(cb.disabled, true);
  const submit = doc.querySelector('.imp-confirm');
  assert.equal(submit.textContent, '确认导入 0 门课');
  submit.click(); // 自守卫：0 选中不写库不关层
  assert.ok(panel(), '无可导入行时确认不关闭浮层');

  setSelect(selectsOf(row)[0], '1'); // 星期 → 周一
  assert.equal(row.querySelector('.imp-badge').textContent, '已识别');
  assert.equal(cb.disabled, false);
  cb.checked = true;
  cb.fire('change');
  assert.equal(doc.querySelector('.imp-confirm').textContent, '确认导入 1 门课');
  doc.querySelector('.imp-confirm').click();
  const saved = loadCourses();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].day, 1);
});

test('预览行内改课名/地点即时进模型', () => {
  seedCourses([]);
  parseText('占位课程 周三 第3-4节 三教101');
  const row = rowsInView()[0];
  const name = row.querySelector('.imp-name');
  name.value = '中级法语(1)';
  name.fire('input');
  const room = row.querySelector('.imp-room');
  room.value = '外院楼202';
  room.fire('input');
  doc.querySelector('.imp-confirm').click();
  const saved = loadCourses()[0];
  assert.equal(saved.name, '中级法语(1)');
  assert.equal(saved.room, '外院楼202');
});

// ---------- 冲突判定 ----------

test('预览内两行互相冲突：都标冲突不勾选；× 移除一行后另一行复活', () => {
  seedCourses([]);
  parseText([
    '高级语言程序设计 周一 第1-2节 教学一号楼101',
    '数据库原理 周一 第2-3节 教学一号楼102',
  ].join('\n'));
  const [rowA, rowB] = rowsInView();
  assert.match(rowA.querySelector('.imp-badge').textContent, /冲突：与「数据库原理」重叠/);
  assert.match(rowB.querySelector('.imp-badge').textContent, /冲突：与「高级语言程序设计」重叠/);
  assert.equal(doc.querySelector('.imp-confirm').textContent, '确认导入 0 门课');

  rowA.querySelector('.imp-remove-row').click();
  const rows2 = rowsInView();
  assert.equal(rows2.length, 1);
  assert.equal(rows2[0].querySelector('.imp-badge').textContent, '已识别');
  const cb = rows2[0].querySelector('.imp-check');
  assert.equal(cb.disabled, false);
  cb.checked = true;
  cb.fire('change');
  doc.querySelector('.imp-confirm').click();
  assert.deepEqual(loadCourses().map((c) => c.name), ['数据库原理']);
});

test('与已有课程冲突：预览标记且确认时不写库；不同时段正常导入', () => {
  seedCourses([{ id: 'x1', name: '已排好的课', day: 1, startSection: 1, endSection: 2, room: '', color: 'blue' }]);
  parseText([
    '冲突测试课 周一 第2-3节 楼101',
    '正常插入课 周三 第5-6节 楼102',
  ].join('\n'));
  const [bad, good] = rowsInView();
  assert.match(bad.querySelector('.imp-badge').textContent, /冲突：与「已排好的课」重叠/);
  assert.match(good.querySelector('.imp-badge').textContent, /已识别/);
  assert.equal(doc.querySelector('.imp-confirm').textContent, '确认导入 1 门课');
  doc.querySelector('.imp-confirm').click();
  const saved = loadCourses();
  assert.equal(saved.length, 2);
  assert.ok(saved.find((c) => c.id === 'x1'));
  assert.equal(saved.find((c) => c.name === '正常插入课').importedFrom, 'import');
});

test('单周/双周同星期同节次并存，不算冲突', () => {
  seedCourses([]);
  parseText([
    '法语口语 周一 第1-2节 楼101 单周',
    '法语听力 周一 第1-2节 楼102 双周',
  ].join('\n'));
  for (const row of rowsInView()) {
    assert.equal(row.querySelector('.imp-badge').textContent, '已识别');
  }
  assert.equal(doc.querySelector('.imp-confirm').textContent, '确认导入 2 门课');
  doc.querySelector('.imp-confirm').click();
  const saved = loadCourses();
  assert.equal(saved.length, 2);
  assert.equal(saved.find((c) => c.name === '法语口语').weeks.parity, 'odd');
  assert.equal(saved.find((c) => c.name === '法语听力').weeks.parity, 'even');
});

test('未识别行以 details 展开呈现，不静默丢弃', () => {
  seedCourses([]);
  parseText(['高等数学 周一 第1-2节 楼101', '！！！？？？'].join('\n'));
  const d = doc.querySelector('.imp-unparsed');
  assert.match(d.querySelector('summary').textContent, /未能识别的内容（1 行/);
  assert.equal(d.querySelector('.imp-unparsed-line').textContent, '！！！？？？');
  doc.querySelector('.imp-confirm').click();
});

// ---------- P5 半自动（样例 1 丢位文本） ----------

test('样例1：进入丢位提示态，文案与出路齐全', () => {
  seedCourses([]);
  const api = parseText(sample1);
  assert.equal(api.state.step, 'loss');
  assert.equal(doc.querySelector('.imp-loss-notice').textContent, '这种复制方式丢失了上课时间信息');
  assert.match(doc.querySelector('.imp-loss-reasons').textContent, /已认出 14 门课/);
  assert.ok(doc.querySelector('.imp-semi-open'));
  doc.querySelector('.imp-loss-back').click();
  assert.ok(doc.querySelector('.imp-area'), '返回修改原文回到输入态');
  closeOverlay();
});

test('样例1：半自动补选 1 条 → 预览 → 导入，未补全条给跳过 Toast', () => {
  seedCourses([]);
  const api = parseText(sample1);
  doc.querySelector('.imp-semi-open').click();
  const semiRows = doc.querySelectorAll('.imp-semi-row');
  assert.equal(semiRows.length, 14);
  assert.match(doc.querySelector('.imp-hint').textContent, /需要你补选上课时间/);
  const next = doc.querySelector('.imp-semi-next');
  assert.equal(next.disabled, true, '一条没补全时不可进入预览');

  const r0 = semiRows[0];
  assert.equal(r0.getAttribute('data-course'), '法国歌剧史与作品赏析');
  assert.equal(r0.querySelector('.imp-semi-room').textContent, '教学一号楼3004');
  const sels = selectsOf(r0);
  setSelect(sels[0], '1'); // 周一
  setSelect(sels[1], '1'); // 起：第1节
  setSelect(sels[2], '2'); // 止：第2节
  assert.match(next.textContent, /进入预览（已补全 1\/14）/);
  assert.equal(next.disabled, false);
  next.click();

  assert.ok(toasts().some((t) => /13 条还没补全时间，本次不会导入/.test(t)));
  assert.equal(rowsInView().length, 1);
  doc.querySelector('.imp-confirm').click();
  const saved = loadCourses();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, '法国歌剧史与作品赏析');
  assert.equal(saved[0].room, '教学一号楼3004');
  assert.equal(saved[0].day, 1);
  assert.equal(saved[0].startSection, 1);
  assert.equal(saved[0].endSection, 2);
  assert.equal(saved[0].importedFrom, 'import');
});

test('半自动起节联动止节：起始改到止节之后自动拉齐', () => {
  seedCourses([]);
  const api = parseText(sample1);
  doc.querySelector('.imp-semi-open').click();
  const sels = selectsOf(doc.querySelectorAll('.imp-semi-row')[0]);
  setSelect(sels[0], '1'); // 星期 → 周一（就绪判定要求星期+节次齐全）
  setSelect(sels[1], '3'); // 起 3 → 止自动 3
  setSelect(sels[2], '5'); // 止 5
  setSelect(sels[1], '6'); // 起 6 > 止 5 → 止拉齐 6
  const cand = api.state.candidates[0];
  assert.deepEqual({ s: cand.startSection, e: cand.endSection }, { s: 6, e: 6 });
  assert.match(doc.querySelector('.imp-semi-next').textContent, /已补全 1\/14/);
  closeOverlay();
});

// ---------- 清除导入课 ----------

test('清除全部导入课：confirm 后只删带标记的，手动课保留', () => {
  seedCourses([
    { id: 'm1', name: '手动课', day: 2, startSection: 1, endSection: 2, room: '', color: 'blue' },
    { id: 'i1', name: '导入课A', day: 3, startSection: 3, endSection: 4, room: '', color: 'green', importedFrom: 'import' },
    { id: 'i2', name: '导入课B', day: 4, startSection: 5, endSection: 6, room: '', color: 'orange', importedFrom: 'import' },
  ]);
  const api = open();
  assert.ok(doc.querySelector('.imp-clear'), '有导入课时应出现清除按钮');
  api.go('preview'); // 随便离开输入态再回来，按钮按当前数据重绘
  api.go('input');
  globalThis.confirm = () => true;
  doc.querySelector('.imp-clear').click();
  const left = loadCourses();
  assert.deepEqual(left.map((c) => c.id), ['m1']);
  assert.ok(toasts().some((t) => /已清除 2 门导入课/.test(t)));
  assert.equal(doc.querySelector('.imp-clear'), null, '清除后按钮消失');
  closeOverlay();
});

test('清除导入课：取消 confirm 时不动数据', () => {
  seedCourses([
    { id: 'i1', name: '导入课A', day: 3, startSection: 3, endSection: 4, room: '', color: 'green', importedFrom: 'import' },
  ]);
  open();
  globalThis.confirm = () => false;
  doc.querySelector('.imp-clear').click();
  assert.equal(loadCourses().length, 1);
  closeOverlay();
  globalThis.confirm = () => true;
});

// ---------- 图片通道接线（P6 前用替身验证接缝） ----------

test('注入 parseImage 后出现图片分段与上传区', () => {
  open({ parseImage: async () => ({ items: [], unparsed: [], positionLoss: false }) });
  assert.deepEqual(doc.querySelectorAll('.seg-btn').map((b) => b.textContent), ['文字', '图片']);
  doc.querySelectorAll('.seg-btn')[1].click();
  assert.equal(doc.querySelector('.imp-hint').textContent, '上传或粘贴课表截图');
  assert.ok(doc.querySelector('.imp-drop'));
  assert.ok(doc.querySelector('.imp-file'));
  assert.equal(doc.querySelector('.imp-parse').disabled, true, '未选图时解析禁用');
  closeOverlay();
});

test('parseImage 返回 gridFailed → 降级半自动并 Toast', async () => {
  seedCourses([]);
  const api = open({
    parseImage: async () => ({
      items: [{ raw: 'x', name: '未定位课程', day: null, startSection: null, endSection: null, room: '三教101', weeks: null, color: 'blue', status: 'semiAuto', missing: ['day', 'section'] }],
      unparsed: [],
      gridFailed: true,
    }),
  });
  // 桩里没有 FileReader/文件选择：直接摆好状态，点真实〔解析〕按钮走 onParse 分支
  api.state.mode = 'image';
  api.state.image = 'data:image/png;base64,AAAA';
  doc.querySelector('.imp-parse').click();
  await new Promise((r) => setTimeout(r, 0)); // 放行 parseImage 的 Promise 链
  assert.ok(toasts().some((t) => /未能从这张图里认出课表网格，已降级为半自动导入/.test(t)));
  assert.equal(api.state.step, 'semi');
  assert.equal(doc.querySelectorAll('.imp-semi-row').length, 1);
  assert.equal(doc.querySelector('.imp-semi-row').getAttribute('data-course'), '未定位课程');
  closeOverlay();
});

test('parseImage 正常返回网格结果 → 直接进预览', async () => {
  seedCourses([]);
  const api = open({
    parseImage: async () => ({
      items: [{ raw: 'g', name: '网格课', day: 2, startSection: 3, endSection: 4, room: 'R1-4090', weeks: null, color: 'cyan', status: 'ok', missing: [] }],
      unparsed: [],
      positionLoss: false,
    }),
  });
  api.state.mode = 'image';
  api.state.image = 'data:image/png;base64,AAAA';
  doc.querySelector('.imp-parse').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(rowsInView().length, 1);
  assert.equal(rowsInView()[0].querySelector('.imp-badge').textContent, '已识别');
  doc.querySelector('.imp-confirm').click();
  const saved = loadCourses();
  assert.equal(saved[0].name, '网格课');
  assert.equal(saved[0].room, 'R1-4090');
});

test('parseImage 抛错 → 按钮复位并给失败 Toast', async () => {
  const api = open({
    parseImage: async () => { throw new Error('引擎缺失'); },
  });
  api.state.mode = 'image';
  api.state.image = 'data:image/png;base64,AAAA';
  doc.querySelector('.imp-parse').click();
  await new Promise((r) => setTimeout(r, 0));
  const btn = doc.querySelector('.imp-parse');
  assert.equal(btn.textContent, '解析');
  assert.equal(btn.disabled, false);
  assert.ok(toasts().some((t) => /识别失败：引擎缺失/.test(t)));
  closeOverlay();
});

// ---------- 课表页入口接线 ----------

function setDesktop(on) {
  globalThis.window = { matchMedia: () => ({ matches: on, addEventListener() {}, removeEventListener() {} }) };
}
const { render: renderTimetable, __reset: resetTimetable } = await import('../views/timetable.js');
const MON_9 = new Date(2026, 8, 7, 9, 0, 0);
const view = () => doc.querySelector('#view');

test('课表页头部：一键导入按钮打开导入浮层（图片通道已接线）', () => {
  seedCourses([{ id: 'c1', name: '大学计算机基础', day: 2, startSection: 4, endSection: 6, room: 'R1-4090', color: 'cyan' }]);
  setDesktop(true);
  resetTimetable();
  renderTimetable(view(), new URLSearchParams(), MON_9);
  doc.querySelector('.tt-import-btn').click();
  assert.equal(doc.querySelector('.overlay-title').textContent, '一键导入课表');
  assert.deepEqual(doc.querySelectorAll('.seg-btn').map((b) => b.textContent), ['文字', '图片']);
  closeOverlay();
  resetTimetable();
});

test('空课表：空态附导入课表引导按钮', () => {
  seedCourses([]);
  setDesktop(true);
  resetTimetable();
  renderTimetable(view(), new URLSearchParams(), MON_9);
  const btn = doc.querySelector('.tt-empty-import');
  assert.match(btn.textContent, /导入课表/);
  btn.click();
  assert.equal(doc.querySelector('.overlay-title').textContent, '一键导入课表');
  closeOverlay();
  resetTimetable();
});

// ---------- 清理定时器后进程可退出 ----------

test('toast 定时器不阻塞退出（全部 dismiss）', () => {
  for (const t of doc.querySelectorAll('.toast')) t.remove();
});
