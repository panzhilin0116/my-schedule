// 本地预览服务器：静态服务 web/，并把同源 /functions/v1/app 转给**真实的** handler。
// 目的：让浏览器里的前端代码在本地就跑在真契约上，而不是另写一份 mock（dev/ 不进发布包）。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApp } from '../functions/handler.mjs';
import { createFakeSupabase } from './fake-supabase.mjs';
import { buildSeed } from './seed.mjs';

const ROOT = resolve(fileURLToPath(new URL('../web', import.meta.url)));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const db = createFakeSupabase(buildSeed());

function safePath(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const target = join(ROOT, clean);
  return target.startsWith(ROOT) ? target : null;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error('body_to_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function forward(incoming, outgoing, url) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value !== undefined) headers.append(name, value);
  }
  const body = incoming.method === 'GET' || incoming.method === 'HEAD' ? undefined : await readBody(incoming);
  const request = new Request(`http://${incoming.headers.host ?? '127.0.0.1'}${url}`, {
    method: incoming.method, headers, body: body?.length ? body : undefined,
  });
  const response = await handleApp({ request, supabase: db });
  const payload = Buffer.from(await response.arrayBuffer());
  outgoing.writeHead(response.status, { ...Object.fromEntries(response.headers), 'content-length': String(payload.length) });
  outgoing.end(payload);
}

export function createPreviewServer({ port = 4173 } = {}) {
  return createServer(async (incoming, outgoing) => {
    // 整段都要在 try 里：处理器抛错时如果不回响应，fetch 会一直等下去（浏览器端的
    // 表现就是"页面卡死 5 分钟"），比一个干脆的 500 难查得多。
    try {
      const url = new URL(incoming.url, 'http://127.0.0.1');
      if (url.pathname === '/functions/v1/app') {
        await forward(incoming, outgoing, incoming.url);
        return;
      }
      let target = safePath(url.pathname);
      if (!target) { outgoing.writeHead(400).end('bad path'); return; }
      let file = target;
      if (!extname(file)) file = join(file, 'index.html');
      const data = await readFile(file);
      outgoing.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'content-length': String(data.length),
      });
      outgoing.end(data);
    } catch (error) {
      if (outgoing.headersSent || outgoing.writableEnded) { outgoing.destroy(); return; }
      outgoing.writeHead(error?.code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain; charset=utf-8' });
      outgoing.end(error?.code === 'ENOENT' ? 'not found' : 'preview server error');
    }
  });
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) {
  const port = Number(process.argv[2] ?? 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`端口不合法：${process.argv[2]}`);
  createPreviewServer({ port }).listen(port, '127.0.0.1', () => {
    console.log(`本地预览（seed 已装载）： http://127.0.0.1:${port}/`);
    console.log('停止：Ctrl+C');
  });
}
