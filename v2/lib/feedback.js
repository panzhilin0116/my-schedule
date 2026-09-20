import { h, qs } from './dom.js';

let current = null;

function escHandler(e) {
  if (e.key === 'Escape') closeOverlay();
}

export function closeOverlay() {
  if (!current) return;
  const { backdrop, panel, prevFocus } = current;
  current = null;
  document.removeEventListener('keydown', escHandler);
  backdrop.remove();
  panel.remove();
  try { prevFocus?.focus?.(); } catch { /* 桩环境无 focus */ }
}

export function overlayOpen() {
  return !!current;
}

export function openOverlay({ title, body }) {
  closeOverlay();
  const root = qs('#modal-root');
  const prevFocus = document.activeElement;

  const backdrop = h('div', { class: 'overlay-backdrop' });
  backdrop.addEventListener('click', closeOverlay);

  const panel = h(
    'div', { class: 'overlay-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'overlay-grab' }),
    h(
      'header', { class: 'overlay-head' },
      h('h2', { class: 'overlay-title' }, title),
      h('button', { class: 'overlay-x', type: 'button', 'aria-label': '关闭', onclick: closeOverlay }, '✕'),
    ),
    h('div', { class: 'overlay-body' }, body),
  );

  attachDrawerDrag(panel);

  root.appendChild(backdrop);
  root.appendChild(panel);
  document.addEventListener('keydown', escHandler);
  current = { backdrop, panel, prevFocus };
  panel.querySelector('.overlay-body input, .overlay-body button, .overlay-body select, .overlay-body textarea')?.focus?.();
  return panel;
}

function attachDrawerDrag(panel) {
  const grab = panel.querySelector('.overlay-grab');
  let startY = null;
  grab.addEventListener('pointerdown', (e) => { startY = e.clientY ?? e.y ?? 0; });
  grab.addEventListener('pointermove', (e) => {
    if (startY === null) return;
    const dy = (e.clientY ?? e.y ?? 0) - startY;
    panel.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
  });
  grab.addEventListener('pointerup', (e) => {
    if (startY === null) return;
    const dy = (e.clientY ?? e.y ?? 0) - startY;
    startY = null;
    panel.style.transform = '';
    if (dy > 80) closeOverlay();
  });
}

export function toast(message, { actionLabel, onAction, duration = 5000 } = {}) {
  const root = qs('#toast-root');
  let timer = null;
  function dismiss() {
    if (timer) clearTimeout(timer);
    node.remove();
  }
  const node = h(
    'div', { class: 'toast' },
    h('span', { class: 'toast-msg' }, message),
    actionLabel ? h('button', { class: 'toast-action', type: 'button', onclick: () => { dismiss(); onAction?.(); } }, actionLabel) : null,
  );
  root.appendChild(node);
  timer = setTimeout(dismiss, duration);
  return { dismiss, node };
}
