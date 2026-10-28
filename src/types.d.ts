// 字体以 base64 文本内嵌（build.mjs 的 '.txt' loader）
declare module '*.txt' {
  const s: string;
  export default s;
}

// CSS 由 esbuild 处理，TS 只需要知道这是个可副作用导入的模块
declare module '*.css';

// gifenc 没有随包类型，这里给出用到的那三个 API
declare module 'gifenc' {
  export function GIFEncoder(opts?: Record<string, unknown>): {
    writeFrame(index: Uint8Array, w: number, h: number, opts?: Record<string, unknown>): void;
    finish(): void;
    bytes(): Uint8Array;
  };
  export function quantize(data: Uint8Array | Uint8ClampedArray, maxColors: number, opts?: Record<string, unknown>): number[][];
  export function applyPalette(data: Uint8Array | Uint8ClampedArray, palette: number[][], format?: string): Uint8Array;
}
