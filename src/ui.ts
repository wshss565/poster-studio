import type { Doc, TextLayer, BgLayer, ImageLayer, Layer, ImageFx, CoverFx, DocMode, CoverPreset, SubjectInfo } from './doc';
import {
  RATIOS, FONT_LABELS, EASING_LABELS, PRESET_LABELS, isText, isBg, isImage, isCover, coverLayer,
  uid, defaultFx, FX_RANGES, modeOf, applyDoc, emptyCoverDoc, defaultDoc,
  defaultCoverFx, coverFxForPreset, coverMatchPreset, COVER_PRESETS, COVER_PRESET_LABELS, COVER_RANGES,
  readProject,
} from './doc';
import type { Store } from './store';
import type { Renderer } from './render';
import type { Player } from './player';
import { TEXT_PRESETS, animSpan } from './anim';
import { IMAGE_PRESETS, IMAGE_PRESET_LABELS, fxForPreset, matchPreset } from './imagefx';
import { analyzeImage, analyzeWithRoi, TIER_ABILITY, ANALYZE_SIZE, maskToDataUrl, featuresFromMask, paintMaskStroke } from './analyze';
import type { Roi } from './analyze';
import { exportVideo, exportGif, exportPngZip, exportProject } from './exporter';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function layerLabel(l: TextLayer): string {
  const t = l.text.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 12) : '空文字';
}

function layerName(l: Layer): string {
  if (isBg(l)) return '背景渐变';
  if (isImage(l)) return l.name || '图片';
  return layerLabel(l);
}

function layerTag(l: Layer): string {
  return isBg(l) ? '背景' : isImage(l) ? '图片' : '文字';
}

/** 取图层的入场动效；图片图层没有 anim 字段，返回 null */
function animOf(l: Layer) {
  return (l as any).anim ?? null;
}

export function buildUI(store: Store, renderer: Renderer, player: Player) {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const canvas = $<HTMLCanvasElement>('poster');

  /* ---------- 自编辑计数：检查器只在外部变更时重建 ---------- */
  let selfEdits = 0;
  let lastSel: string | null = null; // 哨兵：保证首屏必然构建一次检查器
  let lastExtRev = store.revision;
  let timelineKey = '';

  /** 强制重建检查器：一键预设会批量改参数，不重建滑块数值就不会跟着走 */
  function invalidateInspector() { lastSel = '\u0000'; }

  function uiCommit(fn: (d: Doc) => void) { selfEdits++; store.commit(fn); }
  function uiPreview(fn: (d: Doc) => void) { store.preview(fn); }

  /** 连续输入控件：先存档再应用，保证一步撤销整个拖动/输入手势 */
  function bindArmedInput(input: HTMLElement, read: (i: HTMLElement) => any, apply: (d: Doc, v: any) => void) {
    let armed = true;
    input.addEventListener('input', () => {
      if (armed) { store.checkpoint(); armed = false; }
      uiPreview(d => apply(d, read(input)));
    });
    input.addEventListener('pointerdown', () => { armed = true; });
    input.addEventListener('keydown', () => { armed = true; });
    input.addEventListener('change', () => { armed = true; });
  }

  /* ---------- 画布适配 ---------- */
  function fitCanvas() {
    const stage = $('stage');
    const doc = store.state.doc;
    const aw = Math.max(80, stage.clientWidth - 64);
    const ah = Math.max(80, stage.clientHeight - 64);
    const r = doc.canvas.w / doc.canvas.h;
    let cw = aw;
    let ch = cw / r;
    if (ch > ah) { ch = ah; cw = ch * r; }
    canvas.style.width = Math.round(cw) + 'px';
    canvas.style.height = Math.round(ch) + 'px';
    syncOverlaySize();

    /* 预览按"显示尺寸 × DPR"渲染，而不是照着 doc 原始分辨率画完再让浏览器缩。
       1080 的画板缩到 732 显示时，这一步省掉 2.2 倍的像素。
       上限仍是 doc 原生分辨率（再高没有信息可加），DPR 也封顶 2（4K 屏上没必要）。 */
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const target = Math.min(doc.canvas.w, Math.round(cw * dpr));
    if (renderer.setRenderScale(target / doc.canvas.w)) {
      // 缩放变了必须补一帧：ResizeObserver 那条路径后面没有 renderAt
      renderer.renderAt(player.currentTime);
    }
  }

  /* ---------- 图层面板 ---------- */
  function renderLayers() {
    const list = $('layerList');
    list.innerHTML = '';
    const layers = store.state.doc.layers;
    const cover = isCover(store.state.doc);
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      const item = el('div', 'layer-item' + (l.id === store.state.selectedId ? ' sel' : ''));
      item.append(el('span', 'tag', cover && isImage(l) ? '封面' : layerTag(l)));
      item.append(el('span', 'name', layerName(l)));
      // 封面只有一张图，删掉就没有内容了：这里不给删除入口，换图走检查器
      if (!isBg(l) && !cover) {
        const del = el('button', 'del', '✕');
        del.title = '删除图层';
        del.addEventListener('click', ev => { ev.stopPropagation(); deleteLayer(l.id); });
        item.append(del);
      }
      item.addEventListener('click', () => store.select(l.id));
      list.append(item);
    }
    if (cover && !layers.length) list.append(el('div', 'hint', '还没有封面图，点左上「导入 / 换图」。'));
  }

  function deleteLayer(id: string) {
    if (store.state.doc.layers.filter(l => !isBg(l)).length <= 1) { toast('至少保留一个内容图层'); return; }
    uiCommit(d => { d.layers = d.layers.filter(l => l.id !== id); });
    if (store.state.selectedId === id) {
      const t = store.state.doc.layers.find(l => !isBg(l));
      store.select(t ? t.id : null);
    }
  }

  /* ---------- 检查器 ---------- */
  function fieldWrap(label: string, ...rows: HTMLElement[]) {
    const wrap = el('div', 'field');
    const lab = el('label');
    lab.textContent = label;
    wrap.append(lab, ...rows);
    return wrap;
  }

  function fieldRange(label: string, min: number, max: number, step: number, value: number,
    fmt: (v: number) => string, apply: (d: Doc, v: number) => void) {
    const input = el('input');
    input.type = 'range';
    input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value);
    const val = el('span', 'val', fmt(value));
    bindArmedInput(input, i => Number((i as HTMLInputElement).value), apply);
    return fieldWrap(label, objectRow(input, val));
  }

  function fieldNum(label: string, value: number, min: number, max: number, step: number,
    apply: (d: Doc, v: number) => void) {
    const input = el('input');
    input.type = 'number'; input.value = String(value); input.min = String(min); input.max = String(max); input.step = String(step);
    bindArmedInput(input, i => Number((i as HTMLInputElement).value) || 0, apply);
    return fieldWrap(label, objectRow(input));
  }

  function fieldSelect(label: string, options: { value: string; label: string }[], value: string,
    apply: (d: Doc, v: string) => void) {
    const sel = el('select');
    for (const o of options) {
      const opt = el('option', null, o.label);
      opt.value = o.value;
      if (o.value === value) opt.selected = true;
      sel.append(opt);
    }
    sel.addEventListener('change', () => uiCommit(d => apply(d, sel.value)));
    return fieldWrap(label, objectRow(sel));
  }

  function fieldColor(label: string, value: string, apply: (d: Doc, v: string) => void) {
    const input = el('input');
    input.type = 'color'; input.value = value;
    input.addEventListener('input', () => uiCommit(d => apply(d, input.value)));
    return fieldWrap(label, objectRow(input));
  }

  function fieldSeg(label: string, options: { value: string; label: string }[], value: string,
    apply: (d: Doc, v: string) => void) {
    const seg = el('div', 'seg');
    for (const o of options) {
      const b = el('button', o.value === value ? 'on' : null, o.label);
      b.type = 'button';
      b.addEventListener('click', () => {
        seg.querySelectorAll('button').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        uiCommit(d => apply(d, o.value));
      });
      seg.append(b);
    }
    return fieldWrap(label, seg);
  }

  function objectRow(...children: HTMLElement[]) {
    const row = el('div', 'row');
    row.append(...children);
    return row;
  }

  function group(title: string, ...fields: HTMLElement[]) {
    const g = el('div', 'group');
    g.append(el('div', 'group-title', title), ...fields);
    return g;
  }

  /* 默认折叠的低频组。状态放模块外，检查器每次重建都不会丢。 */
  const FOLDED = new Set<string>(['星尘', '频闪', '滤镜', '构图', '质感']);

  /**
   * 可折叠分组。
   *
   * 三个约束：
   *  1. 折叠箭头与「有改动」的蓝点用 **CSS 伪元素**画，不往标题里塞节点 ——
   *     否则 .group-title 的 textContent 会变成「星尘▾」，分组顺序断言会挂。
   *  2. 点标题只切 class，不重建检查器 —— 重建会把滚动位置清掉。
   *  3. 折叠组里只要有一个非默认值就点蓝点。否则用户套了预设「频闪」却看不到那个组，
   *     只会觉得"画面怎么自己在闪"。
   */
  function groupFold(title: string, dirty: boolean, ...fields: HTMLElement[]) {
    const open = !FOLDED.has(title);
    const g = el('div', 'group' + (open ? '' : ' collapsed'));
    const head = el('div', 'group-title fold' + (dirty ? ' dirty' : ''), title);
    head.addEventListener('click', () => {
      if (g.classList.toggle('collapsed')) FOLDED.add(title); else FOLDED.delete(title);
    });
    g.append(head, ...fields);
    return g;
  }

  /** 折叠组里有没有非默认值（默认值来自 defaultCoverFx，不是"非零"） */
  function coverDirty(keys: (keyof CoverFx)[]): boolean {
    const c = coverLayer(store.state.doc)?.cover;
    if (!c) return false;
    const d = defaultCoverFx();
    return keys.some(k => Math.abs((c[k] as number) - (d[k] as number)) > 0.001);
  }

  function withText(fn: (l: TextLayer, v: any) => void) {
    return (d: Doc, v: any) => {
      const l = d.layers.find(x => x.id === store.state.selectedId);
      if (l && isText(l)) fn(l, v);
    };
  }
  function withBg(fn: (l: BgLayer, v: any) => void) {
    return (d: Doc, v: any) => {
      const l = d.layers.find(x => x.id === store.state.selectedId);
      if (l && isBg(l)) fn(l, v);
    };
  }
  function withImage(fn: (l: ImageLayer, v: any) => void) {
    return (d: Doc, v: any) => {
      const l = d.layers.find(x => x.id === store.state.selectedId);
      if (l && isImage(l)) fn(l, v);
    };
  }
  /* 注意：**不要**在这里对 v 做 Number()。
     滑块给的是数字，而「形态」这类分段控件给的是字符串（'flat' / 'vinyl'）——
     一转就成 NaN，`v === 'vinyl'` 永远为假，"黑胶唱盘"根本切不过去。
     （这个 bug 是 tsc 查出来的：number 与 string 比较没有交集。） */
  function withFx(fn: (f: ImageFx, v: any) => void) {
    return withImage((l, v) => fn(l.fx, v));
  }

  /* ---------- 封面模式（v0.7） ---------- */

  /** 两个模式各留一份文档：来回切换不丢工作 */
  let posterCache: Doc | null = null;
  let coverCache: Doc | null = null;

  type Sens = 'low' | 'std' | 'high';
  let recogSens: Sens = 'std';                 // 只影响"下一次识别"，不写进文档
  let recogBusy = false;                       // 识别进行中（只影响状态卡文案）
  const SENS_BIAS: Record<Sens, number> = { low: 1.3, std: 1, high: 0.75 };
  const SENS_LABEL: Record<Sens, string> = { low: '保守', std: '标准', high: '激进' };

  function coverFxOf(l: ImageLayer): CoverFx { return l.cover ?? defaultCoverFx(); }
  function abilityOf(l: ImageLayer | null) { return TIER_ABILITY[l?.subject?.tier ?? 'fallback']; }
  /** 掩膜只能当"动效区域"（不是剪影）→ 不做景深分层，背景保持原样 */
  function isRegion(l: ImageLayer | null) { return l?.subject?.fit === 'region'; }

  function withCover(fn: (l: ImageLayer, v: any) => void) {
    return (d: Doc, v: any) => {
      const l = coverLayer(d);
      if (l) fn(l, v);
    };
  }
  /** 同 withFx：不要把 v 转成数字 —— 分段控件传的是字符串 */
  function withCf(fn: (f: CoverFx, v: any) => void) {
    return withCover((l, v) => {
      if (!l.cover) l.cover = defaultCoverFx();
      fn(l.cover, v);
    });
  }

  function decodeImage(src: string): Promise<HTMLImageElement> {
    return new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('图片解码失败'));
      i.src = src;
    });
  }

  /* --- 手动识别（v0.7.1）：框选 / 擦除 / 补回 --- */

  type CovTool = 'roi' | 'erase' | 'add';
  let covTool: CovTool | null = null;   // 当前画板工具（只影响交互，不写进文档）
  let brushPct = 6;                     // 笔刷直径占画板宽度的百分比
  /** 进行中的手势取消器：切工具 / 模式时把旧的手势收干净，避免监听残留 */
  let covCancel: (() => void) | null = null;

  const maskCv = document.createElement('canvas');
  const maskCtx = maskCv.getContext('2d')!;

  /** 掩膜 alpha 解码缓存：笔刷每笔都要拿上一版掩膜做底，重复解码太浪费 */
  const maskCache = new Map<string, Float32Array>();

  interface CovOverlay {
    root: HTMLElement; canvas: HTMLCanvasElement; box: HTMLElement; ctx: CanvasRenderingContext2D;
  }
  let covOv: CovOverlay | null = null;

  function ensureOverlay(): CovOverlay {
    if (covOv) return covOv;
    const root = el('div', 'cov-overlay hidden');
    root.id = 'covOverlay';
    const cv = document.createElement('canvas');
    cv.id = 'covMask';
    const box = el('div', 'cov-box');
    box.id = 'covBox';
    box.style.display = 'none';
    root.append(cv, box);
    (canvas.parentElement ?? $('stage')).append(root);
    covOv = { root, canvas: cv, box, ctx: cv.getContext('2d')! };
    return covOv;
  }

  /** 覆盖层严丝合缝贴在画板上（画板尺寸随窗口变，跟着同步） */
  function syncOverlaySize() {
    if (!covOv) return;
    const ov = covOv;
    const w = Math.max(1, Math.round(canvas.clientWidth));
    const h = Math.max(1, Math.round(canvas.clientHeight));
    ov.root.style.left = canvas.offsetLeft + 'px';
    ov.root.style.top = canvas.offsetTop + 'px';
    ov.root.style.width = w + 'px';
    ov.root.style.height = h + 'px';
    if (ov.canvas.width !== w) ov.canvas.width = w;
    if (ov.canvas.height !== h) ov.canvas.height = h;
  }

  function showRoiBox(roi: Roi | null) {
    const ov = ensureOverlay();
    syncOverlaySize();
    if (!roi) { ov.box.style.display = 'none'; return; }
    const w = ov.canvas.width, h = ov.canvas.height;
    ov.box.style.display = 'block';
    ov.box.style.left = Math.round(roi[0] * w) + 'px';
    ov.box.style.top = Math.round(roi[1] * h) + 'px';
    ov.box.style.width = Math.max(1, Math.round((roi[2] - roi[0]) * w)) + 'px';
    ov.box.style.height = Math.max(1, Math.round((roi[3] - roi[1]) * h)) + 'px';
  }

  /** 把掩膜按半透明青色画到画板上（笔刷时看得见自己在擦什么）
   *  画法：主体区青色高亮 + 非主体区压暗，一眼能看出「哪些像素算主体」 */
  function paintOverlayMask(
    alpha: Float32Array | null, mw = ANALYZE_SIZE, mh = ANALYZE_SIZE,
    cursor: { x: number; y: number } | null = null,
  ) {
    const ov = ensureOverlay();
    if (!covTool || covTool === 'roi' || !alpha) { ov.canvas.style.display = 'none'; return; }
    syncOverlaySize();
    if (maskCv.width !== mw || maskCv.height !== mh) { maskCv.width = mw; maskCv.height = mh; }
    const img = maskCtx.createImageData(mw, mh);
    const d = img.data;
    for (let p = 0; p < mw * mh; p++) {
      const i = p * 4;
      const a = alpha[p];
      if (a > 0.02) { d[i] = 54; d[i + 1] = 197; d[i + 2] = 255; d[i + 3] = Math.round(a * 112); }
      else { d[i] = 6; d[i + 1] = 10; d[i + 2] = 16; d[i + 3] = 78; }
    }
    maskCtx.putImageData(img, 0, 0);
    ov.canvas.style.display = 'block';
    ov.ctx.clearRect(0, 0, ov.canvas.width, ov.canvas.height);
    ov.ctx.imageSmoothingEnabled = true;
    ov.ctx.drawImage(maskCv, 0, 0, ov.canvas.width, ov.canvas.height);
    if (cursor) {
      const r = Math.max(2, (brushPct / 100) * ov.canvas.width / 2);
      ov.ctx.beginPath();
      ov.ctx.arc(cursor.x, cursor.y, r, 0, Math.PI * 2);
      ov.ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ov.ctx.lineWidth = 1.4;
      ov.ctx.stroke();
      ov.ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ov.ctx.lineWidth = 1;
      ov.ctx.beginPath();
      ov.ctx.arc(cursor.x, cursor.y, r + 1.2, 0, Math.PI * 2);
      ov.ctx.stroke();
    }
  }

  /** 挑工具 / 换工具时重画覆盖层 */
  function refreshCoverOverlay() {
    const layer = coverLayer(store.state.doc);
    if (!covTool || !layer) {
      if (covOv) {
        covOv.root.classList.add('hidden');
        covOv.canvas.style.display = 'none';
        covOv.box.style.display = 'none';
      }
      return;
    }
    ensureOverlay().root.classList.remove('hidden');
    if (covTool === 'roi') { showRoiBox(layer.subject?.roi ?? null); paintOverlayMask(null); return; }
    showRoiBox(null);
    const s = layer.subject;
    if (!s) { paintOverlayMask(null); return; }
    const mw = s.mw || ANALYZE_SIZE, mh = s.mh || ANALYZE_SIZE;
    void loadMaskAlpha(s).then(a => paintOverlayMask(a, mw, mh));
  }

  function setCovTool(t: CovTool | null) {
    if (covCancel) covCancel();      // 上一笔/上一框没结束就切工具：先收掉监听
    covTool = t;
    canvas.classList.toggle('cov-roi', t === 'roi');
    canvas.classList.toggle('cov-brush', t === 'erase' || t === 'add');
    invalidateInspector();
    renderInspector();
    syncChrome();
    refreshCoverOverlay();
    if (t === 'roi') toast('在画板上拖一个框：识别只在框内进行');
    else if (t === 'erase') toast('在画板上涂抹要排除的区域，松手生效');
    else if (t === 'add') toast('在画板上涂抹要补回的区域，松手生效');
  }

  /** 解码掩膜 dataURL → alpha（0..1） */
  async function loadMaskAlpha(s: SubjectInfo): Promise<Float32Array> {
    const hit = maskCache.get(s.maskUrl);
    if (hit) return new Float32Array(hit);
    const img = await decodeImage(s.maskUrl);
    const mw = s.mw || ANALYZE_SIZE, mh = s.mh || ANALYZE_SIZE;
    const c = document.createElement('canvas');
    c.width = mw; c.height = mh;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, mw, mh);
    const d = ctx.getImageData(0, 0, mw, mh).data;
    const a = new Float32Array(mw * mh);
    for (let p = 0; p < mw * mh; p++) a[p] = d[p * 4 + 3] / 255;
    if (maskCache.size > 12) {
      const oldest = maskCache.keys().next();
      if (!oldest.done) maskCache.delete(oldest.value);
    }
    maskCache.set(s.maskUrl, new Float32Array(a));
    return a;
  }

  /** 一笔涂完：重算几何特征、保留 seed（背景板缓存不白烘）、压一步撤销 */
  function commitPaintedMask(alpha: Float32Array, mw: number, mh: number) {
    const bin = new Uint8Array(mw * mh);
    let cnt = 0;
    for (let p = 0; p < bin.length; p++) { bin[p] = alpha[p] > 0.5 ? 1 : 0; if (bin[p]) cnt++; }
    if (cnt / bin.length < 0.002) {
      toast('掩膜被擦空了，按 Ctrl+Z 撤销这一笔');
      return;
    }
    const feats = featuresFromMask(bin, mw, mh);
    const url = maskToDataUrl(alpha, mw, mh);
    invalidateInspector();
    uiCommit(d => {
      const l = coverLayer(d);
      if (!l || !l.subject) return;
      const old = l.subject;
      // 注意力点跟着新掩膜筛一遍：擦掉的地方不该再脉冲
      const peaks = old.peaks.filter(k => {
        const px = Math.min(mw - 1, Math.max(0, Math.round(k.x * mw)));
        const py = Math.min(mh - 1, Math.max(0, Math.round(k.y * mh)));
        return alpha[py * mw + px] > 0.4;
      });
      l.subject = {
        ...old,
        maskUrl: url, mw, mh,
        bbox: feats.bbox, cx: feats.cx, cy: feats.cy,
        feet: feats.feet, neck: feats.neck,
        peaks,
        conf: Math.max(0.62, old.conf),
        tier: old.tier === 'precise' ? 'precise' : 'ok',
        manual: true,
        // 擦到只剩主体（面积不大）才恢复"剪影"语义、让景深分层生效；
        // 还盖着大半幅就继续按区域动效处理，避免又变成"一块清晰矩形"
        fit: feats.areaRatio > 0.6 ? 'region' : 'cut',
      };
    });
    paintOverlayMask(alpha, mw, mh);
    toast('掩膜已更新（Ctrl+Z 可撤销这一笔）');
  }

  /** 框选手势：拖出矩形 → 框内识别（框太小视为清除框选） */
  function startRoiGesture(ev: PointerEvent, rect: DOMRect) {
    const toNorm = (e: PointerEvent): [number, number] => [
      Math.min(1, Math.max(0, (e.clientX - rect.left) / Math.max(1, rect.width))),
      Math.min(1, Math.max(0, (e.clientY - rect.top) / Math.max(1, rect.height))),
    ];
    const p0 = toNorm(ev);
    let p1 = p0;
    const roiOf = (): Roi => [
      Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]),
      Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1]),
    ];
    showRoiBox(roiOf());
    try { canvas.setPointerCapture(ev.pointerId); } catch { /* 合成事件忽略 */ }
    canvas.classList.add('cov-gesturing');
    const move = (e: PointerEvent) => { p1 = toNorm(e); showRoiBox(roiOf()); };
    const detach = () => {
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
    };
    const up = () => {
      covCancel = null;
      detach();
      canvas.classList.remove('cov-gesturing');
      const roi = roiOf();
      if (roi[2] - roi[0] < 0.04 || roi[3] - roi[1] < 0.04) {
        showRoiBox(null);
        toast('框太小，按整图重新识别');
        void runAnalyze(null);
        return;
      }
      void runAnalyze(roi);
    };
    covCancel = () => { detach(); canvas.classList.remove('cov-gesturing'); showRoiBox(null); covCancel = null; };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
  }

  /** 笔刷手势：涂抹期间只改内存里的 alpha 并即时上屏，松手才落文档（一步撤销） */
  function startBrushGesture(ev: PointerEvent, rect: DOMRect, erase: boolean) {
    const layer = coverLayer(store.state.doc);
    const s = layer?.subject;
    if (!s) { toast('先识别出主体，再用笔刷精修'); return; }
    const mw = s.mw || ANALYZE_SIZE, mh = s.mh || ANALYZE_SIZE;
    const rPx = Math.max(1, (brushPct / 100) * mw / 2);
    const toMask = (e: PointerEvent): [number, number] => [
      ((e.clientX - rect.left) / Math.max(1, rect.width)) * mw,
      ((e.clientY - rect.top) / Math.max(1, rect.height)) * mh,
    ];
    const toCss = (e: PointerEvent) => ({
      x: e.clientX - rect.left, y: e.clientY - rect.top,
    });

    let alpha: Float32Array | null = null;
    const trail: Array<[number, number]> = [toMask(ev)];

    // 掩膜解码是异步的：先记轨迹，解码完一次性回放，不丢第一笔
    void loadMaskAlpha(s).then(a => {
      alpha = a;
      paintMaskStroke(a, mw, mh, trail, rPx, erase);
      paintOverlayMask(a, mw, mh, toCss(ev));
    });

    try { canvas.setPointerCapture(ev.pointerId); } catch { /* 合成事件忽略 */ }
    canvas.classList.add('cov-gesturing');
    const move = (e: PointerEvent) => {
      const p = toMask(e);
      trail.push(p);
      if (alpha) {
        paintMaskStroke(alpha, mw, mh, [trail[trail.length - 2] ?? p, p], rPx, erase);
        paintOverlayMask(alpha, mw, mh, toCss(e));
      }
    };
    const detach = () => {
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
    };
    const up = () => {
      covCancel = null;
      detach();
      canvas.classList.remove('cov-gesturing');
      const finish = () => {
        if (!alpha) return;
        commitPaintedMask(alpha, mw, mh);
      };
      if (alpha) finish();
      else void loadMaskAlpha(s).then(a => { alpha = a; paintMaskStroke(a, mw, mh, trail, rPx, erase); finish(); });
    };
    covCancel = () => { detach(); canvas.classList.remove('cov-gesturing'); covCancel = null; };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
  }

  /** 识别 / 重新识别当前封面主体。失败不阻断编辑，UI 会停在"未识别"。 */
  async function runAnalyze(roi: Roi | null, silent = false): Promise<boolean> {
    const layer = coverLayer(store.state.doc);
    if (!layer) return false;
    if (!silent) toast(roi ? '正在框内识别主体…' : '正在识别主体…');
    // 状态卡先切到"识别中"：uiCommit 自己会 emit 一帧，但那一刻检查器还拿着旧的
    // 哨兵值不会重建，所以这里必须手动刷一次（顺序错了就会一直显示"未识别"）。
    recogBusy = true;
    invalidateInspector();
    renderInspector();
    try {
      const img = await decodeImage(layer.src);
      const r = roi
        ? analyzeWithRoi(img, img.naturalWidth, img.naturalHeight, roi, SENS_BIAS[recogSens])
        : analyzeImage(img, img.naturalWidth, img.naturalHeight, ANALYZE_SIZE, SENS_BIAS[recogSens]);
      recogBusy = false;
      invalidateInspector();     // 必须在 commit 之前，才能在 emit 的那一帧重建
      uiCommit(d => { const l = coverLayer(d); if (l) l.subject = r.subject; });
      refreshCoverOverlay();
      const c = Math.round(r.subject.conf * 100);
      const rect = (r as { mode?: string }).mode === 'rect';
      const region = r.subject.fit === 'region';
      const touch = r.stats.touch;
      const touchMax = touch ? Math.max(touch.l, touch.r, touch.t, touch.b) : 0;
      toast(
        rect ? '框内没找到清晰边界，已按框生成「区域动效」：背景保持原样，可用笔刷擦出轮廓'
          : region ? `框内掩膜不够贴合剪影 → 已切「区域动效」（置信度 ${c}%）：背景不虚化，只有框内区域动${touchMax > 0.35 ? '；框有点紧，主体被切到了，往外松一点能更准' : ''}`
            : r.subject.tier === 'precise' ? `识别完成：精确（置信度 ${c}%）`
              : r.subject.tier === 'ok' ? `识别完成：可用（置信度 ${c}%），已隐藏轮廓流光`
                : '这张图主体不突出，已退化为整图动效（仍可导出）',
      );
      return true;
    } catch (e) {
      recogBusy = false;
      invalidateInspector();
      renderInspector();
      if (!silent) toast('识别失败：' + (e as Error).message);
      return false;
    }
  }

  /** 重新识别：有手动框就用框，否则整图 */
  async function reanalyze(silent = false): Promise<boolean> {
    return runAnalyze(coverLayer(store.state.doc)?.subject?.roi ?? null, silent);
  }

  function setMode(m: DocMode) {
    const doc = store.state.doc;
    if (modeOf(doc) === m) return;
    if (m === 'cover') {
      posterCache = doc;
      const next = coverCache ?? emptyCoverDoc();
      uiCommit(d => applyDoc(d, next));
    } else {
      coverCache = doc;
      const next = posterCache ?? defaultDoc();
      uiCommit(d => applyDoc(d, next));
    }
    invalidateInspector();
    covTool = null;
    canvas.classList.remove('cov-roi', 'cov-brush');
    refreshCoverOverlay();
    const first = store.state.doc.layers.find(l => !isBg(l));
    store.select(first ? first.id : null);
    player.seek(0);
  }

  /** 顶栏 / 舞台按模式切形态 */
  function syncChrome() {
    const doc = store.state.doc;
    const cover = isCover(doc);
    $('modeSeg').querySelectorAll('button').forEach(b => {
      b.classList.toggle('on', (b as HTMLElement).dataset.mode === (cover ? 'cover' : 'poster'));
    });
    $('ratioGroup').classList.toggle('hidden', cover);
    $('addTextBtn').classList.toggle('hidden', cover);
    $('addImageBtn').textContent = cover ? '导入 / 换图' : '+ 图片';
    $('resetBtn').title = cover ? '清空当前封面' : '恢复默认示例海报';
    $('stageHint').textContent = cover
      ? covTool === 'roi' ? '画板工具：拖出一个框，识别只在框内进行（拖太小 = 清除框选）'
        : covTool === 'erase' ? '画板工具：涂抹要排除的区域，松手生效（Ctrl+Z 撤销）'
          : covTool === 'add' ? '画板工具：涂抹要补回的区域，松手生效（Ctrl+Z 撤销）'
            : '空格播放 / 暂停 · 主体识别与动效参数在右侧'
      : '空格播放 / 暂停 · 拖拽画布中的文字调整位置';
    const empty = cover && !coverLayer(doc);
    $('stageEmpty').style.display = empty ? 'grid' : 'none';
  }

  function renderCoverInspector(box: HTMLElement, layer: ImageLayer | null) {
    if (!layer) {
      const b = el('button', 'btn primary wide', '选择封面图片');
      b.addEventListener('click', () => pickImage());
      box.append(group('开始做封面',
        el('div', 'rc-tip', '封面模式只认一张图：画板固定 1:1（1080×1080），图片铺满画板。导入后自动识别主体，动效只作用在主体上。'),
        b,
        el('div', 'hint', '也可以直接把图片拖到中间画板上。'),
      ));
      return;
    }

    const fx = coverFxOf(layer);
    const s = layer.subject;
    const ab = abilityOf(layer);
    const region = isRegion(layer);
    const preset = coverMatchPreset(fx);

    /* --- 识别状态卡 --- */
    const card = el('div', 'rc-card');
    const thumb = el('div', 'rc-thumb');
    if (s) {
      const im = new Image();
      im.src = s.maskUrl;
      im.alt = '主体掩膜';
      thumb.append(im);
    } else {
      thumb.append(el('span', 'rc-none', '未识别'));
    }
    const meta = el('div', 'rc-meta');
    const title = el('div', 'rc-title');
    title.append(el('span', null, '主体识别'));
    if (recogBusy) {
      title.append(el('span', 'badge mid', '识别中'));
      meta.append(title, el('div', 'rc-sub', '正在分析主体轮廓，稍候…'));
    } else if (s) {
      const cls = s.tier === 'precise' ? 'good' : s.tier === 'ok' ? 'mid' : 'poor';
      const txt = s.tier === 'precise' ? '精确' : s.tier === 'ok' ? '可用' : '降级';
      const pathTxt = s.path === 'uniform' ? '纯色底' : s.path === 'saliency' ? '复杂背景' : '—';
      title.append(el('span', 'badge ' + cls, txt));
      if (s.manual) title.append(el('span', 'badge manual', '手动'));
      if (s.fit === 'region') title.append(el('span', 'badge mid', '区域动效'));
      meta.append(title, el('div', 'rc-sub',
        `置信度 ${Math.round(s.conf * 100)}% · ${pathTxt}${s.roi ? ' · 框内' : ''} · ${s.source === 'remote' ? '云端' : '本地'} · ${s.peaks.length} 个注意力点`));
    } else {
      title.append(el('span', 'badge', '待识别'));
      meta.append(title, el('div', 'rc-sub', '点击下方「重新识别」分析主体'));
    }
    card.append(thumb, meta);

    const sensSeg = el('div', 'seg');
    (['low', 'std', 'high'] as Sens[]).forEach(k => {
      const b = el('button', k === recogSens ? 'on' : null, SENS_LABEL[k]);
      b.type = 'button';
      b.addEventListener('click', () => {
        recogSens = k;
        sensSeg.querySelectorAll('button').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
      });
      sensSeg.append(b);
    });

    const reBtn = el('button', 'btn wide', '重新识别');
    reBtn.addEventListener('click', () => { void reanalyze(); });
    const swapBtn = el('button', 'btn wide', '换一张图');
    swapBtn.addEventListener('click', () => pickImage(layer.id));

    box.append(group('识别', card, fieldWrap('灵敏度（下次识别生效）', sensSeg), reBtn, swapBtn));

    if (!ab.subject && !recogBusy) {
      box.append(el('div', 'rc-tip',
        '置信度不足：这张图的主体与背景区分度低，分层动效已自动退化为整图动效。可换成纯色底 / 白底图，或把灵敏度调到「激进」再试。'));
    }
    if (region && !recogBusy) {
      box.append(el('div', 'rc-tip',
        '当前是「区域动效」：掩膜不够贴合剪影（被框切断 / 框内背景被算进主体），所以背景不虚化、只有这块区域形变。想要景深分层，用「擦除」把多余背景擦掉即可。'));
    }

    /* --- 手动识别：框选 / 笔刷 --- */
    const toolSeg = el('div', 'seg');
    toolSeg.id = 'covToolSeg';
    const TOOL_LABEL: Record<CovTool, string> = { roi: '框选主体', erase: '擦除', add: '补回' };
    (['roi', 'erase', 'add'] as CovTool[]).forEach(k => {
      const b = el('button', covTool === k ? 'on' : null, TOOL_LABEL[k]);
      b.type = 'button';
      b.dataset.cov = k;
      b.addEventListener('click', () => setCovTool(covTool === k ? null : k));
      toolSeg.append(b);
    });

    const manualGroup = group('手动识别',
      el('div', 'rc-tip', '自动识别对纯色底最准；背景复杂时先用「框选主体」把范围缩小，还不对就用笔刷直接修掩膜。'),
      fieldWrap('画板工具', toolSeg),
    );
    if (covTool === 'erase' || covTool === 'add') {
      const input = el('input');
      input.type = 'range'; input.id = 'covBrush';
      input.min = '1'; input.max = '20'; input.step = '1'; input.value = String(brushPct);
      const val = el('span', 'val', brushPct + '%');
      input.addEventListener('input', () => {
        brushPct = Math.max(1, Math.min(20, Number(input.value) || 6));
        val.textContent = brushPct + '%';
        refreshCoverOverlay();
      });
      manualGroup.append(fieldWrap('笔刷大小', objectRow(input, val)));
    }
    if (s?.roi) {
      const b = el('button', 'btn wide', '清除框选并重识别');
      b.id = 'covClearRoi';
      b.addEventListener('click', () => { setCovTool(null); void runAnalyze(null); });
      manualGroup.append(b);
    }
    manualGroup.append(el('div', 'hint', s
      ? '笔刷一次涂抹算一步撤销；改完会自动重算包围盒 / 脚底 / 颈部。'
      : '先识别出主体，笔刷才可用。'));
    box.append(manualGroup);

    /* --- 预设 --- */
    box.append(group('动效预设',
      fieldSeg('预设', [
        ...COVER_PRESETS.map(p => ({ value: p, label: COVER_PRESET_LABELS[p] })),
        { value: 'custom', label: '自定义' },
      ], preset ?? 'custom', (d, v) => {
        if (v === 'custom') return;
        const l2 = coverLayer(d);
        if (l2) l2.cover = coverFxForPreset(v as CoverPreset);
        invalidateInspector();
      }),
      el('div', 'hint', preset ? '当前参数与「' + COVER_PRESET_LABELS[preset] + '」一致' : '当前为自定义参数'),
    ));

    /* --- 参数组（按档位门控） --- */
    function cr(label: string, key: keyof CoverFx, fmt: (v: number) => string, enabled: boolean, need = '需主体') {
      const [lo, hi] = COVER_RANGES[key];
      const f = fieldRange(label, lo, hi, 1, fx[key] as number, fmt, withCf((c, v) => { c[key] = v; }));
      if (!enabled) {
        f.classList.add('off');
        const lab = f.querySelector('label');
        if (lab) lab.textContent = label + '（' + need + '）';
      }
      return f;
    }

    box.append(group('运动',
      cr('速度', 'speed', v => (v / 100).toFixed(2) + '×', true, '可用'),
      cr('呼吸缩放', 'breathe', v => v + '%', true, '可用'),
      cr('漂浮', 'float', v => v + '%', ab.subject),
      cr('站立摇摆', 'sway', v => (v / 10).toFixed(1) + '°', ab.subject),
      cr('视差分层', 'parallax', v => v + '%', ab.subject && !region, '需剪影'),
      cr('点头', 'nod', v => (v / 10).toFixed(1) + '°', ab.subject && ab.local, '需精确识别'),
    ));

    box.append(group('高光',
      cr('轮廓流光', 'rim', v => v + '%', ab.rim, '需精确识别'),
      cr('注意力点脉冲', 'pulse', v => v + '%', ab.subject && s!.peaks.length > 0),
      cr('扫光', 'sweep', v => v + '%', true),
      cr('扫光宽度', 'sweepW', v => v + '%', true),
    ));

    box.append(group('镜头',
      cr('推镜', 'zoom', v => v + '%', true),
      cr('背景缓转', 'spin', v => (v / 100 * 2.5).toFixed(1) + '°', true),
      cr('节拍脉冲', 'beat', v => v + '%', true),
      cr('BPM', 'bpm', v => v + '', true),
      el('div', 'hint', '镜头作用于整幅（背景板与主体同一变换，不会把主体边缘拉开）。'
        + 'BPM 会吸附到总时长的整数拍，导出 GIF 才首尾相接。'),
    ));

    box.append(groupFold('星尘', coverDirty(['dust']),
      cr('密度', 'dust', v => v + '%', true),
      el('div', 'hint', '最多 56 颗，位置由固定伪随机推出：拖时间轴不会闪，导出可复现。'),
    ));

    box.append(groupFold('频闪', coverDirty(['strobe', 'strobeDark', 'invert', 'mono', 'glitch', 'flashScope', 'flashFeather']),
      cr('提亮闪', 'strobe', v => v + '%', true),
      cr('压暗闪', 'strobeDark', v => v + '%', true),
      cr('反相闪', 'invert', v => v + '%', true),
      cr('抽色闪', 'mono', v => v + '%', true),
      cr('切片错位', 'glitch', v => v + '%', true),
      cr('频率', 'flashHz', v => v + ' Hz', true),
      fieldSeg('作用范围', [
        { value: '0', label: '全幅' },
        { value: '1', label: '框选矩形' },
        { value: '2', label: '主体剪影' },
      ], String(Math.round(fx.flashScope ?? 0)), (d, v) => {
        const l = coverLayer(d);
        if (l?.cover) l.cover.flashScope = Number(v) || 0;
        invalidateInspector();
      }),
      cr('边缘羽化', 'flashFeather', v => v + '%', fx.flashScope !== 0, '先选范围'),
      el('div', 'hint', (fx.flashScope === 0
        ? '全幅：整张画板一起闪。'
        : fx.flashScope === 1
          ? '框选矩形：只在你框出来的那块里闪；没框过就用识别出的主体包围盒（' + (s?.roi ? '当前用的是手动框' : '当前用的是包围盒') + '）。'
          : (s ? '主体剪影：沿掩膜软边闪，和你擦出来的形状一致。' : '主体剪影：当前没有可用掩膜，已退回全幅。'))
        + ' 切片错位遵循同一个范围。羽化按画板宽度的比例算，导出 600 与 1080 观感一致。'),
      el('div', 'hint warn', '⚠ 3 Hz 以上的大面积闪烁可能诱发光敏性癫痫。'
        + '四个通道共用这一个频率（各自只调强度），方形波硬切，相位对齐到总时长整数周期。'
        + 'GIF 只有 12fps，频率高于 6 Hz 会在 GIF 里混叠成乱码 —— 频闪类建议用视频通道导出。'),
    ));

    box.append(groupFold('滤镜', coverDirty(['fxPixel', 'fxRgb', 'fxDuotone', 'fxScan', 'fxDot']),
      cr('像素化', 'fxPixel', v => v + '%', true),
      cr('色差', 'fxRgb', v => v + '%', true),
      cr('双色调', 'fxDuotone', v => v + '%', true),
      cr('色相', 'fxDuoHue', v => v + '°', true),
      cr('扫描线', 'fxScan', v => v + '%', true),
      cr('行距', 'fxScanGap', v => v + 'px', true),
      cr('网点', 'fxDot', v => v + '%', true),
      cr('格大小', 'fxDotScale', v => v + 'px', true),
      el('div', 'hint', '顺序固定：像素化 → 色差 → 双色调 → 扫描线 → 网点，都在暗角与颗粒之下。'
        + '网点是屏幕空间的圆点纹理，不是按亮度出点的真半调（那个要逐像素，1080 下每帧 30ms+，扛不住）。'
        + '像素化与色差的尺寸都按画板宽度换算，导出 600 与 1080 观感一致。'),
      el('div', 'hint warn', '成本：色差与双色调最贵（1080 下各约 +28ms / +14ms 每帧，因为要把整幅拆通道再叠回去），'
        + '扫描线、网点、像素化各约 +1~8ms。同时开 3 个以上在低端机会掉帧、导出也会变慢 —— '
        + '建议最多同时开 2 个；预览按 0.6 倍渲染时成本约为 1/3。'),
    ));

    box.append(groupFold('构图', coverDirty(['frameZoom', 'panX', 'panY']),
      cr('缩放', 'frameZoom', v => (v / 100).toFixed(2) + '×', true),
      cr('水平', 'panX', v => (v > 0 ? '+' : '') + v + '%', true),
      cr('垂直', 'panY', v => (v > 0 ? '+' : '') + v + '%', true),
      el('div', 'hint', (fx.frameZoom <= 100
        ? '先放大才有平移余量：缩放 100% 时平移无效（否则画框四边会露底）。'
        : '平移量按「放大后剩下的边距」的百分比算，所以永远不会把画框推穿。')
        + ' 这里调的是整幅，背景板与主体同一变换，主体边缘不会被拉开；识别漏掉的块请用笔刷补。'),
    ));

    box.append(group('背景板',
      cr('虚化', 'bgBlur', v => v + 'px', ab.subject && !region, '需剪影'),
      cr('压暗', 'bgDark', v => v + '%', ab.subject && !region, '需剪影'),
      el('div', 'hint', region
        ? '区域动效模式：掩膜只当"动效作用区域"，背景保持原样（虚化 / 压暗 / 视差不生效）。用笔刷擦出轮廓后自动恢复景深分层。'
        : '虚化 / 压暗只作用于主体之外的底衬；想让背景完全原样就都拉到 0。'),
    ));

    box.append(groupFold('质感', coverDirty(['vignette', 'grain', 'sat']),
      cr('暗角', 'vignette', v => v + '%', true, '可用'),
      cr('胶片颗粒', 'grain', v => v + '%', true, '可用'),
      cr('饱和度', 'sat', v => (v / 100).toFixed(2) + '×', true, '可用'),
    ));

    box.append(el('div', 'hint', '封面模式不加文字与背景层：导出即为 1:1 正方形（1080 / 600 两档）。'));
  }

  function renderInspector() {
    const box = $('inspector');
    box.innerHTML = '';
    const doc = store.state.doc;
    if (isCover(doc)) { renderCoverInspector(box, coverLayer(doc)); return; }
    const l = doc.layers.find(x => x.id === store.state.selectedId);
    if (!l) {
      box.append(el('div', 'hint', '在左侧选择图层，或点击「新建文字」开始创作。'));
      return;
    }
    if (isBg(l)) {
      box.append(group('背景',
        fieldColor('渐变至上', l.color1, withBg((b, v) => { b.color1 = v; })),
        fieldColor('渐变至下', l.color2, withBg((b, v) => { b.color2 = v; })),
      ));
      box.append(group('动效',
        fieldSelect('动画', [
          { value: 'none', label: '无动画' },
          { value: 'kenBurns', label: PRESET_LABELS.kenBurns },
        ], l.anim.preset, withBg((b, v) => { b.anim.preset = v; })),
        l.anim.preset === 'kenBurns'
          ? fieldRange('时长', 1000, Math.round(doc.duration), 100, l.anim.duration,
            v => (v / 1000).toFixed(1) + 's', withBg((b, v) => { b.anim.duration = v; }))
          : el('div', 'hint', '背景缓推会让渐变缓慢放大，适合营造氛围。'),
      ));
      return;
    }

    if (isImage(l)) {
      const fx = l.fx;
      const preset = matchPreset(fx);
      box.append(group('图片',
        el('div', 'hint', `${l.name || '图片'} · 可直接在画布上拖拽位置`),
        fieldNum('位置 X', Math.round(l.x), -400, doc.canvas.w + 400, 4, withImage((i, v) => { i.x = v; })),
        fieldNum('位置 Y', Math.round(l.y), -400, doc.canvas.h + 400, 4, withImage((i, v) => { i.y = v; })),
        fieldRange('宽度', 80, doc.canvas.w, 10, Math.round(l.w), v => v + 'px', withImage((i, v) => { i.w = v; })),
        fieldRange('高度', 80, doc.canvas.h, 10, Math.round(l.h), v => v + 'px', withImage((i, v) => { i.h = v; })),
        (() => {
          const b = el('button', 'btn wide', '替换图片');
          b.addEventListener('click', () => pickImage(l.id));
          return b;
        })(),
      ));

      box.append(group('动效预设',
        fieldSeg('预设', [
          ...IMAGE_PRESETS.map(p => ({ value: p, label: IMAGE_PRESET_LABELS[p] })),
          { value: 'custom', label: '自定义' },
        ], preset || 'custom', (d, v) => {
          if (v === 'custom') return;
          const l2 = d.layers.find(x => x.id === store.state.selectedId);
          if (l2 && isImage(l2)) l2.fx = fxForPreset(v as any);
        }),
        el('div', 'hint', preset ? '当前参数与「' + IMAGE_PRESET_LABELS[preset] + '」一致' : '当前为自定义参数'),
      ));

      box.append(group('运动',
        fieldRange('速度', FX_RANGES.speed[0], FX_RANGES.speed[1], 5, fx.speed,
          v => (v / 100).toFixed(2) + '×', withFx((f, v) => { f.speed = v; })),
        fieldRange('呼吸缩放', 0, 100, 1, fx.breathe, v => v + '%', withFx((f, v) => { f.breathe = v; })),
        fieldRange('轨道漂浮', 0, 100, 1, fx.float, v => v + '%', withFx((f, v) => { f.float = v; })),
        fieldRange('旋转幅度', 0, 100, 1, fx.spin, v => (v / 10).toFixed(1) + '°', withFx((f, v) => { f.spin = v; })),
      ));

      box.append(group('光效',
        fieldRange('光扫强度', 0, 100, 1, fx.sweep, v => v + '%', withFx((f, v) => { f.sweep = v; })),
        fieldRange('光扫角度', 0, 360, 1, fx.angle, v => v + '°', withFx((f, v) => { f.angle = v; })),
        fieldRange('呼吸光晕', 0, 100, 1, fx.glow, v => v + '%', withFx((f, v) => { f.glow = v; })),
      ));

      box.append(group('质感',
        fieldRange('胶片颗粒', 0, 100, 1, fx.grain, v => v + '%', withFx((f, v) => { f.grain = v; })),
        fieldRange('暗角', 0, 100, 1, fx.vignette, v => v + '%', withFx((f, v) => { f.vignette = v; })),
        fieldRange('液态扭曲', 0, 100, 1, fx.warp, v => v + '%', withFx((f, v) => { f.warp = v; })),
      ));

      box.append(group('画面',
        fieldRange('圆角', 0, 50, 1, fx.radius, v => v + '%', withFx((f, v) => { f.radius = v; })),
        fieldRange('饱和度', 40, 200, 1, fx.sat, v => (v / 100).toFixed(2) + '×', withFx((f, v) => { f.sat = v; })),
        fieldRange('背景虚化', 0, 60, 1, fx.bgBlur, v => v + 'px', withFx((f, v) => { f.bgBlur = v; })),
        fieldSeg('形态', [
          { value: 'flat', label: '平面' },
          { value: 'vinyl', label: '黑胶唱盘' },
        ], fx.vinyl > 0.5 ? 'vinyl' : 'flat', withFx((f, v) => { f.vinyl = v === 'vinyl' ? 1 : 0; })),
      ));
      return;
    }

    const s = l.style;
    box.append(group('文字',
      (() => {
        const ta = el('textarea');
        ta.value = l.text;
        ta.placeholder = '输入海报文字，回车换行';
        bindArmedInput(ta, i => (i as HTMLTextAreaElement).value, withText((t, v) => { t.text = v; }));
        return fieldWrap('内容', ta);
      })(),
      fieldSelect('字体', (['serif', 'sans', 'kai'] as const).map(f => ({ value: f, label: FONT_LABELS[f] })),
        s.font, withText((t, v) => { t.style.font = v; })),
      fieldRange('字号', 24, 220, 2, s.size, v => v + 'px', withText((t, v) => { t.style.size = v; })),
    ));

    box.append(group('排版',
      fieldRange('行高', 1, 2.6, 0.05, s.lineHeight, v => v.toFixed(2), withText((t, v) => { t.style.lineHeight = v; })),
      fieldRange('字距', -10, 60, 1, s.letterSpacing, v => v + 'px', withText((t, v) => { t.style.letterSpacing = v; })),
      fieldSeg('对齐', [
        { value: 'left', label: '左对齐' },
        { value: 'center', label: '居中' },
        { value: 'right', label: '右对齐' },
      ], s.align, withText((t, v) => { t.style.align = v; })),
      fieldColor('颜色', s.color, withText((t, v) => { t.style.color = v; })),
      fieldNum('位置 X', Math.round(s.x), -400, doc.canvas.w + 400, 4, withText((t, v) => { t.style.x = v; })),
      fieldNum('位置 Y', Math.round(s.y), -400, doc.canvas.h + 400, 4, withText((t, v) => { t.style.y = v; })),
      fieldRange('排版宽度', 240, Math.min(1040, doc.canvas.w - 40), 10, s.boxWidth,
        v => v + 'px', withText((t, v) => { t.style.boxWidth = v; })),
      el('div', 'hint', '也可以直接在画布上拖拽文字调整位置。'),
    ));

    const useStagger = l.anim.preset === 'charRise' || l.anim.preset === 'lineSlide';
    box.append(group('动效',
      fieldSelect('预设', TEXT_PRESETS.map(p => ({ value: p, label: PRESET_LABELS[p] })),
        l.anim.preset, withText((t, v) => { t.anim.preset = v; })),
      fieldRange('时长', 200, 6000, 50, l.anim.duration,
        v => (v / 1000).toFixed(2) + 's', withText((t, v) => { t.anim.duration = v; })),
      fieldRange('延迟', 0, 6000, 50, l.anim.delay,
        v => (v / 1000).toFixed(2) + 's', withText((t, v) => { t.anim.delay = v; })),
      useStagger
        ? fieldRange('逐字间隔', 0, 400, 10, l.anim.stagger,
          v => v + 'ms', withText((t, v) => { t.anim.stagger = v; }))
        : el('div'),
      fieldSelect('缓动', Object.entries(EASING_LABELS).map(([value, label]) => ({ value, label })),
        l.anim.easing, withText((t, v) => { t.anim.easing = v; })),
    ));
  }

  function renderInspectorIfNeeded() {
    const extRev = store.revision - selfEdits;
    if (store.state.selectedId !== lastSel || extRev !== lastExtRev) {
      lastSel = store.state.selectedId;
      lastExtRev = extRev;
      renderInspector();
    }
  }

  /* ---------- 时间轴 ---------- */
  function renderTimeline() {
    const doc = store.state.doc;
    ($('tlDurInput') as HTMLInputElement).value = String(Math.round(doc.duration / 100) / 10);

    const ruler = $('tlRuler');
    ruler.innerHTML = '';
    for (let t = 0; t <= doc.duration + 1; t += 500) {
      const tick = el('div', 'tl-tick');
      tick.style.left = (t / doc.duration * 100) + '%';
      if (t % 1000 === 0 && t > 0) tick.append(el('span', null, (t / 1000) + 's'));
      ruler.append(tick);
    }

    const tracks = $('tlTracks');
    tracks.innerHTML = '';
    for (const l of doc.layers) {
      // 图片图层没有 anim 字段（动效走 fx），时间轴不出条
      const a = animOf(l);
      if (!a || a.preset === 'none') continue;
      const lane = el('div', 'tl-lane');
      lane.append(el('div', 'lane-name', isBg(l) ? '背景缓推' : layerName(l)));
      let units = 1;
      if (isText(l)) {
        const layout = renderer.getLayout(l);
        if (a.preset === 'charRise' || a.preset === 'typewriter') units = layout.chars.length;
        else if (a.preset === 'lineSlide') units = layout.lineCount;
      }
      const span = Math.max(200, animSpan(a, units));
      const block = el('div', 'tl-block' + (l.id === store.state.selectedId ? ' sel' : ''));
      block.style.left = (a.delay / doc.duration * 100) + '%';
      block.style.width = (span / doc.duration * 100) + '%';
      lane.append(block);
      tracks.append(lane);
    }

    // 封面模式没有入场动效，整条时间轴就是一次循环
    if (isCover(doc) && doc.layers.length) {
      const lane = el('div', 'tl-lane');
      lane.append(el('div', 'lane-name', '封面循环'));
      const block = el('div', 'tl-block sel');
      block.style.left = '0%';
      block.style.width = '100%';
      lane.append(block);
      tracks.append(lane);
    }
  }

  function renderTimelineIfNeeded() {
    const doc = store.state.doc;
    const key = JSON.stringify([doc.duration, store.state.selectedId,
      doc.layers.map(l => [l.id, animOf(l)])]);
    if (key !== timelineKey) { timelineKey = key; renderTimeline(); }
  }

  function updateTimelineFrame() {
    const doc = store.state.doc;
    $('tlTime').textContent = `${(player.currentTime / 1000).toFixed(2)}s / ${(doc.duration / 1000).toFixed(2)}s`;
    $('tlPlayhead').style.left = (player.currentTime / doc.duration * 100) + '%';
  }

  function updateButtons() {
    $('tlPlay').textContent = store.state.playing ? '⏸ 暂停' : '▶ 播放';
    $('undoBtn').toggleAttribute('disabled', !store.canUndo());
    $('redoBtn').toggleAttribute('disabled', !store.canRedo());
    $('loopBtn').classList.toggle('active', store.state.loop);
    const sel = $<HTMLSelectElement>('ratioSel');
    const r = RATIOS.find(x => x.w === store.state.doc.canvas.w && x.h === store.state.doc.canvas.h);
    if (r) sel.value = r.key;
  }

  /* ---------- 导出 ---------- */
  /** 工程文件的导入：校验 → 迁移 → 切模式 → 替换（可撤销） */
  async function importProjectFile(file: File): Promise<void> {
    try {
      const raw = JSON.parse(await file.text());
      const doc = readProject(raw);
      if (!doc) throw new Error('不是本工具的工程文件（缺 version / layers / canvas）');
      const target = modeOf(doc);
      if (target === modeOf(store.state.doc)) {
        store.resetDoc(doc);                       // 同模式：直接替换，进撤销栈
      } else {
        // 跨模式：先把它放进目标模式的缓存，再切过去（setMode 会读缓存）
        if (target === 'cover') coverCache = doc; else posterCache = doc;
        setMode(target);
      }
      invalidateInspector();
      const n = doc.layers.length;
      toast(`已导入工程：${target === 'cover' ? '封面' : '海报'} · ${n} 个图层 · ${(doc.duration / 1000).toFixed(1)}s`);
    } catch (err) {
      toast('导入失败：' + ((err as Error).message || '文件无法解析'));
    }
  }

  async function runExport(kind: 'video' | 'gif' | 'png', outW = 1080) {
    $('exportMenu').classList.remove('open');
    const doc = store.state.doc;
    player.pause();
    store.setPlaying(false);
    let lastPaint = 0;
    const hooks = {
      onProgress: (r: number, label: string) => {
        // 节流：导出期间每帧都写 DOM 会拖慢软件渲染，限制到 200ms 一次
        const now = performance.now();
        if (r < 1 && now - lastPaint < 200) return;
        lastPaint = now;
        showOverlay(`${label} ${Math.round(r * 100)}%`);
      },
    };
    showOverlay('准备导出');
    $('overlay').classList.add('exporting'); // 停掉 spinner 动画，避免持续重绘
    try {
      if (kind === 'video') await exportVideo(renderer, doc, player, hooks);
      else if (kind === 'gif') await exportGif(renderer, doc, hooks, { outW });
      else await exportPngZip(renderer, doc, hooks, { outW });
    } catch (err) {
      toast('导出失败：' + (err as Error).message);
    }
    $('overlay').classList.remove('exporting');
    hideOverlay();
    renderer.renderAt(player.currentTime);
    updateTimelineFrame();
  }

  function showOverlay(text: string) {
    $('overlayText').textContent = text;
    $('overlay').style.display = 'grid';
  }
  function hideOverlay() { $('overlay').style.display = 'none'; }

  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function toast(msg: string) {
    let t = document.getElementById('toast');
    if (!t) { t = el('div', 'toast'); t.id = 'toast'; document.body.append(t); }
    t.textContent = msg;
    (t as HTMLElement).style.display = 'block';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { (t as HTMLElement).style.display = 'none'; }, 3600);
  }

  /* ---------- 图片导入 ---------- */
  const MAX_EDGE = 1600;                       // 最长边降采样上限
  const MAX_SRC = 2.6 * 1024 * 1024;           // dataURL 上限（保护 localStorage）

  function pickImage(layerId?: string) {
    const input = $<HTMLInputElement>('imageInput');
    input.value = '';
    input.dataset.target = layerId || '';
    input.click();
  }

  /** 读文件 → 降采样 → dataURL（webp 优先，保留透明通道；不支持时浏览器回落 PNG） */
  async function fileToImage(file: File): Promise<{ src: string; w: number; h: number; name: string }> {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('图片解码失败'));
        i.src = url;
      });
      const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const x = c.getContext('2d')!;
      x.imageSmoothingQuality = 'high';
      x.drawImage(img, 0, 0, w, h);
      let src = c.toDataURL('image/webp', 0.9);
      if (src.length > MAX_SRC) src = c.toDataURL('image/webp', 0.72);
      if (src.length > MAX_SRC * 1.3) {
        const c2 = document.createElement('canvas');
        c2.width = Math.round(w * 0.7); c2.height = Math.round(h * 0.7);
        c2.getContext('2d')!.drawImage(c, 0, 0, c2.width, c2.height);
        src = c2.toDataURL('image/webp', 0.78);
      }
      return { src, w, h, name: file.name.replace(/\.[^.]+$/, '').slice(0, 40) };
    } finally { URL.revokeObjectURL(url); }
  }

  async function importImage(file: File, replaceId?: string) {
    if (!/^image\//.test(file.type)) { toast('请选择图片文件'); return; }
    try {
      const { src, w, h, name } = await fileToImage(file);
      const doc = store.state.doc;

      /* 封面模式：一张图铺满 1:1 画板，导入后立刻识别主体 */
      if (isCover(doc)) {
        const existing = coverLayer(doc);
        const id = existing?.id ?? uid();
        if (existing) {
          uiCommit(d => {
            const l = coverLayer(d);
            if (l) { l.src = src; l.name = name; l.subject = undefined; }
          });
        } else {
          uiCommit(d => {
            d.layers = [{
              id, type: 'image', name, src,
              x: d.canvas.w / 2, y: d.canvas.h / 2, w: d.canvas.w, h: d.canvas.h,
              fx: fxForPreset('breath'), cover: defaultCoverFx(),
            }];
          });
        }
        store.select(id);
        toast('已导入 ' + name);
        void reanalyze();
        return;
      }

      const box = Math.min(doc.canvas.w, doc.canvas.h) * 0.8;
      const ar = w / h;
      const iw = ar >= 1 ? box : box * ar;
      const ih = ar >= 1 ? box / ar : box;

      if (replaceId) {
        uiCommit(d => {
          const l = d.layers.find(x => x.id === replaceId);
          if (l && isImage(l)) { l.src = src; l.name = name; }
        });
        toast('已替换为 ' + name);
        return;
      }
      const id = uid();
      uiCommit(d => {
        const layer: ImageLayer = {
          id, type: 'image', name, src,
          x: Math.round(d.canvas.w / 2), y: Math.round(d.canvas.h / 2),
          w: Math.round(iw), h: Math.round(ih),
          fx: fxForPreset('breath'),
        };
        const bgIdx = d.layers.findIndex(isBg);
        d.layers.splice(bgIdx + 1, 0, layer);
      });
      store.select(id);
      toast('已导入 ' + name + '（最长边已降至 1600px）');
    } catch (e) {
      toast('导入失败：' + (e as Error).message);
    }
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    $('modeSeg').querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => setMode((b as HTMLElement).dataset.mode as DocMode));
    });

    $('stageImportBtn').addEventListener('click', () => pickImage());

    $('ratioSel').addEventListener('change', () => {
      const r = RATIOS.find(x => x.key === ($('ratioSel') as HTMLSelectElement).value);
      if (!r) return;
      uiCommit(d => { d.canvas.w = r.w; d.canvas.h = r.h; });
    });

    $('tlPlay').addEventListener('click', () => {
      player.toggle();
      store.setPlaying(player.isRunning);
    });

    $('loopBtn').addEventListener('click', () => {
      const v = !store.state.loop;
      store.setLoop(v);
      player.loop = v;
    });

    $('undoBtn').addEventListener('click', () => store.undo());
    $('redoBtn').addEventListener('click', () => store.redo());

    $('resetBtn').addEventListener('click', () => {
      const cover = isCover(store.state.doc);
      const msg = cover
        ? '清空当前封面？（可撤销）'
        : '恢复为默认示例海报？当前编辑内容将被覆盖（可撤销）。';
      if (!window.confirm(msg)) return;
      store.resetDoc(cover ? emptyCoverDoc() : defaultDoc());
      const first = store.state.doc.layers.find(l => !isBg(l));
      store.select(first ? first.id : null);
    });

    $('exportBtn').addEventListener('click', ev => {
      ev.stopPropagation();
      $('exportMenu').classList.toggle('open');
    });
    document.addEventListener('click', () => $('exportMenu').classList.remove('open'));
    let exportOutW = 1080;
    $('exportSize').querySelectorAll('button').forEach(b => {
      b.addEventListener('click', ev => {
        ev.stopPropagation(); // 别把菜单点没了
        exportOutW = Number((b as HTMLElement).dataset.size) || 1080;
        $('exportSize').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      });
    });
    $('exportMenu').querySelectorAll('button[data-kind]').forEach(b => {
      b.addEventListener('click', () => runExport((b as HTMLElement).dataset.kind as 'video' | 'gif' | 'png', exportOutW));
    });

    /* 工程文件：导出直接序列化；导入走一个隐藏的 file input（也支持把 .json 拖到画板上） */
    const projInput = el('input') as HTMLInputElement;
    projInput.type = 'file';
    projInput.accept = '.json,application/json';
    projInput.style.display = 'none';
    document.body.append(projInput);
    projInput.addEventListener('change', () => {
      const f = projInput.files?.[0];
      if (f) void importProjectFile(f);
      projInput.value = '';                        // 允许连续导入同一个文件
    });
    $('exportMenu').querySelectorAll('button[data-file]').forEach(b => {
      b.addEventListener('click', () => {
        $('exportMenu').classList.remove('open');
        if ((b as HTMLElement).dataset.file === 'export') {
          const ver = (document.querySelector('.brand .ver')?.textContent || '').trim();
          exportProject(store.state.doc, ver);
          toast('已导出工程文件（含图片与掩膜，可换设备继续编辑）');
        } else {
          projInput.click();
        }
      });
    });

    $('addTextBtn').addEventListener('click', () => {
      const doc = store.state.doc;
      const id = uid();
      uiCommit(d => {
        d.layers.push({
          id, type: 'text', text: '新文字',
          style: {
            font: 'serif', size: 72, lineHeight: 1.4, letterSpacing: 4, align: 'center',
            color: '#F2EDE2', x: Math.round(d.canvas.w / 2), y: Math.round(d.canvas.h / 2),
            boxWidth: Math.min(900, d.canvas.w - 120),
          },
          anim: { preset: 'charRise', duration: 800, delay: 0, stagger: 70, easing: 'easeOut' },
        });
      });
      store.select(id);
    });

    $('addImageBtn').addEventListener('click', () => pickImage());
    $<HTMLInputElement>('imageInput').addEventListener('change', () => {
      const input = $<HTMLInputElement>('imageInput');
      const f = input.files && input.files[0];
      const target = input.dataset.target || undefined;
      if (f) void importImage(f, target);
      input.value = '';
      input.dataset.target = '';
    });

    // 图片拖入舞台
    const stageEl = $('stage');
    stageEl.addEventListener('dragover', ev => { ev.preventDefault(); });
    stageEl.addEventListener('drop', ev => {
      ev.preventDefault();
      const f = ev.dataTransfer?.files?.[0];
      if (!f) return;
      // .json 当工程文件导入，其余按图片处理 —— 拖拽比找菜单更快
      if (/\.json$/i.test(f.name) || f.type === 'application/json') void importProjectFile(f);
      else void importImage(f);
    });

    $('tlDurInput').addEventListener('change', () => {
      const v = Math.min(60000, Math.max(500, Math.round(Number(($('tlDurInput') as HTMLInputElement).value) * 1000)));
      uiCommit(d => { d.duration = v; });
    });

    // 时间轴擦洗
    const scrub = $('tlScrub');
    scrub.addEventListener('pointerdown', ev => {
      const seek = (e: PointerEvent) => {
        const r = scrub.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        player.seek(ratio * store.state.doc.duration);
      };
      seek(ev); // 先定位，捕获失败也不影响擦洗
      try { scrub.setPointerCapture(ev.pointerId); } catch { /* 合成事件等场景忽略 */ }
      const move = (e: PointerEvent) => seek(e);
      const up = () => {
        scrub.removeEventListener('pointermove', move);
        scrub.removeEventListener('pointerup', up);
        scrub.removeEventListener('pointercancel', up);
      };
      scrub.addEventListener('pointermove', move);
      scrub.addEventListener('pointerup', up);
      scrub.addEventListener('pointercancel', up);
    });

    // 画布拖拽（文字 / 图片）
    canvas.addEventListener('pointerdown', ev => {
      const doc = store.state.doc;
      if (isCover(doc)) {
        // 封面模式：画板只服务手动识别工具，没有工具时不做任何事
        if (!covTool || !coverLayer(doc)) return;
        ev.preventDefault();
        const rect = canvas.getBoundingClientRect();
        if (covTool === 'roi') startRoiGesture(ev, rect);
        else startBrushGesture(ev, rect, covTool === 'erase');
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const toDoc = (e: PointerEvent) => ({
        x: (e.clientX - rect.left) / rect.width * doc.canvas.w,
        y: (e.clientY - rect.top) / rect.height * doc.canvas.h,
      });
      const p = toDoc(ev);
      const hit = renderer.hitTest(p.x, p.y);
      if (!hit) return;
      store.select(hit);
      const layer = doc.layers.find(l => l.id === hit);
      if (!layer || isBg(layer)) return;
      const isImg = isImage(layer);
      const startX = isImg ? layer.x : (layer as TextLayer).style.x;
      const startY = isImg ? layer.y : (layer as TextLayer).style.y;
      let moved = false;
      try { canvas.setPointerCapture(ev.pointerId); } catch { /* 合成事件等场景忽略 */ }
      canvas.classList.add('dragging');
      const move = (e: PointerEvent) => {
        const q = toDoc(e);
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 2) return;
        if (!moved) { store.checkpoint(); moved = true; }
        uiPreview(d => {
          const l2 = d.layers.find(x => x.id === hit);
          if (!l2) return;
          if (isImage(l2)) { l2.x = startX + dx; l2.y = startY + dy; }
          else if (isText(l2)) { l2.style.x = startX + dx; l2.style.y = startY + dy; }
        });
      };
      const up = () => {
        canvas.classList.remove('dragging');
        canvas.removeEventListener('pointermove', move);
        canvas.removeEventListener('pointerup', up);
        canvas.removeEventListener('pointercancel', up);
      };
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
      canvas.addEventListener('pointercancel', up);
    });

    // 快捷键
    document.addEventListener('keydown', e => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        player.toggle();
        store.setPlaying(player.isRunning);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) store.redo(); else store.undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        store.redo();
      }
    });

    // 舞台尺寸变化
    new ResizeObserver(() => fitCanvas()).observe($('stage'));

    store.onSave = () => {
      const el2 = $('saveState');
      el2.textContent = '已自动保存 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
      el2.classList.remove('save-fail');
      el2.removeAttribute('title');
    };

    /* 保存失败必须说出来。localStorage 只有 ~5MB，一张大图 base64 之后很容易顶到上限；
       原来这里没有任何订阅者，写失败是静默的 —— 用户会以为存上了，刷新才发现白做。 */
    let saveFailShown = false;
    store.onSaveError = (msg: string) => {
      const el2 = $('saveState');
      el2.textContent = '未保存：空间不足';
      el2.classList.add('save-fail');
      el2.title = msg;
      if (saveFailShown) return;          // 连续触发只提示一次，别刷屏
      saveFailShown = true;
      toast('自动保存失败：浏览器本地存储已满（约 5MB）。当前进度只在内存里，刷新会丢 —— 请先导出视频/GIF，或换一张小一点的图。');
      setTimeout(() => { saveFailShown = false; }, 8000);
    };

    function render() {
      const doc = store.state.doc;
      if (!doc.layers.some(l => l.id === store.state.selectedId)) {
        const t = doc.layers.find(l => !isBg(l));
        const want = t ? t.id : null;
        // 只有选中项真的变了才重入；空封面没有图层，select(null) 不会 emit，
        // 无条件 return 会让画布永远不刷新
        if (want !== store.state.selectedId) { store.select(want); return; }
      }
      renderer.setDoc(doc);
      fitCanvas();
      // 暂停时没有 player.onFrame 每帧重绘，改文档必须在这里补一帧，
      // 否则「暂停 → 调参数 / 换预设 / 导入图片」画布一律不刷新。
      renderer.renderAt(player.currentTime);
      syncChrome();
      // 撤销 / 重做 / 重新识别都会换掩膜，覆盖层得跟着重画（涂抹手势期间不打断）
      if (isCover(doc) && covTool && !canvas.classList.contains('cov-gesturing')) refreshCoverOverlay();
      renderLayers();
      renderTimelineIfNeeded();
      updateTimelineFrame();
      renderInspectorIfNeeded();
      updateButtons();
    }

    // 图片解码是异步的：解码完成后重绘一帧，否则首帧是空的
    // （必须在首次 render 之前挂上，否则 boot 时就有的图片永远等不到回调）
    renderer.onNeedsRender = () => renderer.renderAt(player.currentTime);

    store.subscribe(render);
    render(); // 首屏渲染（boot 时没有任何事件，必须主动跑一次）

    player.onFrame = t => {
      renderer.renderAt(t);
      updateTimelineFrame();
    };
    player.onEnd = () => store.setPlaying(false);
    player.loop = store.state.loop;
  }

  bind();

  return { fitCanvas, renderInspector, setMode, reanalyze };
}
