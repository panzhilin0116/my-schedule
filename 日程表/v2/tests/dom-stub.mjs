// 测试用的最小 DOM 实现：只覆盖本项目前端真正用到的那部分能力，
// 目的是让六个视图与浮层表单能在 node --test 里被真实渲染并断言文本，
// 而不是把渲染正确性完全交给人工点页面。不要在这里加与断言无关的特性。

class Node {
  constructor() {
    this.childNodes = [];
    this.parentNode = null;
  }

  get firstChild() { return this.childNodes[0] ?? null; }

  get children() { return this.childNodes.filter((node) => node instanceof Element); }

  appendChild(node) {
    if (node instanceof DocumentFragment) {
      for (const child of [...node.childNodes]) this.appendChild(child);
      return node;
    }
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  append(...nodes) { for (const node of nodes) this.appendChild(node); }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index < 0) throw new Error('removeChild: 不是子节点');
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  remove() { this.parentNode?.removeChild(this); }

  /** 浮层的 Tab 焦点陷阱要用它判断焦点是否还在层内。 */
  contains(node) {
    let current = node ?? null;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  get textContent() { return this.childNodes.map((node) => node.textContent).join(''); }

  set textContent(value) {
    this.childNodes = [];
    if (value !== '' && value !== null && value !== undefined) {
      this.appendChild(new Text(String(value)));
    }
  }
}

class Text extends Node {
  constructor(data) {
    super();
    this.data = String(data);
  }

  get textContent() { return this.data; }

  set textContent(value) { this.data = String(value); }
}

// 选择器只支持本项目用到的形式：逗号分组 + 后代组合 + tag/#id/.class/[attr]/[attr="v"]
function parseSimple(token) {
  const parts = { tag: null, id: null, classes: [], attrs: [] };
  // 伪类/伪元素（:not([disabled]) 等）不参与匹配：本项目的选择器只用它排除禁用态
  const clean = String(token).split(':')[0];
  const re = /([.#]?)([a-zA-Z0-9_-]+)|\[([a-zA-Z0-9_-]+)(?:([~^$*|]?=)"?([^\]"]*)"?)?\]/g;
  for (const match of clean.matchAll(re)) {
    if (match[3]) parts.attrs.push({ name: match[3], value: match[5] });
    else if (match[1] === '.') parts.classes.push(match[2]);
    else if (match[1] === '#') parts.id = match[2];
    else parts.tag = match[2].toLowerCase();
  }
  return parts;
}

function parseSelector(selector) {
  return String(selector).split(',').map((group) => group.trim().split(/\s+/).filter(Boolean).map(parseSimple));
}

class Element extends Node {
  constructor(tag, namespace = null) {
    super();
    this.localName = String(tag).toLowerCase();
    this.tagName = String(tag).toUpperCase();
    this.namespaceURI = namespace;
    this.attributes = new Map();
    // 桩里 style 就是普通对象；自定义属性（--x）浏览器只能走 setProperty，桩照做以便断言
    this.style = {
      setProperty(name, value) { this[name] = String(value); },
      removeProperty(name) { const old = this[name]; delete this[name]; return old ?? ''; },
      getPropertyValue(name) { return this[name] ?? ''; },
    };
    // dataset 在浏览器里就是 data-* 属性的视图：只存对象的话
    // "用 dataset 写、用 getAttribute 读"这类真实用法在桩里会静默失去联系
    this.dataset = makeDataset(this);
    this.listeners = new Map();
    this.id = '';
    this._value = undefined;
    this.checked = false;
    this.isContentEditable = false;
  }

  get className() { return this.attributes.get('class') ?? ''; }

  set className(value) { this.setAttribute('class', value); }

  // 这几个属性在浏览器里与标签双向反映，视图代码混用了两种写法，桩必须同样反映
  get hidden() { return this.hasAttribute('hidden'); }

  set hidden(value) { value ? this.setAttribute('hidden', '') : this.removeAttribute('hidden'); }

  get disabled() { return this.hasAttribute('disabled'); }

  set disabled(value) { value ? this.setAttribute('disabled', '') : this.removeAttribute('disabled'); }

  get value() { return this._value ?? this.getAttribute('value') ?? ''; }

  set value(input) { this._value = String(input); }

  get classList() {
    const self = this;
    const list = () => (self.className ? String(self.className).split(/\s+/).filter(Boolean) : []);
    const write = (items) => self.setAttribute('class', [...new Set(items)].join(' '));
    return {
      add: (...names) => write([...list(), ...names]),
      remove: (...names) => write(list().filter((item) => !names.includes(item))),
      contains: (name) => list().includes(name),
      toggle: (name, force) => {
        const has = list().includes(name);
        const on = force === undefined ? !has : Boolean(force);
        write(on ? [...new Set([...list(), name])] : list().filter((item) => item !== name));
        return on;
      },
    };
  }

  setAttribute(name, value) {
    // 浏览器只对 HTML 元素小写化属性名；SVG 的 viewBox 保留驼峰，桩必须一样，
    // 否则"属性名被改写成 kebab"这类真实缺陷在这里根本测不出来
    const key = this.namespaceURI ? String(name) : String(name).toLowerCase();
    if (key === 'id') this.id = String(value);
    this.attributes.set(key, String(value));
  }

  getAttribute(name) { return this.attributes.get(this.namespaceURI ? String(name) : String(name).toLowerCase()) ?? null; }

  hasAttribute(name) { return this.attributes.has(this.namespaceURI ? String(name) : String(name).toLowerCase()); }

  removeAttribute(name) { this.attributes.delete(this.namespaceURI ? String(name) : String(name).toLowerCase()); }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }

  /** 测试侧派发事件：只调用挂在该节点上的处理器，不做冒泡。 */
  fire(type, event = {}) {
    const detail = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...event };
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(detail);
    return detail;
  }

  focus() { document.activeElement = this; }

  blur() {}

  /**
   * 浏览器语义：禁用按钮不响应点击；type=submit 的按钮点击要连带触发
   * 它所关联表单的 submit（本项目把保存按钮放在 form 外面，靠 form 属性关联，
   * 少了这一段，界面点不动的缺陷在测试里根本暴露不出来）。
   */
  click() {
    this.fire('click');
    if (this.localName !== 'button' || this.disabled) return;
    if ((this.getAttribute('type') ?? 'submit').toLowerCase() !== 'submit') return;
    const formId = this.getAttribute('form');
    const owner = formId ? this.root()?.getElementById?.(formId) : this.closest('form');
    if (owner?.localName === 'form') owner.fire('submit');
  }

  /** 往上走到所在文档/片段，供按 id 关联表单。 */
  root() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node;
  }

  matches(token) { return matchParts(this, parseSimple(token)); }

  descendants() {
    const out = [];
    for (const child of this.children) {
      out.push(child, ...child.descendants());
    }
    return out;
  }

  querySelectorAll(selector) {
    const groups = parseSelector(selector);
    return this.descendants().filter((node) => groups.some((chain) => matchChain(node, chain)));
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }

  closest(selector) {
    const groups = parseSelector(selector);
    let node = this;
    while (node) {
      if (node.matches && groups.some((chain) => matchChain(node, [chain[chain.length - 1]]))) return node;
      node = node.parentNode;
    }
    return null;
  }

  get outerText() { return this.textContent; }

  toString() { return `<${this.localName}${this.id ? `#${this.id}` : ''}>`; }
}

function matchParts(node, parts) {
  if (!node || !node.classList) return false;
  if (parts.tag && parts.tag !== node.localName) return false;
  if (parts.id && node.id !== parts.id) return false;
  for (const name of parts.classes) if (!node.classList.contains(name)) return false;
  for (const attr of parts.attrs) {
    if (!node.hasAttribute(attr.name)) return false;
    if (attr.value !== undefined && node.getAttribute(attr.name) !== attr.value) return false;
  }
  return true;
}

function matchChain(node, chain) {
  if (!matchParts(node, chain[chain.length - 1])) return false;
  let current = node.parentNode;
  for (let index = chain.length - 2; index >= 0; index -= 1) {
    while (current && !matchParts(current, chain[index])) current = current.parentNode;
    if (!current) return false;
    current = current.parentNode;
  }
  return true;
}

class DocumentFragment extends Node {}

const camelToKebab = (name) => name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
const kebabToCamel = (name) => name.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());

/** dataset 与 data-* 属性互通：读写字首都按浏览器规则转换。 */
function makeDataset(el) {
  return new Proxy({}, {
    get(_, prop) {
      if (typeof prop !== 'string') return undefined;
      return el.getAttribute(`data-${camelToKebab(prop)}`) ?? undefined;
    },
    set(_, prop, value) {
      if (typeof prop === 'string') el.setAttribute(`data-${camelToKebab(prop)}`, String(value));
      return true;
    },
    has(_, prop) { return typeof prop === 'string' && el.hasAttribute(`data-${camelToKebab(prop)}`); },
    deleteProperty(_, prop) {
      if (typeof prop === 'string') el.removeAttribute(`data-${camelToKebab(prop)}`);
      return true;
    },
    ownKeys() {
      return [...el.attributes.keys()].filter((key) => key.startsWith('data-')).map((key) => kebabToCamel(key.slice(5)));
    },
    getOwnPropertyDescriptor(_, prop) {
      const key = `data-${camelToKebab(String(prop))}`;
      if (!el.hasAttribute(key)) return undefined;
      return { configurable: true, enumerable: true, value: el.getAttribute(key) };
    },
  });
}

class Document extends Node {
  constructor() {
    super();
    this.documentElement = new Element('html');
    this.body = new Element('body');
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
    this.activeElement = this.body;
    this.visibilityState = 'visible';
    this.listeners = new Map();
  }

  createElement(tag) { return new Element(tag); }

  createElementNS(namespace, tag) { return new Element(tag, namespace); }

  createTextNode(data) { return new Text(data); }

  createDocumentFragment() { return new DocumentFragment(); }

  getElementById(id) {
    if (this.documentElement.id === id) return this.documentElement;
    return this.documentElement.descendants().find((node) => node.id === id) ?? null;
  }

  querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); }

  querySelector(selector) { return this.documentElement.querySelector(selector); }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }

  fire(type, event = {}) {
    const detail = { type, target: this, preventDefault() {}, ...event };
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(detail);
    return detail;
  }
}

/** 把 DOM 装进全局；返回 document 供测试构造页面骨架。 */
export function installDom() {
  globalThis.Node = Node;
  globalThis.Element = Element;
  globalThis.HTMLElement = Element; // 视图里用 instanceof HTMLElement 排除输入框内的快捷键
  globalThis.Text = Text;
  globalThis.DocumentFragment = DocumentFragment;
  globalThis.document = new Document();
  return globalThis.document;
}

/** 复刻 index.html 的挂载点，让视图与浮层有地方落。 */
export function mountShell(doc = globalThis.document) {
  for (const id of ['rail', 'topbar', 'view', 'tabbar']) {
    const node = new Element('div');
    node.id = id;
    doc.body.appendChild(node);
  }
  for (const id of ['modal-root', 'toast-root']) {
    const node = new Element('div');
    node.id = id;
    node.className = id;
    doc.body.appendChild(node);
  }
  return doc;
}

export { Element, Text, DocumentFragment, Node };
