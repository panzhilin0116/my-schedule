import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, mountShell } from './dom-stub.mjs';

installDom();
const doc = mountShell();
globalThis.location = { hash: '#/timetable' };

function makeStorage(init = {}) {
  const map = new Map(Object.entries(init));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}
globalThis.localStorage = makeStorage();

const { COURSE_KEY_BASE, loadCourses } = await import('../lib/courseStore.js');
const { getSpaceKey } = await import('../lib/space.js');
const { render, __reset } = await import('../views/timetable.js');
const { closeOverlay } = await import('../lib/feedback.js');
const { FIX_COURSES } = await import('./course-fixture.mjs');

const view = () => doc.querySelector('#view');
const MON_9 = new Date(2026, 8, 7, 9, 0, 0); // 第1周周一 09:00

function setDesktop(on) {
  globalThis.window = {
    matchMedia: () => ({
      matches: on,
      addEventListener() {},
      removeEventListener() {},
    }),
  };
}

function seedCourses(list = FIX_COURSES) {
  globalThis.localStorage = makeStorage();
  globalThis.localStorage.setItem(getSpaceKey(COURSE_KEY_BASE), JSON.stringify(list));
  __reset();
}

test('桌面：整周网格 12 个课程块与跨行定位', () => {
  seedCourses();
  setDesktop(true);
  render(view(), new URLSearchParams(), MON_9);
  const blocks = doc.querySelectorAll('.tt-block');
  assert.equal(blocks.length, 12);

  const opera = doc.querySelector('[data-course="法国歌剧史与作品赏析"]');
  assert.match(opera.getAttribute('style'), /grid-column:2/);
  assert.match(opera.getAttribute('style'), /grid-row:2 \/ span 2/);

  const french = doc.querySelectorAll('.tt-block')
    .find((b) => b.getAttribute('data-course') === '综合法语(1)' && /grid-row:12/.test(b.getAttribute('style')));
  assert.ok(french, '周四 11-12 节综合法语(1)');
  assert.match(french.getAttribute('style'), /grid-column:5/);
});

test('桌面：09:00 有 now 线且第一节课程块标记进行中', () => {
  seedCourses();
  setDesktop(true);
  render(view(), new URLSearchParams(), MON_9);
  const line = doc.querySelector('.tt-nowline');
  assert.ok(line);
  assert.match(line.getAttribute('style'), /top:\d+(\.\d+)?px/);
  assert.ok(doc.querySelector('[data-course="法国歌剧史与作品赏析"]').classList.contains('living'));
});

test('非教学周：横幅且无课程块', () => {
  seedCourses();
  setDesktop(true);
  render(view(), new URLSearchParams(), new Date(2026, 11, 28, 10, 0));
  assert.equal(doc.querySelectorAll('.tt-block').length, 0);
  assert.match(doc.querySelector('.tt-banner').textContent, /本周无教学安排（第\d+周）/);
  assert.equal(doc.querySelector('.tt-nowline'), null);
});

test('空白空间：课表空态带添加引导', () => {
  seedCourses([]);
  setDesktop(true);
  render(view(), new URLSearchParams(), MON_9);
  assert.equal(doc.querySelectorAll('.tt-block').length, 0);
  assert.ok(doc.querySelector('.empty'));
  assert.match(doc.querySelector('.empty-text').textContent, /课表还是空的/);
  doc.querySelector('.empty .btn').click();
  assert.equal(doc.querySelector('.overlay-title').textContent, '添加课程');
  closeOverlay();
});

test('手机：默认停在今天，只显示当日课程', () => {
  seedCourses();
  setDesktop(false);
  render(view(), new URLSearchParams(), MON_9);
  const chips = doc.querySelectorAll('.tt-chip');
  assert.equal(chips.length, 7);
  assert.ok(chips[0].classList.contains('active'));
  const blocks = doc.querySelectorAll('.tt-block');
  assert.equal(blocks.length, 4); // 周一 4 门
});

test('手机：点星期二胶囊切换当日', () => {
  seedCourses();
  setDesktop(false);
  render(view(), new URLSearchParams(), MON_9);
  const chip2 = doc.querySelectorAll('.tt-chip')[1];
  chip2.click();
  const blocks = doc.querySelectorAll('.tt-block');
  assert.equal(blocks.length, 3); // 周二 3 门
  const cs = doc.querySelector('[data-course="大学计算机基础"]');
  assert.match(cs.getAttribute('style'), /grid-row:4 \/ span 3/);
});

test('手机：左滑切下一天', () => {
  seedCourses();
  setDesktop(false);
  const root = render(view(), new URLSearchParams(), MON_9); // 选中周一
  const grid = root.querySelector('.tt-grid');
  grid.fire('touchstart', { touches: [{ clientX: 200 }] });
  grid.fire('touchend', { changedTouches: [{ clientX: 120 }] });
  assert.equal(doc.querySelectorAll('.tt-block').length, 3); // 切到周二
});

test('手机：选中无课之日显示空态提示', () => {
  seedCourses();
  setDesktop(false);
  render(view(), new URLSearchParams(), MON_9);
  doc.querySelectorAll('.tt-chip')[6].click(); // 周日无课
  assert.equal(doc.querySelectorAll('.tt-block').length, 0);
  assert.equal(doc.querySelector('.tt-empty').textContent, '当天没有课');
});

test('点课程块弹详情，含编辑与删除按钮', () => {
  seedCourses();
  setDesktop(true);
  render(view(), new URLSearchParams(), MON_9);
  doc.querySelector('[data-course="法国歌剧史与作品赏析"]').click();
  assert.equal(doc.querySelector('.overlay-title').textContent, '法国歌剧史与作品赏析');
  const body = doc.querySelector('.overlay-body');
  assert.match(body.textContent, /教学一号楼3004/);
  assert.match(body.textContent, /第1-2节/);
  assert.match(body.textContent, /08:00 – 09:35/);
  assert.match(body.textContent, /本学期 1–14 周/);
  const btns = body.querySelectorAll('.btn');
  assert.deepEqual(btns.map((b) => b.textContent), ['编辑', '删除']);
  closeOverlay();
});

test('详情点删除：写入存储并可撤销', () => {
  seedCourses();
  setDesktop(true);
  render(view(), new URLSearchParams(), MON_9);
  doc.querySelector('[data-course="法国歌剧史与作品赏析"]').click();
  doc.querySelector('.cd-actions .btn.danger').click();
  assert.equal(loadCourses().find((c) => c.id === 'c1'), undefined);
  assert.equal(doc.querySelectorAll('.tt-block').length, 11);
  const undo = doc.querySelector('.toast .toast-action');
  assert.ok(undo);
  undo.click();
  assert.ok(loadCourses().find((c) => c.id === 'c1'));
  closeOverlay();
});

test('添加课程：校验、冲突提示、保存成功', () => {
  seedCourses();
  setDesktop(true);
  render(view(), new URLSearchParams(), MON_9);
  doc.querySelector('.tt-add-btn').click();
  assert.equal(doc.querySelector('.overlay-title').textContent, '添加课程');
  const submit = doc.querySelector('.f-submit');
  const name = doc.querySelector('input[name="name"]');
  assert.equal(submit.disabled, true);

  name.fire('blur');
  assert.equal(doc.querySelector('.f-err').textContent, '课程名称不能为空');

  name.value = '高等数学';
  name.fire('input');
  // 默认周一 1-2 节，与夹具 c1 冲突
  assert.ok(doc.querySelectorAll('.f-err').map((e) => e.textContent).some((t) => /时间冲突/.test(t)));
  assert.equal(submit.disabled, true);

  const selects = doc.querySelectorAll('select');
  const day = selects[0];
  const start = selects[1];
  const end = selects[2];
  day.value = '3'; // 周三
  day.fire('change');
  start.value = '5';
  start.fire('change');
  end.value = '6';
  end.fire('change');
  assert.equal(submit.disabled, false);
  submit.click();

  assert.equal(doc.querySelector('.overlay-panel'), null);
  const saved = loadCourses().find((c) => c.name === '高等数学');
  assert.ok(saved);
  assert.equal(saved.day, 3);
  assert.equal(saved.startSection, 5);
  assert.equal(saved.endSection, 6);
  assert.equal(doc.querySelectorAll('.tt-block').length, 13); // 界面即时更新
});

test('编辑课程：保存后写回存储', () => {
  seedCourses();
  setDesktop(true);
  render(view(), new URLSearchParams(), MON_9);
  doc.querySelector('[data-course="体育(1)"]').click();
  doc.querySelector('.cd-actions .btn.primary').click();
  assert.equal(doc.querySelector('.overlay-title').textContent, '编辑课程');
  const room = doc.querySelector('input[name="room"]');
  room.value = '操场';
  room.fire('input');
  doc.querySelector('.f-submit').click();
  const c4 = loadCourses().find((c) => c.id === 'c4');
  assert.equal(c4.room, '操场');
});

test('课程数据不跨空间：另一空间读到空白', () => {
  seedCourses();
  setDesktop(true);
  const otherKey = `${COURSE_KEY_BASE}.sp_someone_else`;
  globalThis.localStorage.setItem(otherKey, JSON.stringify([]));
  // 当前空间仍读到 12 门
  assert.equal(loadCourses().length, 12);
});

test('清理定时器后进程可退出', () => {
  __reset();
});
