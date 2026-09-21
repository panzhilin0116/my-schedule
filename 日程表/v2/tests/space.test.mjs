import { test } from 'node:test';
import assert from 'node:assert/strict';

// 桩件：给每个测试一个干净的 localStorage
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    _map: map,
  };
}

function installFakeStorage() {
  globalThis.localStorage = fakeStorage();
}

test('ensureSpace：首次调用自动创建空间', async () => {
  installFakeStorage();
  const { ensureSpace, getSpaceId } = await import('../lib/space.js');
  assert.equal(getSpaceId(), null); // 还没有空间
  const id = ensureSpace();
  assert.ok(id.startsWith('sp_'));
  assert.equal(getSpaceId(), id);
  // 再次调用返回同一个 id
  assert.equal(ensureSpace(), id);
});

test('createSpace：每次生成唯一 ID', async () => {
  installFakeStorage();
  const { createSpace } = await import('../lib/space.js');
  const ids = new Set(Array.from({ length: 100 }, () => createSpace()));
  assert.equal(ids.size, 100);
});

test('getSpaceKey：返回带空间 ID 的键', async () => {
  installFakeStorage();
  const { ensureSpace, getSpaceKey } = await import('../lib/space.js');
  const spaceId = ensureSpace();
  const key = getSpaceKey('schedule.tasks.v1');
  assert.equal(key, `schedule.tasks.v1.${spaceId}`);
});

test('resetSpace：清空当前空间数据并创建新空间', async () => {
  installFakeStorage();
  const { ensureSpace, getSpaceId, resetSpace, getSpaceKey } = await import('../lib/space.js');
  const oldId = ensureSpace();
  // 写入一些数据
  const oldKey = getSpaceKey('schedule.tasks.v1');
  globalThis.localStorage.setItem(oldKey, JSON.stringify([{ id: 'x' }]));
  globalThis.localStorage.setItem('other.key', 'keep');

  resetSpace();
  const newId = getSpaceId();
  assert.ok(newId);
  assert.notEqual(newId, oldId);
  // 旧空间数据已清除
  assert.equal(globalThis.localStorage.getItem(oldKey), null);
  // 无关数据保留
  assert.equal(globalThis.localStorage.getItem('other.key'), 'keep');
});

test('无 localStorage 时 getSpaceId 返回 null', async () => {
  const orig = globalThis.localStorage;
  delete globalThis.localStorage;
  try {
    const { getSpaceId } = await import('../lib/space.js');
    assert.equal(getSpaceId(), null);
  } finally {
    globalThis.localStorage = orig;
  }
});
