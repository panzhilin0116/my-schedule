// 视觉契约：新粗野主义（Neo-Brutalism）——硬边缘、粗边框、硬阴影、高饱和撞色、零圆角。
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

function parseRules(text) {
  const rules = [];
  const stack = [];
  let buf = '';
  const cleaned = stripComments(text).replace(/@import[^\n]+/g, '');
  for (const ch of cleaned) {
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

test('圆角：零圆角为主，token 只有 0px / 2px 两档', () => {
  assert.equal(ROOT_VARS.get('--r'), '0px');
  assert.equal(ROOT_VARS.get('--r-sm'), '2px');

  const offenders = [];
  for (const r of RULES) {
    for (const d of r.body.match(/border-radius\s*:[^;]+/g) ?? []) {
      const value = d.split(':').slice(1).join(':').trim();
      if (/var\(--r/.test(value)) continue;
      const px = [...value.matchAll(/(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
      for (const v of px) {
        if (v > 2) offenders.push(`${r.selectors[0]} → ${value}（${v}px 超过 2px）`);
      }
    }
  }
  assert.deepEqual(offenders, [], '新粗野主义不允许圆角超过 2px');
});

test('硬材质：粗边框 + 硬偏移阴影，禁止 backdrop-filter 与渐变背景', () => {
  const cleanCss = stripComments(css);
  assert.ok(!cleanCss.includes('backdrop-filter'), '新粗野主义禁止 backdrop-filter');

  const panels = ['.hm-hero', '.hm-course', '.hm-task', '.tk-row', '.tt-grid', '.seg', '.tt-chip', '.toast', '.overlay-panel'];
  const recipe = RULES.find((r) => panels.every((p) => r.selectors.includes(p)));
  assert.ok(recipe, '面板要共用同一份硬材质配方');
  assert.match(recipe.body, /border\s*:\s*var\(--border\)/, '面板用粗边框 token');
  assert.match(recipe.body, /box-shadow\s*:\s*var\(--shadow\)/, '面板用硬阴影 token');
  assert.match(resolve(recipe.body.match(/background(?:-color)?\s*:\s*([^;]+)/)[1]), /^#FFFFFF$|^var\(--surface\)$/, '面板白底实心');

  assert.match(ROOT_VARS.get('--border'), /3px solid/, '主边框 3px 实线');
  assert.match(ROOT_VARS.get('--shadow'), /\d+px \d+px 0/, '硬阴影零模糊');
});

test('强调色高饱和：撞色体系，不是低饱和灰调', () => {
  for (const token of ['--accent', '--pink', '--yellow', '--green']) {
    const hex = ROOT_VARS.get(token);
    assert.match(hex, /^#[0-9a-f]{6}$/i, `${token} 必须是六位十六进制`);
    const s = saturation(hex);
    assert.ok(s >= 0.55, `${token} ${hex} 饱和度 ${(s * 100).toFixed(0)}%，不够鲜艳`);
  }

  const sans = ROOT_VARS.get('--sans');
  assert.match(sans, /Space Grotesk/, '主字体 Space Grotesk');
  assert.match(sans, /PingFang SC/);
  assert.match(sans, /Microsoft YaHei/);
});

test('动效干脆：线性或阶梯过渡，时长 80–250ms，不用缓动曲线', () => {
  const offenders = [];
  let checked = 0;
  const easingCurves = /cubic-bezier|ease-in(?!-out)|ease-out(?!-in)|ease\b(?!-)/;

  for (const r of RULES) {
    for (const d of r.body.match(/transition\s*:[^;]+/g) ?? []) {
      const value = d.split(':').slice(1).join(':');
      assert.ok(!/\ball\b/.test(value), `${r.selectors[0]} 用了 transition: all`);
      for (const part of resolve(value).split(',')) {
        for (const [, n, unit] of part.matchAll(/(\d+(?:\.\d+)?)(ms|s)\b/g)) {
          const ms = unit === 's' ? Number(n) * 1000 : Number(n);
          checked += 1;
          if (ms < 80 || ms > 250) offenders.push(`${r.selectors[0]} → ${part.trim()}（${ms}ms 不在 80–250ms 区间）`);
        }
        if (easingCurves.test(part) && !/linear|steps/.test(part)) {
          offenders.push(`${r.selectors[0]} → ${part.trim()}（不允许缓动曲线）`);
        }
      }
    }
  }
  assert.ok(checked >= 15, `只找到 ${checked} 条过渡时长，样式表大概没接上`);
  assert.deepEqual(offenders, []);
});

test('浅色基底：color-scheme: light，波点背景图案', () => {
  assert.match(css, /color-scheme\s*:\s*light/, 'color-scheme 应为 light');
  assert.match(css, /radial-gradient\(circle.*0\.8px/, '背景要有波点图案');
  assert.match(css, /background-size:\s*24px 24px/, '波点间距 24px');
});

test('按压反馈：:active 位移 + 阴影归零', () => {
  const btnActive = RULES.find((r) => r.selectors.includes('.btn:active') || r.selectors.includes('.btn'));
  const hasActivePress = RULES.some((r) => {
    const sel = r.selectors.join(',');
    return sel.includes(':active') && r.body.includes('transform') && r.body.includes('box-shadow');
  });
  assert.ok(hasActivePress, '交互元素 :active 要有位移 + 阴影归零的按压感');
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
  assert.deepEqual(hits, [], '界面内容不得出现气象元素');

  assert.match(readFileSync(join(V2, 'components', 'emptyState.js'), 'utf8'), /icon\s*=\s*'◇'/);
  for (const v of ['views/home.js', 'views/tasks.js', 'views/timetable.js']) {
    assert.ok(!/icon:\s*'/.test(readFileSync(join(V2, v), 'utf8')), `${v} 不该覆写空态图标`);
  }
});

test('无障碍降级：prefers-reduced-motion 与 coarse pointer 命中区', () => {
  assert.ok(css.includes('prefers-reduced-motion'), '缺少动效降级');
  assert.ok(css.includes('pointer: coarse'), '缺少粗指针命中区放大');
});
