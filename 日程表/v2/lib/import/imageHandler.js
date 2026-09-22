// §5.7 图片通道编排：把浮层的一次〔解析〕点击变成"加载引擎→识别→网格重建"。
// 全部重依赖（OCR 引擎、语言包）都在首次调用时才 dynamic import——
// 初始包与文字通道用户完全无感；vendor 文件由 P7 的 SW 运行时缓存兜底离线。
export async function imageHandler(dataUrl, hooks = {}) {
  const { onProgress = () => {} } = hooks;
  onProgress('加载识别引擎…');
  const { recognizeImage } = await import('./ocr.js');
  onProgress('识别文字…');
  const words = await recognizeImage(dataUrl, onProgress);
  onProgress('还原课表网格…');
  const { itemsFromWords } = await import('./grid.js');
  return itemsFromWords(words);
}
