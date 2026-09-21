import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, mountShell } from './dom-stub.mjs';

installDom();
mountShell();
globalThis.location = { hash: '#/' };

const { defineRoutes, render } = await import('../lib/router.js');
const { renderNav, renderTopbar } = await import('../main.js');
const { openOverlay, closeOverlay, toast } = await import('../lib/feedback.js');
const { renderEmpty } = await import('../components/emptyState.js');

test('导航在 rail 与 tabbar 各渲染 3 个 Tab', () => {
  renderNav();
  assert.equal(document.querySelectorAll('#rail .tab').length, 3);
  assert.equal(document.querySelectorAll('#tabbar .tab').length, 3);
  assert.deepEqual(
    document.querySelectorAll('#tabbar .tab').map((t) => t.textContent),
    ['首页', '课表', '日程'],
  );
});

test('路由渲染与 active 标记', () => {
  const calls = [];
  defineRoutes({
    '#/': (el, params) => calls.push(['home', params]),
    '#/timetable': (el, params) => calls.push(['timetable', params]),
    '#/tasks': (el, params) => calls.push(['tasks', params]),
  });

  render();
  assert.equal(calls.at(-1)[0], 'home');
  assert.ok(document.querySelector('#tabbar .tab[data-route="#/"]').classList.contains('active'));

  location.hash = '#/timetable';
  render();
  assert.equal(calls.at(-1)[0], 'timetable');
  assert.ok(document.querySelector('#rail .tab[data-route="#/timetable"]').classList.contains('active'));
  assert.ok(!document.querySelector('#rail .tab[data-route="#/"]').classList.contains('active'));
});

test('未知路由回落首页；hash 参数解析', () => {
  const calls = [];
  defineRoutes({
    '#/': (el, params) => calls.push(['home', params]),
    '#/tasks': (el, params) => calls.push(['tasks', params]),
  });
  location.hash = '#/nope';
  render();
  assert.equal(calls.at(-1)[0], 'home');

  location.hash = '#/tasks?focus=t9';
  render();
  assert.equal(calls.at(-1)[0], 'tasks');
  assert.equal(calls.at(-1)[1].get('focus'), 't9');
});

test('顶栏显示日期与周次', () => {
  renderTopbar(new Date(2026, 8, 20));
  const text = document.querySelector('#topbar').textContent;
  assert.match(text, /9月20日 周日/);
  assert.match(text, /第2周/);
});

test('浮层打开/关闭/Esc', () => {
  const body = document.createElement('div');
  body.textContent = '表单内容';
  const panel = openOverlay({ title: '新建日程', body });
  assert.ok(panel);
  assert.equal(document.querySelector('.overlay-title').textContent, '新建日程');
  assert.match(document.querySelector('.overlay-body').textContent, /表单内容/);

  document.fire('keydown', { key: 'Escape' });
  assert.equal(document.querySelector('.overlay-panel'), null);

  openOverlay({ title: '再开', body });
  assert.equal(document.querySelectorAll('.overlay-panel').length, 1);
  openOverlay({ title: '替换', body }); // 打开新层应替换旧层
  assert.equal(document.querySelectorAll('.overlay-panel').length, 1);
  assert.equal(document.querySelector('.overlay-title').textContent, '替换');
  closeOverlay();
});

test('toast 出现、动作回调、消失', () => {
  let acted = 0;
  const t = toast('已删除「组会」', { actionLabel: '撤销', onAction: () => { acted += 1; } });
  const node = document.querySelector('.toast');
  assert.ok(node);
  assert.match(node.textContent, /已删除「组会」/);
  node.querySelector('.toast-action').click();
  assert.equal(acted, 1);
  assert.equal(document.querySelector('.toast'), null);

  const t2 = toast('普通提示');
  assert.equal(document.querySelector('.toast .toast-action'), null);
  t2.dismiss();
  assert.equal(document.querySelector('.toast'), null);
});

test('空态组件带引导按钮', () => {
  let clicked = 0;
  const node = renderEmpty({ text: '还没有日程', actionText: '记一笔', onAction: () => { clicked += 1; } });
  document.querySelector('#view').appendChild(node);
  document.querySelector('#view .empty .btn').click();
  assert.equal(clicked, 1);
});

test('迷你月历：上/下个月按钮可翻月', async () => {
  const { buildMiniCalendar } = await import('../components/miniCalendar.js');
  const taskDates = new Set();
  const sept = new Date(2026, 8, 20);
  const cal = buildMiniCalendar(sept, taskDates, []);
  assert.match(cal.querySelector('.cal-title').textContent, /2026年9月/);
  assert.ok(cal.querySelector('.cal-nav-btn[aria-label="上个月"]'));
  assert.ok(cal.querySelector('.cal-nav-btn[aria-label="下个月"]'));
});
