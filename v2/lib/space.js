// 空间管理：每个浏览器自动生成独立空间 ID，数据按空间隔离，无需注册。
const SPACE_KEY = 'schedule.spaceId';

export function getSpaceId() {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(SPACE_KEY);
}

export function createSpace() {
  if (typeof localStorage === 'undefined') throw new Error('localStorage 不可用');
  const id = 'sp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  localStorage.setItem(SPACE_KEY, id);
  return id;
}

export function ensureSpace() {
  let id = getSpaceId();
  if (!id) id = createSpace();
  return id;
}

export function getSpaceKey(baseKey) {
  const spaceId = ensureSpace();
  return `${baseKey}.${spaceId}`;
}

export function resetSpace() {
  if (typeof localStorage === 'undefined') return;
  const id = getSpaceId();
  if (!id) return;
  // 清除当前空间的所有数据
  const keysToRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.includes(id)) keysToRemove.push(key);
  }
  for (const key of keysToRemove) localStorage.removeItem(key);
  // 生成新空间
  createSpace();
}
