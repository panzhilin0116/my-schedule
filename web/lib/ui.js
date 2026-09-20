// 全局 UI 原语：浮层表单、确认框、Toast+撤销、骨架/空态/错误态、左滑删除。
// 桌面 Modal 与移动底部抽屉是同一套 DOM，形态差异只由 styles.css 的断点决定，
// 因此这里不读视口宽度；字段定义一律来自 registry，界面不得自造库里没有的字段。
import { h, mount, clear, byId, icon } from './dom.js';
import { TABLES } from './registry.mjs';

const FOCUSABLE = 'input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled]),a[href]';
const layers = [];
let formSeq = 0;

const ENUM_LABELS = {
  all: '每周', odd: '单周', even: '双周',
  not_started: '未开始', active: '进行中', blocked: '受阻', done: '已完成',
  partial: '部分完成', missed: '缺练',
};

const HIDDEN_COLUMNS = new Set(['id', 'created_at', 'updated_at', 'done_at', 'periods']);

const asInt = (value) => (Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0);

/** 由表定义生成表单字段描述；overrides 按列名补充或替换。 */
export function fieldsFor(table, { only, except = [], overrides = {} } = {}) {
  const spec = TABLES[table];
  if (!spec) throw new Error(`未知的数据表：${table}`);
  const names = only ?? Object.keys(spec.columns);
  const fields = [];
  for (const name of names) {
    if (except.includes(name) || HIDDEN_COLUMNS.has(name) || !spec.columns[name]) continue;
    const col = spec.columns[name];
    const base = { name, label: col.label ?? name, type: 'text', rules: { required: Boolean(col.required), max: col.max } };
    if (col.kind === 'int') Object.assign(base, { type: 'number', rules: { required: Boolean(col.required), between: [col.min, col.max] } });
    if (col.kind === 'bool') Object.assign(base, { type: 'switch' });
    if (col.kind === 'date') Object.assign(base, { type: 'date' });
    if (col.kind === 'hhmm') Object.assign(base, { type: 'time' });
    if (col.kind === 'text' && col.enum) {
      Object.assign(base, {
        type: 'select',
        options: col.enum.map((value) => ({ value, label: ENUM_LABELS[value] ?? value })),
      });
    }
    if (name === 'color') Object.assign(base, { type: 'swatches', options: PALETTE });
    if (name === 'duration_min') Object.assign(base, { type: 'stepper', step: 5, min: 0, max: 600 });
    if (name === 'progress') Object.assign(base, { type: 'stepper', step: 5, min: 0, max: 100 });
    if (name === 'sort') continue;
    fields.push(Object.assign(base, overrides[name] ?? {}));
  }
  return fields;
}

export const PALETTE = ['#3DD6F5', '#FF8A3D', '#4ADE80', '#A78BFA', '#F2555A', '#38BDF8', '#FACC15', '#8FA3C0'];

function control(field, get, commit) {
  const id = `f_${field.name}`;
  switch (field.type) {
    case 'textarea':
      return h('textarea', {
        id, maxlength: field.rules?.max ?? 500, placeholder: field.placeholder ?? '',
        oninput: (event) => commit(event.target.value),
      }, get() ?? '');
    case 'select':
      return h('select', { id, onchange: (event) => commit(event.target.value) },
        field.rules?.required ? null : h('option', { value: '', text: field.emptyLabel ?? '未设定' }),
        ...(field.options ?? []).map((option) => h('option', {
          value: option.value, text: option.label, selected: String(get() ?? '') === String(option.value),
        })));
    case 'switch': {
      const button = h('button.btn.sm', {
        type: 'button', id, 'aria-pressed': get() ? 'true' : 'false',
        onclick: () => {
          commit(!get());
          button.setAttribute('aria-pressed', get() ? 'true' : 'false');
          button.textContent = labelOf(field, get());
        },
      });
      button.textContent = labelOf(field, get());
      return button;
    }
    case 'number':
      return h('input', {
        id, type: 'number', inputmode: 'numeric',
        min: field.rules?.between?.[0], max: field.rules?.between?.[1],
        value: get() ?? '', placeholder: field.placeholder ?? '',
        oninput: (event) => commit(event.target.value === '' ? null : Number(event.target.value)),
      });
    case 'stepper': {
      const [min, max] = field.rules?.between ?? [field.min ?? 0, field.max ?? 9999];
      const display = h('span.num');
      const paint = () => { display.textContent = `${Number(get()) || 0}${field.unit ?? ''}`; };
      const bump = (delta) => {
        commit(Math.max(min, Math.min(max, (Number(get()) || 0) + delta)));
        paint();
      };
      paint();
      return h('div.stepper',
        h('button.iconbtn', { type: 'button', 'aria-label': `${field.label}减少`, onclick: () => bump(-(field.step ?? 5)), text: '−' }),
        display,
        h('button.iconbtn', { type: 'button', 'aria-label': `${field.label}增加`, onclick: () => bump(field.step ?? 5), text: '+' }),
      );
    }
    case 'swatches': {
      const wrap = h('div.swatches');
      const paint = () => {
        for (const node of [...wrap.children]) node.setAttribute('aria-pressed', String(node.dataset.value === get()));
      };
      for (const color of field.options ?? []) {
        wrap.appendChild(h('button', {
          type: 'button', dataset: { value: color }, style: { background: color },
          'aria-label': `颜色 ${color}`, 'aria-pressed': get() === color ? 'true' : 'false',
          onclick: () => { commit(color); paint(); },
        }));
      }
      paint();
      return wrap;
    }
    case 'chips': {
      const wrap = h('div.row.wrap');
      const buttons = [];
      const box = field.allowCustom ? h('input', {
        type: 'text', maxlength: field.rules?.max, placeholder: field.customPlaceholder ?? '自定义名称',
        'aria-label': `${field.label}：自定义名称`, hidden: true,
        oninput: (event) => commit(event.target.value.trim()),
      }) : null;
      const paint = () => {
        const value = get();
        for (const node of buttons) {
          node.setAttribute('aria-pressed', String(field.multiple ? (value ?? []).includes(node.dataset.value) : value === node.dataset.value));
        }
        if (!box) return;
        // 候选里没有当前值，说明这是个自定义名字：把输入框显出来接住它，否则编辑时看着像没填
        const isCustom = Boolean(value) && !(field.options ?? []).includes(value);
        box.hidden = !isCustom;
        if (isCustom) box.value = value;
      };
      for (const option of field.options ?? []) {
        buttons.push(h('button.chip', {
          type: 'button', dataset: { value: option }, text: option,
          onclick: () => { commit(field.multiple ? toggleValue(get(), option) : option); paint(); },
        }));
      }
      if (box) {
        buttons.push(h('button.chip.more', {
          type: 'button', text: '自定义…', 'aria-label': `自定义${field.label}`,
          onclick: () => { box.hidden = false; box.focus?.(); },
        }));
      }
      wrap.append(...buttons, ...(box ? [box] : []));
      paint();
      return wrap;
    }
    case 'quickstep': {
      // 常用档位点一下就填好，微调仍走 ±：记一笔要压到 3 次点击以内
      const [min, max] = field.rules?.between ?? [field.min ?? 0, field.max ?? 9999];
      const step = field.step ?? 5;
      const display = h('span.num');
      const marks = h('div.row.wrap');
      const sync = () => {
        const value = asInt(get());
        display.textContent = `${value}${field.unit ?? ''}`;
        for (const node of marks.children) node.setAttribute('aria-pressed', String(node.dataset.value === String(value)));
      };
      const write = (value, { snap = false } = {}) => {
        const raw = snap ? Math.round(asInt(value) / step) * step : asInt(value);
        commit(Math.max(min, Math.min(max, raw)));
        sync();
      };
      for (const option of field.options ?? []) {
        marks.appendChild(h('button.chip', {
          type: 'button', dataset: { value: option }, text: `${option}${field.unit ?? ''}`,
          'aria-label': `${field.label} ${option}${field.unit ?? ''}`,
          onclick: () => write(option, { snap: true }),
        }));
      }
      sync();
      return h('div.quickstep',
        marks,
        h('div.stepper',
          h('button.iconbtn', { type: 'button', 'aria-label': `${field.label}减少 ${step}`, onclick: () => write(asInt(get()) - step), text: '−' }),
          display,
          h('button.iconbtn', { type: 'button', 'aria-label': `${field.label}增加 ${step}`, onclick: () => write(asInt(get()) + step), text: '+' }),
        ),
      );
    }
    case 'tri': {
      const wrap = h('div.tri', { role: 'group', 'aria-label': field.label });
      const sync = () => {
        for (const node of wrap.children) node.setAttribute('aria-pressed', String(node.dataset.value === get()));
      };
      for (const option of field.options ?? []) {
        wrap.appendChild(h('button', {
          type: 'button', dataset: { value: option.value }, 'aria-pressed': 'false',
          'aria-label': `${field.label}：${option.label}`,
          onclick: () => { commit(option.value); sync(); },
        }, option.glyph ? icon(option.glyph) : null, h('span', { text: option.label })));
      }
      sync();
      return wrap;
    }
    default:
      return h('input', {
        id, type: field.type ?? 'text', value: get() ?? '', placeholder: field.placeholder ?? '',
        maxlength: field.rules?.max, oninput: (event) => commit(event.target.value),
      });
  }
}

function labelOf(field, value) {
  if (value === true) return field.onLabel ?? '是';
  if (value === false) return field.offLabel ?? '否';
  return String(value ?? '');
}

function toggleValue(list, option) {
  const current = Array.isArray(list) ? [...list] : list ? [list] : [];
  const index = current.indexOf(option);
  if (index >= 0) current.splice(index, 1); else current.push(option);
  return current;
}

/** 失焦即校验：错误信息只出现在对应字段上，不弹整体报错（PRD 2.3.6）。 */
function checkField(field, value, draft) {
  const empty = value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
  if (empty) return field.rules?.required ? `${field.label}不能为空` : null;
  if (field.validate) return field.validate(value, draft);
  const rules = field.rules ?? {};
  if (typeof value === 'string' && rules.max && value.trim().length > rules.max) return `${field.label}最长 ${rules.max} 个字符`;
  if (typeof value === 'string' && rules.pattern && !rules.pattern.test(value.trim())) return `${field.label}格式不合法`;
  if (typeof value === 'number' && rules.between) {
    const [min, max] = rules.between;
    if (!Number.isSafeInteger(value)) return `${field.label}必须是整数`;
    if (value < min || value > max) return `${field.label}需在 ${min}–${max} 之间`;
  }
  if (field.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return `${field.label}格式应为 2026-09-01`;
  if (field.type === 'time' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))) return `${field.label}格式应为 08:00`;
  return null;
}

function buildLayer({ title, eyebrow, closeLabel = '关闭' }) {
  const root = byId('modal-root');
  // 栈里有几层就标记 html，CSS 据此锁住背景滚动
  const syncScrollLock = () => {
    const html = document.documentElement;
    if (layers.length) html.setAttribute('data-layers', String(layers.length));
    else html.removeAttribute('data-layers');
  };
  const head = h('div.layer-head',
    h('div', h('span.eyebrow', { text: eyebrow }), h('h2', { text: title })),
    h('div.spacer'),
  );
  const body = h('div.layer-body');
  const foot = h('div.layer-foot');
  const layer = h('div.layer', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div.grabber'), head, body, foot);
  const closeButton = h('button.iconbtn', { type: 'button', 'aria-label': closeLabel, onclick: () => handle.close({ submitted: false }) }, icon('close'));
  head.appendChild(closeButton);
  const veil = h('div.layer-veil', { onpointerdown: (event) => { if (event.target === veil) handle.close({ submitted: false }); } }, layer);
  const restore = document.activeElement;
  // 键盘用户按 Tab 不能掉进被遮住的背景里：焦点在浮层内首尾相扣
  layer.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const items = [...layer.querySelectorAll(FOCUSABLE)]
      .filter((node) => !node.hidden && !node.disabled && !node.closest('[hidden]'));
    if (!items.length) return;
    const active = document.activeElement;
    const outside = !layer.contains(active);
    if (event.shiftKey && (outside || active === items[0])) {
      event.preventDefault();
      items[items.length - 1].focus?.();
    } else if (!event.shiftKey && (outside || active === items[items.length - 1])) {
      event.preventDefault();
      items[0].focus?.();
    }
  });
  const handle = {
    element: layer, body, foot,
    close(result = { submitted: false }) {
      const index = layers.indexOf(handle);
      if (index < 0) return;
      layers.splice(index, 1);
      veil.remove();
      syncScrollLock();
      restore?.focus?.();
      handle.onDismiss?.(result);
    },
  };
  root.appendChild(veil);
  layers.push(handle);
  syncScrollLock();
  return handle;
}

/** 移动底部抽屉的下拉关闭：抓住把手向下拖超过阈值即关闭。 */
function enablePullToClose(layer, close) {
  const grabber = layer.querySelector('.grabber');
  if (!grabber) return;
  let dy = 0;
  grabber.addEventListener('pointerdown', (start) => {
    dy = 0;
    const origin = start.clientY;
    const move = (event) => {
      dy = Math.max(0, event.clientY - origin);
      layer.style.transform = `translateY(${dy}px)`;
    };
    const up = () => {
      globalThis.removeEventListener('pointermove', move);
      globalThis.removeEventListener('pointerup', up);
      layer.style.transform = '';
      if (dy > 90) close();
    };
    globalThis.addEventListener('pointermove', move);
    globalThis.addEventListener('pointerup', up);
  });
}

/**
 * 浮层表单。onSubmit 抛错时保留输入并显示字段级/整体错误；
 * pending 期间禁用提交按钮，重复点击不会二次提交。
 * onDraft 每次改动草稿都会被调用，用于"当前第 N 周""影响几门课"这类实时读数。
 */
export function openLayer({ title, eyebrow = 'FORM', fields, values = {}, submitLabel = '保存', onSubmit, extra = [], twoColumns = false, onDraft }) {
  const draft = { ...values };
  const errors = new Map();
  let submitting = false;
  const handle = buildLayer({ title, eyebrow });
  // 提交按钮在 .layer-foot 里，与 <form> 是兄弟：靠 form 属性关联，
  // 否则浏览器里点"保存"根本不会提交（表单语义不由 DOM 位置决定）
  const formId = `layer-form-${(formSeq += 1)}`;
  const form = h('form', { class: twoColumns ? 'field-grid' : 'field-stack', id: formId });
  const notice = h('div.notice.danger', { hidden: true });
  const submit = h('button.btn.primary', { type: 'submit', form: formId, text: submitLabel });
  const entries = new Map();

  const paint = (name) => {
    const entry = entries.get(name);
    if (!entry) return;
    const message = errors.get(name) ?? null;
    entry.wrap.classList.toggle('invalid', Boolean(message));
    entry.wrap.querySelector('.err').textContent = message ?? '';
  };

  const validate = (field, value) => {
    const message = checkField(field, value, draft);
    if (message) errors.set(field.name, message); else errors.delete(field.name);
    paint(field.name);
    refreshSubmit();
    return message;
  };

  for (const field of fields) {
    const wrap = h('div.field');
    const node = control(field, () => draft[field.name], (value) => {
      draft[field.name] = value;
      validate(field, value);
      onDraft?.(draft);
    });
    wrap.appendChild(h('label', { for: `f_${field.name}`, text: field.label }));
    wrap.appendChild(node);
    if (field.hint) wrap.appendChild(h('span.hint', { text: field.hint }));
    wrap.appendChild(h('span.err'));
    entries.set(field.name, { wrap, field, node });
    form.appendChild(wrap);
  }

  const refreshSubmit = () => {
    const blankRequired = (field) => {
      if (!field.rules?.required) return false;
      const value = draft[field.name];
      return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
    };
    // 必填项还没填齐就禁用提交：不用等用户点一下才看到红字，
    // 也不会把注定被 Function 拒绝的请求发出去
    submit.disabled = submitting || errors.size > 0 || fields.some(blankRequired);
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting) return;
    for (const entry of entries.values()) validate(entry.field, draft[entry.field.name]);
    const firstBad = [...entries.keys()].find((name) => errors.has(name));
    if (firstBad) { entries.get(firstBad).node.focus?.(); return; }
    submitting = true;
    notice.hidden = true;
    submit.textContent = '正在保存…';
    refreshSubmit();
    try {
      // 只交回表单自己渲染的字段：values 里通常还带着 id/created_at 这些服务端列，
      // 原样发出去会被 Function 判成"不支持的字段"，编辑就永远保存不掉
      const picked = {};
      for (const field of fields) if (draft[field.name] !== undefined) picked[field.name] = draft[field.name];
      await onSubmit(picked);
      handle.close({ submitted: true });
    } catch (error) {
      if (error?.field && entries.has(error.field)) {
        errors.set(error.field, error.message ?? '此项有误');
        paint(error.field);
      } else {
        mount(notice, [icon('alert', '错误'), h('span', { text: error?.message ?? '保存失败，请重试' })]);
        notice.hidden = false;
      }
      submit.textContent = '重试保存';
    } finally {
      submitting = false;
      refreshSubmit();
    }
  });

  handle.body.append(form, ...extra, notice);
  handle.foot.append(h('button.btn.ghost', { type: 'button', text: '取消', onclick: () => handle.close({ submitted: false }) }), submit);
  refreshSubmit();
  // 打开浮层就把光标停在第一个字段上：键盘与读屏用户不必先 Tab 过标题和关闭按钮
  form.querySelector(FOCUSABLE)?.focus?.();
  enablePullToClose(handle.element, () => handle.close({ submitted: false }));
  // 返回 handle 本体而不是浅拷贝：调用方挂 onDismiss 时才收得到关闭结果
  handle.draft = () => draft;
  return handle;
}

export function confirmDialog({ title, message, detail = '', confirmLabel = '确认删除', cancelLabel = '返回', danger = true, requireText }) {
  return new Promise((resolve) => {
    let confirmed = false;
    const handle = buildLayer({ title, eyebrow: 'CONFIRM' });
    handle.onDismiss = () => resolve(confirmed);
    const confirm = h('button.btn', {
      class: danger ? 'danger' : 'primary', type: 'button', text: confirmLabel, disabled: Boolean(requireText),
      onclick: () => { confirmed = true; handle.close({ submitted: true }); },
    });
    const parts = [h('p', { text: message })];
    if (detail) parts.push(h('p.tiny.faint', { text: detail }));
    if (requireText) {
      parts.push(h('div.field',
        h('label', { text: `请输入 ${requireText} 以确认` }),
        h('input', {
          type: 'text', autocomplete: 'off', placeholder: requireText,
          oninput: (event) => { confirm.disabled = event.target.value.trim() !== requireText; },
        }),
      ));
    }
    handle.body.appendChild(h('div.stack', {}, ...parts));
    const cancel = h('button.btn.ghost', { type: 'button', text: cancelLabel, onclick: () => handle.close({ submitted: false }) });
    handle.foot.append(cancel, confirm);
    enablePullToClose(handle.element, () => handle.close({ submitted: false }));
    // 默认光标停在「返回」上：回车键不该顺手把删除确认执行掉
    (requireText ? handle.body.querySelector(FOCUSABLE) : cancel).focus?.();
  });
}

export function closeTopLayer() {
  const top = layers[layers.length - 1];
  if (!top) return false;
  top.close({ submitted: false });
  return true;
}

export const layerIsOpen = () => layers.length > 0;

/** Toast：默认 5 秒后自动消失；传入 action 即为撤销入口。 */
export function toast(message, { kind = 'ok', action, onAction, duration = 5000 } = {}) {
  const root = byId('toast-root');
  if (!root) return () => {};
  let timer = 0;
  const dismiss = () => {
    globalThis.clearTimeout(timer);
    node.remove();
  };
  const node = h('div.toast', {
    class: kind === 'error' ? 'error' : kind === 'ok' ? 'ok' : '',
    role: kind === 'error' ? 'alert' : 'status',
  },
    icon(kind === 'error' ? 'alert' : 'check'),
    h('span.truncate', { text: message }),
    action ? h('button', { type: 'button', text: action, onclick: () => { dismiss(); onAction?.(); } }) : null,
    kind === 'error' ? h('button.iconbtn', { type: 'button', 'aria-label': '关闭提示', onclick: dismiss }, icon('close')) : null,
  );
  root.appendChild(node);
  if (duration > 0) timer = globalThis.setTimeout(dismiss, duration);
  return dismiss;
}

export function skeleton(count = 3, height = 56) {
  return h('div.stack', {}, ...Array.from({ length: count }, (_, index) => h('div.skeleton', {
    style: { height: `${height}px`, opacity: String(Math.max(0.35, 1 - index * 0.18)) },
    'aria-hidden': 'true',
  })));
}

export function emptyState({ glyph = 'plus', title, hint = '', cta, onCta } = {}) {
  return h('div.empty',
    h('div.glyph', icon(glyph, title)),
    h('p', { text: title }),
    hint ? h('p.tiny.faint', { text: hint }) : null,
    cta ? h('button.btn.primary', { type: 'button', text: cta, onclick: onCta }) : null,
  );
}

export function errorState({ message = '数据服务暂时不可用', detail = '', onRetry, retryLabel = '重试' } = {}) {
  return h('div.empty', { role: 'alert' },
    h('div.glyph', icon('alert', '加载失败')),
    h('p', { text: message }),
    detail ? h('p.tiny.faint', { text: detail }) : null,
    onRetry ? h('button.btn.primary', { type: 'button', text: retryLabel, onclick: onRetry }) : null,
  );
}

export function panelHead({ eyebrow = '', title, actions = [] }) {
  return h('div.panel-head',
    h('div', h('span.eyebrow', { text: eyebrow }), h('h3', { text: title })),
    h('div.spacer'),
    ...actions,
  );
}

/** 左滑删除（移动端）：滑出右侧删除按钮，回调里负责 store 写入与撤销。 */
export function swipeDelete(el, { label = '删除', onDelete }) {
  // 桌面端有编辑/删除按钮，滑动手势只在触屏设备上启用，避免鼠标拖拽误触发。
  if (globalThis.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return () => {};
  el.classList.add('swipeable');
  const button = h('button.list-delete', {
    type: 'button', text: label,
    onclick: (event) => { event.stopPropagation(); reset(); onDelete(); },
  });
  el.appendChild(button);
  let startX = 0;
  let offset = 0;
  let dragging = false;
  const reset = () => { offset = 0; el.classList.remove('swiping'); };
  el.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button,input,select,a,textarea')) return;
    startX = event.clientX;
    dragging = true;
  });
  el.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    offset = Math.max(-96, Math.min(0, event.clientX - startX));
    el.classList.toggle('swiping', offset < -28);
  });
  const finish = () => { dragging = false; if (offset > -60) reset(); };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
  el.addEventListener('pointerleave', finish);
  return reset;
}

export function clearOverlays() {
  while (layers.length) layers[layers.length - 1].close({ submitted: false });
  const root = byId('toast-root');
  if (root) clear(root);
}
