const SVG_NS = 'http://www.w3.org/2000/svg';

function applyProps(node, props) {
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') {
      node.setAttribute('class', Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value));
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'style' && typeof value === 'object') {
      for (const [prop, raw] of Object.entries(value)) {
        if (raw === null || raw === undefined) continue;
        // --custom 只能走 setProperty：直接赋值在浏览器里会被静默忽略
        if (prop.startsWith('--')) node.style.setProperty(prop, String(raw));
        else node.style[prop] = String(raw);
      }
    } else if (key === 'dataset') {
      for (const [name, raw] of Object.entries(value)) {
        if (raw !== null && raw !== undefined) node.dataset[name] = String(raw);
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'html') {
      throw new Error('h() 不接受 html 属性，请使用 text');
    } else {
      // 属性名原样写出：HTML 会自己归一化大小写，而 SVG 的 viewBox 必须保留驼峰
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
}

function appendChild(node, child) {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) {
    for (const item of child) appendChild(node, item);
    return;
  }
  node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
}

/**
 * 建元素：h('div.panel', {onclick}, childA, childB)
 * 第二个参数不是纯对象时按子节点处理：h('div', h('span')) 也会正常渲染，
 * 否则漏写 {} 的调用会静默丢掉第一个子节点（界面上就是空白标题）。
 */
export function h(spec, props = {}, ...children) {
  const isProps = props !== null && typeof props === 'object' && !(props instanceof Node) && !Array.isArray(props);
  const init = isProps ? props : {};
  const kids = isProps ? children : [props, ...children];
  const [tag, ...classes] = String(spec).split('.');
  const [name, id] = tag.split('#');
  const node = document.createElement(name || 'div');
  if (id) node.id = id;
  const allProps = { ...init };
  if (classes.length) {
    allProps.class = [classes.join(' '), init.class ?? ''].filter(Boolean).join(' ');
  }
  applyProps(node, allProps);
  for (const child of kids) appendChild(node, child);
  return node;
}

export function svg(spec, props = {}, ...children) {
  const [tag, ...classes] = String(spec).split('.');
  const node = document.createElementNS(SVG_NS, tag);
  applyProps(node, classes.length ? { ...props, class: [classes.join(' '), props.class ?? ''].filter(Boolean).join(' ') } : props);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function frag(...children) {
  const node = document.createDocumentFragment();
  for (const child of children) appendChild(node, child);
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** 用新内容替换 parent 的子节点，并返回 parent 便于链式使用。 */
export function mount(parent, ...children) {
  clear(parent);
  for (const child of children) appendChild(parent, child);
  return parent;
}

export const byId = (id) => document.getElementById(id);

export function icon(name, label) {
  const paths = {
    home: 'M3 11 12 4l9 7M6 9.5V20h12V9.5',
    timetable: 'M4 6h16M4 12h16M4 18h16M8 3v18',
    tasks: 'M4 7h11M4 12h11M4 17h7M18 6l2 2-4 4-2-2',
    research: 'M9 3v6l-5 8a2 2 0 0 0 1.7 3h11.6A2 2 0 0 0 19 17l-5-8V3M8 3h8',
    workout: 'M5 8v8M19 8v8M3 10v4M21 10v4M5 12h14',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2',
    plus: 'M12 5v14M5 12h14',
    close: 'M6 6l12 12M18 6 6 18',
    chevLeft: 'M15 5l-7 7 7 7',
    chevRight: 'M9 5l7 7-7 7',
    chevDown: 'M5 9l7 7 7-7',
    check: 'M4 12l5 5L20 6',
    minus: 'M6 12h12',
    lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
    unlock: 'M7 11V8a5 5 0 0 1 9-3M5 11h14v10H5z',
    trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14',
    pencil: 'M4 20h4L20 8l-4-4L4 16z',
    download: 'M12 4v11M7 11l5 5 5-5M4 20h16',
    upload: 'M12 20V9M7 13l5-5 5 5M4 4h16',
    alert: 'M12 4l9 16H3zM12 10v5M12 18h.01',
    dots: 'M6 12h.01M12 12h.01M18 12h.01',
    grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
    arrowUp: 'M12 20V5M6 11l6-6 6 6',
    arrowDown: 'M12 4v15M6 13l6 6 6-6',
    refresh: 'M20 12a8 8 0 1 1-2.4-5.7M20 3.5V8h-4.5',
  };
  const element = svg('svg.icon', {
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': label ? undefined : 'true',
    ...(label ? { role: 'img', 'aria-label': label } : {}),
  });
  const path = svg('path', { d: paths[name] ?? paths.dots });
  element.appendChild(path);
  return element;
}
