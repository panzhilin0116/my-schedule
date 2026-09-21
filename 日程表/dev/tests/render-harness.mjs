// 渲染用例的公共脚手架：桩 DOM + 种子状态 + 假 ctx + 外壳启动。
// node --test 每个文件一个进程，所以这里改动的全局只在引入它的用例文件里生效。
import { TABLE_NAMES, TABLES } from '../../functions/registry.mjs';
import { buildSeed } from '../seed.mjs';
import { installDom, mountShell } from './dom-stub.mjs';

export const TODAY = '2026-09-20';
export const TIME = { today: TODAY, now: new Date(`${TODAY}T12:30:00`) };
const DOM_KEYS = [
  'Node', 'Element', 'HTMLElement', 'Text', 'DocumentFragment', 'document', 'location', 'matchMedia', 'fetch',
  'addEventListener', 'removeEventListener', 'setInterval', 'clearInterval', 'URL', 'Blob',
];

// store 在 createStore() 那一刻就绑定了 globalThis.localStorage，所以偏好桩必须
// 装在外壳模块求值之前，否则外壳测试里的折叠偏好永远写不进去。
export const prefs = new Map();
globalThis.localStorage = {
  getItem: (key) => (prefs.has(key) ? prefs.get(key) : null),
  setItem: (key, value) => prefs.set(key, String(value)),
  removeItem: (key) => prefs.delete(key),
};

// 应用外壳的顶层有 `if (document && #view) start()`：必须在装桩 DOM 之前完成求值，
// 否则 start() 会在不受控的用例里跑起来。这里提前加载，让外壳测试自己决定何时启动。
export const app = await import('../../web/app.js');

export const tick = () => new Promise((resolve) => setImmediate(resolve));
/** 提交链路要穿过 store → fetch → 渲染多层 Promise，逐轮宏任务等它落定。 */
export const settle = async (rounds = 10) => {
  for (let index = 0; index < rounds; index += 1) await tick();
};

/** 真实网络回读要等 I/O，用轮询而不是固定轮数。 */
export const waitUntil = async (predicate, timeout = 4000) => {
  const until = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
};

export const texts = (node) => node.textContent;
export const winHandlers = new Map();
export const intervals = [];
export const emitWindow = (type, event = {}) => {
  let prevented = false;
  const detail = {
    type,
    target: globalThis,
    currentTarget: globalThis,
    preventDefault: () => { prevented = true; },
    stopPropagation() {},
    ...event,
  };
  for (const handler of [...(winHandlers.get(type) ?? [])]) handler(detail);
  return prevented;
};

/** 装上桩 DOM → 执行断言 → 还原全局；浮层、toast 与 window 监听一并清掉。 */
export async function withDom(run) {
  const saved = Object.fromEntries(DOM_KEYS.map((key) => [key, globalThis[key]]));
  const doc = installDom();
  mountShell(doc);
  globalThis.location = { hash: '#/', href: 'http://127.0.0.1/' };
  // 默认按触屏设备处理，桌面端那条分支单独测
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  // 真实 setInterval 会让测试进程退不出去：记录下来由用例自己触发
  globalThis.setInterval = (handler, ms) => {
    intervals.push({ handler, ms });
    return intervals.length;
  };
  globalThis.clearInterval = () => {};
  globalThis.addEventListener = (type, handler) => {
    if (!winHandlers.has(type)) winHandlers.set(type, []);
    winHandlers.get(type).push(handler);
  };
  globalThis.removeEventListener = (type, handler) => {
    winHandlers.set(type, (winHandlers.get(type) ?? []).filter((item) => item !== handler));
  };
  try {
    return await run(doc);
  } finally {
    const ui = await import('../../web/lib/ui.js');
    ui.clearOverlays();
    winHandlers.clear();
    intervals.length = 0;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

export const stateFrom = (tables, { config, loadedAt = `${TODAY}T12:00:00.000Z` }) => ({
  status: 'ready',
  error: null,
  writeError: null,
  inflight: 0,
  pending: [],
  loadedAt,
  serverTime: loadedAt,
  config,
  limits: Object.fromEntries(TABLE_NAMES.map((name) => [name, TABLES[name].maxRows ?? 500])),
  tables,
});

export function seedState(today = TODAY) {
  const tables = buildSeed(new Date(`${today}T12:00:00`));
  return stateFrom(tables, { config: tables.semester_config[0] });
}

export const emptyAppState = () => stateFrom(
  Object.fromEntries(TABLE_NAMES.map((name) => [name, []])),
  { config: null, loadedAt: null },
);

/** 视图只通过 ctx 触达 store：记录被调用的写操作，用来验证按钮接的是真写入。 */
export function fakeCtx() {
  const calls = [];
  return {
    calls,
    ctx: {
      navigate: (hash) => calls.push(`navigate:${hash}`),
      store: {
        state: {},
        update: async (table, id, patch) => { calls.push(`update:${table}`, patch); },
        create: async (table, row) => { calls.push(`create:${table}`, row); },
        remove: (table, id) => { calls.push(`remove:${table}`, id); return { token: 'rm_test' }; },
        undoRemove: (token) => { calls.push(`undo:${token}`); return true; },
        pref: (_key, fallback) => fallback,
        setPref: (key, value) => calls.push(`pref:${key}=${String(value)}`),
        refresh: async () => {},
      },
    },
  };
}

export const viewRenders = async () => ({
  home: (await import('../../web/views/home.js')).renderHome,
  timetable: (await import('../../web/views/timetable.js')).renderTimetable,
  tasks: (await import('../../web/views/tasks.js')).renderTasks,
  research: (await import('../../web/views/research.js')).renderResearch,
  workout: (await import('../../web/views/workout.js')).renderWorkout,
  settings: (await import('../../web/views/settings.js')).renderSettings,
});

export const viewArgs = {
  home: (state, ctx) => ({ state, ctx, time: TIME }),
  timetable: (state, ctx) => ({ state, ctx, time: TIME, query: new URLSearchParams() }),
  tasks: (state, ctx) => ({ state, ctx, time: TIME }),
  research: (state, ctx) => ({ state, ctx, time: TIME, sub: '' }),
  workout: (state, ctx) => ({ state, ctx, time: TIME }),
  settings: (state, ctx) => ({ state, ctx, time: TIME }),
};

export const LABEL_CLASSES = ['title', 'k', 'v', 'eyebrow', 'week', 'sub', 'current', 'count'];

/** 标题位空白是本阶段真实踩过的坑：h() 参数误用会把第一个子节点静默吞掉。 */
export function assertNoBlankLabels(root, where) {
  const suspects = root.descendants().filter((node) =>
    LABEL_CLASSES.some((name) => node.classList.contains(name)) || ['h2', 'h3', 'h4'].includes(node.localName));
  assert0(suspects.length > 0, `${where} 没有渲染出任何标题位，断言等于空转`);
  for (const node of suspects) {
    assert0(node.textContent.trim().length > 0, `${where}：${node} 内容为空（class=${node.className}）`);
  }
}

function assert0(condition, message) {
  if (!condition) throw new Error(message);
}

export const fieldWrap = (form, label) => form.querySelectorAll('.field')
  .find((node) => node.querySelector('label')?.textContent === label);

/**
 * 假 ctx 的写操作默认只记录不落地；这里让它直接改 state，
 * 于是"点一下 → 重新渲染 → 看界面上的数字"能整条跑通（服务端语义留给最后的往返用例）。
 */
export function liveCtx(state) {
  const { calls, ctx } = fakeCtx();
  const writes = [];
  // 视图会就地改行对象并重新渲染，所以本地偏好也得真的"存下来"，
  // 否则"改一次排序→再渲染→看顺序"这条链路在测试里是断的。
  const localPrefs = new Map();
  ctx.store.update = async (table, id, patch) => {
    writes.push({ op: 'update', table, id, patch });
    const row = state.tables[table].find((item) => item.id === id);
    if (!row) throw new Error(`没有这一行：${table}/${id}`);
    Object.assign(row, patch);
    return row;
  };
  ctx.store.create = async (table, row) => {
    writes.push({ op: 'create', table, row });
    const created = { ...row, id: `tmp_${table}_${state.tables[table].length}`, created_at: '', updated_at: '' };
    state.tables[table].push(created);
    return created;
  };
  ctx.store.remove = (table, id, options = {}) => {
    writes.push({ op: 'remove', table, id, related: options.related ?? null });
    const drop = new Map([[table, new Set([id])]]);
    for (const [name, rows] of Object.entries(options.related ?? {})) {
      drop.set(name, new Set([...(drop.get(name) ?? []), ...rows.map((item) => item.id)]));
    }
    for (const [name, ids] of drop) state.tables[name] = state.tables[name].filter((item) => !ids.has(item.id));
    return { token: 'rm_test' };
  };
  ctx.store.pref = (key, fallback) => (localPrefs.has(key) ? localPrefs.get(key) : fallback);
  ctx.store.setPref = (key, value) => {
    localPrefs.set(key, value);
    calls.push(`pref:${key}=${JSON.stringify(value)}`);
    writes.push({ op: 'pref', key, value });
  };
  return { calls, ctx, writes, prefs: localPrefs };
}

export const topTitle = () => document.getElementById('topbar').querySelector('h1').textContent;
export const clockText = () => document.getElementById('topbar').querySelector('.clock').textContent;
export const railOf = () => document.getElementById('rail');
export const toastTexts = () => [...document.getElementById('toast-root').querySelectorAll('.toast')].map((node) => node.textContent);

export const go = async (hash) => {
  globalThis.location.hash = hash;
  emitWindow('hashchange');
  await settle(2);
};
