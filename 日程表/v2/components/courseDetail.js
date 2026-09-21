import { h } from '../lib/dom.js';
import { openOverlay } from '../lib/feedback.js';
import { PERIODS, WEEK_LABELS } from '../data/semester.js';

function row(k, v) {
  return h('div', { class: 'cd-row' }, h('span', { class: 'cd-k' }, k), h('span', { class: 'cd-v' }, v));
}

export function openCourseDetail(course, { onEdit, onDelete } = {}) {
  const p1 = PERIODS[course.startSection - 1];
  const p2 = PERIODS[course.endSection - 1];
  const body = h(
    'div', { class: 'course-detail' },
    row('星期', WEEK_LABELS[course.day - 1]),
    row('节次', `第${course.startSection}-${course.endSection}节`),
    row('时间', `${p1.start} – ${p2.end}`),
    row('地点', course.room || '未指定'),
    row('周期', '本学期 1–14 周'),
  );
  if (onEdit || onDelete) {
    const actions = h('div', { class: 'cd-actions' });
    if (onEdit) actions.appendChild(h('button', { class: 'btn primary', type: 'button', onclick: onEdit }, '编辑'));
    if (onDelete) actions.appendChild(h('button', { class: 'btn danger', type: 'button', onclick: onDelete }, '删除'));
    body.appendChild(actions);
  }
  return openOverlay({ title: course.name, body });
}
