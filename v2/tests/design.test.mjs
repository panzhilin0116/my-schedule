// 视觉重构契约：深色液态玻璃的圆角、材质、过渡时长、配色饱和度，以及「不得出现气象元素」这条红线。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const V2 = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(V2, 'styles.css'), 'utf8');
const html = readFileSync(join(V2, 'index.html'), 'utf8');

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** 只按大括号配平切规则；@media / @supports 的头部记进 at，方便区分条件覆盖。 */
function parseRules(text) {
  const rules = [];
  const stack = [];
  let buf = '';
  for (const ch of stripComments(text)) {
    if (ch === '{') {
      stack.push(buf.trim());
      buf = '';
    } else if (ch === '}') {
      const head = stack.pop() ?? '';
      const body = buf.trim();
      buf = '';
      if (!head || head.startsWith('@')) continue;
      rules.push({
        at: stack.filter((h) => h.startsWith('@')).join(' '),
        selectors: head.split(',').map((s) => s.replace(/\s+/g, ' ').trim()),
        body,
      });
    } else {
      buf += ch;
    }
  }
  return rules;
}

const RULES = parseRules(css);
const ROOT_VARS = new Map(
  (RULES.find((r) => r.selectors.includes(':root'))?.body.match(/--[\w-]+\s*:[^;]+/g) ?? [])
    .map((d) => {
      const [name, ...rest] = d.split(':');
      return [name.trim(), rest.join(':').trim()];
    }),
);

function resolve(value, depth = 0) {
  if (!value || depth > 6 || !/--[\w-]+/.test(value)) return value ?? '';
  return resolve(value.replace(/var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)/g, (_, name) => ROOT_VARS.get(name) ?? ''), depth + 1);
}

function decl(selector, prop, atIncludes = '') {
  for (const r of RULES) {
    if (!r.selectors.includes(selector) || !r.at.includes(atIncludes)) continue;
    const m = r.body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
    if (m) return m[1].trim();
  }
  return null;
}

function sourceFiles(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'tests') sourceFiles(p, exts, out);
    } else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

function saturation(hex) {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const l = (max + min) / 2;
  return (max - min) / (l > 0.5 ? 2 - max - min : max + min);
}

test('圆角只有 12/16/20 三档：不允许再混进第三种弧度', () => {
  assert.equal(ROOT_VARS.get('--r-sm'), '12px');
  assert.equal(ROOT_VARS.get('--r'), '16px');
  assert.equal(ROOT_VARS.get('--r-lg'), '20px');

  const offenders = [];
  for (const r of RULES) {
    for (const d of r.body.match(/border-radius\s*:[^;]+/g) ?? []) {
      const value = d.split(':').slice(1).join(':').trim();
      if (/inherit|50%|var\(--r/.test(value)) continue; // 圆形标记与胶囊沿用 token，另算
      const px = [...value.matchAll(/(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
      for (const v of px) if (v !== 0 && (v < 12 || v > 20)) offenders.push(`${r.selectors[0]} → ${value}`);
      if (!px.length && value !== '0') offenders.push(`${r.selectors[0]} → ${value}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('玻璃面板：半透明填充 + 背景模糊 + 亮边 + 高光，缺一不可', () => {
  const panels = ['.hm-hero', '.hm-course', '.hm-task', '.tk-row', '.tt-grid', '.seg', '.tt-chip', '.toast', '.overlay-panel', '.rail'];
  const recipe = RULES.find((r) => panels.every((p) => r.selectors.includes(p)));
  assert.ok(recipe, '面板要共用同一份玻璃配方，而不是各写一套');

  const bg = resolve(recipe.body.match(/background(?:-color)?\s*:\s*([^;]+)/)[1]);
  const alpha = bg.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)/);
  assert.ok(alpha && Number(alpha[1]) < 0.35, `面板填充要够透：${bg}`);
  assert.match(resolve(recipe.body.match(/backdrop-filter\s*:\s*([^;]+)/)[1]), /blur\(\d+(\.\d+)?px/);
  assert.match(recipe.body, /border\s*:\s*1px solid/);
  assert.match(recipe.body, /box-shadow/);

  // 上表面高光：::before 铺在面板背后，且不能吃掉交互
  const sheen = RULES.find((r) => r.selectors.some((s) => s.endsWith('::before')) && r.body.includes('var(--sheen)'));
  assert.ok(sheen && /z-index:\s*-1/.test(sheen.body) && /pointer-events:\s*none/.test(sheen.body));

  for (const bar of ['.topbar', '.tabbar']) {
    assert.match(decl(bar, 'backdrop-filter') ? resolve(decl(bar, 'backdrop-filter')) : '', /blur\(/, `${bar} 没有背景模糊`);
  }
});

test('不支持背景模糊时退回实心面板，玻璃不能退化成透明', () => {
  const fallback = RULES.filter((r) => r.at.includes('@supports not'));
  assert.ok(fallback.length >= 2, '缺少 @supports not (backdrop-filter…) 降级块');
  assert.ok(fallback.some((r) => r.selectors.includes(':root') && /--glass-1/.test(r.body)), '玻璃 token 要有实心兜底');
  assert.ok(
    fallback.some((r) => r.selectors.includes('.topbar') && r.selectors.includes('.tabbar') && r.selectors.includes('.overlay-panel')),
    '贴边条与浮层要一起兜底，否则退化成半透明',
  );
  let opaque = 0;
  for (const r of fallback) {
    for (const m of r.body.matchAll(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)/g)) {
      assert.ok(Number(m[1]) >= 0.9, `${r.selectors.join(',')} 的兜底色仍然透明`);
      opaque += 1;
    }
  }
  assert.ok(opaque >= 4, '兜底块要同时覆盖玻璃 token 与贴边条');
});

test('交互过渡落在 200–400ms，且不用 transition: all', () => {
  const offenders = [];
  let checked = 0;
  for (const r of RULES) {
    for (const d of r.body.match(/transition\s*:[^;]+/g) ?? []) {
      const value = d.split(':').slice(1).join(':');
      assert.ok(!/\ball\b/.test(value), `${r.selectors[0]} 用了 transition: all`);
      for (const part of resolve(value).split(',')) {
        for (const [, n, unit] of part.matchAll(/(\d+(?:\.\d+)?)(ms|s)\b/g)) {
          const ms = unit === 's' ? Number(n) * 1000 : Number(n);
          checked += 1;
          if (ms < 200 || ms > 400) offenders.push(`${r.selectors[0]} → ${part.trim()}`);
        }
      }
    }
  }
  assert.ok(checked >= 20, `只找到 ${checked} 条过渡时长，样式表大概没接上`);
  assert.deepEqual(offenders, []);
});

test('强调色低饱和：不回到霓虹青/霓虹橙，字体走系统无衬线', () => {
  for (const c of ['#3DD6F5', '#FF8A3D', '#3dd6f5', '#ff8a3d']) {
    assert.ok(!css.includes(c) && !html.includes(c), `${c} 是 v1 的霓虹色`);
  }
  for (const token of ['--accent', '--warn', '--ok', '--danger']) {
    const hex = ROOT_VARS.get(token);
    assert.match(hex, /^#[0-9a-f]{6}$/i, `${token} 必须是六位十六进制`);
    const s = saturation(hex);
    assert.ok(s <= 0.68, `${token} ${hex} 饱和度 ${(s * 100).toFixed(0)}%，太抢内容`);
  }

  const sans = ROOT_VARS.get('--sans');
  assert.match(sans, /-apple-system,\s*BlinkMacSystemFont/);
  assert.match(sans, /system-ui/);
  assert.match(sans, /PingFang SC/);
  assert.match(sans, /Microsoft YaHei/);
  assert.ok(!/@import|@font-face|fonts\.googleapis/.test(css + html), '不加载网络字体');
});

test('红线：界面里没有任何气象元素', () => {
  const files = sourceFiles(V2, ['.js', '.css', '.html']);
  const words = /\b(starfield|star|stars|cloud|clouds|sun|sunny|moon|snow|rain|sky|weather|meteor)\b/i;
  const glyphs = /[☀☁☂☃☄⛅★☆☾☽❄]/;
  const cn = /天气|乌云|雨雪|星空|月亮|太阳/;
  const hits = [];
  for (const f of files) {
    const text = stripComments(readFileSync(f, 'utf8'));
    if (words.test(text) || glyphs.test(text) || cn.test(text)) hits.push(f.slice(V2.length + 1));
  }
  assert.deepEqual(hits, [], '只允许借鉴 macOS 的材质语言，界面内容不得出现气象元素');

  // 空态图标必须是中性符号，视图不能再各自覆写
  assert.match(readFileSync(join(V2, 'components', 'emptyState.js'), 'utf8'), /icon\s*=\s*'◇'/);
  for (const v of ['views/home.js', 'views/tasks.js', 'views/timetable.js']) {
    assert.ok(!/icon:\s*'/.test(readFileSync(join(V2, v), 'utf8')), `${v} 不该覆写空态图标`);
  }
});
