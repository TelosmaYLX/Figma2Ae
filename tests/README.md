# AE 渐变回归

直接导出 AEP 的用法、范围和验证命令见 [scripts/aep/README.md](../scripts/aep/README.md)。

## 导出检查与打开文件夹

AEP 导出先完成 Figma 采集、图片处理和临时工程生成，再弹出原生保存窗口。可在窗口内修改工程文件夹名称，AEP 使用同名文件；同名目录加序号，不覆盖旧工程。字体缺失、图片损坏和不支持的效果均在选择位置前报错。取消、出错及保存完成后清理临时文件；成功后显示“打开文件夹”，开始新导出时隐藏旧按钮。

```powershell
node tests/direct-aep.cjs
node tests/direct-aep-ui.cjs
node tests/aep-open-directory.cjs
.\.venv-aep\Scripts\python.exe tests\aep-destination.py
node tests/aep-distribution.cjs
```

检查使用真实 Python/AEP 写入与 HTTP 服务，覆盖检查/窗口顺序、取消和失败清理、自定义中文名称、同名目录、临时素材删除后的相对引用、打开目录标识与错误，以及 UI 按钮显隐和重复点击。`aep-destination.py` 实际打开 Windows 保存窗口，自动输入中文名称并测试取消，不创建工程。Explorer 启动回归确认窗口可见；本机另通过 Shell.Application 实测中文及空格目录可见。Figma UI 由测试模拟；分发测试可通过首个参数指定分发目录。

## 图片像素对齐

小数边界的栅格内容放入对齐选区像素网格的透明画布，保留原图形变换；避免紧贴内容的 PNG 宽高取整改变比例，再在 AE 中重新采样。已对齐的内容直接导出。普通原始图片不重采样，切图倍率和预合成尺寸保持原规则；AEP 图层写入最佳质量及双三次采样。

```powershell
node tests/raster-pixels.cjs
node tests/raster-scale.cjs
node tests/bicubic-export.cjs
node tests/aep-layout.cjs 1
node scripts/ae-eval.mjs tests/ae-aep-layout.jsx artifacts/aep-layout-pixels-ae-1x.json
node tests/aep-layout.cjs 4
node scripts/ae-eval.mjs tests/ae-aep-layout.jsx artifacts/aep-layout-pixels-ae-4x.json
```

像素检查使用实际导出代码与模拟 Figma 画布，覆盖 1×/2×/3×/4×、双三次输出、原变换与小数偏移、透明补边和失败清理。真实 AE 检查临时导入生成的工程，核对图片倍率、像素比例、位置和采样设置，渲染后移除测试项目项。上述检查不替代一次新的在线 Figma 导出画面对照。完整画布边界使用 Figma 的 [useAbsoluteBounds](https://developers.figma.com/docs/plugins/api/ExportSettings/#useabsolutebounds-boolean-readonly)。

## 锚点与栅格比例

AEP 的形状按路径边界、文字按字形边界、图片及预合成按素材尺寸居中锚点，并补偿位置保持画面不动。文字补齐原生连续栅格化标志，避免 AE 把字形内容边界读成整张合成。切图倍率默认 1×，可选 1×/2×/3×/4×；栅格 PNG 携带 `rasterScale`，AE/AEP 按倍率倒数缩放；普通图片保留原始像素与 FIT/FILL，不按栅格规则处理。

```powershell
node tests/raster-scale.cjs
node tests/aep-layout.cjs 1
node tests/reference-layer.cjs
node scripts/ae-eval.mjs tests/ae-aep-layout.jsx artifacts/aep-layout-ae-report.json
```

检查覆盖四档倍率、默认值及再次导出重置、投影的像素偏移、分数尺寸 PNG、贝塞尔极值、参数形状、文字对齐/旋转、段落/富文本、渐变文字、蒙版及嵌套预合成。前三条使用生产代码、模拟 Figma 和真实 AEP 回读；`aep-layout.cjs` 可传入其他倍率。最后一条需已打开 AE/F2A 面板，实际导入工程，核对全部图层内容中心与锚点、图片比例及位置，并渲染 `artifacts/aep-layout-ae.png`。报告须 `passed: true`；检查结束清理临时导入项，恢复之前的活动合成。倍率下拉框使用模拟 UI 验证默认值、选值传递和导出锁定，未进行本轮真实 Figma 窗口截图验收。

## 文字透明度

文字图层的整体透明度、纯色填充透明度和富文本各段透明度分别保存。父组透明度由预合成承担；不生成预合成时才计入文字整体透明度。富文本每段的填充透明度通过 AE 原生文字范围选择器写入，保留为可编辑文字；渐变文字同时保留渐变填充自身的透明度。

```powershell
node tests/text-opacity.cjs
node tests/aep-fidelity.cjs
```

`text-opacity.cjs` 使用实际 Figma 采集函数生成真实 AEP，再递归回读其二进制属性。检查普通/富文本、段落/旋转文字、0% 透明度、各段不同透明度、隐藏填充、渐变填充及父组透明度不重复应用。Figma 场景由测试模拟，AEP 回读不替代 AE 实际显示验收。

原生检查脚本为 `tests/ae-text-opacity.jsx`，先运行上述测试生成输入，再在 AE 中运行该脚本；它验证 AE 导入与生成的 AEP，清理临时项目项后写入 `artifacts/text-opacity-ae-report.json`。仅在该报告 `passed: true` 时视为宿主验证通过。

## 出错图层定位

图层校验失败时，错误提示下方显示“定位图层”。按钮按原图层 ID 选中并缩放到对应对象，同名图层不会混淆；导出副本清理后仍可定位，切换页面后会返回目标所在页。图层已删除时显示提示，没有图层目标的错误不显示该按钮。

```powershell
node tests/error-layer.cjs
```

检查使用实际导出代码与 UI，模拟 Figma 选中和视口接口，覆盖同名节点、多选、临时副本删除、字体/图片/背景模糊错误、跨页、目标删除和延迟桥接回执。没有将该检查表述为真实 Figma 窗口点击验收。

## 图片保存位置

Figma 插件和 AE 面板均显示“图片保存位置”，右侧文件夹按钮可重新选择。完整地址支持换行和复制，两端共用 AE 面板记住的目录。首次点击“导入到 After Effects”时，如未设置目录或原目录已失效，会先打开目录窗口；取消或选择失败时不开始导出。图片先写入所选目录，再通过该目录交给 AE 导入。

```powershell
node tests/image-folder.cjs
node tests/client-import-queue.cjs
node tests/bridge-batch.cjs
node tests/direct-aep-ui.cjs
```

检查覆盖目录显示、原生 CEP 窗口调用、重选与取消、无效路径、导入期间禁止修改、真实 HTTP 接口、PNG 写入及导入数据中的路径。Figma 和 CEP 窗口 API 由测试模拟；代码更新后需重新运行 Figma 插件并重新打开 AE 的 F2A 面板。

## AE 渐变

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

检查覆盖多选标记、重复点击、取消标记、嵌套边界、直接选择已标记根节点、关闭自动栅格化、文字自动栅格化开关、父组去重、旧 SVG 模式、重复导出、边界缓存隔离，以及慢图片等待完整批次、失败图片取消整批导入。UI、主线程和桥接使用实际源码，Figma API 由测试场景模拟。

## 局部栅格化与明确失败

开启“忽略隐藏图层”时，蒙版作用范围内没有可导出对象，则跳过这个空蒙版，不再中止整批导出，也不把蒙版本身输出成图片。隐藏蒙版仍按隐藏规则跳过；其他蒙版和裁剪边界保持各自的作用范围。

```powershell
node tests/empty-masks.cjs
```

检查使用实际导出函数与模拟 Figma 节点，覆盖空矢量/图片蒙版、全部内容隐藏、隐藏蒙版、后续有效蒙版和裁剪边界，确认不读取空图片蒙版的素材且不改动原图层。

```powershell
node tests/raster-scope.cjs
node tests/aep-fidelity.cjs
node tests/blend-merge.cjs
node tests/bridge-batch.cjs
node tests/client-import-queue.cjs
```

当前自动策略不再将子层图片、效果或布尔标记向父组传播。位图保持独立；布尔结果优先保留矢量；简单蒙版保留原生遮罩，组遮罩放在预合成上；复杂蒙版只处理相关兄弟层，保留父组背景及其他图层。普通投影与内容分离，混合区间内不相交的图形与文字同样保留。下文关于复杂组整体栅格化、失败图片继续导入及组效果强制烘焙的描述属于旧版验证记录，以本节为当前行为。

检查包含裁剪与多蒙版边界、父样式隔离、异常还原、原图不变、原生组遮罩不重复、图片/路径/字体/效果失败的具体错误，以及桥接取消失败批次后继续下一次导入。AEP 检查生成真实二进制文件，但 Figma API/PNG 渲染仍使用模拟对象；没有将这些检查表述为新的在线 Figma 或 AE 画面对照。

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

## 副本导出与原图对照

导出先读取原选区的完整 2× PNG，再复制画框或组到临时容器。裁剪、文字和混合通道等导出操作只处理副本，结束或失败后删除整个临时容器并恢复原选择。多选时分别生成各选区的完整对照 PNG，再将副本组合导出。

对照图片以“原图对照”结尾命名，随同一批图片导入 AE。导入后放在主合成最上方并关闭可见性，不参与形状占位匹配和内部预合成；最终图层整理后再次置顶并隐藏。

```powershell
node tests/export-copy.cjs
node tests/reference-layer.cjs
node tests/client-import-queue.cjs
node tests/bridge-batch.cjs
```

检查原稿及祖先属性禁止写入、先参考图后复制、多选、副本创建和 PNG 失败后的整组清理，以及对照标记经过实际 UI、传输和图片保存流程后仍然保留。AE 图片构建器和排序逻辑通过模拟宿主检查；准备好的原生 `ae-export-smoke.jsx` 同时检查对照图位于主合成顶部且隐藏。本轮按用户先前要求不启动原生 AE 对照。

## 投影与可编辑文字

开启“自动栅格化复杂组”时，无文字的效果对象自动导出 Figma PNG，包含投影、内阴影和模糊。含文字的组或文字本身带有投影时，在副本上分别渲染带投影和移除投影后的 PNG，从两者的预乘颜色和透明度求出独立投影图片；背景绘制与文字分开导入，AE 不重复添加已烘焙的投影。

组投影采集时保留完整文字轮廓。选中根组的投影放在根预合成外侧，避免被根画框裁剪。文字本身保持可编辑；烘焙投影固定为导出时的内容，修改文字后需重新导出。显式星号和文字整体栅格化选项仍然优先。

保留可编辑文字的分离目前针对 `DROP_SHADOW`。含文字组的内阴影、模糊等非投影效果仍使用原有可编辑导入，尚未实现与文字分离的 Figma 效果图片，不能视作这部分效果已完成像素还原。

```powershell
node tests/figma-effects.cjs
node tests/client-import-queue.cjs
node tests/reference-layer.cjs
```

检查投影 RGBA 重合成、按钮组及文字自身投影、无文字效果自动栅格化、去除重复 AE 投影、根投影排除预合成，以及图片异步处理成功/失败时的导入队列。`tests/fixtures/raster-effects.html` 可用浏览器执行真实 PNG 解码、Canvas 提取和 PNG 再编码检查；本轮本地 Edge 检查的重合成单通道最大误差为 2/255。Figma 渲染在离线测试中模拟，真实 Figma 和 AE 画面对照尚未执行。

## 合并叠加模式图层

Figma 面板新增默认开启的“合并叠加模式图层”。关闭时恢复原有导出流程；该选项独立于“自动栅格化复杂组”。新面板向主线程显式传递 `mergeBlends: true`，旧面板和未传该字段的脚本继续原流程。

合并按底图依赖判断，不按模式名称建立永久安全名单。展开没有绘制、效果、不透明度或裁剪的穿透组，从叠加对象向下寻找能够覆盖其运算区域的不透明矩形/画框底图，或利用 Normal 等隔离组的透明边界。相互重叠的合并区间合成一次 PNG，在 AE 中使用 Normal，避免再次进行叠加运算。合并区间之外的图层及文字保持独立；区间内不与后续合并绘制相交的文字也保持可编辑，并提升到合并图片之上以保留可见性。真正参与叠加的文字随依赖范围烘焙。组投影先单独提取，保留上方文字；作用于全组的模糊、非完全不透明度或蒙版需要整组渲染。Normal 节点自身的填充/描边混合只烘焙该节点，Normal 画框的混合填充可与子文字分离。

底图在选区外且无法在当前范围闭合时，不将透明叠加误改为 Normal；保留原模式，并提示选择更外层画框。该策略采用几何边界作保守判断，不能证明所有 Figma/AE 模式在任意透明度、位深和工作色彩空间下等价。背景蒙版仅在不透明 alpha 蒙版可以闭合范围时视作封闭；穿透组中的渐变 alpha、亮度蒙版无法仅凭底图几何证明闭合。

所有取样和属性修改仍在临时副本中执行。合并图片不参与其他图片占位匹配；SVG 模式抑制已合并节点的绘制，避免与 PNG 重复导入。同组内的合并图片保留在原预合成，跨组合并后提升结束组内剩余的前景，避免被合并图片遮住。原图对照仍为最上层隐藏图片。

```powershell
node tests/blend-merge.cjs
node tests/bridge-batch.cjs
node tests/figma-effects.cjs
node tests/export-copy.cjs
```

检查闭合背景、嵌套穿透组、画框自身填充、保留/烘焙文字、扩大与合并区间、外部底图、填充混合、组投影和模糊、SVG 去重、失败清理及实际 UI 开关传递。Figma API/渲染在这些单元检查中使用模拟对象。

原生 AE 样例对照需要现有 `artifacts/card-brightness` 的真实 Figma PNG、源图层记录及本地原始背景图片：

```powershell
node tests/prepare-blend-comparison.cjs
node scripts/ae-eval.mjs tests/ae-blend-merge.jsx artifacts/blend-merge/native-report.json
python scripts/compare-blend-merge.py
```

在 AE 26.0、8 bpc、无工作色彩空间、未线性化的环境下，运行正式图片和文字导入器，对比独立叠加与合并背景。背景 4545 个取样像素的平均绝对 RGB 误差由 5.6357 降为 2.4398（0–255 范围），减少 56.71%；亮度偏差由 -3.8472 降为 -0.5995。可编辑文字与置顶隐藏对照层检查通过；实际预合成中的组内前景、跨组前景和避开叠加区域的文字顺序也通过原生 AE 检查。临时工程条目全部清理，测试前后项目条目数均为 1，未保存原工程。

这些像素结果使用已有真实 Figma 导出 PNG 与模拟节点 API，不代表当前文档的新鲜 Figma 导出或像素完全一致。2026-11-11 已尝试读取用户给出的云端文件 `fpAhwQB7hmcu0fWLfCAhC5` 节点 `3748:51614`，官方 MCP 返回 Starter 套餐工具额度耗尽，真实 Figma 端对照未执行。界面使用独立浏览器在 320、375、1280 宽度检查，无水平溢出，常规/展开工具区均可见。

### Group 节点属性回归

`GROUP` 没有 `fills` / `strokes` 属性。合并导出临时抑制容器绘制时，只保存、清空和恢复该节点实际支持的绘制属性；已包含在 PNG 中的容器绘制也按相同能力检查移除。

```powershell
node tests/figma-node-api.cjs
```

测试在严格模式下使用不带填充/描边的不可扩展 Group，并保持克隆后的节点不可扩展。修复前可复现 `Cannot add property fills, object is not extensible`，修复后普通合并、嵌套组、组投影，以及复杂组栅格化开关的检查均通过。该回归检查模拟原生节点的属性限制，没有执行新的在线 Figma 渲染。

## 图片与独立蒙版

```powershell
node tests/native-image-masks.cjs
node tests/direct-aep-ui.cjs
```

使用实际采集代码与模拟 Figma API，检查原图字节保留、独立矢量／Alpha／亮度蒙版、蒙版内可编辑文字，以及图片自身 CROP 与外部蒙版的嵌套。生成真 AEP，再读取二进制检查素材尺寸、原图变换和轨道遮罩关系；也覆盖默认关闭、重复导出重置、自动栅格化关闭和双三次选项。UI 检查覆盖新选项的默认值、参数传递和导出期间禁用。设置面板在 320、375、1280 像素宽度检查，无水平溢出。

原生 AE 属性检查需先生成上述测试数据，在 AE 空闲且 F2A 面板打开时运行：

```powershell
node scripts/ae-eval.mjs tests/ae-native-image-masks.jsx artifacts/native-image-masks/ae-report.json native-image-masks
```

脚本只创建并清理测试项，不替换或保存当前工程。本轮尝试遇到脚本回调超时，尚未形成完整原生 AE 报告；离线检查不代表新的真实 Figma → AE 端到端或像素一致性验收。
