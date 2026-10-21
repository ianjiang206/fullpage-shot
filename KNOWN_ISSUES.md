# KNOWN ISSUES

以下为实现计划中已发现、但按约定未修改的问题（按任务顺序记录）。

## 1. content/capture.js — 内部滚动容器截图未计入容器上边框

- 位置：`content/capture.js:94`（`containerTop`）、`content/capture.js:148`（`drawImage` 源 Y）。
- 理由：`target.getBoundingClientRect().top` 是 border box 顶部，而滚动内容从 padding box 顶部开始（需加 `target.clientTop`）。对测试页 `.inner-scroll`（3px 边框）会从边框顶开始取图，画面整体上移 3px，顶部出现边框、底部少 3px 内容。窗口滚动场景（`isWindow`）不受影响。

## 2. content/capture.js — 部分可见的内部滚动容器帧规划与裁剪错位

- 位置：`content/capture.js:94-98`、`content/capture.js:109`、`content/capture.js:121`、`content/capture.js:148`。
- 理由：非窗口容器把“当前视口中可见高度”当帧步长，但 `scrollTop` 的上限是 `scrollHeight - clientHeight`。当容器底部超出视口时，`planFrames` 会规划超过实际上限的位置，浏览器把 `scrollTop` clamp 后，后续帧的 `slice.sy` 假设与实际截图内容不一致，导致重复/缺失。容器顶部在视口上方时 `containerTop` 被 clamp 为 0，也会漏掉首屏上方的内容。若容器完整位于视口内，则不受影响。
