// 字体子集化：Noto Serif SC (woff2) → 常用4000字+符号子集 woff2
// 运行：node tools/subset-font.mjs（需 managed workspace 已装 fonteditor-core）
import fs from 'node:fs';
import path from 'node:path';
import fe from 'file:///C:/Users/15040/.workbuddy/binaries/node/workspace/node_modules/fonteditor-core/lib/main.js';
const { createFont, woff2 } = fe;

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'fonts/NotoSerifSC.woff2');
const CHARS = path.join(ROOT, 'fonts/common4000.txt');
const OUT = path.join(ROOT, 'fonts/NotoSerifSC.subset.woff2');

// 应用默认文案 + UI 可能出现的字符，全部纳入子集，防止回退
const APP_TEXT = '动态海报编辑器文字海报把文字海报变成会动的片头时长延迟间隔缓动曲线打字机逐字上浮整行滑入遮罩扫过缩放回弹背景缓推播放暂停循环导出序列帧图模板分享保存恢复撤销重做图层检查器时间轴进度拖拽动画块点击输入你的内容每按一次节拍都会跳动一次让画面跟随音乐呼吸示例作品预览中不分平台均可离线打开使用';

const ascii = [];
for (let c = 0x20; c <= 0x7e; c++) ascii.push(String.fromCodePoint(c));
const symbols = '，。！？；：、「」『』（）《》—…·～￥【】{}[]#@%&*+-=/\\|<>$^_~`"\'';
const punctFull = '，。！？；：、（）《》—…';

async function main() {
  await woff2.init();
  const buf = fs.readFileSync(SRC);
  const full = createFont(buf, { type: 'woff2' });
  const cmap = full.get().cmap;

  const charset = new Set();
  for (const ch of [...APP_TEXT]) charset.add(ch);
  for (const ch of ascii) charset.add(ch);
  for (const ch of symbols + punctFull) charset.add(ch);
  const list = fs.readFileSync(CHARS, 'utf8');
  for (const ch of list) if (/\S/.test(ch)) charset.add(ch);

  const indices = new Set([0]); // .notdef
  const missing = [];
  const charCodes = new Set();
  for (const ch of charset) {
    const cp = ch.codePointAt(0);
    charCodes.add(cp);
    const g = cmap[cp];
    if (g === undefined || g < 0) missing.push(ch);
    else indices.add(g);
  }
  const sub = createFont(buf, { type: 'woff2', subset: [...charCodes], hinting: false });
  const out = Buffer.from(sub.write({ type: 'woff2', hinting: false }));
  fs.writeFileSync(OUT, out);
  const b64 = fs.readFileSync(OUT).toString('base64');
  fs.writeFileSync(path.join(ROOT, 'fonts/NotoSerifSC.subset.b64.txt'), b64);
  console.log('charset:', charset.size, 'glyphs:', indices.size, 'missing:', missing.length, missing.slice(0, 20).join(''));
  console.log('subset woff2 bytes:', out.length, 'base64 chars:', b64.length);
}

main().catch(e => { console.error(e); process.exit(1); });
