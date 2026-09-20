// 单一真源在前端的样子：内存里一份服务端快照 + 乐观更新 + 写后回读。
// 业务数据不落本地存储，localStorage 只放 UI 偏好（PRD 7.4 第 1 条）。
// 删除在 5 秒撤销窗口内采用"延后写"，这样撤销能还原原 ID，不必重新插入。
import { TABLE_NAMES } from './registry.mjs';
import { createApi, isWriteOutcomeUnknown } from './api.js';

export const PREF_KEYS = ['ui.rail', 'ui.timetableView', 'ui.homeCardOrder'];
const UNDO_MS = 5000;

function emptyTables() {
  return Object.fromEntries(TABLE_NAMES.map((name) => [name, []]));
}

export function createStore({
  api = createApi(),
  prefs: prefsImpl,
  events,
  now = () => new Date(),
  undoMs = UNDO_MS,
  timer,
} = {}) {
  const listeners = new Set();
  const state = {
    status: 'idle',
    loader: null,
    error: null,
    writeError: null,
    tables: emptyTables(),
    config: null,
    limits: {},
    serverTime: null,
    loadedAt: null,
    inflight: 0,
  };
  const pending = new Map();
  const timers = timer ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) };
  const storage = prefsImpl ?? (() => {
    try {
      const store = globalThis.localStorage;
      return {
        get: (key) => { try { return JSON.parse(store.getItem(key)); } catch { return undefined; } },
        set: (key, value) => { try { store.setItem(key, JSON.stringify(value)); } catch { /* 隐私模式下写不进去，偏好退回默认值 */ } },
      };
    } catch { return null; }
  })();

  let notifyQueued = false;
  function notify() {
    if (notifyQueued) return;
    notifyQueued = true;
    queueMicrotask(() => {
      notifyQueued = false;
      for (const listener of [...listeners]) listener(snapshot());
    });
  }

  function snapshot() {
    return {
      status: state.status,
      error: state.error,
      writeError: state.writeError,
      config: state.config,
      limits: state.limits,
      serverTime: state.serverTime,
      loadedAt: state.loadedAt,
      inflight: state.inflight,
      tables: state.tables,
      pending: [...pending.keys()],
    };
  }

  function setRows(table, rows) {
    const hidden = hiddenIds(table);
    state.tables[table] = (rows ?? []).filter((row) => !hidden.has(row.id));
  }

  function hiddenIds(table) {
    const ids = new Set();
    for (const entry of pending.values()) {
      for (const item of entry.removed[table] ?? []) ids.add(item.id);
    }
    return ids;
  }

  /** 延后删除期间，界面上把这些行一并藏起来（级联子孙）。 */
  function hideRows(table, rows) {
    const hidden = new Set(rows.map((row) => row.id));
    state.tables[table] = state.tables[table].filter((row) => !hidden.has(row.id));
  }

  async function load({ silent = false } = {}) {
    if (state.loader) {
      // 已经有一次回读在跑：跟着它走。原样返回的话，这次调用没有 catch，
      // 失败就会变成无人处理的拒绝（撤销窗口结束后的浮动作最容易踩到）
      try { return await state.loader; } catch { return snapshot(); }
    }
    state.inflight += 1;
    state.status = state.status === 'ready' ? 'ready' : 'loading';
    if (!silent) state.error = null;
    notify();
    const request = (async () => {
      const result = await api.bootstrap();
      const next = result.data.tables;
      for (const table of TABLE_NAMES) setRows(table, next[table]);
      state.config = result.data.config ?? null;
      state.limits = result.data.limits ?? {};
      state.serverTime = result.serverTime ?? null;
      state.loadedAt = now().toISOString();
      state.status = 'ready';
      state.error = null;
      return snapshot();
    })();
    state.loader = request;
    try {
      return await request;
    } catch (error) {
      if (!silent && state.status !== 'ready') state.status = 'error';
      state.error = { message: error.message, code: error.code ?? 'unknown', retry: true };
      return snapshot();
    } finally {
      state.loader = null;
      state.inflight -= 1;
      notify();
    }
  }

  const refresh = () => load({ silent: true });

  function table(name) {
    return state.tables[name] ?? [];
  }

  function row(name, id) {
    return table(name).find((item) => item.id === id) ?? null;
  }

  function beginWrite() {
    state.writeError = null;
    state.inflight += 1;
    notify();
  }

  function endWrite() {
    state.inflight -= 1;
    notify();
  }

  function failWrite(table_, id, previous, error) {
    if (previous) {
      const index = state.tables[table_].findIndex((item) => item.id === previous.id);
      if (index >= 0) state.tables[table_][index] = previous;
      else state.tables[table_] = [...state.tables[table_], previous];
    } else if (id) {
      state.tables[table_] = state.tables[table_].filter((item) => item.id !== id);
    }
    state.writeError = {
      message: error.message ?? '保存失败',
      code: error.code ?? 'request_failed',
      field: error.field ?? null,
      unknown: isWriteOutcomeUnknown(error),
    };
    notify();
  }

  /** 本地新增行只用于即时反馈：ID 带 tmp_ 前缀，写完成即以服务端行为准。 */
  function optimisticCreate(table_, input) {
    const stamp = now().toISOString();
    const tempId = `tmp_${Math.random().toString(36).slice(2, 10)}`;
    const draft = { ...input, id: tempId, created_at: stamp, updated_at: stamp };
    state.tables[table_] = [...table(table_), draft];
    return { tempId, draft };
  }

  async function create(table_, input) {
    const { tempId, draft } = optimisticCreate(table_, input);
    beginWrite();
    try {
      const result = await api.create(table_, input);
      const index = state.tables[table_].findIndex((item) => item.id === tempId);
      if (index >= 0) state.tables[table_].splice(index, 1, result.row);
      else state.tables[table_] = [...state.tables[table_], result.row];
      return result.row;
    } catch (error) {
      failWrite(table_, tempId, null, error);
      throw error;
    } finally {
      endWrite();
      refresh();
    }
  }

  async function update(table_, id, patch) {
    if (typeof id !== 'string' || id.startsWith('tmp_')) {
      throw new Error('临时记录不能直接更新，请先等待写入完成');
    }
    const previous = row(table_, id);
    if (previous) {
      const merged = { ...previous, ...patch };
      state.tables[table_] = state.tables[table_].map((item) => (item.id === id ? merged : item));
    }
    beginWrite();
    notify();
    try {
      const result = await api.update(table_, id, patch);
      state.tables[table_] = state.tables[table_].map((item) => (item.id === id ? result.row : item));
      return result.row;
    } catch (error) {
      failWrite(table_, id, previous, error);
      throw error;
    } finally {
      endWrite();
      refresh();
    }
  }

  /**
   * 删除：先从界面拿走并保存副本，undoMs 内可 cancel 还原（含原 ID 与级联子孙），
   * 超时后才真正调用 remove。写失败的后果只是"又出现了"，刷新即可确认。
   */
  function remove(table_, id, { related = {} } = {}) {
    const removed = { [table_]: [] };
    const primary = row(table_, id);
    if (primary) {
      removed[table_].push(primary);
      hideRows(table_, [primary]);
    }
    for (const [childTable, rows] of Object.entries(related)) {
      if (!rows?.length) continue;
      removed[childTable] = [...rows];
      hideRows(childTable, rows);
    }
    const token = `rm_${Math.random().toString(36).slice(2, 10)}`;
    const entry = { token, table: table_, id, removed, error: null };
    pending.set(token, entry);
    entry.handle = timers.set(async () => {
      pending.delete(token);
      beginWrite();
      try {
        await api.remove(table_, id);
      } catch (error) {
        entry.error = error;
        for (const [name, rows] of Object.entries(removed)) {
          const existing = new Set(state.tables[name].map((item) => item.id));
          state.tables[name] = [...state.tables[name], ...rows.filter((item) => !existing.has(item.id))];
        }
        state.writeError = {
          message: error.message ?? '删除未生效',
          code: error.code ?? 'request_failed',
          field: null,
          unknown: isWriteOutcomeUnknown(error),
        };
        // 定时回调里没有人 await：错误只进 writeError 并由界面提示，不外抛未处理拒绝
      } finally {
        endWrite();
        notify();
        refresh();
      }
    }, undoMs);
    notify();
    return { token, undo: () => undoRemove(token), entry };
  }

  function undoRemove(token) {
    const entry = pending.get(token);
    if (!entry) return false;
    timers.clear(entry.handle);
    pending.delete(token);
    for (const [name, rows] of Object.entries(entry.removed)) {
      const byId = new Map(state.tables[name].map((item) => [item.id, item]));
      for (const row_ of rows) byId.set(row_.id, row_);
      state.tables[name] = [...byId.values()];
    }
    notify();
    // 撤销时服务端并未删除，回读一次即可恢复服务端排序
    refresh();
    return true;
  }

  async function wipeAll() {
    beginWrite();
    try {
      const result = await api.wipe();
      state.tables = emptyTables();
      state.config = null;
      notify();
      return result;
    } finally {
      endWrite();
    }
  }

  async function importSnapshot(tables) {
    beginWrite();
    try {
      const result = await api.importSnapshot(tables);
      notify();
      await load();
      return result;
    } finally {
      endWrite();
    }
  }

  function subscribe(listener) {
    listeners.add(listener);
    listener(snapshot());
    return () => listeners.delete(listener);
  }

  function pref(key, fallback) {
    if (!PREF_KEYS.includes(key)) throw new Error(`不允许的本地偏好键：${key}`);
    const value = storage?.get(key);
    return value === undefined || value === null ? fallback : value;
  }

  function setPref(key, value) {
    if (!PREF_KEYS.includes(key)) throw new Error(`不允许的本地偏好键：${key}`);
    storage?.set(key, value);
    notify();
  }

  if (events?.document?.addEventListener) {
    // PRD 7.4：切到前台即回读，手机与电脑看到的是同一份云端状态。
    events.document.addEventListener('visibilitychange', () => {
      if (events.document.visibilityState === 'visible') refresh();
    });
  }

  return {
    get state() { return snapshot(); },
    subscribe,
    load,
    refresh,
    table,
    row,
    create,
    update,
    remove,
    undoRemove,
    hasPendingRemove: (token) => pending.has(token),
    wipeAll,
    importSnapshot,
    pref,
    setPref,
    clearWriteError: () => { state.writeError = null; notify(); },
  };
}
