# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 常用命令

- `node --test test/` — 运行全部单元测试（node:test + assert/strict，无依赖）
- `node --test --test-name-pattern="visualRect" test/` — 按名称片段运行单个测试
- `node scripts/make-icons.js` — 重新生成图标（零依赖 PNG 生成器）
- `python3 -m http.server 8000` 后访问 `http://localhost:8000/test/fixtures/long-page.html` — 手工测试页；`#tall` 为超长模式（触发多 part 拆分）

无构建步骤。改动代码后必须到 `chrome://extensions` 手动点重新加载（Chrome 137+ 已移除 `--load-extension` 命令行参数，无法用 CLI 自动加载）。

## 架构

MV3 扩展，纯原生 JS。权限只有 `activeTab` + `scripting`（无 host_permissions → 安装零警告），这是硬约束，不要引入需要额外权限的 API。

**数据流**：点击图标 → `background.js`（service worker）按固定顺序注入 5 个 content script（stitch → select → capture → preview → main；重复点击靠 `window.__fpsMainLoaded` ping/pong 复用）→ 选区遮罩 → 截取循环（content script 滚动页面，每帧发消息给 background 调 `chrome.tabs.captureVisibleTab`，dataUrl 回传后在 content 侧解码绘制）→ 拼接 canvas → 预览浮层（下载 PNG / 复制剪贴板）。

**关键不变量**（跨文件才能看懂的部分）：

- `content/stitch.js` 是所有几何计算的纯函数核心（UMD：浏览器挂 `window.FpsStitch`，node 可 require），也是唯一的单元测试对象。任何可纯化的逻辑都应放这里并先写失败测试（TDD）。
- **截取坐标系**：拼接几何全部以 `startY`（选区顶边的内容坐标）为 0，`planFrames`/`assignParts`/`frameSlice` 不感知偏移；滚动时 `setTop(frame + startY)` 平移回内容坐标。「截取整页」= 选区带 `fromTop: true`，startY=0。
- **captureVisibleTab 限速 2 次/秒**：帧间隔 ≥520ms + 限速错误退避重试，与每帧 300ms 懒加载等待兼容。
- **fixed/sticky 处理是本项目最微妙的部分**（规则详见 spec §5.3，改动前先读）：所见即所得——框选覆盖的（`inSelection`，收集时刻用视觉矩形判定）在首帧出现一次；未吸顶 sticky 在自然位置出现一次（`stickyVisible` + relative 技巧测 `naturalTop`）；超半视口高的 sticky 视为滚动叙事内容永不隐藏（`stickyIsContent`）；零面积元素用可见后代包围盒（`visualRect`，GitHub blob 工具栏模式）。截取前先预热滚动一遍触发懒加载，每帧截屏前做弹窗清扫（新出现的 fixed 元素全程隐藏）。
- 拼接高度 × dpr 超 16384px 时沿帧边界拆分多张 PNG；dpr 从首帧实测量（`img.width / innerWidth`），不信 `window.devicePixelRatio`。
- 选区/预览 UI 在 Shadow DOM 里，样式经 `web_accessible_resources` 注入 `overlay.css`，`:host { all: initial }` 隔离页面样式。

## 约定

- spec 是活文档：`docs/superpowers/specs/2026-10-21-fullpage-shot-design.md`。行为变更时同步修订对应小节。
- 提交信息用中文 + conventional 前缀（`fix:` / `feat:` / `style:` 等）。
- 真实网站问题排查的既定工具：headless Chrome CDP 探针（`--headless=new --remote-debugging-port=9222` + Node 内置 WebSocket 脚本）。可以把 `stitch.js`/`capture.js` 源码注入线上页面，直接调用 `FpsCapture.collectFixedElements()` 等函数验证收集与可见性规则，配合 `Page.captureScreenshot` 存帧读图确认。
