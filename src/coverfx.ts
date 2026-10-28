/**
 * 封面动效求值（纯函数，可单测）
 *
 * 与 imagefx.ts（整图动效）的区别：这里的变换作用在「识别出的主体」上，
 * pivot 不是画板中心，而是解析出来的脚底 / 颈部，所以看起来像"那个人在动"。
 */
import type { CoverFx } from './doc';
import { TIER_ABILITY } from './analyze';

export interface CoverTransform {
  scale: number;
  rot: number;      // rad
  dx: number;       // 画板宽度的比例
  dy: number;       // 画板高度的比例
}

const TAU = Math.PI * 2;

/** 统一时间基准：speed=100 时为 1 秒 1 个单位 */
export function coverTime(fx: CoverFx, tMs: number): number {
  return (tMs / 1000) * (Math.max(10, fx.speed) / 100);
}

/** 主体变换（呼吸 + 漂浮 + 摇摆），全部以「幅度 × 正弦」表达，保证首尾相接可循环 */
export function subjectXform(fx: CoverFx, tMs: number, ability = TIER_ABILITY.precise): CoverTransform {
  const T = coverTime(fx, tMs);
  const able = ability.subject;
  const breathe = able ? fx.breathe / 100 : 0;
  const float = able ? fx.float / 100 : 0;
  const sway = able ? fx.sway / 100 : 0;
  // 周期取无理比例，避免呼吸与漂浮同相位（同相位会像整体缩放，很假）
  const scale = 1 + breathe * 0.055 * Math.sin((T / 2.6) * TAU);
  const dx = float * 0.010 * Math.sin((T / 5.1) * TAU);
  const dy = float * 0.020 * Math.sin((T / 3.4) * TAU);
  const rot = sway * 0.045 * Math.sin((T / 3.8) * TAU);   // 约 ±2.6°
  return { scale, rot, dx, dy };
}

/** 背景板变换：与主体反向位移形成视差。
 *
 *  **背景板绝对不能再靠"放大"来遮画板边。**
 *  擦除区（主体位置的洞）是烘进背景板里的，背景板一放大，洞就跟着放大，
 *  而主体层并不放大 —— 于是主体四周被甩出一圈"补洞色"，看起来就是
 *  "主体边缘有一圈虚化/模糊的边"。实测 zoom=1.04 在 r≈350px 处就是 14px 的环。
 *  现在把遮边交给背景板外扩（render.ts 的 PLATE_MARGIN），
 *  zoom 只留一点点（≤1.01，位移 ≤3px）作为"背景也在轻轻呼吸"的暗示。
 */
export function plateXform(fx: CoverFx, tMs: number): CoverTransform {
  const p = fx.parallax / 100;
  const s = subjectXform(fx, tMs);
  const zoom = 1 + p * 0.010 + (fx.breathe / 100) * 0.002;
  return {
    scale: zoom,
    rot: 0,
    // 反向 40%，幅度小，够看出层次但不会晃
    dx: -s.dx * 0.4 * (0.3 + p),
    dy: -s.dy * 0.4 * (0.3 + p),
  };
}

/** 头部点头：绕颈部旋转，幅度比整体摇摆更小更快 */
export function headXform(fx: CoverFx, tMs: number, ability = TIER_ABILITY.precise): { rot: number; active: boolean } {
  const able = ability.local && ability.subject;
  const nod = able ? fx.nod / 100 : 0;
  if (nod <= 0) return { rot: 0, active: false };
  const T = coverTime(fx, tMs);
  return { rot: nod * 0.035 * Math.sin((T / 1.9) * TAU), active: true };
}

/** 轮廓流光：沿轮廓跑一圈的相位 0..1，以及整体亮度呼吸 */
export function rimState(fx: CoverFx, tMs: number, ability = TIER_ABILITY.precise): { phase: number; alpha: number } {
  if (!ability.rim || fx.rim <= 0) return { phase: 0, alpha: 0 };
  const T = coverTime(fx, tMs);
  const speed = 0.25 + (fx.rim / 100) * 0.35;             // 一圈 2~4 秒
  return {
    phase: ((T * speed) % 1 + 1) % 1,
    alpha: Math.min(1, fx.rim / 100) * (0.55 + 0.45 * Math.sin((T / 2.2) * TAU)),
  };
}

/** 注意力点脉冲：每个点相位错开，避免三点同时亮 */
export function peakPulse(fx: CoverFx, tMs: number, index: number, ability = TIER_ABILITY.precise): number {
  if (!ability.subject || fx.pulse <= 0) return 0;
  const T = coverTime(fx, tMs);
  const ph = T / 2.4 * TAU + index * (TAU / 3);
  const v = 0.5 + 0.5 * Math.sin(ph);
  return Math.min(1, fx.pulse / 100) * Math.pow(v, 1.6);
}

/** 颗粒：逐帧用固定伪随机序列（按帧序号索引），避免噪点乱跳导致码率爆炸 */
export function grainOffset(tMs: number): { x: number; y: number } {
  const f = Math.floor(tMs / 1000 * 15);
  const a = Math.sin(f * 12.9898) * 43758.5453;
  const b = Math.sin(f * 78.233) * 43758.5453;
  return { x: (a - Math.floor(a)) * 220, y: (b - Math.floor(b)) * 220 };
}

/** 主体是否需要分层绘制（不需要时退化为整图动效，仍能出效果） */
export function shouldLayer(fx: CoverFx, tier: 'precise' | 'ok' | 'fallback'): boolean {
  return TIER_ABILITY[tier].subject;
}

/* ============================ v0.8 新增：光效 / 星尘 / 镜头 / 节奏 ============================ */

/**
 * 循环对齐相位：把周期量化成"总时长里正好整数个周期"，返回 0..1。
 *
 * 为什么必须这么做：导出 GIF 是把 0..duration 采样一圈再首尾拼起来。
 * 如果某个动效在 duration 处没回到起点，播放时每一圈都会"跳一下"。
 * 老动效（呼吸/漂浮/摇摆）的周期是写死的无理比例，本来就不严格循环 ——
 * 新增的这些一律走这里，至少不继续制造新的跳变。
 */
export function looped(tMs: number, durMs: number, cycles: number): number {
  const d = Math.max(1, durMs);
  const n = Math.max(1, Math.round(cycles));
  const p = (Math.max(0, tMs) / d) * n;
  return p - Math.floor(p);
}

/** 节拍包络：0..1，起音尖锐、衰减快（pow 3 让"点"听得出来） */
export function beatEnv(fx: CoverFx, tMs: number, durMs: number): number {
  if (fx.beat <= 0) return 0;
  const bpm = Math.min(180, Math.max(60, fx.bpm));
  // 吸附到整数拍：否则 looped 会在半拍处回绕，GIF 首帧就从鼓点中间开始
  const n = Math.max(1, Math.round(Math.max(1, durMs) / (60000 / bpm)));
  const ph = looped(tMs, durMs, n);
  return Math.pow(1 - ph, 3);
}

/**
 * 镜头层变换：整幅（背景板 + 主体）共用的缩放与旋转。
 *
 * 关键约束：**必须同时作用在背景板和主体上**。只缩放背景板会让烘在板子里的
 * 擦除区跟着变大，主体四周又露出补洞色 —— 那就是 v0.7.3 刚修掉的那个 bug。
 * 两者套同一变换时相对几何完全不变，只有画框边界需要覆盖：
 * 背景板本来就外扩了 PLATE_MARGIN(36px)，在 1080 画板上撑得住 3.8° 以内的旋转，
 * 所以这里不需要额外的补偿倍率。
 */
export function sceneXform(fx: CoverFx, tMs: number, durMs: number): { scale: number; rot: number } {
  const zoomAmp = (fx.zoom / 100) * 0.08;
  const zc = Math.max(1, Math.round(durMs / 7000));
  // 0.5-0.5cos：首尾都落在 1.0，推进后自动退回，循环平滑
  const push = 0.5 - 0.5 * Math.cos(looped(tMs, durMs, zc) * TAU);
  const beat = beatEnv(fx, tMs, durMs);
  const scale = 1 + zoomAmp * push + (fx.beat / 100) * 0.012 * beat;

  const spinAmp = (fx.spin / 100) * 0.0436;      // 2.5°
  const sc = Math.max(1, Math.round(durMs / 9000));
  const rot = spinAmp * Math.sin(looped(tMs, durMs, sc) * TAU);
  return { scale, rot };
}

/** 扫光带：位置 0..1（-0.30 进、1.30 出）、透明度、半宽（占画板宽） */
export function sweepBand(fx: CoverFx, tMs: number, durMs: number): { x: number; alpha: number; halfW: number } {
  if (fx.sweep <= 0) return { x: 0, alpha: 0, halfW: 0 };
  const ph = looped(tMs, durMs, Math.max(1, Math.round(durMs / 3400)));
  // 两端各留 1/6 相位淡入淡出：否则光带会在画框里凭空出现/消失
  const edge = Math.min(1, Math.min(ph, 1 - ph) * 6);
  return {
    x: -0.30 + ph * 1.60,
    alpha: (Math.min(100, fx.sweep) / 100) * edge,
    halfW: 0.06 + (Math.min(100, Math.max(8, fx.sweepW)) / 100) * 0.22,
  };
}

/**
 * 频闪范围边缘的羽化半径（画板像素）。
 *
 * 用「画板宽度的比例」而不是绝对像素：导出 600 和 1080 时观感才一致。
 * 100% 对应 0.09 × 画板宽（1080 下约 97px），足够把硬边化成一段柔和过渡。
 */
export function flashFeatherPx(fx: CoverFx, canvasW: number): number {
  const f = Math.min(100, Math.max(0, Number.isFinite(fx.flashFeather) ? fx.flashFeather : 0));
  return (f / 100) * 0.09 * Math.max(0, canvasW);
}

/** 星尘颗粒数（0..56）。上限压在 56：每颗一次 drawImage，导出逐帧渲染要留余量。 */
export function dustCount(fx: CoverFx): number {
  return Math.round(Math.min(100, Math.max(0, fx.dust)) / 100 * 56);
}

/**
 * 构图微调：整幅缩放 + 平移。
 *
 * 三个设计约束：
 *  1. **必须是整幅**（背景板与主体套同一矩阵）。只挪主体会让烘在板子里的擦除区露出来，
 *     而且识别漏掉的块也不会因此长回来 —— 补块该用笔刷。
 *  2. **缩放 ≥ 1**。缩放小于 1 会把画框四边拉开露底。
 *  3. **平移量用"可用余量的比例"表达**，而不是绝对像素：
 *     余量 = (zoom-1)/2，所以无论缩放到多少，平移都不会把画框推穿。
 *     zoom=100 时余量为 0，平移自然无效（UI 会提示"先放大再平移"）。
 */
export function frameXform(fx: CoverFx): { scale: number; dx: number; dy: number } {
  const z = Math.min(160, Math.max(100, fx.frameZoom)) / 100;
  const room = (z - 1) / 2;
  const px = Math.min(100, Math.max(-100, fx.panX)) / 100;
  const py = Math.min(100, Math.max(-100, fx.panY)) / 100;
  return { scale: z, dx: px * room, dy: py * room };
}

/* ============================ 频闪族（v0.8.3） ============================ */

/**
 * 频闪「框选矩形」的取框规则（归一化）：
 *   有手动框 → 用框；没框过 → 用识别出的主体包围盒；两者都没有 → 全幅。
 * 抽成纯函数是因为这条优先级容易被改错，而它决定了"闪在哪一块"。
 */
export function flashRectOf(
  roi?: [number, number, number, number],
  bbox?: [number, number, number, number],
): [number, number, number, number] {
  const r = roi ?? bbox;
  if (!r) return [0, 0, 1, 1];
  const clamp01 = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  const x0 = clamp01(r[0]), y0 = clamp01(r[1]);
  const x1 = Math.max(x0, clamp01(r[2])), y1 = Math.max(y0, clamp01(r[3]));
  return [x0, y0, x1, y1];
}

/** 频闪的占空比：一个周期里"亮"的比例。0.34 在 4Hz 下约 85ms 一次，够硬但不糊。 */
const FLASH_DUTY = 0.34;

/**
 * 频闪包络：四个频闪效果共用**同一条方形波**（各自只调强度）。
 *
 * 为什么合并频率：四个效果各给一个 Hz 只会互相打乱，视觉上变成噪声；
 * 共用一个频率才像"同一个频闪器在驱动不同通道"。
 *
 * 方形波而不是正弦：正弦是"呼吸"，方形才是"闪"。
 * 相位用 looped() 对齐到总时长整数周期，导出 GIF/视频不会在接缝处断拍。
 */
export function flashPulse(fx: CoverFx, tMs: number, durMs: number): { on: number; phase: number; index: number } {
  const hz = Math.min(12, Math.max(1, fx.flashHz));
  const d = Math.max(1, durMs);
  const cycles = Math.max(1, Math.round((d / 1000) * hz));
  const phase = looped(tMs, d, cycles);
  const index = Math.floor((Math.max(0, tMs) / d) * cycles);
  return { on: phase < FLASH_DUTY ? 1 : 0, phase, index };
}

/**
 * 切片错位：不是每一拍都触发（连续触发会变成花屏），
 * 用拍号做确定性伪随机，约 55% 的拍子会错位，并在拍内快速衰减。
 */
export function glitchState(fx: CoverFx, tMs: number, durMs: number): { amt: number; seed: number } {
  if (fx.glitch <= 0) return { amt: 0, seed: 0 };
  const p = flashPulse(fx, tMs, durMs);
  if (p.on === 0) return { amt: 0, seed: 0 };
  const seed = p.index;
  if (rnd(seed, 7) > 0.55) return { amt: 0, seed };                 // 只有约一半的拍子触发
  const decay = 1 - Math.min(1, p.phase / FLASH_DUTY);              // 拍内线性衰减
  return { amt: (Math.min(100, fx.glitch) / 100) * decay, seed };
}

/**
 * 由拍号生成错位条带（确定性：同一个拍号永远同一套条带，导出可复现）。
 * y / h 是画板高度的归一化值，dx 是画板宽度的归一化位移。
 */
export function glitchSlices(seed: number, amt: number): { y: number; h: number; dx: number }[] {
  const a = Math.min(1, Math.max(0, amt));
  if (a <= 0) return [];
  const n = 3 + Math.round(a * 6);                                  // 3~9 条
  const out: { y: number; h: number; dx: number }[] = [];
  for (let i = 0; i < n; i++) {
    const k = seed * 17 + i * 3;
    const y = rnd(k, 1) * 0.94;
    const h = 0.012 + rnd(k, 2) * 0.055;
    const mag = 0.012 + a * 0.07;
    const dx = (rnd(k, 3) - 0.5) * 2 * mag;
    out.push({ y, h: Math.min(h, 1 - y), dx });
  }
  return out;
}

/** 确定性伪随机：同一个索引永远同一组常数，导出可复现、拖动时间轴不闪 */
function rnd(i: number, k: number): number {
  const v = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return v - Math.floor(v);
}

/**
 * 第 i 颗星尘的状态。坐标是画板归一化坐标，半径是占画板宽的比例。
 * 全部由 (i, 相位) 推出来，不持有状态 —— 任意拖动时间轴都能得到同一画面。
 */
export function dustParticle(i: number, fx: CoverFx, tMs: number, durMs: number): { x: number; y: number; r: number; a: number } {
  // 每颗自己的上升速度：整排一起飘太假
  const speed = 0.55 + rnd(i, 1) * 0.95;
  const ph = looped(tMs, durMs, Math.max(1, Math.round((durMs / 7000) * speed)));
  const u = (rnd(i, 2) + ph) % 1;                       // 0..1 循环
  const y = 1 - u;                                      // 往上飘
  const x = rnd(i, 3) + Math.sin(ph * TAU + i * 1.7) * 0.022;
  const r = (0.0012 + rnd(i, 4) * 0.0028);              // 1080 画板上约 1.3~4.3px
  const fade = Math.min(1, Math.min(u, 1 - u) * 7);     // 进出画面不留硬边
  const twinkle = 0.6 + 0.4 * Math.sin(ph * TAU * 3 + i * 2.3);
  return { x, y, r, a: fade * twinkle * (0.62 + rnd(i, 5) * 0.38) };
}
