import type { ImageFx } from './doc';
import { defaultFx } from './doc';

/** 图片动效预设（对标网易云动态封面） */
export const IMAGE_PRESETS = ['breath', 'float', 'sweep', 'liquid', 'vinyl', 'film'] as const;
export type ImagePreset = typeof IMAGE_PRESETS[number];

export const IMAGE_PRESET_LABELS: Record<ImagePreset, string> = {
  breath: '呼吸',
  float: '漂浮',
  sweep: '光扫',
  liquid: '液态',
  vinyl: '黑胶',
  film: '胶片',
};

/** 每个预设只覆盖它关心的字段，其余沿用默认值 */
export const IMAGE_PRESET_FX: Record<ImagePreset, Partial<ImageFx>> = {
  breath: { breathe: 46, float: 0, spin: 0, sweep: 0, glow: 34, grain: 8, vignette: 20, warp: 0, vinyl: 0 },
  float: { breathe: 18, float: 62, spin: 12, sweep: 0, glow: 26, grain: 10, vignette: 24, warp: 0, vinyl: 0 },
  sweep: { breathe: 24, float: 8, spin: 0, sweep: 82, glow: 46, grain: 6, vignette: 26, warp: 0, vinyl: 0 },
  liquid: { breathe: 22, float: 10, spin: 0, sweep: 18, glow: 24, grain: 8, vignette: 22, warp: 62, vinyl: 0 },
  vinyl: { breathe: 6, float: 0, spin: 42, sweep: 14, glow: 30, grain: 14, vignette: 30, warp: 0, vinyl: 1 },
  film: { breathe: 14, float: 6, spin: 6, sweep: 10, glow: 16, grain: 52, vignette: 46, warp: 0, vinyl: 0 },
};

export function fxForPreset(name: ImagePreset): ImageFx {
  return { ...defaultFx(), ...IMAGE_PRESET_FX[name] };
}

/** 匹配最接近当前参数的预设（用于面板高亮）；都不接近返回 null */
export function matchPreset(fx: ImageFx): ImagePreset | null {
  for (const name of IMAGE_PRESETS) {
    const p = IMAGE_PRESET_FX[name];
    let ok = true;
    for (const k of Object.keys(p) as (keyof ImageFx)[]) {
      if (Math.abs(Number(fx[k]) - Number(p[k])) > 1) { ok = false; break; }
    }
    if (ok) return name;
  }
  return null;
}

export interface FxMotion {
  /** 呼吸缩放系数，1 表示原尺寸 */
  scale: number;
  /** 归一化位移（乘图层宽/高即像素） */
  dx: number;
  dy: number;
  /** 旋转弧度 */
  rot: number;
  /** 归一化时间（秒，已乘速度） */
  T: number;
}

/**
 * 求某个时刻的图层运动量。纯函数：同参数同 t 必然同结果（导出与预览一致的前提）。
 * 幅度全部相对图层尺寸，避免换画布尺寸后观感漂移。
 */
export function fxAt(fx: ImageFx, tMs: number): FxMotion {
  const T = (tMs / 1000) * (fx.speed / 100);
  return {
    scale: 1 + (fx.breathe / 100) * 0.055 * Math.sin(T * 1.15),
    dx: (fx.float / 100) * 0.022 * Math.sin(T * 0.62 + 0.6),
    dy: (fx.float / 100) * 0.028 * Math.cos(T * 0.83),
    rot: (fx.spin / 100) * 0.035 * Math.sin(T * 0.55),
    T,
  };
}

/** 黑胶盘面上封面圆片的自转角（弧度）；按 doc 时长取整圈，保证循环无缝 */
export function vinylAngle(fx: ImageFx, tMs: number, durationMs: number): number {
  const speed = fx.speed / 100;
  const turns = Math.max(1, Math.round((durationMs / 1000) * speed * (fx.spin / 100) * 0.55 / (Math.PI * 2)));
  const prog = durationMs > 0 ? (tMs % durationMs) / durationMs : 0;
  return prog * turns * Math.PI * 2;
}

/** 光扫在 t 时刻的归一化位置 0..1（周期 5.2s，随速度缩放） */
export function sweepPhase(fx: ImageFx, tMs: number): number {
  const T = (tMs / 1000) * (fx.speed / 100);
  const period = 5.2;
  return (((T % period) + period) % period) / period;
}

/** 光晕脉动系数 0..1 */
export function glowPulse(fx: ImageFx, tMs: number): number {
  const T = (tMs / 1000) * (fx.speed / 100);
  return 0.55 + 0.45 * Math.sin(T * 0.9);
}
