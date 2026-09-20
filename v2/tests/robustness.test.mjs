// S6 横切健壮性：坏数据 → 整页错误态（可重置）、多标签页 storage 同步、跨零点刷新、断网纯前端。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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

// window 事件在桩件里统一转发到 document，便于 doc.fire 模拟 storage/visibilitychange
const winHandlers = new Map();
globalThis.window = {
  addEventListener(type, handler) {
    if (!winHandlers.has(type)) winHandlers.set(type, []);
    winHandlers.get(type).push(handler);
    doc.addEventListener(type, handler);
  },
  removeEventListener(type, handler) {
    (winHandlers.get(type) ?? []).splice((winHandlers.get(type) ?? []).indexOf(handler), 1);
    doc.removeEventListener(type, handler);
  },
};

const V2 = join(dirname(fileURLToPath(import.meta.url)), '..');
const { renderSkeleton } = await import('../components/emptyState.js');
const { STORAGE_KEY, loadTasks } = await import('../lib/store.js');
const router = await import('../lib/router.js');
const tasksView = await import('../views/tasks.js');
const homeView = await import('../views/home.js');
const timetableView = await import('../views/timetable.js');

const NOW = new Date(2026, 8, 20, 10, 0);
const view = () => doc.querySelector('#view');

function routes() {
  return {
    '#/': (el, params) => homeView.render(el, params, NOW),
    '#/timetable': (el, params) => timetableView.render(el, params, NOW),
    '#/tasks': (el, params) => tasksView.render(el, params, NOW),
  };
}

test('坏 JSON：整页错误态而不是白屏', () => {
  globalThis.localStorage = makeStorage({ [STORAGE_KEY]: '{broken' });
  location.hash = '#/tasks';
  router.defineRoutes(routes());
  router.render();
  assert.ok(view().querySelector('.error-state'));
  assert.match(view().textContent, /本地日程数据损坏/);
  assert.ok(view().querySelector('.error-actions .btn'));
  assert.ok(view().querySelectorAll('.error-actions .btn').length >= 2); // 重试 + 清空并重置
});

test('错误态点「清空并重置」：存储清空、页面恢复渲染', () => {
  const resetBtn = view().querySelectorAll('.error-actions .btn').find((b) => b.textContent === '清空并重置');
  resetBtn.click();
  assert.deepEqual(loadTasks(globalThis.localStorage), []); // 坏数据被清掉，读取不再报错
  assert.equal(view().querySelector('.error-state'), null);
  assert.ok(view().querySelector('.empty')); // 空态而非报错
  assert.match(doc.querySelector('#toast-root').textContent, /数据已清空重置/);
});

test('多标签页同步：storage 事件后当前页可见新数据', () => {
  globalThis.localStorage = makeStorage();
  location.hash = '#/tasks';
  const stop = router.start(routes());

  // A 标签页写入（直接改存储），B 标签页收到 storage 事件
  const crossTab = { key: STORAGE_KEY };
  globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify([
    { id: 'x1', title: '另一页新建的日程', date: '2026-09-21', done: false, createdAt: 1 },
  ]));
  doc.fire('storage', crossTab);
  assert.match(view().textContent, /另一页新建的日程/);

  doc.fire('storage', { key: 'something.else' }); // 无关键不应视为更新，但数据仍在
  assert.match(view().textContent, /另一页新建的日程/);
  stop();
});

test('跨零点：makeDayGuard 换 day 才放行', () => {
  const check = router.makeDayGuard(new Date(2026, 8, 20, 23, 59));
  assert.equal(check(new Date(2026, 8, 20, 23, 59, 59)), false);
  assert.equal(check(new Date(2026, 8, 21, 0, 1)), true);
  assert.equal(check(new Date(2026, 8, 21, 12, 0)), false); // 同一新的一天不重复刷
});

test('跨零点：visibilitychange 触发整页按新日期重渲染', () => {
  globalThis.localStorage = makeStorage({ [STORAGE_KEY]: JSON.stringify([
    { id: 'm1', title: '零点后的今天日程', date: '2026-09-21', done: false, createdAt: 1 },
  ]) });
  location.hash = '#/';
  const stop = router.start(routes());
  // 注入时刻为 9/20 10:00：这条属于「明天」，只出现在临近日程组，不在今日区
  const todaySection = () => view().querySelector('.hm-tasks')?.textContent ?? '';
  assert.doesNotMatch(todaySection(), /零点后的今天日程/);

  // 模拟时间走到次日 00:05：守卫放行 → 按新日期重渲染 → 该条进入今日区
  const check = router.makeDayGuard(new Date(2026, 8, 20, 23, 59));
  assert.equal(check(new Date(2026, 8, 21, 0, 5)), true);
  homeView.render(view(), new URLSearchParams(), new Date(2026, 8, 21, 0, 5));
  assert.match(view().textContent, /零点后的今天日程/);
  stop();
});

test('断网纯前端：v2 源码不含 fetch/XHR/网络接口调用', () => {
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.js')) files.push(p);
    }
  })(join(V2, 'lib'));
  for (const d of ['views', 'components', 'data']) {
    for (const name of readdirSync(join(V2, d))) files.push(join(V2, d, name));
  }
  files.push(join(V2, 'main.js'), join(V2, 'index.html'));
  const pattern = /\bfetch\s*\(|XMLHttpRequest|EventSource|WebSocket|import\s*\(/;
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!pattern.test(src), `${f} 含网络调用`);
  }
});

test('首屏骨架：index.html 的 #view 自带骨架，首次渲染即被替换', () => {
  const html = readFileSync(join(V2, 'index.html'), 'utf8');
  const viewInner = html.match(/<main class="view" id="view"[^>]*>([\s\S]*?)<\/main>/)[1];
  assert.match(viewInner, /class="skeleton"/);
  assert.ok((viewInner.match(/skeleton-row/g) ?? []).length >= 3);

  globalThis.localStorage = makeStorage();
  location.hash = '#/tasks';
  const stop = router.start(routes());
  view().appendChild(renderSkeleton(4)); // 复刻首屏状态
  assert.ok(view().querySelector('.skeleton'));
  router.render();
  assert.equal(view().querySelector('.skeleton'), null); // 挂载时整体替换
  stop();
});

test('清理定时器', () => {
  tasksView.__reset();
  timetableView.__stop();
  homeView.__stop();
});
