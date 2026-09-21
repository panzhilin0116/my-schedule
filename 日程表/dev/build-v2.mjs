// 把 v2 的纯前端源码拷成一份干净的公开产物：站点目录里只留要发给浏览器的文件，
// 测试与构建脚本不进包。用法：node dev/build-v2.mjs
import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(fileURLToPath(new URL('../v2', import.meta.url)));
const OUT = join(SRC, 'dist');
const SKIP = new Set(['dist', 'tests']);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let files = 0;
(function copy(dir, rel = '') {
  for (const name of readdirSync(dir)) {
    const from = join(dir, name);
    if (statSync(from).isDirectory()) {
      if (SKIP.has(name)) continue;
      copy(from, join(rel, name));
      continue;
    }
    if (!/\.(html|css|js|mjs|json|svg|png|ico|woff2?)$/.test(name)) continue;
    const to = join(OUT, rel, name);
    mkdirSync(join(to, '..'), { recursive: true });
    cpSync(from, to);
    files += 1;
  }
})(SRC);

console.log(`[build-v2] ${files} 个文件 → ${OUT}`);
