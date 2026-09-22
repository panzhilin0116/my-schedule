// §5.7 P4 本机 OCR 装载器：Tesseract.js v6 与 chi_sim/eng 语言包全部来自
// vendor/tesseract/（首次用时才加载），识别在浏览器内存内完成，图片永不离开本机。
import { preprocessGray, planResize, grayToRgba, invertGray, findColorBlocks, polarityToDarkText } from './preprocess.js';

let workerPromise = null;
let activeLogger = null;

const vendorUrl = (rel) => new URL(`vendor/tesseract/${rel}`, document.baseURI).href;

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`missing ${src}`));
    document.head.appendChild(s);
  });
}

async function loadScript(src) {
  const file = src.split('/').pop();
  try {
    await loadScriptOnce(src);
  } catch {
    try {
      // 一次自动重试：加查询串绕开某些浏览器/兼容壳对失败响应的负缓存
      await loadScriptOnce(`${src}?retry=1`);
    } catch {
      throw new Error(`本机缺少识别引擎文件「${file}」，请刷新页面重试；若仍失败，说明站点发布包缺件，可改用文字粘贴导入`);
    }
  }
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
    corePath: vendorUrl(''), // 目录：worker 按 SIMD 能力拼 tesseract-core[-simd]-lstm.wasm.js，两对都要在
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

/** dataUrl → 缩放+灰度+拉伸后的两份 canvas：正常版 + 反相版；
 *  并给出原色 ImageData 供彩底块检测（加强档）。
 *  教务课表的课程块是"彩色底 + 白字"，灰度后对比度趋同；反相一遍能救回白字，
 *  两遍结果按 IoU 合并（grid.mergeWordLists）；整图两遍仍糊的块由逐块识别补认。 */
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
  const normal = grayCanvas(base, width, height);
  const dark = grayCanvas(invertGray(base), width, height);
  return { canvas: normal, inverted: dark, color: id, width, height, scale };
}

function grayCanvas(gray, width, height) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(width, height);
  id.data.set(grayToRgba(gray, width, height));
  ctx.putImageData(id, 0, 0);
  return c;
}

/** 彩色块裁剪 → 放大到识字友好尺寸 → 灰度拉伸 + 极性修正（白字彩底 → 黑字白底）。 */
function blockToGrayCanvas(colorCanvas, width, height, rect) {
  const x0 = Math.max(0, Math.floor(rect.x0));
  const y0 = Math.max(0, Math.floor(rect.y0));
  const x1 = Math.min(width, Math.ceil(rect.x1));
  const y1 = Math.min(height, Math.ceil(rect.y1));
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (bw < 2 || bh < 2) return null;
  const crop = document.createElement('canvas');
  crop.width = bw;
  crop.height = bh;
  const cctx = crop.getContext('2d', { willReadFrequently: true });
  cctx.drawImage(colorCanvas, x0, y0, bw, bh, 0, 0, bw, bh);
  const target = Math.max(bw, bh);
  const fit = target < 240 ? Math.min(3, 240 / target) : 1; // 小块放大补清晰度，大块不动
  const w = Math.max(2, Math.round(bw * fit));
  const h = Math.max(2, Math.round(bh * fit));
  const up = document.createElement('canvas');
  up.width = w;
  up.height = h;
  const uctx = up.getContext('2d', { willReadFrequently: true });
  uctx.drawImage(crop, 0, 0, w, h);
  const uid = uctx.getImageData(0, 0, w, h);
  return grayCanvas(polarityToDarkText(preprocessGray(uid.data, w, h)), w, h);
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

const MAX_BLOCKS = 40;
const MAX_BLOCK_WORDS = 400;

/** @returns {Promise<{words:Array,width:number,height:number,confidence:number}>} 坐标为预处理后图像坐标系 */
export async function recognizeImage(dataUrl, onProgress) {
  const worker = await getOcrWorker(onProgress);
  const { canvas, inverted, color, width, height } = await preprocessDataUrl(dataUrl);
  onProgress?.('识别文字… 0%');
  // v6 坑：output 配置必须在 recognize 第三参传，createWorker 里的不生效
  const { data: a } = await worker.recognize(canvas, {}, { blocks: true });
  onProgress?.('识别文字… 40%');
  const { data: b } = await worker.recognize(inverted, {}, { blocks: true });
  const { mergeWordLists } = await import('./grid.js');
  let words = mergeWordLists(flattenWords(a), flattenWords(b));
  const wholeConfidence = Math.max(a.confidence ?? 0, b.confidence ?? 0);

  // 加强档：彩底白字块整图两遍仍易糊，逐块裁剪放大补认；块内结果优先并入
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = width;
  colorCanvas.height = height;
  colorCanvas.getContext('2d').putImageData(color, 0, 0);
  const blocks = findColorBlocks(color.data, width, height).slice(0, MAX_BLOCKS);
  if (blocks.length) {
    const blockWords = [];
    for (let i = 0; i < blocks.length && blockWords.length < MAX_BLOCK_WORDS; i += 1) {
      onProgress?.(`加强识别彩底课程块 ${i + 1}/${blocks.length}…`);
      const rect = blocks[i];
      const piece = blockToGrayCanvas(colorCanvas, width, height, rect);
      if (!piece) continue;
      try {
        const { data } = await worker.recognize(piece, {}, { blocks: true });
        for (const w of flattenWords(data)) {
          blockWords.push({
            ...w,
            bbox: {
              x0: rect.x0 + w.bbox.x0 / piece.width * (rect.x1 - rect.x0),
              y0: rect.y0 + w.bbox.y0 / piece.height * (rect.y1 - rect.y0),
              x1: rect.x0 + w.bbox.x1 / piece.width * (rect.x1 - rect.x0),
              y1: rect.y0 + w.bbox.y1 / piece.height * (rect.y1 - rect.y0),
            },
          });
        }
      } catch { /* 单块失败不否决整图结果 */ }
    }
    if (blockWords.length) words = mergeWordLists(blockWords, words);
  }
  return { words, width, height, confidence: wholeConfidence };
}
