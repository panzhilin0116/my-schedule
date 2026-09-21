import { getSpaceKey } from './space.js';

export const STORAGE_KEY_BASE = 'schedule.tasks.v1';

export class StoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StoreError';
  }
}

function storageKey(storage) {
  // 测试模式：传入自定义 storage 时，直接用 base key（不隔离空间）
  if (storage !== undefined) return STORAGE_KEY_BASE;
  return getSpaceKey(STORAGE_KEY_BASE);
}

function backend(storage) {
  const s = storage !== undefined ? storage : globalThis.localStorage;
  if (!s) throw new StoreError('localStorage 不可用');
  return s;
}

export function newTaskId() {
  return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

export function loadTasks(storage) {
  const s = backend(storage);
  const raw = s.getItem(storageKey(storage));
  if (raw == null) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new StoreError('日程数据已损坏，无法读取');
  }
  if (!Array.isArray(parsed)) throw new StoreError('日程数据格式不正确');
  return parsed;
}

export function saveTasks(tasks, storage) {
  const s = backend(storage);
  try {
    s.setItem(storageKey(storage), JSON.stringify(tasks));
  } catch (e) {
    if (e.name === 'QuotaExceededError' || e.code === 22) {
      throw new StoreError('本机存储空间已满，请先删除部分日程');
    }
    throw new StoreError('保存失败：' + e.message);
  }
  return tasks;
}

export function resetStore(storage) {
  return saveTasks([], storage);
}

export function upsertTask(task, storage) {
  const tasks = loadTasks(storage);
  const list = tasks.slice();
  const idx = list.findIndex((t) => t.id === task.id);
  if (idx >= 0) list[idx] = task;
  else list.push(task);
  return saveTasks(list, storage);
}

export function removeTask(id, storage) {
  const tasks = loadTasks(storage).filter((t) => t.id !== id);
  return saveTasks(tasks, storage);
}

export function toggleTask(id, storage) {
  const tasks = loadTasks(storage).map((t) => (t.id === id ? { ...t, done: !t.done } : t));
  return saveTasks(tasks, storage);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

function validTime(s) {
  if (!TIME_RE.test(s)) return false;
  const [hh, mm] = s.split(':').map(Number);
  return hh < 24 && mm < 60;
}

export function validateTask(draft) {
  const errors = {};
  if (!draft.title || !String(draft.title).trim()) errors.title = '标题不能为空';
  if (!draft.date || !DATE_RE.test(draft.date)) errors.date = '请选择有效日期';
  else if (Number.isNaN(new Date(draft.date + 'T00:00:00').getTime())) errors.date = '日期无效';

  const hasStart = !!draft.startTime;
  const hasEnd = !!draft.endTime;
  if (hasStart && !validTime(draft.startTime)) errors.startTime = '开始时间格式应为 HH:MM';
  if (hasEnd && !validTime(draft.endTime)) errors.endTime = '结束时间格式应为 HH:MM';
  if (hasStart !== hasEnd) {
    const msg = '开始与结束时间需成对填写';
    errors.startTime = errors.startTime || msg;
    errors.endTime = errors.endTime || msg;
  } else if (hasStart && hasEnd && !errors.startTime && !errors.endTime && draft.startTime > draft.endTime) {
    errors.endTime = '结束时间不能早于开始时间';
  }

  return { ok: Object.keys(errors).length === 0, errors };
}

export function subscribe(cb) {
  if (typeof window === 'undefined' || !window.addEventListener) return () => {};
  const key = storageKey();
  const handler = (e) => {
    if (e.key === key || e.key === null) cb(loadTasks());
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}
