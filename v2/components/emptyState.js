import { h } from '../lib/dom.js';

export function renderEmpty({ icon = '◇', text, actionText, onAction }) {
  return h(
    'div', { class: 'empty' },
    h('div', { class: 'empty-icon', 'aria-hidden': 'true' }, icon),
    h('p', { class: 'empty-text' }, text),
    actionText ? h('button', { class: 'btn primary', type: 'button', onclick: onAction }, actionText) : null,
  );
}

export function renderSkeleton(rows = 4) {
  return h(
    'div', { class: 'skeleton', 'aria-hidden': 'true' },
    ...Array.from({ length: rows }, (_, i) => h('div', { class: 'skeleton-row', style: `width:${90 - i * 12}%` })),
  );
}

export function renderError({ message = '数据读取失败', onRetry, retryLabel = '重试', onReset }) {
  return h(
    'div', { class: 'error-state' },
    h('div', { class: 'empty-icon', 'aria-hidden': 'true' }, '!'),
    h('p', { class: 'empty-text' }, message),
    h('div', { class: 'error-actions' },
      onRetry ? h('button', { class: 'btn', type: 'button', onclick: onRetry }, retryLabel) : null,
      onReset ? h('button', { class: 'btn danger', type: 'button', onclick: onReset }, '清空并重置') : null,
    ),
  );
}
