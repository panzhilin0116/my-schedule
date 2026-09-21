import { h, qs } from './lib/dom.js';
import { start as startRouter } from './lib/router.js';
import { fmtDateCN, weekLabel } from './lib/time.js';
import { openMiniCalendar } from './components/miniCalendar.js';
import { ensureSpace, getSpaceId, resetSpace } from './lib/space.js';
import * as home from './views/home.js';
import * as timetable from './views/timetable.js';
import * as tasks from './views/tasks.js';

const TABS = [
  { hash: '#/', label: '首页', key: 'home' },
  { hash: '#/timetable', label: '课表', key: 'timetable' },
  { hash: '#/tasks', label: '日程', key: 'tasks' },
];

function tabNode(tab) {
  return h(
    'button', { class: 'tab', type: 'button', 'data-route': tab.hash, onclick: () => { location.hash = tab.hash; } },
    h('span', { class: 'dot' }),
    h('span', { class: 'tab-label' }, tab.label),
  );
}

export function renderNav() {
  const rail = qs('#rail');
  const tabbar = qs('#tabbar');
  if (rail && !rail.childNodes.length) {
    rail.appendChild(h('div', { class: 'rail-title' }, '日程任务舱'));
    for (const t of TABS) rail.appendChild(tabNode(t));
  }
  if (tabbar && !tabbar.childNodes.length) {
    for (const t of TABS) tabbar.appendChild(tabNode(t));
  }
}

export function renderTopbar(now = new Date()) {
  const topbar = qs('#topbar');
  if (!topbar) return;
  topbar.textContent = '';

  const spaceId = getSpaceId();
  const spaceShort = spaceId ? spaceId.slice(-4).toUpperCase() : '----';

  topbar.appendChild(h(
    'button', { class: 'tb-date-btn', type: 'button', onclick: () => openMiniCalendar(new Date()) },
    h('span', { class: 'tb-date' }, `${fmtDateCN(now)} · `),
    h('span', { class: 'tb-week' }, weekLabel(now)),
    h('span', { class: 'tb-cal', 'aria-hidden': 'true' }, '▦'),
  ));

  topbar.appendChild(h(
    'div', { class: 'tb-space' },
    h('span', { class: 'tb-space-label' }, '空间'),
    h('span', { class: 'tb-space-id', title: '你的专属空间 ID' }, spaceShort),
    h('button', {
      class: 'tb-space-new',
      type: 'button',
      title: '新建空间（当前数据将保留，但会切换到全新空间）',
      onclick: () => {
        if (confirm('新建空间后，当前数据会保留在旧空间中。你可以随时切换回来。确定新建？')) {
          resetSpace();
          location.reload();
        }
      },
    }, '+'),
  ));
}

export function boot() {
  ensureSpace();
  renderNav();
  renderTopbar();
  setInterval(() => renderTopbar(), 30000);
  startRouter({
    '#/': home.render,
    '#/timetable': timetable.render,
    '#/tasks': tasks.render,
  });
}

if (typeof window !== 'undefined' && qs('#view')) {
  boot();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}
