import './theme.css';
import { Store } from './store';
import { Renderer } from './render';
import { Player } from './player';
import { buildUI } from './ui';
import { exportGif, exportPngZip, exportVideo, exportProject } from './exporter';
import { analyzeImage } from './analyze';
import { coverFxForPreset } from './doc';
import FONT_B64 from '../fonts/NotoSerifSC.subset.b64.txt';

async function boot() {
  if (location.protocol === 'file:') {
    const warn = document.getElementById('fileWarn');
    if (warn) warn.style.display = 'block';
  }

  const canvas = document.getElementById('poster') as HTMLCanvasElement;
  const store = new Store();
  const renderer = new Renderer(canvas);
  renderer.setDoc(store.state.doc);
  const player = new Player(() => store.state.doc.duration);
  const ui = buildUI(store, renderer, player);

  // 内嵌字体就绪后重绘，避免首屏用后备字体测量导致跳版
  try {
    const face = new FontFace('Noto Serif SC Poster', 'url(data:font/woff2;base64,' + FONT_B64 + ')');
    await face.load();
    document.fonts.add(face);
  } catch { /* 加载失败则静默使用系统字体 */ }

  ui.fitCanvas();
  renderer.renderAt(player.currentTime);

  // 调试 / 自动化验收句柄
  (window as any).__ps = {
    store, renderer, player, ui, exportGif, exportPngZip, exportVideo, exportProject, analyzeImage, coverFxForPreset,
    whenImagesReady: () => renderer.whenImagesReady(store.state.doc),
  };
}

boot();
