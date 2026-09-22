import { h, mount } from '../lib/dom.js';
import {
  PERIODS, weekOf, rawWeekNumber, weekdayOf, courseTimes,
  weekMonday, addDays,
} from '../lib/time.js';
import { WEEK_LABELS } from '../data/semester.js';
import { openCourseDetail } from '../components/courseDetail.js';
import { openCourseForm } from '../components/courseForm.js';
import { openImportOverlay } from '../components/importOverlay.js';
import { imageHandler } from '../lib/import/imageHandler.js';
import { loadCourses, removeCourse, upsertCourse } from '../lib/courseStore.js';
import { renderEmpty } from '../components/emptyState.js';
import { closeOverlay, toast } from '../lib/feedback.js';

const ROW_H = 46;
const HEAD_H = 34;

let selectedDay = null;
let ctx = null;
let tickTimer = null;
let mqUnsub = null;

function isDesktop() {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  return window.matchMedia('(min-width: 640px)').matches;
}

function nowOffset(now) {
  const mins = now.getHours() * 60 + now.getMinutes();
  const toMin = (s) => s.split(':').map(Number).reduce((a, b) => a * 60 + b);
  for (let i = 0; i < PERIODS.length; i += 1) {
    const s = toMin(PERIODS[i].start);
    const e = toMin(PERIODS[i].end);
    if (mins < s) return i === 0 ? null : i * ROW_H;
    if (mins <= e) return (i + (mins - s) / (e - s)) * ROW_H;
  }
  return null;
}

function weekRangeLabel(now) {
  const monday = weekMonday(now);
  if (!monday) return '';
  const sunday = addDays(monday, 6);
  return ` · ${monday.getMonth() + 1}/${monday.getDate()}-${sunday.getMonth() + 1}/${sunday.getDate()}`;
}

function deleteCourse(course) {
  rerender();
  toast(`已删除「${course.name}」`, {
    actionLabel: '撤销',
    onAction: () => { upsertCourse(course); rerender(); },
  });
}

function confirmDeleteCourse(course) {
  removeCourse(course.id);
  closeOverlay();
  deleteCourse(course);
}

function courseBlock(course, now, desktop) {
  const { start, end } = courseTimes(course, now);
  const living = start <= now && now < end;
  return h(
    'button', {
      class: `tt-block color-${course.color}${living ? ' living' : ''}`,
      type: 'button',
      'data-course': course.name,
      'aria-label': `${course.name} ${WEEK_LABELS[course.day - 1]} 第${course.startSection}-${course.endSection}节`,
      style: `grid-column:${desktop ? course.day + 1 : 2};grid-row:${course.startSection + 1} / span ${course.endSection - course.startSection + 1};`,
      onclick: () => openCourseDetail(course, {
        onEdit: () => openCourseForm({ course, onSaved: rerender, onDelete: deleteCourse }),
        onDelete: () => confirmDeleteCourse(course),
      }),
    },
    h('span', { class: 'tt-name' }, course.name),
    course.room ? h('span', { class: 'tt-room' }, course.room) : null,
  );
}

function gridBody(now, desktop, week, courses) {
  const days = desktop ? [1, 2, 3, 4, 5, 6, 7] : [selectedDay];
  const today = weekdayOf(now);
  const body = h('div', { class: 'tt-grid', style: `grid-template-columns:56px repeat(${days.length}, minmax(0,1fr));` },
    h('div', { class: 'tt-corner', style: 'grid-column:1;grid-row:1;' }),
    ...days.map((d) => h('div', { class: `tt-dayhead${d === today ? ' today' : ''}`, style: `grid-column:${desktop ? d + 1 : 2};grid-row:1;` }, WEEK_LABELS[d - 1])),
    ...PERIODS.map((p) => h(
      'div', { class: 'tt-slot', style: `grid-column:1;grid-row:${p.section + 1};` },
      h('span', { class: 'tt-sec' }, String(p.section)),
      h('span', { class: 'tt-time' }, p.start),
      h('span', { class: 'tt-time' }, p.end),
    )),
    ...days.map((d) => h('div', { class: 'tt-daycol', style: `grid-column:${desktop ? d + 1 : 2};grid-row:2 / span 14;` })),
  );
  if (week !== null) {
    for (const c of courses) {
      if (!days.includes(Number(c.day))) continue;
      body.appendChild(courseBlock(c, now, desktop));
    }
    // 手机单日轴下选到空白天，给一条明确的空态提示，避免整屏只剩时间轴。
    if (!desktop && !courses.some((c) => Number(c.day) === selectedDay)) {
      body.appendChild(h('div', { class: 'tt-empty', style: 'grid-column:2;grid-row:2 / span 3;' }, '当天没有课'));
    }
  }
  const offset = week === null ? null : nowOffset(now);
  const lineVisible = offset !== null && (desktop || selectedDay === today);
  if (lineVisible) {
    body.appendChild(h('div', { class: 'tt-nowline', style: `top:${HEAD_H + offset}px;` }));
  }
  return body;
}

function stopTimers() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (mqUnsub) { mqUnsub(); mqUnsub = null; }
}

function scheduleTick(root) {
  tickTimer = setInterval(() => {
    if (!document.contains(root)) { stopTimers(); return; }
    const now = new Date();
    const line = root.querySelector('.tt-nowline');
    const offset = nowOffset(now);
    if (line) {
      if (offset === null) line.remove();
      else line.style.top = `${HEAD_H + offset}px`;
    }
  }, 60000);
  if (typeof window !== 'undefined' && window.matchMedia) {
    const mq = window.matchMedia('(min-width: 640px)');
    const onChange = () => rerender();
    mq.addEventListener?.('change', onChange);
    mqUnsub = () => mq.removeEventListener?.('change', onChange);
  }
}

function rerender() {
  if (ctx) render(ctx.el, ctx.params, ctx.now);
}

export function render(el, params, now = new Date()) {
  stopTimers();
  ctx = { el, params, now };
  const desktop = isDesktop();
  const week = weekOf(now);
  const today = weekdayOf(now);
  if (selectedDay === null) selectedDay = today;
  const courses = loadCourses();

  const root = h('div', { class: 'tt' });
  const openImport = () => openImportOverlay({ onDone: rerender, parseImage: imageHandler });
  root.appendChild(
    h('div', { class: 'tt-head' },
      h('h1', { class: 'tt-title' }, '课表'),
      h('span', { class: 'tt-week' }, week === null ? `非教学周（第${rawWeekNumber(now)}周）` : `第${week}周${weekRangeLabel(now)}`),
      h('button', { class: 'btn tt-today-btn', type: 'button', onclick: () => { selectedDay = weekdayOf(new Date()); rerender(); } }, '今天'),
      h('button', { class: 'btn tt-import-btn', type: 'button', onclick: openImport }, '⇋ 一键导入'),
      h('button', { class: 'btn tt-add-btn', type: 'button', onclick: () => openCourseForm({ onSaved: rerender }) }, '＋ 添加课程'),
    ),
  );
  if (week === null) {
    root.appendChild(h('div', { class: 'tt-banner' }, `本周无教学安排（第${rawWeekNumber(now)}周）`));
    root.appendChild(renderEmpty({
      text: '假期里也要上课？提前把下学期的课加进来',
      actionText: '添加课程',
      onAction: () => openCourseForm({ onSaved: rerender }),
    }));
  } else if (!courses.length) {
    const empty = renderEmpty({
      text: '这个空间的课表还是空的，先把你自己的课加进来',
      actionText: '添加第一节课',
      onAction: () => openCourseForm({ onSaved: rerender }),
    });
    empty.appendChild(h('button', { class: 'btn tt-empty-import', type: 'button', onclick: openImport }, '导入课表（文字或截图）'));
    root.appendChild(empty);
  } else {
    if (!desktop) {
      root.appendChild(
        h('div', { class: 'tt-chips', role: 'tablist' },
          ...[1, 2, 3, 4, 5, 6, 7].map((d) => h(
            'button', {
              class: `tt-chip${d === selectedDay ? ' active' : ''}${d === today ? ' istoday' : ''}`,
              type: 'button', role: 'tab', 'aria-selected': d === selectedDay ? 'true' : 'false',
              onclick: () => { selectedDay = d; rerender(); },
            }, WEEK_LABELS[d - 1].slice(1),
          ))),
      );
    }
    const body = gridBody(now, desktop, week, courses);
    if (!desktop) attachSwipe(body);
    root.appendChild(body);
  }
  mount(el, root);
  scheduleTick(root);
  return root;
}

function attachSwipe(body) {
  let startX = null;
  body.addEventListener('touchstart', (e) => { startX = e.touches?.[0]?.clientX ?? e.clientX ?? null; });
  body.addEventListener('touchend', (e) => {
    if (startX === null) return;
    const endX = e.changedTouches?.[0]?.clientX ?? e.clientX ?? startX;
    const dx = endX - startX;
    startX = null;
    if (Math.abs(dx) < 40) return;
    selectedDay = Math.min(7, Math.max(1, selectedDay + (dx < 0 ? 1 : -1)));
    rerender();
  });
}

export function __stop() { stopTimers(); }
export function __reset() { stopTimers(); ctx = null; selectedDay = null; }
