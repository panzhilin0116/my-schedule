import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, mountShell } from './dom-stub.mjs';

installDom();
const doc = mountShell();
globalThis.location = { hash: '#/' };

function makeStorage(init = {}) {
  const map = new Map(Object.entries(init));
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}
globalThis.localStorage = makeStorage();

const { saveTasks, loadTasks, STORAGE_KEY_BASE } = await import('../lib/store.js');
const { COURSE_KEY_BASE } = await import('../lib/courseStore.js');
const { getSpaceKey } = await import('../lib/space.js');
const { FIX_COURSES } = await import('./course-fixture.mjs');
const { render, __tick, __stop } = await import('../views/home.js');
const { buildMiniCalendar } = await import('../components/miniCalendar.js');

const MON_9 = new Date(2026, 8, 7, 9, 0, 0);
const view = () => doc.querySelector('#view');

const TASKS = [
  { id: 'h1', title: '交法语作业', date: '2026-09-07', startTime: '19:50', endTime: '21:30', done: false, createdAt: 1 },
  { id: 'h2', title: '取快递', date: '2026-09-07', done: true, createdAt: 2 },
  { id: 'h3', title: '组会', date: '2026-09-08', startTime: '14:00', endTime: '15:30', location: '主楼302', done: false, createdAt: 3 },
  { id: 'h4', title: '买返程票', date: '2026-09-25', done: false, createdAt: 4 },
  { id: 'h5', title: '还书', date: '2026-09-06', done: false, createdAt: 5 },
];

function seed() {
  globalThis.localStorage = makeStorage();
  globalThis.localStorage.setItem(getSpaceKey(STORAGE_KEY_BASE), JSON.stringify(TASKS));
  globalThis.localStorage.setItem(getSpaceKey(COURSE_KEY_BASE), JSON.stringify(FIX_COURSES));
  __stop();
}

test('周一 09:00：Hero 显示进行中提示、下一节与倒计时', () => {
  seed();
  render(view(), new URLSearchParams(), MON_9);
  const hero = doc.querySelector('.hm-hero');
  assert.match(hero.textContent, /进行中：法国歌剧史与作品赏析/);
  assert.match(hero.textContent, /综合法语实训\(1\)/);
  assert.match(hero.textContent, /教学二号楼4003/);
  assert.match(hero.querySelector('[data-count]').textContent, /还有 00:50:00/);
});

test('__tick 按注入时刻更新倒计时', () => {
  __tick(new Date(2026, 8, 7, 9, 30, 0));
  assert.match(doc.querySelector('[data-count]').textContent, /还有 00:20:00/);
});

test('今日课程时间轴：进行中高亮', () => {
  seed();
  render(view(), new URLSearchParams(), MON_9);
  const rows = doc.querySelectorAll('.hm-course');
  assert.equal(rows.length, 4);
  assert.ok(rows[0].classList.contains('living'));
  assert.ok(!rows[1].classList.contains('past'));
});

test('今日日程：未完成置顶；临近只显示 1-3 天', () => {
  seed();
  render(view(), new URLSearchParams(), MON_9);
  const todayIds = doc.querySelectorAll('.hm-tasks .hm-task').map((r) => r.getAttribute('data-id'));
  assert.deepEqual(todayIds, ['h1', 'h2']);
  const upc = doc.querySelector('.hm-upc-group');
  assert.match(upc.textContent, /组会/);
  assert.match(doc.querySelector('.home').textContent, /9\/8/);
  assert.ok(!doc.querySelector('.home').textContent.includes('买返程票'));
  assert.ok(!doc.querySelector('.home').textContent.includes('还书'));
});

test('点日程条目跳转带 focus 参数', () => {
  seed();
  render(view(), new URLSearchParams(), MON_9);
  doc.querySelector('[data-id="h1"] .tk-main').click();
  assert.equal(location.hash, '#/tasks?focus=h1');
});

test('首页勾选完成直接写存储', () => {
  seed();
  render(view(), new URLSearchParams(), MON_9);
  location.hash = '#/';
  doc.querySelectorAll('.hm-tasks .tk-check')[1].click();
  assert.equal(loadTasks().find((t) => t.id === 'h2').done, false);
});

test('周日无课：Hero 今日无课 + 课程空态', () => {
  seed();
  render(view(), new URLSearchParams(), new Date(2026, 8, 20, 12, 0));
  assert.match(doc.querySelector('.hm-hero').textContent, /今日无课/);
  assert.match(doc.querySelector('.hm-section .empty-text, .hm-section .empty').textContent, /今天没有课/);
});

test('迷你月历：有课/有日程标记与今日框', () => {
  seed();
  const cal = buildMiniCalendar(new Date(2026, 8, 15), new Set(['2026-09-07', '2026-09-21']), FIX_COURSES);
  const d7 = cal.querySelector('[data-day="2026-09-07"]');
  assert.ok(d7.querySelector('.cal-dot--course'));
  assert.ok(d7.querySelector('.cal-dot--task'));
  const d13 = cal.querySelector('[data-day="2026-09-13"]'); // 周日无课
  assert.equal(d13.querySelector('.cal-dot--course'), null);
  const today = new Date();
  const todayKey = `2026-09-${String(today.getDate()).padStart(2, '0')}`;
  const todayCell = cal.querySelector(`[data-day="${todayKey}"]`);
  if (todayCell) assert.ok(todayCell.classList.contains('cal-cell--today'));
  // 桩件不解析 :not()，用 data-day 的存在性精确圈出日期格（排除表头与补白白格）
  assert.equal(cal.querySelectorAll('.cal-cell').filter((c) => c.getAttribute('data-day')).length, 30);
});

test('今日日程空态：图标 + 引导语 + 按钮', () => {
  globalThis.localStorage = makeStorage();
  __stop();
  render(view(), new URLSearchParams(), new Date(2026, 8, 20, 12, 0));
  const sections = doc.querySelectorAll('.hm-section');
  const taskSection = sections[1];
  assert.ok(taskSection.querySelector('.empty'));
  assert.ok(taskSection.querySelector('.empty-icon'));
  assert.ok(taskSection.querySelector('.empty-text').textContent.includes('今天没有日程'));
  assert.ok(taskSection.querySelector('.btn.primary'));
});

test('清理定时器', () => {
  __stop();
});
