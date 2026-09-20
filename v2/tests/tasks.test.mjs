import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, mountShell } from './dom-stub.mjs';

installDom();
const doc = mountShell();
globalThis.location = { hash: '#/tasks' };

function makeStorage(init = {}) {
  const map = new Map(Object.entries(init));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}
globalThis.localStorage = makeStorage();

const { saveTasks, loadTasks, STORAGE_KEY } = await import('../lib/store.js');
const { render, __reset } = await import('../views/tasks.js');
const { closeOverlay } = await import('../lib/feedback.js');

const NOW = new Date(2026, 8, 20, 10, 0); // 2026-09-20 周日 10:00
const view = () => doc.querySelector('#view');
const params = () => new URLSearchParams();

const SEED = [
  { id: 't1', title: '还书', date: '2026-09-19', done: false, createdAt: 1 },
  { id: 't2', title: '交法语作业', date: '2026-09-20', startTime: '19:50', endTime: '21:30', done: false, createdAt: 2 },
  { id: 't3', title: '取快递', date: '2026-09-20', done: true, createdAt: 3 },
  { id: 't4', title: '组会', date: '2026-09-21', startTime: '14:00', endTime: '15:30', location: '主楼302', done: false, createdAt: 4 },
  { id: 't5', title: '买返程票', date: '2026-09-25', done: false, createdAt: 5 },
];

function seed() {
  globalThis.localStorage = makeStorage({ [STORAGE_KEY]: JSON.stringify(SEED) });
  __reset();
}

test('分组顺序与高亮竖条', () => {
  seed();
  render(view(), params(), NOW);
  const heads = doc.querySelectorAll('.tk-group-head').map((x) => x.textContent);
  assert.deepEqual(heads, ['逾期 (1)', '今天 · 9月20日 周日 (2)', '明天 (1)', '未来 (1)']);
  assert.ok(doc.querySelector('[data-id="t1"]').classList.contains('bar-orange'));
  assert.ok(doc.querySelector('[data-id="t2"]').classList.contains('bar-cyan'));
  assert.ok(doc.querySelector('[data-id="t4"]').classList.contains('bar-cyan'));
  const todayRows = doc.querySelector('.g-today').querySelectorAll('.tk-row');
  assert.deepEqual(todayRows.map((r) => r.getAttribute('data-id')), ['t2', 't3']); // 已完成沉底
});

test('勾选完成写入存储并换位', () => {
  seed();
  render(view(), params(), NOW);
  doc.querySelector('[data-id="t3"] .tk-check').click();
  const t3 = loadTasks(globalThis.localStorage).find((t) => t.id === 't3');
  assert.equal(t3.done, false);
  const todayRows = doc.querySelector('.g-today').querySelectorAll('.tk-row');
  assert.deepEqual(todayRows.map((r) => r.getAttribute('data-id')), ['t2', 't3']);
  assert.ok(!todayRows[1].classList.contains('done')); // t3 取消完成后不再置灰
});

test('筛选：未完成 / 已完成', () => {
  seed();
  render(view(), params(), NOW);
  const segs = doc.querySelectorAll('.seg-btn');
  segs[1].click(); // 未完成
  assert.equal(doc.querySelectorAll('.tk-row.done').length, 0);
  render(view(), params(), NOW);
  doc.querySelectorAll('.seg-btn')[2].click(); // 已完成
  const ids = doc.querySelectorAll('.tk-row').map((r) => r.getAttribute('data-id'));
  assert.deepEqual(ids, ['t3']);
});

test('编辑浮层删除 + Toast 撤销恢复', () => {
  seed();
  render(view(), params(), NOW);
  doc.querySelector('[data-id="t1"] .tk-main').click();
  assert.equal(doc.querySelector('.overlay-title').textContent, '编辑日程');
  doc.querySelector('.f-delete').click();
  assert.equal(loadTasks(globalThis.localStorage).find((t) => t.id === 't1'), undefined);
  const undo = doc.querySelector('.toast .toast-action');
  assert.ok(undo);
  undo.click();
  assert.ok(loadTasks(globalThis.localStorage).find((t) => t.id === 't1'));
});

test('新建：校验、禁用提交、保存成功', () => {
  seed();
  render(view(), params(), NOW);
  doc.querySelector('.fab').click();
  assert.equal(doc.querySelector('.overlay-title').textContent, '新建日程');
  const submit = doc.querySelector('.f-submit');
  const title = doc.querySelector('.f-title');
  assert.equal(submit.disabled, true);

  title.fire('blur');
  assert.equal(doc.querySelector('.f-row .f-err').textContent, '标题不能为空');

  title.value = '开组会';
  title.fire('input');
  const inputs = doc.querySelectorAll('.task-form input');
  const start = inputs[2];
  const end = inputs[3];
  start.value = '14:00';
  start.fire('input');
  assert.equal(submit.disabled, true); // 成对校验
  start.fire('blur');
  end.fire('blur');
  assert.equal(doc.querySelectorAll('.f-err').map((e) => e.textContent).includes('开始与结束时间需成对填写'), true);

  end.value = '15:00';
  end.fire('input');
  assert.equal(submit.disabled, false);
  submit.click();
  assert.equal(doc.querySelector('.overlay-panel'), null);
  const saved = loadTasks(globalThis.localStorage).find((t) => t.title === '开组会');
  assert.ok(saved);
  assert.equal(saved.startTime, '14:00');
  assert.equal(saved.date, '2026-09-20');
});

test('左滑条目触发删除', () => {
  seed();
  render(view(), params(), NOW);
  const row = doc.querySelector('[data-id="t5"]');
  row.fire('touchstart', { touches: [{ clientX: 300 }] });
  row.fire('touchend', { changedTouches: [{ clientX: 200 }] });
  assert.equal(loadTasks(globalThis.localStorage).find((t) => t.id === 't5'), undefined);
  assert.ok(doc.querySelector('.toast'));
  closeOverlay();
});

test('空态引导打开新建浮层', () => {
  globalThis.localStorage = makeStorage();
  __reset();
  render(view(), params(), NOW);
  assert.ok(doc.querySelector('.empty'));
  doc.querySelector('.empty .btn').click();
  assert.equal(doc.querySelector('.overlay-title').textContent, '新建日程');
  closeOverlay();
});

test('focus 参数高亮定位', () => {
  seed();
  render(view(), new URLSearchParams('focus=t2'), NOW);
  assert.ok(doc.querySelector('[data-id="t2"]').classList.contains('flash'));
  assert.ok(!doc.querySelector('[data-id="t1"]').classList.contains('flash'));
});

test('清理', () => {
  __reset();
});
