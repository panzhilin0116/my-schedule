// §5.7 P4 本机 OCR 装载器：Tesseract.js v6 与 chi_sim/eng 语言包全部来自
// vendor/tesseract/（首次用时才加载），识别在浏览器内存内完成，图片永不离开本机。
import { preprocessGray, planResize, grayToRgba } from './preprocess.js';

let workerPromise = null;
let activeLogger = null;

const vendorUrl = (rel) => new URL(`vendor/tesseract/${rel}`, document.baseURI).href;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('无法在本机找到识别引擎文件'));
    document.head.appendChild(s);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片读取失败，请换一张清晰的课表截图'));
    img.src = dataUrl;
  });
}

/** 进度口径统一：引擎加载/初始化 → 「加载识别引擎…」；识别 → 百分比。 */
function translateLog(m) {
  if (!activeLogger) return;
  const pct = Math.round((m.progress ?? 0) * 100);
  if (/recognizing/i.test(m.status ?? '')) activeLogger(`识别文字… ${pct}%`);
  else if (/language/i.test(m.status ?? '')) activeLogger(`加载字库（${m.status.includes('chi') ? '中文' : '英文'}）… ${pct}%`);
  else activeLogger(`加载识别引擎… ${pct}%`);
}

async function createOcrWorker() {
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    throw new Error('识别引擎需要浏览器环境');
  }
  if (!globalThis.Tesseract) await loadScript(vendorUrl('tesseract.min.js'));
  return globalThis.Tesseract.createWorker(['chi_sim', 'eng'], 1, {
    workerPath: vendorUrl('worker.min.js'),
    corePath: vendorUrl(''), // 目录：worker 自己拼 tesseract-core-simd-lstm.wasm.js
    langPath: vendorUrl('langs'),
    gzip: true,
    cacheMethod: 'none', // 语言包已在本地，不再写一份 IndexedDB 缓存
    output: { blocks: true, text: false }, // v6：要词级 bbox 必须显式开 blocks
    logger: translateLog,
  });
}

export function getOcrWorker(onProgress) {
  activeLogger = onProgress ?? null;
  if (!workerPromise) {
    workerPromise = createOcrWorker().catch((err) => {
      workerPromise = null; // 失败可重试（比如离线又没缓存时）
      throw err;
    });
  }
  return workerPromise;
}

/** dataUrl → 缩放+灰度+拉伸后的两份 canvas：正常版 + 反相版。
 *  教务课表的课程块是"彩色底 + 白字"，灰度后对比度趋同；反相一遍能救回白字，
 *  两遍结果按 IoU 合并（grid.mergeWordLists）。 */
export async function preprocessDataUrl(dataUrl) {
  const img = await loadImage(dataUrl);
  const { scale, width, height } = planResize(img.naturalWidth || img.width, img.naturalHeight || img.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, width, height);
  const id = ctx.getImageData(0, 0, width, height);
  const base = preprocessGray(id.data, width, height);
  const inverted = new Uint8Array(base.length);
  for (let i = 0; i < base.length; i += 1) inverted[i] = 255 - base[i];
  const normal = document.createElement('canvas');
  normal.width = width;
  normal.height = height;
  const nctx = normal.getContext('2d');
  const nid = nctx.createImageData(width, height);
  nid.data.set(grayToRgba(base, width, height));
  nctx.putImageData(nid, 0, 0);
  const dark = document.createElement('canvas');
  dark.width = width;
  dark.height = height;
  const dctx = dark.getContext('2d');
  const did = dctx.createImageData(width, height);
  did.data.set(grayToRgba(inverted, width, height));
  dctx.putImageData(did, 0, 0);
  return { canvas: normal, inverted: dark, width, height, scale };
}

function flattenWords(data) {
  if (Array.isArray(data.words) && data.words.length) return data.words;
  const out = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const w of line.words ?? []) out.push(w);
      }
    }
  }
  return out;
}

/** @returns {Promise<{words:Array,width:number,height:number,confidence:number}>} 坐标为预处理后图像坐标系 */
export async function recognizeImage(dataUrl, onProgress) {
  const worker = await getOcrWorker(onProgress);
  const { canvas, inverted, width, height } = await preprocessDataUrl(dataUrl);
  onProgress?.('识别文字… 0%');
  // v6 坑：output 配置必须在 recognize 第三参传，createWorker 里的不生效
  const { data: a } = await worker.recognize(canvas, {}, { blocks: true });
  onProgress?.('识别文字… 50%');
  const { data: b } = await worker.recognize(inverted, {}, { blocks: true });
  const { mergeWordLists } = await import('./grid.js');
  const words = mergeWordLists(flattenWords(a), flattenWords(b));
  return { words, width, height, confidence: Math.max(a.confidence ?? 0, b.confidence ?? 0) };
}
