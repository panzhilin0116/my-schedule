import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadTasks, saveTasks, upsertTask, removeTask, toggleTask,
  validateTask, resetStore, StoreError, STORAGE_KEY, newTaskId,
} from '../lib/store.js';

function fakeStorage(initial) {
  const map = new Map(initial ? Object.entries(initial) : []);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

test('空存储返回 []', () => {
  assert.deepEqual(loadTasks(fakeStorage()), []);
});

test('upsert / toggle / remove 往返', () => {
  const st = fakeStorage();
  const t = { id: 'a', title: '交作业', date: '2026-09-21', done: false, createdAt: 1 };
  upsertTask(t, st);
  assert.deepEqual(loadTasks(st), [t]);

  toggleTask('a', st);
  assert.equal(loadTasks(st)[0].done, true);

  upsertTask({ ...loadTasks(st)[0], title: '改标题' }, st);
  assert.equal(loadTasks(st).length, 1);
  assert.equal(loadTasks(st)[0].title, '改标题');
  assert.equal(loadTasks(st)[0].done, true);

  removeTask('a', st);
  assert.deepEqual(loadTasks(st), []);
});

test('resetStore 清空', () => {
  const st = fakeStorage({ [STORAGE_KEY]: JSON.stringify([{ id: 'x' }]) });
  resetStore(st);
  assert.deepEqual(loadTasks(st), []);
});

test('坏 JSON 抛 StoreError', () => {
  const st = fakeStorage({ [STORAGE_KEY]: '{not json' });
  assert.throws(() => loadTasks(st), StoreError);
  const st2 = fakeStorage({ [STORAGE_KEY]: '{"a":1}' });
  assert.throws(() => loadTasks(st2), StoreError);
});

test('validateTask 各非法分支', () => {
  assert.equal(validateTask({ title: '', date: '2026-09-21' }).errors.title, '标题不能为空');
  assert.equal(validateTask({ title: 'ok', date: '' }).errors.date, '请选择有效日期');
  assert.equal(validateTask({ title: 'ok', date: '2026-13-40' }).errors.date, '日期无效');

  const pair = validateTask({ title: 'ok', date: '2026-09-21', startTime: '10:00' });
  assert.equal(pair.ok, false);
  assert.equal(pair.errors.startTime, '开始与结束时间需成对填写');
  assert.equal(pair.errors.endTime, '开始与结束时间需成对填写');

  const order = validateTask({ title: 'ok', date: '2026-09-21', startTime: '14:00', endTime: '13:00' });
  assert.equal(order.errors.endTime, '结束时间不能早于开始时间');

  const bad = validateTask({ title: 'ok', date: '2026-09-21', startTime: '25:99', endTime: '13:00' });
  assert.equal(bad.errors.startTime, '开始时间格式应为 HH:MM');

  const ok = validateTask({ title: 'ok', date: '2026-09-21', startTime: '13:00', endTime: '14:00' });
  assert.equal(ok.ok, true);

  const min = validateTask({ title: 'ok', date: '2026-09-21' });
  assert.equal(min.ok, true);
});

test('newTaskId 唯一', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newTaskId()));
  assert.equal(ids.size, 200);
});
