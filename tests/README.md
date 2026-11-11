# AE 渐变回归

需要 AE 26，以及已打开的 F2A 面板（调试端口 8621）。测试使用内置 Node 和项目现有的渐变预设，不需要安装依赖。

```powershell
node tests/prepare-gradients.cjs
node scripts/ae-eval.mjs tests/ae-gradients.jsx artifacts/gradient-test/report.json
```

数据来自 SampleProject 的 `pinball_game_container`（Figma 节点 `1793:131401`），只保留本次故障涉及的七个渐变形状、三个文字和祖先容器。

测试在独立文件夹中创建临时合成，检查：

- 音乐按钮和四个兑换标签的原生渐变及纯色底层。
- 三个可编辑文字的渐变填充。
- 嵌套预合成后，文字与渐变仍在同一合成且保持遮罩关系。
- 单个形状失败后，其他渐变形状和文字仍可继续创建。

测试结束会删除本次创建的临时文件夹并恢复原来的合成视图。结果写入 `artifacts/gradient-test/report.json`，以 `passed` 字段判断成功。

## 排版、旋转和亮光

```powershell
node tests/export-fidelity.cjs
node scripts/ae-eval.mjs tests/ae-punctuation.jsx artifacts/fidelity/punctuation-report.json
```

导出检查覆盖已渲染 PNG 不重复旋转、原始位图保留旋转、柔光分层顺序、保留原遮罩、文字描边，以及导出失败后还原 Figma 属性。AE 检查使用真实副标题，验证普通文字和富文本的标点宽度，同时保留其他字符的字偶距，并检查可编辑的外侧文字描边。

本地 SVG 的光效对照可通过以下命令复现：

```powershell
python scripts/extract-light-passes.py
node scripts/render-svg-passes.mjs
python scripts/prepare-light-replay.py
node scripts/ae-eval.mjs scripts/replay-ae.jsx artifacts/fidelity/final-report.json final
```

光效对照从原 SVG 提取普通纹理和两层柔光，不使用参考 PNG 裁图替代素材。该检查验证 AE 的实际合成；Figma 端导出状态和分层行为另由 `export-fidelity.cjs` 验证。

完整样例的前后渲染、对照图和本地回放数据位于 `artifacts/fidelity/`；它们不进入 Git。`scripts/replay-ae.jsx` 可以回放该目录的数据，`scripts/compare-fidelity.py` 可以重新生成对照图。

## 导出速度和星号标记

选中 Figma 图层后点击“标记栅格化”，名称会加上 `*` 前缀；“取消标记”只移除所选图层的前缀。标记组时包含组内文字，作为一张 PNG 导入。关闭“自动栅格化复杂组”后，星号仍生效；取消标记后恢复自动策略。

“文字自动栅格化”默认关闭。开启后，每个剩余文字图层分别导出 PNG，不修改名称；已随父组栅格化的文字不重复导出。该选项独立于复杂组栅格化，关闭后下一次导出恢复可编辑文字。

```powershell
node tests/export-options.cjs
node tests/bridge-batch.cjs
node tests/benchmark-export.cjs
```

检查覆盖多选标记、重复点击、取消标记、嵌套边界、直接选择已标记根节点、关闭自动栅格化、文字自动栅格化开关、父组去重、旧 SVG 模式、重复导出、边界缓存隔离，以及慢图片或失败图片只触发一次整批导入。UI、主线程和桥接使用实际源码，Figma API 由测试场景模拟。

性能报告位于 `artifacts/export-speed/report.json`。对比的是仓库 HEAD 与当前代码的属性读取次数、SVG/字体调用次数和数据尺寸，不代表真实 Figma 文件到 AE 的总耗时。

```powershell
node tests/prepare-export-smoke.cjs
node scripts/ae-eval.mjs tests/ae-export-smoke.jsx artifacts/export-smoke/ae-report.json
```

此检查由实际导出函数直接生成数据包，不另行修正 JSON；Figma PNG 渲染由已有样例 PNG 模拟。真实 AE 通过正常 `runImport`、`runImportImages`、`runOrganize` 入口读取数据，验证混合导入保留形状与文字，而标记子树只生成图片。测试结束清理临时项目项并恢复原合成视图。

代码更新后需重新运行 Figma 开发插件，并重新打开 AE 的 F2A 面板，以加载导出代码与整批传输协议。

## PSD4V185 参考功能

参考 `D:\Software\Figma\PSD4V185\code.js` 与 `ui.html` 的功能行为，按 F2A 数据通道实现，未引入 PSD 写入库。

| 功能 | 默认与范围 |
|---|---|
| Group 整组栅格化 | 默认关闭；合并实际 Group 的全部内容，多选时临时包装组不参与该策略 |
| 实例整体栅格化 | 默认关闭；实例按一张 PNG 导入 |
| 保留画框裁剪 | 默认开启；关闭时临时解除选区及祖先裁剪，导出结束或失败后恢复 |
| 沿路径文字 | 按图片导入，避免丢失曲线路径排版 |
| 可编辑段落样式 | 保留像素/百分比显式行距、段后间距和首行缩进；富文本分段保留行距 |
| 分离实例 | 手动按钮；递归处理选中范围中的嵌套实例 |
| Group 转 Frame | 手动按钮；保留变换、绘制顺序、透明度及效果属性，跳过蒙版组 |
| 展开空分组 | 手动按钮；移除无绘制内容的透传容器，保留填充、效果、裁剪、蒙版、自动布局和隔离混合的容器 |
| 清理隐藏图层 | 手动按钮；保留选中根节点，移除其隐藏子树；实例内部需先分离 |

```powershell
node tests/layer-tools.cjs
node tests/export-options.cjs
node tests/bridge-batch.cjs
node tests/prepare-export-smoke.cjs
node scripts/ae-eval.mjs tests/ae-export-smoke.jsx artifacts/export-smoke/psd4-ae-report.json
node scripts/ae-eval.mjs tests/ae-paragraph.jsx artifacts/export-smoke/paragraph-report.json
```

整理工具检查通过实际 UI 按钮调用主线程处理，Figma 场景 API 使用模拟节点，覆盖旋转、镜像、缩放、嵌套分组及分组原点自动变化。AE 检查验证 Group/实例图片层、裁剪开关对应的原生遮罩数量，以及真实文字文档的行距和段落属性；PNG 渲染仍使用样例图片模拟，不等同于真实 Figma 文件的视觉验收。

## 导入撤销与重做

面板收到整批图片并完成素材保存后，使用一次 `runImportBatch` 调用创建形状、文字、图片及预合成。`AEShapeBuilder.withUndo` 统一管理这次同步调用的撤销组；内部构建函数共享该组，不跨 CEP 回调保留撤销组。连续导入按队列串行执行，并在接收数据时绑定目标合成。

```powershell
node tests/undo-transaction.cjs
node tests/client-import-queue.cjs
node tests/prepare-undo.cjs
node scripts/ae-undo-boundary.mjs
```

原生检查需要完整的 `artifacts/fidelity/` 回放数据及已打开的 F2A 面板。测试在临时合成中导入完整样例，等待导入脚本返回 CEP 后，在下一次脚本调用中执行一次真实撤销及重做；检查新增项目项、图层、渐变、预合成和遮罩关系，并清理测试内容、恢复原视图。结果位于 `artifacts/undo/boundary-report.json`。

脚本检查还覆盖嵌套构建、解析/预合成异常后的撤销组闭合、图片失败、选择文件夹取消、目标合成切换及多次导入不交错。旧版本已经写入当前 AE 会话的撤销记录不会被更新；验证新流程需重新打开 F2A 面板，再进行新的导入。

## 卡面背景亮度

复杂组在首个混合图层之前已有完整、不透明的矩形底色时，保持为一张 Figma PNG，让柔光、加深等内部混合在 Figma 中完成。背景不完整、渐变透明、透明度降低或需要外部底图的光效继续分离混合通道。文字仍通过文字通道导入；星号标记与文字栅格化选项保持原有规则。

Figma 的 `LINEAR_DODGE` 在 SVG 中导出为 `plus-lighter`。AE 使用 `Add` 保留透明发光的加法结果；原来的 `Linear Dodge` 对透明发光偏暗。

```powershell
node tests/export-fidelity.cjs
node tests/export-options.cjs
python scripts/recover-card-test-assets.py
node tests/prepare-card-brightness.cjs
node scripts/ae-eval.mjs tests/ae-card-brightness.jsx artifacts/card-brightness/ae-report.json
python scripts/compare-card-brightness.py
```

本地视觉检查使用 `D:\Users\Desktop\F2A test.aep`、已保存的工程图层记录 `artifacts/card-brightness/project-before.json`，以及原有 Figma 背景 PNG `D:\Users\图片\temp\bg_s_img_36.png` 和圆形图标 PNG。准备脚本执行实际导出函数，Figma 场景节点由模拟对象提供，PNG 字节来自这些已有真实导出素材。AE 检查通过当前 `buildImages` 生成新的背景与图标，保留工程中的可编辑计数文字；当前未打开样例工程时，将其作为临时项目项导入，结束后清理测试内容、恢复原视图。原工程不保存。

输出 `comparison.png`、`metrics.json` 和 `ae-report.json` 位于 `artifacts/card-brightness/`。该检查验证真实 AE 合成与导出决策，不代表已完成一次新的在线 Figma 导出。

样例引用的临时 PNG 可能被后续导出覆盖。`recover-card-test-assets.py` 按原素材尺寸筛选，并要求按样例变换后的 RGBA 像素与留存图层完全一致，再复制到 `verified-assets/` 供测试使用。

2026-11-11 本轮已通过离线导出检查；按用户要求暂停原生 AE 对照。目录中原有 AE 渲染与指标属于此前记录，不能作为本轮通过的证据。当前检查状态见 `artifacts/card-brightness/current-validation.json`。

## 导出位置

```powershell
node tests/export-position.cjs artifacts/position-check/report.json
```

检查含小数坐标的形状、文字、图片共享同一画框原点；节点导入分支不应用 SVG 的画布位移。栅格边界重复测量不得累加平移，分层导出用透明度抑制其他绘制，避免隐藏图层导致自动布局重新排版；导出失败后恢复原透明度和混合模式。测试执行实际导出、SVG 解析和宿主入口，Figma 自动布局与裁剪行为使用模拟对象；未执行真实 Figma 或 AE 画面对照。
