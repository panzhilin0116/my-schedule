import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, mountShell } from './dom-stub.mjs';

installDom();
const doc = mountShell();
globalThis.location = { hash: '#/timetable' };

const { render, __reset } = await import('../views/timetable.js');
const { closeOverlay } = await import('../lib/feedback.js');

const view = () => doc.querySelector('#view');
const MON_9 = new Date(2026, 8, 7, 9, 0, 0); // 第2周之前的第1周周一 09:00

function setDesktop(on) {
  globalThis.window = {
    matchMedia: () => ({
      matches: on,
      addEventListener() {},
      removeEventListener() {},
    }),
  };
}

test('桌面：整周网格 12 个课程块与跨行定位', () => {
  __reset();
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
  __reset();
  setDesktop(true);
  render(view(), new URLSearchParams(), MON_9);
  const line = doc.querySelector('.tt-nowline');
  assert.ok(line);
  assert.match(line.getAttribute('style'), /top:\d+(\.\d+)?px/);
  assert.ok(doc.querySelector('[data-course="法国歌剧史与作品赏析"]').classList.contains('living'));
});

test('非教学周：横幅且无课程块', () => {
  __reset();
  setDesktop(true);
  render(view(), new URLSearchParams(), new Date(2026, 11, 28, 10, 0));
  assert.equal(doc.querySelectorAll('.tt-block').length, 0);
  assert.match(doc.querySelector('.tt-banner').textContent, /本周无教学安排（第\d+周）/);
  assert.equal(doc.querySelector('.tt-nowline'), null);
});

test('手机：默认停在今天，只显示当日课程', () => {
  __reset();
  setDesktop(false);
  render(view(), new URLSearchParams(), MON_9);
  const chips = doc.querySelectorAll('.tt-chip');
  assert.equal(chips.length, 7);
  assert.ok(chips[0].classList.contains('active'));
  const blocks = doc.querySelectorAll('.tt-block');
  assert.equal(blocks.length, 4); // 周一 4 门
});

test('手机：点星期二胶囊切换当日', () => {
  setDesktop(false);
  const chip2 = doc.querySelectorAll('.tt-chip')[1];
  chip2.click();
  const blocks = doc.querySelectorAll('.tt-block');
  assert.equal(blocks.length, 3); // 周二 3 门
  const cs = doc.querySelector('[data-course="大学计算机基础"]');
  assert.match(cs.getAttribute('style'), /grid-row:4 \/ span 3/);
});

test('手机：左滑切下一天', () => {
  __reset();
  setDesktop(false);
  const root = render(view(), new URLSearchParams(), MON_9); // 选中周一
  const grid = root.querySelector('.tt-grid');
  grid.fire('touchstart', { touches: [{ clientX: 200 }] });
  grid.fire('touchend', { changedTouches: [{ clientX: 120 }] });
  assert.equal(doc.querySelectorAll('.tt-block').length, 3); // 切到周二
});

test('手机：选中无课之日显示空态提示', () => {
  __reset();
  setDesktop(false);
  render(view(), new URLSearchParams(), MON_9);
  doc.querySelectorAll('.tt-chip')[6].click(); // 周日无课
  assert.equal(doc.querySelectorAll('.tt-block').length, 0);
  assert.equal(doc.querySelector('.tt-empty').textContent, '当天没有课');
});

test('点课程块弹只读详情，无编辑按钮', () => {
  __reset();
  setDesktop(true);
  render(view(), new URLSearchParams(), MON_9);
  doc.querySelector('[data-course="法国歌剧史与作品赏析"]').click();
  assert.equal(doc.querySelector('.overlay-title').textContent, '法国歌剧史与作品赏析');
  const body = doc.querySelector('.overlay-body');
  assert.match(body.textContent, /教学一号楼3004/);
  assert.match(body.textContent, /第1-2节/);
  assert.match(body.textContent, /08:00 – 09:35/);
  assert.match(body.textContent, /本学期 1–14 周/);
  assert.equal(body.querySelectorAll('.btn').length, 0);
  closeOverlay();
});

test('清理定时器后进程可退出', () => {
  __reset();
});
