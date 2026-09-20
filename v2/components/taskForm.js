import { h } from '../lib/dom.js';
import { openOverlay, closeOverlay } from '../lib/feedback.js';
import { validateTask, upsertTask, removeTask, newTaskId } from '../lib/store.js';
import { dayKey } from '../lib/time.js';

export function openTaskForm({ task, onSaved, onDelete } = {}) {
  const isNew = !task;
  const draft = {
    id: isNew ? newTaskId() : task.id,
    title: task?.title ?? '',
    date: task?.date ?? dayKey(new Date()),
    startTime: task?.startTime ?? '',
    endTime: task?.endTime ?? '',
    location: task?.location ?? '',
    note: task?.note ?? '',
    done: task?.done ?? false,
    createdAt: task?.createdAt ?? Date.now(),
  };

  const inputs = {};
  const errNodes = {};
  let lastErrors = {};

  const submit = h('button', { class: 'btn primary f-submit', type: 'submit' }, '保存');

  function snapshot() {
    for (const k of Object.keys(inputs)) draft[k] = inputs[k].value;
  }

  function showErrors() {
    for (const k of Object.keys(errNodes)) errNodes[k].textContent = lastErrors[k] ?? '';
  }

  function refresh(blurred) {
    snapshot();
    const { ok, errors } = validateTask(draft);
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
    node.addEventListener('blur', () => refresh([key]));
    return h('label', { class: 'f-row' }, h('span', { class: 'f-label' }, label), node, err);
  }

  const noteEl = h('textarea', { name: 'note', class: 'f-note', rows: '3', placeholder: '选填' });
  noteEl.value = draft.note;

  const form = h(
    'form', { class: 'task-form', id: 'task-form' },
    field('title', '标题', h('input', { name: 'title', class: 'f-title', placeholder: '要做什么？', value: draft.title })),
    field('date', '日期', h('input', { name: 'date', type: 'date', value: draft.date })),
    h('div', { class: 'f-pair' },
      field('startTime', '开始', h('input', { name: 'startTime', type: 'time', value: draft.startTime })),
      field('endTime', '结束', h('input', { name: 'endTime', type: 'time', value: draft.endTime })),
    ),
    field('location', '地点', h('input', { name: 'location', placeholder: '选填', value: draft.location })),
    field('note', '备注', noteEl),
    submit,
  );

  form.addEventListener('submit', (e) => {
    e.preventDefault?.();
    refresh();
    const { ok } = validateTask(draft);
    if (!ok) { showErrors(); return; }
    const saved = upsertTask({ ...draft });
    closeOverlay();
    onSaved?.(saved, isNew);
  });

  const body = h('div', { class: 'task-form-wrap' }, form);
  refresh([]); // 初始只算禁用态，不显示错误
  if (!isNew) {
    body.appendChild(
      h('button', {
        class: 'btn danger f-delete', type: 'button',
        onclick: () => {
          const removed = { ...draft };
          removeTask(draft.id);
          closeOverlay();
          onDelete?.(removed);
        },
      }, '删除',),
    );
  }

  return openOverlay({ title: isNew ? '新建日程' : '编辑日程', body });
}

export const openCreate = (onSaved) => openTaskForm({ onSaved });
export const openEdit = (task, onSaved, onDelete) => openTaskForm({ task, onSaved, onDelete });
