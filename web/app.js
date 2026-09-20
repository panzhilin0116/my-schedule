// 应用外壳：启动、hash 路由、导航渲染、全局快捷键与刷新时机。
// 视图只读 store 的状态快照，写操作一律经过 store（乐观更新 + 失败回滚）。
import { h, mount, byId, icon } from './lib/dom.js';
import { ROUTES, routeByKey, navRoutes, keyBindings, parseHash } from './routes.js';
import { createStore } from './lib/store.js';
import { createApi } from './lib/api.js';
import { closeTopLayer, layerIsOpen, toast, skeleton, errorState } from './lib/ui.js';
import * as T from './lib/time.js';
import { renderHome } from './views/home.js';
import { renderTimetable } from './views/timetable.js';
import { renderTasks } from './views/tasks.js';
import { renderResearch } from './views/research.js';
import { renderWorkout } from './views/workout.js';
import { renderSettings } from './views/settings.js';

const VIEWS = {
  home: renderHome,
  timetable: renderTimetable,
  tasks: renderTasks,
  research: renderResearch,
  workout: renderWorkout,
  settings: renderSettings,
};

const BINDINGS = new Map(keyBindings);

const store = createStore({
  api: createApi(),
  events: typeof document === 'undefined' ? undefined : { document },
});

const ctx = {
  store,
  navigate,
  time: () => ({ today: T.todayKey(), now: new Date() }),
  toast,
};

let current = { key: 'home', sub: '', query: new URLSearchParams() };
let lastWriteError = null;
let renderedDay = null;

function brand() {
  return h('div.brand',
    h('a.mark', { href: '#/', 'aria-label': '回到首页' }),
    h('div.words', h('b', { text: '日程任务舱' }), h('span', { text: 'MISSION CONTROL' })),
  );
}

function navLink(route, collapsed) {
  const target = `#/${route.path}`;
  const active = current.key === route.key;
  return h('a.nav-item', {
    href: target, dataset: { key: route.key }, title: route.title,
    'aria-current': active ? 'page' : null,
    'aria-label': collapsed ? route.title : null,
  }, icon(route.icon), h('span.nav-label', { text: route.title }));
}

function renderShell() {
  const collapsed = store.pref('ui.rail', false) === true;
  const rail = byId('rail');
  if (!rail) return;
  mount(rail,
    brand(),
    navRoutes.map((route) => navLink(route, collapsed)),
    h('div.rail-foot',
      h('a.nav-item', {
        href: '#/settings', title: '设置', 'aria-current': current.key === 'settings' ? 'page' : null,
      }, icon('settings'), h('span.nav-label', { text: '设置' })),
      h('button.collapse', {
        type: 'button', 'aria-label': collapsed ? '展开侧栏' : '收起侧栏', 'aria-expanded': String(!collapsed),
        onclick: () => { store.setPref('ui.rail', !collapsed); render(); },
      }, icon(collapsed ? 'chevRight' : 'chevLeft')),
    ),
  );
  rail.dataset.collapsed = String(collapsed);
  mount(byId('tabbar'),
    navRoutes.map((route) => h('a', {
      href: `#/${route.path}`, 'aria-current': current.key === route.key ? 'page' : null,
    }, icon(route.icon), h('span', { text: route.title }))),
  );
}

function renderTopbar(route) {
  const state = store.state;
  const today = T.todayKey();
  const week = T.weekOf(today, state.config);
  mount(byId('topbar'),
    // 设置不在导航里（PRD 2.2：从首页右上角齿轮进），窄屏下侧栏是收起的，
    // 所以齿轮与返回都要放在顶栏，否则进了设置就出不来
    route.nav === false ? h('a.iconbtn', { href: '#/', 'aria-label': '返回首页', title: '返回首页' }, icon('chevLeft')) : null,
    h('div.titles', h('h1', { text: route.title }), h('span', { text: route.subtitle })),
    h('div.spacer'),
    h('div.clock',
      h('div', { text: T.fmtDate(today) }),
      h('b', { text: week ? `第 ${week} 周 / 共 ${state.config.total_weeks} 周` : (state.config ? '假期 / 学期外' : '未设置学期') }),
    ),
    // 有旧数据可读时不回骨架屏，但必须当场说明"这一屏不是刚同步来的"
    state.error?.stale ? h('span.badge.red.stale', {
      role: 'status', 'aria-label': '上次同步失败，界面显示的是上一次的数据',
      title: `${state.error.message}（显示的是上一次成功同步的数据）`, text: '同步失败',
    }) : null,
    h('button.iconbtn', {
      type: 'button', 'aria-label': '刷新数据', title: '刷新数据',
      onclick: async (event) => {
        event.currentTarget.disabled = true;
        await store.refresh();
        event.currentTarget.disabled = false;
        render();
      },
    }, icon('refresh')),
    route.key === 'home' ? h('a.iconbtn.settings-entry', {
      href: '#/settings', 'aria-label': '设置', title: '设置',
    }, icon('settings')) : null,
  );
}

function render() {
  const route = routeByKey(current.key) ?? ROUTES[0];
  const view = byId('view');
  if (!view) return;
  renderShell();
  renderTopbar(route);
  document.title = `${route.title} · 日程任务舱`;
  const state = store.state;
  const args = { store, ctx, state, route, sub: current.sub, query: current.query, time: ctx.time() };
  let content;
  // 加载骨架与错误重试一律走 lib/ui.js 的同一套原语：六个页面口径要一样
  if (state.status === 'loading' || state.status === 'idle') {
    content = h('div.stack', skeleton(1, 92), skeleton(3));
  } else if (state.status === 'error') {
    content = errorState({
      message: state.error?.message ?? '无法读取数据',
      detail: '数据还在服务器上，恢复网络后点重试即可',
      onRetry: () => store.load().then(render),
    });
  } else {
    content = (VIEWS[route.key] ?? VIEWS.home)(args);
  }
  mount(view, content);
  renderedDay = T.todayKey();
}

/**
 * 定时与切回前台走这里的重绘：重绘会换掉整屏节点，
 * 焦点还在填写框里或浮层开着时重绘，等于把用户正在输入的东西扔掉、把长按拖拽打断。
 * 跳过一次不要紧：跨天的判定条件仍然成立，下一轮定时器会补上。
 */
function repaint() {
  const active = globalThis.document?.activeElement;
  const view = byId('view');
  if (layerIsOpen()) return;
  if (view && active && active !== view && view.contains(active)) return;
  render();
}

function navigate(hash) {
  const target = hash ?? globalThis.location?.hash ?? '';
  // 视图里的程序化跳转（周次切换、返回上级）必须写回地址栏：
  // 状态只存在查询串里，不写回去刷新就回到默认屏，浏览器后退也没有这一步。
  if (globalThis.location && globalThis.location.hash !== target) globalThis.location.hash = target;
  current = parseHash(target);
  byId('view')?.focus?.({ preventScroll: true });
  render();
}

/** 快捷键：1–6 切页、N 新建（各视图自定含义）、Esc 关闭浮层。 */
function onKeydown(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === 'Escape') {
    if (closeTopLayer()) event.preventDefault();
    return;
  }
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
  if (event.key === 'n' || event.key === 'N') {
    const handler = VIEWS[current.key]?.onNew;
    if (handler) { event.preventDefault(); handler({ store, ctx, state: store.state, time: ctx.time() }); }
    return;
  }
  const key = BINDINGS.get(event.key);
  if (key && `#/${routeByKey(key).path}` !== globalThis.location?.hash) {
    event.preventDefault();
    globalThis.location.hash = `#/${routeByKey(key).path}`;
  }
}

/** 下拉刷新：页面已在顶部时向下拖超过阈值即回读服务端。 */
function bindPullToRefresh() {
  const view = byId('view');
  if (!view) return;
  let startY = 0;
  let pulling = false;
  const indicator = h('div.pull-hint', { text: '↓ 松开刷新' });
  document.body.appendChild(indicator);
  const setProgress = (dy) => {
    indicator.style.opacity = dy > 12 ? String(Math.min(1, dy / 90)) : '0';
    indicator.textContent = dy > 70 ? '↑ 松开刷新' : '↓ 松开刷新';
  };
  view.addEventListener('touchstart', (event) => {
    if ((globalThis.scrollY ?? 0) > 0 || event.touches.length !== 1) return;
    startY = event.touches[0].clientY;
    pulling = true;
  }, { passive: true });
  view.addEventListener('touchmove', (event) => {
    if (pulling) setProgress(event.touches[0].clientY - startY);
  }, { passive: true });
  const finish = async (event) => {
    if (!pulling) return;
    pulling = false;
    const dy = (event.changedTouches?.[0]?.clientY ?? startY) - startY;
    setProgress(0);
    if (dy > 70) {
      const result = await store.refresh();
      render();
      // 失败要说失败：给出"已同步"的成功回执，比不刷新更容易骗人
      if (result.error?.stale) toast('同步失败，界面上还是上一次的数据', { kind: 'error', duration: 4000 });
      else toast('已同步最新数据', { kind: 'ok', duration: 2000 });
    }
  };
  view.addEventListener('touchend', finish);
  view.addEventListener('touchcancel', finish);
}

export function start() {
  globalThis.addEventListener?.('hashchange', () => navigate(globalThis.location.hash));
  globalThis.addEventListener?.('keydown', onKeydown);
  store.subscribe((state) => {
    if (state.writeError && state.writeError !== lastWriteError) {
      lastWriteError = state.writeError;
      toast(state.writeError.unknown ? `${state.writeError.message}（结果未知，已停止自动重试）` : state.writeError.message, { kind: 'error', duration: 0 });
    }
    render();
  });
  // 跨天时首页读数必须跟着变，不必依赖用户操作
  globalThis.setInterval?.(() => {
    if (T.todayKey() !== renderedDay) repaint();
  }, 30000);
  // 倒计时是分钟级读数：只重写那一小段文字，整页重绘会打断首页的长按排序
  globalThis.setInterval?.(() => {
    const node = globalThis.document?.querySelector?.('[data-countdown]');
    if (node) node.textContent = T.countdownText(node.dataset.countdown, new Date());
  }, 60000);
  // 切回前台：时间已经走过去了，读数按当下重算（数据回读由 store 负责）
  globalThis.document?.addEventListener?.('visibilitychange', () => {
    if (globalThis.document.visibilityState === 'visible') repaint();
  });
  bindPullToRefresh();
  navigate(globalThis.location?.hash);
  store.load();
}

export { store, navigate, render, ctx };

if (typeof document !== 'undefined' && byId('view')) start();
