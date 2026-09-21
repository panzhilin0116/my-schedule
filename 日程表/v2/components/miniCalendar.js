import { h, qs } from '../lib/dom.js';
import { openOverlay, closeOverlay } from '../lib/feedback.js';
import { loadCourses } from '../lib/courseStore.js';
import { weekOf, dayKey, parseDate, addDays } from '../lib/time.js';
import { SEMESTER } from '../data/semester.js';
import { loadTasks } from '../lib/store.js';

const CELL_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

function monthMatrix(year, month /* 0-based */) {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < offset; i += 1) cells.push(null);
  for (let d = 1; d <= days; d += 1) cells.push(new Date(year, month, d));
  return cells;
}

function renderCalendarBody(viewDate, taskDates, courses, onNavigate) {
  const courseDays = new Set();
  const week1 = parseDate(SEMESTER.week1Monday);
  for (const c of courses) {
    for (let w = 0; w < SEMESTER.totalWeeks; w += 1) {
      const d = addDays(week1, c.day - 1 + w * 7);
      if (d.getMonth() === viewDate.getMonth() && d.getFullYear() === viewDate.getFullYear()) {
        courseDays.add(d.getDate());
      }
    }
  }
  const cells = monthMatrix(viewDate.getFullYear(), viewDate.getMonth());
  const todayKey = dayKey(new Date());

  const prevBtn = h('button', {
    class: 'cal-nav-btn', type: 'button', 'aria-label': '上个月',
    onclick: () => onNavigate(new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1)),
  }, '‹');
  const nextBtn = h('button', {
    class: 'cal-nav-btn', type: 'button', 'aria-label': '下个月',
    onclick: () => onNavigate(new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1)),
  }, '›');

  return h(
    'div', { class: 'cal' },
    h('div', { class: 'cal-header' },
      prevBtn,
      h('div', { class: 'cal-title' }, `${viewDate.getFullYear()}年${viewDate.getMonth() + 1}月`),
      nextBtn,
    ),
    h('div', { class: 'cal-grid' },
      ...CELL_LABELS.map((l) => h('div', { class: 'cal-cell cal-cell--head' }, l)),
      ...cells.map((d) => {
        if (!d) return h('div', { class: 'cal-cell cal-cell--blank' });
        const key = dayKey(d);
        const marks = [];
        if (courseDays.has(d.getDate()) && weekOf(d) !== null) marks.push(h('i', { class: 'cal-dot cal-dot--course' }));
        if (taskDates.has(key)) marks.push(h('i', { class: 'cal-dot cal-dot--task' }));
        return h('div', {
          class: `cal-cell${key === todayKey ? ' cal-cell--today' : ''}`,
          'data-day': key,
        }, h('span', null, String(d.getDate())), marks);
      }),
    ),
    h('div', { class: 'cal-legend' },
      h('span', null, h('i', { class: 'cal-dot cal-dot--course' }), ' 有课'),
      h('span', null, h('i', { class: 'cal-dot cal-dot--task' }), ' 有日程'),
    ),
  );
}

export function buildMiniCalendar(viewDate = new Date(), taskDates = null, courses = null) {
  const dates = taskDates ?? new Set(loadTasks().map((t) => t.date));
  const courseList = courses ?? loadCourses();
  return renderCalendarBody(viewDate, dates, courseList, () => {});
}

export function openMiniCalendar(now = new Date()) {
  let viewDate = new Date(now.getFullYear(), now.getMonth(), 1);
  const taskDates = new Set(loadTasks().map((t) => t.date));
  const courses = loadCourses();

  function navigate(newDate) {
    viewDate = newDate;
    const newBody = renderCalendarBody(viewDate, taskDates, courses, navigate);
    const overlayBody = qs('.overlay-body');
    if (overlayBody && overlayBody.firstChild) {
      overlayBody.replaceChild(newBody, overlayBody.firstChild);
    }
  }

  const body = renderCalendarBody(viewDate, taskDates, courses, navigate);
  return openOverlay({ title: '校历月历', body });
}
