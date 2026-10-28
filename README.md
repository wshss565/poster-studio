# poster-studio · 动态海报编辑器

<p align="center">
  <b>在线体验 → https://wshss565.github.io/poster-studio/</b>
</p>

<p align="center">
  浏览器端动态海报 / 动态专辑封面编辑器 ｜ 纯前端单文件 ｜ 无后端、无账号、离线可用 ｜ 数据只存本机
</p>

---

## 它做什么

做一张**会动的海报**：加图层、上动效、认主体、调构图，导出 GIF / PNG 序列 / MP4。

- **海报模式**：文字 / 图片 / 背景多图层，逐字与整层两套动效求值，缓动函数可配
- **封面模式**：1:1 画板，单图恒铺满，13+ 参数封面动效（推镜、节拍脉冲、扫光、星尘……）
- **主体识别**：纯前端图像分割（Canvas 2D，无模型下载），自动区分主体与背景，支持框选 / 擦除 / 补回的手动修正
- **频闪特效族**：提亮闪 / 压暗闪 / 反相闪 / 抽色闪 / 切片错位，共用一条方形波；默认 3Hz 并带光敏性警告（WCAG 2.3.1）
- **特效滤镜**：像素化 / 色差 / 双色调 / 扫描线 / 网点
- **工程文件**：Doc JSON 导出 / 导入，换设备续编
- **导出**：GIF（600 档 3.7~6.2s）、PNG zip（1080 档）、MP4（MediaRecorder 逐帧推流，WebM 兜底自动补 EBML Duration）

## 设计约束

- **单一渲染源**：`Renderer.renderAt(t)` 同时服务预览与导出，杜绝"预览 ≠ 导出"
- **单一数据源**：Doc JSON（图层 + 动效 + 画布 + 时长），可序列化、可分享
- **导出强制 1:1**：预览降分辨率渲染，导出三路径统一 `atFullResolution()` 并逐帧断言 `canvas.width = doc.w`

## 质量门

| 检查 | 结果 |
|---|---|
| `tsc` 类型门 | 0 错误 |
| 逻辑单测（qa/logic-test.mjs） | 483 / 483 |
| 封面模式 E2E（qa/e2e-cover.mjs） | 125 / 125 |
| 海报模式 E2E（qa/e2e.mjs） | 41 / 41 |
| 视频导出元数据（时长可解码） | 13 / 13 |

## 技术栈

TypeScript + esbuild（IIFE 单文件，CSS/JS/字体全部内联）｜ Canvas 2D 渲染管线｜ 无框架、无运行时依赖

## 本地运行

仓库根目录的 `index.html` 即完整应用，双击即可用（`file://` 无降级项）。

```bash
# 重新构建（需要 esbuild）
npm install
node build.mjs   # src/main.ts → standalone.html
```

## 目录

```
.
├── index.html          # 构建产物（单文件应用，开箱即用）
├── src/                # TypeScript 源码
│   ├── doc.ts          #   文档模型与迁移钳制
│   ├── render.ts       #   排版与预处理缓存
│   ├── analyze.ts      #   主体识别（纯函数）
│   ├── anim.ts         #   动效求值（逐字 / 整层）
│   ├── exporter.ts     #   GIF / PNG / MP4 导出
│   └── ...
├── template.html       # 单文件装配模板
└── build.mjs           # esbuild 构建 → standalone.html
```

> 字体子集化所需的原始 woff2 未随仓库分发（构建产物已内嵌子集字体）。

## 已知限制

- 掩膜分析分辨率 192²，边缘有 3–4px 过渡带
- 深色主体贴深色背景仍可能漏块（`estimateBackground` 启发式）
- 图片以 dataURL 存工程文件，受 5MB 配额约束
- 后台标签页浏览器不绘制 canvas，导出 MP4 会显式报错而非录出静止文件

## 说明

个人项目，持续迭代中。反馈问题欢迎提 Issue。
