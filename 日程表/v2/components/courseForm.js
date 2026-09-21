import { h } from '../lib/dom.js';
import { openOverlay, closeOverlay, toast } from '../lib/feedback.js';
import {
  validateCourse, upsertCourse, removeCourse, newCourseId,
  loadCourses, COURSE_COLORS, StoreError,
} from '../lib/courseStore.js';
import { PERIODS, WEEK_LABELS } from '../data/semester.js';

export function openCourseForm({ course, onSaved, onDelete } = {}) {
  const isNew = !course;
  const draft = {
    id: isNew ? newCourseId() : course.id,
    name: course?.name ?? '',
    day: course?.day ?? 1,
    startSection: course?.startSection ?? 1,
    endSection: course?.endSection ?? 2,
    room: course?.room ?? '',
    color: course?.color ?? COURSE_COLORS[0],
    createdAt: course?.createdAt ?? Date.now(),
  };

  const inputs = {};
  const errNodes = {};
  let lastErrors = {};

  const submit = h('button', { class: 'btn primary f-submit', type: 'submit' }, '保存');

  const daySelect = h('select', { name: 'day' },
    ...WEEK_LABELS.map((label, i) => h('option', { value: String(i + 1) }, label)),
  );
  daySelect.value = String(draft.day);

  function sectionSelect(name, value) {
    const sel = h('select', { name },
      ...PERIODS.map((p) => h('option', { value: String(p.section) }, `第${p.section}节 (${p.start})`)),
    );
    sel.value = String(value);
    return sel;
  }
  const startSel = sectionSelect('startSection', draft.startSection);
  const endSel = sectionSelect('endSection', draft.endSection);

  const colorDots = COURSE_COLORS.map((c) => h('button', {
    class: `cf-dot color-${c}${draft.color === c ? ' active' : ''}`,
    type: 'button', 'aria-label': `颜色 ${c}`, 'data-color': c,
    onclick: () => {
      draft.color = c;
      colorDots.forEach((d) => d.classList.toggle('active', d.getAttribute('data-color') === c));
      refresh();
    },
  }));

  function snapshot() {
    draft.name = inputs.name.value;
    draft.day = Number(daySelect.value);
    draft.startSection = Number(startSel.value);
    draft.endSection = Number(endSel.value);
    draft.room = inputs.room.value;
  }

  function showErrors() {
    for (const k of Object.keys(errNodes)) errNodes[k].textContent = lastErrors[k] ?? '';
  }

  function refresh(blurred) {
    snapshot();
    const others = loadCourses().filter((c) => c.id !== draft.id);
    const { ok, errors } = validateCourse(draft, others);
    lastErrors = errors;
    const shown = blurred ?? Object.keys(errNodes);
    for (const k of shown) errNodes[k].textContent = errors[k] ?? '';
    submit.disabled = !ok;
  }

  function field(key, label, node) {
    const err = h('span', { class: 'f-err' });
    errNodes[key] = err;
    inputs[key] = node;
    node.addEventListener('input', () => refresh());
    node.addEventListener('change', () => refresh());
    node.addEventListener('blur', () => refresh([key]));
    return h('label', { class: 'f-row' }, h('span', { class: 'f-label' }, label), node, err);
  }

  const form = h(
    'form', { class: 'task-form course-form' },
    field('name', '名称', h('input', { name: 'name', placeholder: '课程名称', value: draft.name })),
    field('day', '星期', daySelect),
    h('div', { class: 'f-pair' },
      field('startSection', '开始', startSel),
      field('endSection', '结束', endSel),
    ),
    field('room', '地点', h('input', { name: 'room', placeholder: '选填', value: draft.room })),
    h('div', { class: 'f-row' },
      h('span', { class: 'f-label' }, '颜色'),
      h('div', { class: 'cf-dots' }, ...colorDots),
    ),
    submit,
  );

  form.addEventListener('submit', (e) => {
    e.preventDefault?.();
    refresh();
    const others = loadCourses().filter((c) => c.id !== draft.id);
    const { ok } = validateCourse(draft, others);
    if (!ok) { showErrors(); return; }
    try {
      const saved = upsertCourse({ ...draft });
      closeOverlay();
      onSaved?.(saved, isNew);
    } catch (err) {
      if (err instanceof StoreError) {
        toast(err.message, { duration: 5000 });
      } else {
        throw err;
      }
    }
  });

  const body = h('div', { class: 'task-form-wrap' }, form);
  refresh([]); // 初始只算禁用态，不显示错误
  if (!isNew) {
    body.appendChild(
      h('button', {
        class: 'btn danger f-delete', type: 'button',
        onclick: () => {
          const removed = { ...draft };
          removeCourse(draft.id);
          closeOverlay();
          onDelete?.(removed);
        },
      }, '删除'),
    );
  }

  return openOverlay({ title: isNew ? '添加课程' : '编辑课程', body });
}
