import type { Doc } from './doc';
import type { Renderer } from './render';
import type { Player } from './player';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

export interface ExportHooks {
  onProgress?: (ratio: number, label: string) => void;
}

export interface ExportOpts {
  /** 目标输出宽度（px）。缺省：画布宽 > 1200 时取半分辨率 */
  outW?: number;
}

function outScale(doc: Doc, opts: ExportOpts): number {
  if (opts.outW && opts.outW > 0) return Math.min(1, opts.outW / doc.canvas.w);
  return doc.canvas.w > 1200 ? 0.5 : 1;
}

/* MP4 排在最前，这是有意的：MediaRecorder 录出的 WebM **不写 Duration 元素**，
   于是播放器/剪辑软件看到的是 0:00（用户报的"视频只有 0 秒"就是这个）。
   MP4 分支实测能正确带出时长（4.197s / 素材 4.2s），而且剪映/抖音只吃 MP4。
   WebM 保留为兜底，并在落盘前用 patchWebmDuration() 补一个 Duration。 */
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

function pickMime(preferred?: string): string {
  if (preferred && typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(preferred)) return preferred;
  for (const m of MIME_CANDIDATES) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  }
  throw new Error('当前浏览器不支持 MediaRecorder 视频录制，请改用 PNG 序列导出');
}

/* ---------- WebM 时长补丁 ---------- */

function readVint(b: Uint8Array, at: number): { len: number; val: number } {
  const first = b[at];
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && !(first & mask)) { mask >>= 1; len++; }
  let val = first & (mask - 1);
  for (let k = 1; k < len; k++) val = val * 256 + b[at + k];
  return { len, val };
}

function writeVint(len: number, val: number): Uint8Array {
  const out = new Uint8Array(len);
  let v = val;
  for (let k = len - 1; k >= 0; k--) { out[k] = v & 0xff; v = Math.floor(v / 256); }
  out[0] |= 0x80 >> (len - 1);
  return out;
}

function indexOfSeq(hay: Uint8Array, seq: number[], from = 0, to = hay.length): number {
  outer:
  for (let i = from; i + seq.length <= to; i++) {
    for (let j = 0; j < seq.length; j++) if (hay[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * 给 MediaRecorder 录出的 WebM 补一个 Duration 元素（0x4489）。
 *
 * 为什么必须补：MediaRecorder 输出的是"实时流"，Segment > Info 里没有 Duration。
 * 播放器只能靠扫集群去猜，Windows 资源管理器/手机相册/剪映多半直接显示 0:00。
 *
 * 单位坑：EBML 的 Duration 不是秒，而是 **TimestampScale 的倍数**（默认 1ms）。
 * 第一次按秒写进去，结果是 0.004s —— 差了 1000 倍。这里按 Info 里真实的
 * TimestampScale 换算，缺省才用 1e6（=1ms）。
 *
 * 已有 Duration 时原样返回（幂等）。找不到 Info 也原样返回，绝不破坏原文件。
 */
export function patchWebmDuration(bytes: Uint8Array, durationMs: number): Uint8Array {
  // 不靠"文件够不够大"这种启发式判据来拦：真正的保护是下面的边界检查。
  if (!(durationMs > 0) || bytes.length < 12) return bytes;
  const infoAt = indexOfSeq(bytes, [0x15, 0x49, 0xA9, 0x66], 0, Math.min(bytes.length, 8192));
  if (infoAt < 0) return bytes;

  const sz = readVint(bytes, infoAt + 4);
  const pStart = infoAt + 4 + sz.len;
  const pEnd = pStart + sz.val;
  if (pEnd > bytes.length) return bytes;
  if (indexOfSeq(bytes, [0x44, 0x89], pStart, pEnd) >= 0) return bytes;   // 已有，幂等

  // 读 TimestampScale（0x2AD7B1）：3 字节 ID + vint size + uint 值
  let scale = 1_000_000;
  const tsAt = indexOfSeq(bytes, [0x2A, 0xD7, 0xB1], pStart, pEnd);
  if (tsAt >= 0) {
    const tsSize = readVint(bytes, tsAt + 3);
    let v = 0;
    for (let k = 0; k < tsSize.val; k++) v = v * 256 + bytes[tsAt + 3 + tsSize.len + k];
    if (v > 0) scale = v;
  }

  const dur = new Uint8Array(11);
  dur[0] = 0x44; dur[1] = 0x89; dur[2] = 0x88;                          // ID + size=8
  new DataView(dur.buffer).setFloat64(3, (durationMs * 1_000_000) / scale);

  const newLen = sz.val + 11;
  let nl = 1;
  while (nl < 8 && newLen > Math.pow(2, 7 * nl) - 1) nl++;               // 用能装下的最短 vint
  const sizeBytes = writeVint(nl, newLen);

  const out = new Uint8Array(bytes.length + 11 + (nl - sz.len));
  out.set(bytes.subarray(0, infoAt + 4), 0);
  out.set(sizeBytes, infoAt + 4);
  out.set(bytes.subarray(pStart, pEnd), infoAt + 4 + nl);
  out.set(dur, infoAt + 4 + nl + sz.val);
  out.set(bytes.subarray(pEnd), infoAt + 4 + nl + sz.val + 11);
  return out;
}

/** 落盘前的最后一步：webm 补时长，mp4 原样 */
async function finalizeVideo(chunks: Blob[], mime: string, durationMs: number): Promise<Blob> {
  const blob = new Blob(chunks, { type: mime });
  if (!mime.includes('webm')) return blob;
  try {
    const raw = new Uint8Array(await blob.arrayBuffer());
    const fixed = patchWebmDuration(raw, durationMs);
    // TS 5.7 的 Uint8Array 泛型与 BlobPart 有摩擦，运行时是普通 ArrayBuffer 视图
    return fixed === raw ? blob : new Blob([fixed as unknown as BlobPart], { type: mime });
  } catch {
    return blob;   // 补丁失败就别把文件搞坏
  }
}

/**
 * 工程文件：doc 本身就是纯 JSON，导出即序列化。
 * 用途有两个：换设备继续编辑；作为 localStorage 超配额时的逃生通道。
 */
export function exportProject(doc: Doc, appVersion = ''): void {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const kind = doc.mode === 'cover' ? 'cover' : 'poster';
  const payload = {
    app: 'poster-studio',
    kind: 'project',
    appVersion,
    exportedAt: d.toISOString(),
    doc,
  };
  // 不缩进：工程文件是给机器读的，缩进只会让文件名里的体积看着吓人
  download(new Blob([JSON.stringify(payload)], { type: 'application/json' }), `动态${kind === 'cover' ? '封面' : '海报'}-${stamp}.json`);
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

/**
 * 导出期间把渲染分辨率强制拉回 1:1。
 *
 * 预览可能按 732px 渲染（见 Renderer.setRenderScale）；导出若沿用那个分辨率，
 * 1080 档就是从 732 放大 —— 尺寸对、画质静默变糊，属于"看不出来但已经坏了"。
 * 所以所有导出路径都必须包这一层，且用 finally 还原。
 */
async function atFullResolution<T>(renderer: Renderer, run: () => Promise<T>): Promise<T> {
  const prev = renderer.renderScaleValue;
  const changed = renderer.setRenderScale(1);
  try {
    return await run();
  } finally {
    if (changed) renderer.setRenderScale(prev);
  }
}

/** WebM/MP4：逐帧推流录制（MediaRecorder + captureStream(0)）
 *
 *  与"实时播放一遍"的区别：
 *  - 帧数与时长由代码决定（frameCount = duration × fps），不看机器快慢；
 *  - 每帧渲染完主动 requestFrame，渲染耗时用累加器补偿：某帧慢不会导致丢帧或时长变形；
 *  - 后台标签页里浏览器不绘制 canvas，captureStream 拿不到画面 —— 这种情况直接报错，
 *    而不是录出一个静止或半截的文件却显示"导出成功"。
 *
 *  已知限制：MediaRecorder 按墙上时间打时间戳，所以录制节奏仍是实时的。
 *  真正的离线编码（不受前台限制、可超实时）需要 WebCodecs 的 VideoEncoder 加封装器，那是另一件事。
 */
export interface VideoOpts {
  /** 目标帧率，默认 30（12..60） */
  fps?: number;
  /** 码率，默认 12Mbps */
  bitrate?: number;
  /** 强制容器/编码（如 'video/webm;codecs=vp9'）。缺省按 MP4 → WebM 的优先级自动挑 */
  mime?: string;
}

export async function exportVideo(renderer: Renderer, doc: Doc, player: Player,
  hooks: ExportHooks = {}, opts: VideoOpts = {}) {
  // 录制要抓 canvas，必须是 1:1
  return atFullResolution(renderer, () => exportVideoImpl(renderer, doc, player, hooks, opts));
}

async function exportVideoImpl(renderer: Renderer, doc: Doc, player: Player,
  hooks: ExportHooks = {}, opts: VideoOpts = {}) {
  await renderer.whenImagesReady(doc);
  if (typeof document !== 'undefined' && document.hidden) {
    throw new Error('录制需要窗口在前台：后台标签页里浏览器不绘制画布，录出来会是静止画面');
  }
  const canvas = renderer.canvas;
  const mime = pickMime(opts.mime);
  const fps = Math.max(12, Math.min(60, Math.round(opts.fps || 30)));
  const frameCount = Math.max(2, Math.round(doc.duration / 1000 * fps));
  const bitrate = opts.bitrate || 12_000_000;

  /* captureStream(0)：浏览器不再自动取帧，全部由 requestFrame 推动。
     这样"录到的帧数"必然等于"我们渲染的帧数"，不会因为主线程忙就少几帧。
     老浏览器没有 requestFrame 时退回按 fps 自动取帧。 */
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
  const canPush = !!track && typeof track.requestFrame === 'function';
  if (!canPush) {
    stream.getTracks().forEach(t => t.stop());
    return exportVideoRealtime(renderer, doc, player, hooks, { fps, bitrate, mime });
  }

  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
  const chunks: Blob[] = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise<void>(res => { rec.onstop = () => res(); });

  hooks.onProgress?.(0, '启动录制');
  player.pause();
  rec.start(120);

  const step = 1000 / fps;
  const t0 = performance.now();
  for (let i = 0; i < frameCount; i++) {
    renderer.renderAt((i / frameCount) * doc.duration);   // 采样 [0, duration)，循环点不重复
    track!.requestFrame();
    hooks.onProgress?.(i / frameCount, `录制 ${i + 1}/${frameCount}（${fps}fps）`);
    // 累加器补偿：目标是"第 i 帧出现在 (i+1)*step"，渲染花掉的时间从等待里扣掉
    const wait = t0 + (i + 1) * step - performance.now();
    if (wait > 0) await sleep(wait);
  }
  await sleep(Math.max(60, step));   // 让编码器吃完最后一帧再停
  rec.stop();
  await stopped;
  stream.getTracks().forEach(t => t.stop());

  hooks.onProgress?.(1, '封装文件');
  const ext = mime.includes('mp4') ? 'mp4' : 'webm';
  download(await finalizeVideo(chunks, mime, doc.duration), `动态海报.${ext}`);
}

/** 兜底：没有 requestFrame 的浏览器，退回按帧率自动取帧的实时录制 */
async function exportVideoRealtime(renderer: Renderer, doc: Doc, player: Player,
  hooks: ExportHooks, cfg: { fps: number; bitrate: number; mime: string }) {
  const canvas = renderer.canvas;
  const stream = canvas.captureStream(cfg.fps);
  const rec = new MediaRecorder(stream, { mimeType: cfg.mime, videoBitsPerSecond: cfg.bitrate });
  const chunks: Blob[] = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise<void>(res => { rec.onstop = () => res(); });

  hooks.onProgress?.(0, '启动录制（兼容模式）');
  player.seek(0);
  renderer.renderAt(0);
  rec.start(120);
  player.play();
  const t0 = performance.now();
  while (performance.now() - t0 < doc.duration + 260) {
    hooks.onProgress?.(Math.min(0.95, (performance.now() - t0) / (doc.duration + 260)), '实时录制中');
    await sleep(100);
  }
  player.pause();
  rec.stop();
  await stopped;
  stream.getTracks().forEach(t => t.stop());
  hooks.onProgress?.(1, '封装文件');
  const ext = cfg.mime.includes('mp4') ? 'mp4' : 'webm';
  download(await finalizeVideo(chunks, cfg.mime, doc.duration), `动态海报.${ext}`);
}

/** GIF：逐帧离屏渲染 + gifenc 量化编码（12fps，默认半分辨率） */
export async function exportGif(renderer: Renderer, doc: Doc, hooks: ExportHooks = {}, opts: ExportOpts = {}) {
  return atFullResolution(renderer, () => exportGifImpl(renderer, doc, hooks, opts));
}

async function exportGifImpl(renderer: Renderer, doc: Doc, hooks: ExportHooks = {}, opts: ExportOpts = {}) {
  await renderer.whenImagesReady(doc);
  const scale = outScale(doc, opts);
  const w = Math.round(doc.canvas.w * scale);
  const h = Math.round(doc.canvas.h * scale);
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const octx = off.getContext('2d', { willReadFrequently: true })!;

  const fps = 12;
  const frameCount = Math.max(2, Math.round(doc.duration / 1000 * fps));
  const gif = GIFEncoder();
  const delay = Math.round(1000 / fps);

  for (let i = 0; i < frameCount; i++) {
    /* 采样区间必须是 [0, duration)，不是 [0, duration]。
       写成 i/(frameCount-1) 会让第 0 帧和最后一帧采到同一个状态（v0.8 起新动效都已
       按总时长整数周期对齐，两端必然相同），GIF 每循环一次就在接缝处多停一帧。 */
    const t = (i / frameCount) * doc.duration;
    renderer.renderAt(t);
    octx.drawImage(renderer.canvas, 0, 0, w, h);
    const { data } = octx.getImageData(0, 0, w, h);
    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);
    gif.writeFrame(index, w, h, { palette, delay });
    hooks.onProgress?.((i + 1) / frameCount, `GIF 编码 ${i + 1}/${frameCount}`);
    await sleep(0);
  }
  gif.finish();
  hooks.onProgress?.(1, '封装文件');
  download(new Blob([gif.bytes() as unknown as BlobPart], { type: 'image/gif' }), '动态海报.gif');
}

/** base64 dataURL → 二进制（用于同步取 PNG 字节） */
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** PNG 序列：15fps 采样打包 zip（半分辨率，任何浏览器可用；全尺寸留待 v0.5）
 *
 * 注意：这里刻意用同步的 toDataURL 而不是 toBlob。
 * Blink 的 canvas→Blob 走「空闲任务 + 1s 超时兜底」调度：只要主线程持续有任务
 * （导出循环每帧 await sleep(0) 就会持续有定时器任务），每个 blob 都要等满 1s 兜底，
 * 实测 63 帧耗时从 2s 膨胀到 150s+。toDataURL 同步编码实测 8ms/帧，稳定。
 */
export async function exportPngZip(renderer: Renderer, doc: Doc, hooks: ExportHooks = {}, opts: ExportOpts = {}) {
  return atFullResolution(renderer, () => exportPngZipImpl(renderer, doc, hooks, opts));
}

async function exportPngZipImpl(renderer: Renderer, doc: Doc, hooks: ExportHooks = {}, opts: ExportOpts = {}) {
  await renderer.whenImagesReady(doc);
  const scale = outScale(doc, opts);
  const w = Math.round(doc.canvas.w * scale);
  const h = Math.round(doc.canvas.h * scale);
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const octx = off.getContext('2d')!;

  const fps = 15;
  const frameCount = Math.max(2, Math.round(doc.duration / 1000 * fps));
  const files: { name: string; data: Uint8Array }[] = [];

  for (let i = 0; i < frameCount; i++) {
    /* 采样区间必须是 [0, duration)，不是 [0, duration]。
       写成 i/(frameCount-1) 会让第 0 帧和最后一帧采到同一个状态（v0.8 起新动效都已
       按总时长整数周期对齐，两端必然相同），GIF 每循环一次就在接缝处多停一帧。 */
    const t = (i / frameCount) * doc.duration;
    renderer.renderAt(t);
    octx.drawImage(renderer.canvas, 0, 0, w, h);
    files.push({
      name: `frame_${String(i).padStart(4, '0')}.png`,
      data: dataUrlToBytes(off.toDataURL('image/png')),
    });
    hooks.onProgress?.((i + 1) / frameCount, `采样 ${i + 1}/${frameCount}`);
    await sleep(0);
  }
  hooks.onProgress?.(1, '打包 ZIP');
  download(new Blob([makeZip(files) as unknown as BlobPart], { type: 'application/zip' }), '动态海报-序列帧.zip');
}

/* ---------- 最小 ZIP 写入器（store，不压缩） ---------- */

function crc32(buf: Uint8Array): number {
  let c: number;
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

export function makeZip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true);
    lh.setUint16(10, 0, true);
    lh.setUint16(12, 0x2100, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, f.data.length, true);
    lh.setUint32(22, f.data.length, true);
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);
    locals.push(new Uint8Array(lh.buffer), nameBytes, f.data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, 0, true);
    cd.setUint16(14, 0x2100, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, f.data.length, true);
    cd.setUint32(24, f.data.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint16(30, 0, true);
    cd.setUint16(32, 0, true);
    cd.setUint16(34, 0, true);
    cd.setUint16(36, 0, true);
    cd.setUint32(38, 0, true);
    cd.setUint32(42, offset, true);
    centrals.push(new Uint8Array(cd.buffer), nameBytes);

    offset += 30 + nameBytes.length + f.data.length;
  }

  const cdSize = centrals.reduce((a, c) => a + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  eocd.setUint16(20, 0, true);

  return concat([...locals, ...centrals, new Uint8Array(eocd.buffer)]);
}
