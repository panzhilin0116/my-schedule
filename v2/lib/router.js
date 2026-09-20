import { qs, mount } from './dom.js';
import { StoreError, resetStore, subscribe } from './store.js';
import { dayKey } from './time.js';
import { renderError } from '../components/emptyState.js';
import { toast } from './feedback.js';

let table = {};
let fallback = '#/';
let last = null; // 最近一次成功渲染的 { route, params }，供跨零点原地刷新

export function defineRoutes(map, fb) {
  table = map;
  if (fb) fallback = fb;
}

export function parseHash() {
  const raw = (globalThis.location?.hash || '').slice(1) || '/';
  const [path, query] = raw.split('?');
  const params = new URLSearchParams(query || '');
  return { path: '#' + path, params };
}

export function navigate(hash) {
  if (globalThis.location?.hash === hash) render();
  else if (globalThis.location) globalThis.location.hash = hash;
}

export function render() {
  const { path, params } = parseHash();
  const route = table[path] || table[fallback];
  const view = qs('#view');
  try {
    route(view, params);
    last = { route, params };
  } catch (err) {
    if (!(err instanceof StoreError)) throw err;
    // 存储里的数据坏了：整页换成错误态，提供重试与一键清空重置。
    mount(view, renderError({
      message: '本地日程数据损坏，无法读取',
      onRetry: () => { location.hash = ''; location.hash = path; render(); },
      onReset: resetAndRender,
    }));
  }
  markActive(path in table ? path : fallback);
  return path;
}

function resetAndRender() {
  resetStore();
  render();
  toast('数据已清空重置');
}

function markActive(path) {
  for (const el of document.querySelectorAll('[data-route]')) {
    el.classList.toggle('active', el.getAttribute('data-route') === path);
  }
}

export function start(map) {
  defineRoutes(map);
  window.addEventListener('hashchange', render);
  if (!globalThis.location.hash) globalThis.location.hash = '#/';
  render();

  // 多标签页同步：其他标签页写入 localStorage 时原地重渲染当前页。
  const unsubStorage = subscribe(() => { if (last) render(); });

  // 跨零点刷新：切回本页时如果日期已变，按当前时刻重渲染。
  const checkDay = makeDayGuard();
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    if (checkDay() && last) render();
  };
  document.addEventListener('visibilitychange', onVisible);

  // 兜底：页面整夜开着（后台被降频但仍会触发）时也能换日。
  const rollover = setInterval(() => {
    if (checkDay() && last) render();
  }, 30000);

  return () => {
    unsubStorage();
    clearInterval(rollover);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

/** 从后台切回可见时的判 day 逻辑；now 可注入以便测试。 */
export function makeDayGuard(now = new Date()) {
  let seen = dayKey(now);
  return function check(again = new Date()) {
    const day = dayKey(again);
    if (day === seen) return false;
    seen = day;
    return true;
  };
}
