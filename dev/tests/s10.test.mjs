// S10 的静态口径：设计系统层面的无障碍与降级规则（减少动效、触控目标、键盘焦点可见）、
// 窄屏不产生横向溢出的结构保证、文案不留占位符、index.html 元信息与 PRD 品牌一致。
// 界面行为（空态、错误态、焦点管理）在 s10-render.test.mjs 里测。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { read } from './helpers.mjs';

const css = await read('../../web/styles.css');
const html = await read('../../web/index.html');

/** 大括号配平取出一个 @media 块的规则体，不引第三方解析器。 */
function mediaBlock(source, query) {
  const at = source.indexOf(query);
  assert.ok(at >= 0, `样式表里没有 ${query} 这段规则`);
  const open = source.indexOf('{', at);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}' && --depth === 0) return source.slice(open + 1, index);
  }
  throw new Error(`${query} 的括号没闭合`);
}

const sourceFiles = (() => {
  const walk = (dir) => readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]));
  return ['../../web'].flatMap((dir) => walk(dir));
})();

test('S10 减少动效：偏好里要求降级时动画与过渡都要压到 1ms，但不抹掉状态色', async () => {
  const block = mediaBlock(css, '@media (prefers-reduced-motion: reduce)');
  assert.match(block, /animation-duration:\s*1ms\s*!important/);
  assert.match(block, /transition-duration:\s*1ms\s*!important/);
  assert.match(block, /\*,\s*\*::before,\s*\*::after/, '降级要覆盖伪元素，不然::before 的过渡还在跑');
  // 关键：只是"快"，不是"没有反馈"——状态类规则不能写在动画里
  assert.equal(/@media \(prefers-reduced-motion[^)]*\)[\s\S]*?(opacity|transform):\s*none/.test(css), false,
    '减少动效不该顺手把透明度与位移当成冗余删掉');
});

test('S10 触控目标：粗指针设备一律放大到 44px，触屏没有的密集箭头交给拖拽', async () => {
  assert.match(css, /--tap:\s*44px/, '基准触控尺寸要就是 44px（PRD 2.4）');
  const block = mediaBlock(css, '@media (pointer: coarse)');
  for (const selector of ['.btn', '.iconbtn', '.chip', '.seg button', '.tri button', '.field input']) {
    assert.ok(block.includes(selector), `触屏放大规则漏了 ${selector}`);
  }
  assert.match(block, /\.iconbtn\s*\{\s*width:\s*var\(--tap\);\s*height:\s*var\(--tap\)/, '图标按钮要真的撑到 44×44');
  assert.match(block, /\.tick::before/, '勾选框视觉上小，靠伪元素撑开命中区');
  assert.match(block, /\.card-sort\s*\{\s*display:\s*none/, '触屏用长按拖拽排序，密集箭头不塞进卡片头');
  assert.ok(css.includes('min-height: var(--tap)'), '列表行与导航项用 --tap 做最小高度');
});

test('S10 键盘可见焦点：:focus-visible 给了轮廓，且只在键盘路径上出现', async () => {
  assert.match(css, /:focus-visible\s*\{\s*outline:/);
  // 只写 :focus 会让鼠标点击也带框，视觉噪声；两者并存时以 focus-visible 为准
  assert.equal(/button:focus\s*\{\s*outline/.test(css), false, '不该再用裸 :focus 给按钮画框');
});

test('S10 窄屏不横向溢出：栅格轨道一律 minmax(0,…) 或自适应，不留裸 1fr', async () => {
  const declared = [...css.matchAll(/grid-template-columns:([^;]+);/g)].map((match) => match[1].trim());
  assert.ok(declared.length >= 8, `只抓到 ${declared.length} 条栅格定义，断言等于空转`);
  const tracks = (value) => {
    const out = [];
    let depth = 0;
    let current = '';
    for (const ch of value) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) { out.push(current.trim()); current = ''; } else current += ch;
    }
    out.push(current.trim());
    return out.filter(Boolean);
  };
  const bareFr = (value) => tracks(value.replace(/\s*!important\s*/i, ''))
    .filter((track) => /^\d*\.?\d*fr$/.test(track));
  for (const value of declared) {
    if (/auto-fit|auto-fill/.test(value)) continue;
    const bad = bareFr(value);
    assert.deepEqual(bad, [], `栅格轨道 ${value} 用的是裸 ${bad[0]}：min-content 会把它顶宽，375px 下就出横向滚动`);
  }
  // 溢出恰恰是响应式覆盖引入的：桌面写了 minmax(0,1fr)，窄屏改回裸 1fr 等于把保护摘掉，
  // 而单轨道 `1fr` 就是 minmax(auto,1fr)，nowrap 的一行描述能把整条轨道顶到 500 多像素
  const media = [...css.matchAll(/@media[^{]+\{([\s\S]*?)\n\}/g)].map((match) => match[1]);
  assert.ok(media.length >= 2, '没抓到响应式区块，断言等于空转');
  let checked = 0;
  for (const block of media) {
    for (const rule of block.matchAll(/([^\n{}]+)\{[^}]*grid-template-columns:([^;]+);/g)) {
      checked += 1;
      const value = rule[2].trim();
      if (/auto-fit|auto-fill/.test(value)) continue;
      assert.equal(bareFr(value).length, 0,
        `窄屏规则 ${rule[1].trim()} 的 grid-template-columns: ${value} 没有 minmax(0,…)，单轨道也会被内容顶宽`);
    }
  }
  assert.ok(checked >= 4, `窄屏栅格覆盖只查到 ${checked} 条，断言等于空转`);
  // 左滑删除的按钮平时不占位，否则每行都溢出
  assert.match(css, /\.list-delete\s*\{[^}]*display:\s*none/);
  assert.match(css, /\.truncate\s*\{[^}]*min-width:\s*0/);
});

test('S10 文案里没有占位符与开发残留', async () => {
  const banned = /TODO|FIXME|XXX|lorem ipsum|待补充|未实现|敬请期待|临时文案/i;
  const hits = [];
  let scanned = 0;
  for (const file of sourceFiles) {
    if (!/\.(js|css|html)$/.test(file)) continue;
    scanned += 1;
    const text = await read(file);
    const line = text.split('\n').findIndex((row) => banned.test(row));
    if (line >= 0) hits.push(`${file}:${line + 1} → ${text.split('\n')[line].trim().slice(0, 60)}`);
  }
  assert.ok(scanned >= 14, `只扫了 ${scanned} 个文件，断言等于空转`);
  assert.deepEqual(hits, [], '发布前不该留下任何占位符');
});

test('S10 index.html：中文元信息、品牌与挂载点和外壳一致', async () => {
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /<title>[^<]*日程任务舱[^<]*<\/title>/);
  const description = /<meta name="description" content="([^"]+)"/.exec(html)?.[1] ?? '';
  for (const word of ['课程', '日程', '科研', '健身']) {
    assert.ok(description.includes(word), `描述里没有覆盖「${word}」这一块（PRD 1）`);
  }
  assert.match(html, /viewport-fit=cover/, '刘海屏要留安全区');
  assert.match(html, /<meta name="theme-color" content="#070B14">/, '状态栏颜色要和 --void 一致');
  const root = /--void:\s*([0-9A-Fa-f#]+)/.exec(css)?.[1] ?? '';
  assert.equal(root.toLowerCase(), '#070b14');
  for (const id of ['rail', 'topbar', 'view', 'tabbar', 'modal-root', 'toast-root']) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺了挂载点 #${id}`);
  }
  assert.match(html, /<script type="module"/);
  // 视图渲染前不留裸文字：文档主体只有骨架容器与脚本
  assert.equal(/>\s*( TBD|Loading|加载中)/.test(html), false);
});

test('S10 每个视图模块都能单独编译，且没有从 functions/ 反向取数', async () => {
  const { assertModuleParses } = await import('./helpers.mjs');
  const files = sourceFiles.filter((file) => file.endsWith('.js'));
  assert.ok(files.length >= 12, `只扫到 ${files.length} 个 js，断言等于空转`);
  for (const file of files) await assertModuleParses(fileURLToPath(new URL(file, import.meta.url)));
  for (const file of files) {
    const text = await read(file);
    assert.equal(/from '\.\.\/\.\.\/functions/.test(text), false, `${file} 直接引了后端目录`);
    assert.equal(/SUPABASE_/.test(text), false, `${file} 出现了数据库凭据字样（PRD 7.5：浏览器永不接触）`);
  }
});
