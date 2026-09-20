import { h, mount } from '../lib/dom.js';
import {
  coursesOn, currentCourse, nextCourse, courseTimes,
  fmtClock, fmtCountdown, weekOf, addDays, dayKey, diffDays, parseDate,
} from '../lib/time.js';
import { loadTasks, toggleTask, StoreError } from '../lib/store.js';
import { openTaskForm } from '../components/taskForm.js';
import { navigate } from '../lib/router.js';
import { renderEmpty } from '../components/emptyState.js';
import { toast } from '../lib/feedback.js';

let ctx = null;
let heroTimer = null;

function stop() {
  if (heroTimer) { clearInterval(heroTimer); heroTimer = null; }
}

function heroContent(now) {
  const courses = coursesOn(now);
  if (!courses.length) {
    return h('div', { class: 'hm-hero hm-hero--idle' }, h('div', { class: 'hm-hero-big' }, weekOf(now) === null ? '假期中 · 今日无课' : '今日无课'));
  }
  const cur = currentCourse(now, now);
  const nx = nextCourse(now, now);
  if (cur && !nx) {
    return h('div', { class: 'hm-hero hm-hero--live' },
      h('div', { class: 'hm-hero-kicker' }, '正在上课'),
      h('div', { class: 'hm-hero-big' }, cur.name),
      h('div', { class: 'hm-hero-sub' }, cur.room || ''),
    );
  }
  if (!nx) {
    return h('div', { class: 'hm-hero hm-hero--idle' }, h('div', { class: 'hm-hero-big' }, '今日课程已结束'));
  }
  return h('div', { class: 'hm-hero' },
    cur ? h('div', { class: 'hm-hero-kicker living-kicker' }, `进行中：${cur.name}`) : h('div', { class: 'hm-hero-kicker' }, `下一节 ${fmtClock(nx.at)}`),
    h('div', { class: 'hm-hero-big' }, nx.course.name),
    h('div', { class: 'hm-hero-sub' }, nx.course.room || ''),
    h('div', { class: 'hm-hero-count mono', 'data-count': '' }, `还有 ${fmtCountdown(nx.at - now)}`),
  );
}

function updateHero(now = new Date()) {
  const root = ctx?.el?.querySelector?.('.home');
  if (!root) return;
  const slot = root.querySelector('.hm-hero-slot');
  if (!slot) return;
  mount(slot, heroContent(now));
}

function courseRow(course, now) {
  const { start, end } = courseTimes(course, now);
  const past = end <= now;
  const living = start <= now && now < end;
  return h('div', { class: `hm-course${past ? ' past' : ''}${living ? ' living' : ''}` },
    h('div', { class: 'hm-course-time mono' }, h('span', null, fmtClock(start)), h('span', null, fmtClock(end))),
    h('div', { class: 'hm-course-main' },
      h('div', { class: 'hm-course-name' }, course.name),
      course.room ? h('div', { class: 'hm-course-room' }, course.room) : null,
    ),
    living ? h('span', { class: 'hm-badge' }, '进行中') : null,
  );
}

function taskLine(t, now) {
  const meta = [t.startTime && t.endTime ? `${t.startTime}-${t.endTime}` : t.startTime, t.location].filter(Boolean).join(' · ');
  return h('div', { class: `hm-task${t.done ? ' done' : ''}`, 'data-id': t.id },
    h('button', {
      class: 'tk-check', type: 'button', 'aria-label': t.done ? '标记未完成' : '标记完成',
      onclick: () => {
        try { toggleTask(t.id); rerender(); }
        catch (err) { if (err instanceof StoreError) toast(err.message); else throw err; }
      },
    }),
    h('div', { class: 'tk-main', onclick: () => navigate(`#/tasks?focus=${t.id}`) },
      h('div', { class: 'tk-title' }, t.title),
      meta ? h('div', { class: 'tk-meta' }, meta) : null,
    ),
  );
}

function sortTasks(list) {
  return list.slice().sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const at = a.startTime || '99:99';
    const bt = b.startTime || '99:99';
    return at < bt ? -1 : at > bt ? 1 : 0;
  });
}

function rerender() {
  if (ctx) render(ctx.el, ctx.params, new Date());
}

export function render(el, params, now = new Date()) {
  stop();
  ctx = { el, params };
  const tasks = loadTasks();
  const todayKey = dayKey(now);
  const todayTasks = sortTasks(tasks.filter((t) => t.date === todayKey));
  const upcoming = tasks
    .filter((t) => !t.done)
    .map((t) => ({ t, d: diffDays(now, parseDate(t.date)) }))
    .filter(({ d }) => d >= 1 && d <= 3)
    .sort((a, b) => a.d - b.d || ((a.t.startTime || '99:99') < (b.t.startTime || '99:99') ? -1 : 1));

  const root = h('div', { class: 'home' });
  root.appendChild(h('div', { class: 'hm-hero-slot' }, heroContent(now)));

  const courses = coursesOn(now);
  root.appendChild(
    h('section', { class: 'hm-section' },
      h('h2', { class: 'hm-h' }, '今日课程'),
      courses.length
        ? h('div', { class: 'hm-courses' }, ...courses.map((c) => courseRow(c, now)))
        : renderEmpty({ text: weekOf(now) === null ? '非教学周，无课程安排' : '今天没有课' }),
    ),
  );

  root.appendChild(
    h('section', { class: 'hm-section' },
      h('div', { class: 'hm-h-row' },
        h('h2', { class: 'hm-h' }, `今日日程${todayTasks.length ? ` (${todayTasks.length})` : ''}`),
        h('button', { class: 'btn hm-add', type: 'button', onclick: () => openTaskForm({ onSaved: rerender }) }, '＋'),
      ),
      todayTasks.length
        ? h('div', { class: 'hm-tasks' }, ...todayTasks.map((t) => taskLine(t, now)))
        : h('p', { class: 'hm-none' }, '今天没有日程'),
    ),
  );

  if (upcoming.length) {
    const byDate = new Map();
    for (const { t } of upcoming) {
      if (!byDate.has(t.date)) byDate.set(t.date, []);
      byDate.get(t.date).push(t);
    }
    root.appendChild(
      h('section', { class: 'hm-section' },
        h('h2', { class: 'hm-h' }, '临近日程'),
        ...[...byDate.entries()].map(([date, list]) => h('div', { class: 'hm-upc-group' },
          h('span', { class: 'hm-upc-date mono' }, `${parseDate(date).getMonth() + 1}/${parseDate(date).getDate()}`),
          ...list.map((t) => taskLine(t, now)),
        )),
      ),
    );
  }

  mount(el, root);
  heroTimer = setInterval(() => {
    if (!document.contains(root)) { stop(); return; }
    updateHero();
  }, 1000);
  return root;
}

export function __tick(now) { updateHero(now); }
export function __stop() { stop(); ctx = null; }
