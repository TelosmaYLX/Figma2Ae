# AE 渐变回归

## 不含运行环境的分发包

```powershell
node scripts/package-dist.cjs
node tests/package-dist.cjs
```

压缩包输出到 `dist/F2A-Windows-x64-v<版本号>.zip`，只按明确的文件清单收集运行文件，
保留第三方许可证，不包含 Node、Python、虚拟环境、账号配置、开发记录或测试素材。
安装说明在包内 `README.txt`；用户自行安装 Node.js 20+、Python 3.11+（64 位，含 Tcl/Tk），
再运行 `install.cmd`。安装时联网安装固定版本的 Python 依赖，选定客户端后可一键配置 MCP。

检查会实际解压 ZIP 到中文及空格路径，校验文件清单、哈希及隐私扫描，创建全新的
Python 虚拟环境并安装依赖，通过包内 HTTP 服务生成真实 AEP，再启动无 `node_modules`
的 MCP 服务并枚举工具。安装脚本只做 Windows PowerShell 语法检查，不写入本机注册表；
没有执行第二台设备安装或真实 Figma/AE 界面验收。

## 内置 MCP

F2A 内置 Cursor Talk to Figma MCP 和 Figwright 工具，使用方式与一次性客户端配置见
[mcp/README.md](../mcp/README.md)。

```powershell
node tests/mcp.cjs
node tests/mcp-start.cjs
node tests/mcp-figwright.cjs
```

检查使用独立 stdio MCP 进程、真实 HTTP/WebSocket 中继、实际 F2A UI 和内置命令，
执行前先按 Figma 沙箱的文本扫描规则检查动态导入，防止依赖注释触发整个插件启动拒绝；
覆盖 165 个工具的发现（含 11 个图层整理工具）、读写、单文档自动连接、多文档选择、
导出互斥、错误与空值、超时和断线。冷启动检查在中文/空格临时目录中同时启动四个
连接，确认复用同一个后台中继；运行目录不含 node_modules。Figma API 对象由测试模拟，
不替代真实 Figma 文档操作验收。`scripts/preview-export-ui.mjs` 检查新增连接状态的布局。

`mcp-figwright.cjs` 在相同链路上检查移植的 109 个工具：完整设计上下文、渐变/效果/布局、
样式、变量与绑定、混合批处理与撤销、矢量路径、本地图片、原始素材去重保存、截图、
PDF/视频字节落盘，以及协作遍历通过实际 iframe 的消息往返。Figma 编码器由测试替身代替。
同时检查上游源码清单的 SHA-256，保证适配没有改写 vendored 源码。

## MCP 图层整理工具

```powershell
node tests/mcp-layer.cjs
```

在模拟 Figma 文档上运行生成的 `figma-plugin/code.js`，检查 F2A 追加的 11 条命令：
成组要求同一父级、解散把子级放回组原来的位置、`reorder_nodes` 的索引语义与越界置顶、
`reparent_nodes` 保持画布绝对坐标和拒绝移入自身子树、`keepPosition:false` 退回原生行为、
`batch_rename_nodes` 跳过缺失节点、显隐与锁定批量生效、`set_clips_content` 只对容器生效、
`search_nodes` 的名称/类型/子树/数量上限、`detach_instances` 的递归分离与位置/子级保留，
以及 `batch` 的 `"$N"` 引用、遇错停止时保留已生效命令并返回 `rolledBack:false`、
`stopOnError:false` 继续执行和写命令白名单。分离检查还覆盖 `recursive:false` 只分离传入
节点、实例套实例直接分离时报错，以及缺失 id 跳过。调用走
构建产物里的 `F2AMCP.execute`，同时确认上游命令仍经新分发器可用。Figma API 由测试模拟；
新命令要在真实 Figma 里重新运行 F2A 插件后才会加载，真实文档验收仍需人工执行。

已有 AE 面板可运行 `node scripts/verify-mcp-cep.mjs --reload` 检查真实 CEP 启动；
`node scripts/verify-mcp-live.cjs` 通过独立 MCP 客户端读取实际连接的 Figma 文档和选区。
后者只读，不创建或修改设计。报告保存在 `artifacts/mcp`。

直接导出 AEP 的用法、范围和验证命令见 [scripts/aep/README.md](../scripts/aep/README.md)。

## 导出检查与打开文件夹

AEP 导出先完成 Figma 采集、图片处理和临时工程生成，再弹出原生保存窗口。可在窗口内修改工程文件夹名称，AEP 使用同名文件；同名目录加序号，不覆盖旧工程。字体缺失、图片损坏和不支持的效果均在选择位置前报错。取消、出错及保存完成后清理临时文件；成功后显示“打开文件夹”，开始新导出时隐藏旧按钮。

```powershell
node tests/direct-aep.cjs
node tests/direct-aep-ui.cjs
node tests/aep-open-directory.cjs
powershell -NoProfile -ExecutionPolicy Bypass -File tests/aep-open-directory.ps1
.\.venv-aep\Scripts\python.exe tests\aep-destination.py
node tests/aep-distribution.cjs
```

检查使用真实 Python/AEP 写入与 HTTP 服务，覆盖检查/窗口顺序、取消和失败清理、自定义中文名称、同名目录、临时素材删除后的相对引用、打开目录标识与错误，以及 UI 按钮显隐和重复点击。`aep-destination.py` 实际打开 Windows 保存窗口，自动输入中文名称并测试取消，不创建工程。`aep-open-directory.cjs` 检查目录参数和辅助进程；`aep-open-directory.ps1` 实测中文、空格及特殊字符目录在前台显示、从最小化恢复和重复打开复用窗口，结束后关闭测试创建的窗口。Figma UI 由测试模拟；分发测试可通过首个参数指定分发目录。

## AEP 目标版本

合成参数面板中的 AEP 版本提供 24.x、25.x、26.x 下拉框，默认 26.x。导出过程中锁定选择，版本写入归一化数据及最终报告。组件健康检查公布支持的目标版本，旧组件缺少此能力时在采集前提示更新。

```powershell
node tests/aep-versions.cjs
node scripts/ae-eval.mjs tests/ae-aep-versions.jsx artifacts/aep-versions/eval-result.txt
python tests/check-aep-version-renders.py
```

第一步通过实际 HTTP/UI 回归之外的真实写入器生成三个版本的基础图层和独立图片遮罩工程，检查原始二进制格式号 95.6/96.9/97.2、应用主版本、层级、位置、透明度及 alpha/luma 遮罩。第二步在当前 AE 26 中临时导入、核对原生文字和遮罩并渲染，结束后清理导入项和恢复用户队列。第三步比较各版本的 RGBA 画面。真实首页对照与用户提供的 24.x 样本记录见 `docs/analysis/aep-target-versions-2026-11-16.md`。本机没有 AE 24/25，不能用 AE 26 的读入结果代替这两个宿主中的原生打开验收。

## 面板设置记忆与合成参数

「导出为 AEP 工程」按钮位于合成参数面板底部，使用与上方「发送到 After Effects」相同的强调色；面板顶部是合成时长、帧率、AEP 版本三个并排下拉框，每项上方有 11px 小字标注，面板没有可见标题和说明文字。默认 10 秒、30 fps、26.x；时长可选 1、2、3、4、5、10、15、20、30、60 秒，时长和帧率也用于未打开合成时的新建合成，版本只影响 AEP 工程。

面板所有参数（本行、图层、文字、图片和高级选项）写入 Figma `clientStorage`（键 `f2a.panelSettings`），同时以 `localStorage` 兜底；重新打开面板后沿用上次选择，导出期间全部锁定。保存值只在控件存在对应选项时恢复，无效值保持当前选择或默认值。

```powershell
node tests/direct-aep-ui.cjs
node scripts/preview-export-ui.mjs
```

`direct-aep-ui.cjs` 覆盖默认值、三个合成参数的传递、导出锁定、设置往返恢复、无效缓存回退，以及合成参数面板位于发送按钮和图层工具之间、导出按钮在面板底部、面板无标题和说明文字、时长含 4 秒、导出按钮沿用发送按钮强调色、「保留图片调色属性」归入图片组并带新说明的结构断言。`preview-export-ui.mjs` 在 320、375、1280 宽度渲染面板，检查三列设置行没有水平溢出。

## 主合成默认打开

写入器在主合成所属文件夹中保存 Composition/Timeline 窗口块，将工程的活动项目指向顶层主合成，并保存 Fit up to 100% 视图。`check-aep-versions.py` 检查三个版本回读后均只有主合成带活动 Viewer，四个视口槽组成一个视图，内部预合成不打开；安装版隔离 Python 环境也分别生成并检查了三个目标版本。

`tests/ae-main-comp-open.jsx` 用于独立空白 AE 进程完整打开 `artifacts/aep-versions/cases.json` 中的工程，不调用 `openInViewer()`，直接检查恢复的主合成及预览窗口。它要求独立测试环境标记，拒绝在用户已有工程中运行。本轮该独立 AE 进程启动报 ORT API 版本错误，未取得完整打开结果，故不把文件回读检查视为真实 AE 打开验收。记录见 `docs/analysis/aep-default-main-comp-2026-11-16.md`。

## 图片像素对齐

小数边界的栅格内容放入对齐选区像素网格的透明画布，保留原图形变换；避免紧贴内容的 PNG 宽高取整改变比例，再在 AE 中重新采样。已对齐的内容直接导出。普通原始图片不重采样，切图倍率和预合成尺寸保持原规则；AEP 保留新建图层的默认质量与采样。

```powershell
node tests/raster-pixels.cjs
node tests/raster-backdrop.cjs
node tests/raster-scale.cjs
node tests/bicubic-export.cjs
node tests/aep-layout.cjs 1
node scripts/ae-eval.mjs tests/ae-aep-layout.jsx artifacts/aep-layout-pixels-ae-1x.json
node tests/aep-layout.cjs 4
node scripts/ae-eval.mjs tests/ae-aep-layout.jsx artifacts/aep-layout-pixels-ae-4x.json
```

像素检查使用实际导出代码与模拟 Figma 画布，覆盖 1×/2×/3×/4×、双三次输出、原变换与小数偏移、透明补边和失败清理。真实 AE 检查临时导入生成的工程，核对图片倍率、像素比例、位置和采样设置，渲染后移除测试项目项。上述检查不替代一次新的在线 Figma 导出画面对照。完整画布边界使用 Figma 的 [useAbsoluteBounds](https://developers.figma.com/docs/plugins/api/ExportSettings/#useabsolutebounds-boolean-readonly)。

背景模糊和玻璃切图的补边画布放在导出副本内、源节点的前一个绘制位置，保留原有背景采样顺序；不能放到页面最上层，否则上方文字会被采样进底框。自动布局中画布使用绝对定位，不参与布局。`raster-backdrop.cjs` 覆盖叶层、包含背景模糊的整组图片、独立文字及自动布局。真实首页的 Figma 复现、修复工程和 AE 对照见 `docs/analysis/homepage-backdrop-2026-11-16.md`；`tests/ae-home-backdrop.jsx` 读取该记录的 cases.json，在 AE 中验证独立矢量文字和底框的层序、素材完整性并渲染。

## 锚点与栅格比例

AEP 的形状按路径边界、文字按字形边界、图片及预合成按素材尺寸居中锚点，并补偿位置保持画面不动。文字补齐原生连续栅格化标志，避免 AE 把字形内容边界读成整张合成。切图倍率默认 1×，可选 1×/2×/3×/4×；栅格 PNG 携带 `rasterScale`，AE/AEP 按倍率倒数缩放；普通图片保留原始像素与 FIT/FILL，不按栅格规则处理。

预合成默认关闭塌陷变换。导出后仍保留叠加等混合层时，仅为其穿透祖先链标记 `collapseForBlends`；普通组、已合并内容保持关闭。正常混合模式、整体裁剪/蒙版、整体效果或透明度构成合成边界，不继续向上传递。直接创建和 AEP 写入使用同一标记，质量/采样不变。`node tests/blend-pass-through.cjs` 验证导出标记、保留蒙版和已合并内容；在独立空白 AE 会话运行 `tests/ae-blend-pass-through.jsx`（设置 `F2A_ROOT`、`F2A_BLEND_FIXTURE`）检查两个后端实际读入的塌陷状态。

共享独立蒙版内的图层需要与外部底图混合时，按绘制层分配蒙版，移除隔离这些混合层的共享 `maskScope`。每个绘制层的蒙版结果使用独立预合成，内部 Normal，原混合模式和透明度放在外层；穿透祖先连续开启塌陷。嵌套蒙版按层级保留，明确 Normal 的组仍保持隔离。原图图片的填充透明度直接传递，图片字节保留。`node tests/masked-blend-layers.cjs` 覆盖双层共享蒙版、加深模式、80% 图片填充、坐标及实际 AEP 写入；现有独立/嵌套图片蒙版检查覆盖不需要外部混合的范围。

2026-11-16，用户重开 F2A 后正常导出的 `pinball_game-card2` 已在 AE 26 渲染比对。相对实时 Figma 原图，建筑区平均绝对 RGB 误差从 78.1697 降至 3.6450，全图从 35.5167 降至 4.5617，范围为 0–255。工程素材缺失为零，KV 至根合成的塌陷链开启；这次结果来自新鲜 Figma 导出，不是模拟节点回放。圆环与发光仍有差异。样本及脚本见 `docs/analysis/owcs-card-color-2026-11-16.md` 和 `tests/ae-masked-blend-layers.jsx`。

未裁切容器在需要时扩展为实际内容边界并补偿位置，Figma 裁剪画框仍保留原边界。`node tests/comp-bounds.cjs` 及 `tests/ae-comp-bounds.jsx` 覆盖六个嵌套预合成，包括框外内容、外描边和半透明重叠；后者同时检查直接创建与 AEP 导入。平面参考只裁切 Figma 明确开启裁剪的画框，不能把错误的预合成裁切当成正确基准。文字的连续栅格化仍保留。

预合成的原点和画布边界统一对齐导出像素网格；原稿内容的小数坐标保留，进入/离开预合成的补偿避免再次采样。裁剪画框也使用对齐的画布，并以原生路径保存原有小数裁剪范围。`node tests/precomp-pixel-grid.cjs` 检查三个关闭塌陷的嵌套画框、源图片位置/比例和独立裁剪；`tests/ae-ring-pixels.jsx` 渲染真实卡面、直接导入的圆环及平面/嵌套位图，`python tests/check-precomp-pixel-grid.py --renders artifacts/owcs-ring-pixels-20261116` 要求两张位图 RGBA 逐像素一致。

与同层 Figma 蒙版组合的形状描边使用路径绘制，保留描边后裁剪的顺序；未遮罩的形状及文字继续使用原有图层样式。`stroke-styles.cjs` 的普通/细描边检查同时覆盖这两种结构。2026-11-16 用户正常导出的 `pinball_game-card3` 在 AE 26 的圆环区误差由 11.1402 降至 3.2812；发光 PNG 字节完全一致，缩放保持 100%。细节见卡面分析文档。

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
node tests/aep-error-layer.cjs
node tests/direct-aep-ui.cjs
```

检查使用实际导出代码与 UI，模拟 Figma 选中和视口接口，覆盖同名节点、多选、临时副本删除、字体/图片/背景模糊错误、跨页、目标删除和延迟桥接回执。没有将该检查表述为真实 Figma 窗口点击验收。

AEP 写入错误通过 Python → Node → HTTP → UI 保留原图层 ID。实际 HTTP 检查复现同名 `shadow` 分组、文字和图形的效果错误，确认定位目标与原节点相同；路径解析错误也保留 ID。AEP 专用采集在自动栅格化开启时渲染不支持效果的对象，普通 AE 导入继续保留原生组模糊。UI 回归确认写入失败后按钮可见、可点击且不清除错误提示；没有定位目标的连接/系统错误保持无按钮。报错界面在 320、375、1280 像素宽度检查，无水平溢出。Figma 节点和渲染使用模拟数据，未进行真实 Figma 文档的点击定位验收。

## 图片保存位置

只有 Figma 插件显示“图片保存位置”，右侧文件夹按钮可重新选择；完整地址支持换行和复制。目录仍由 AE 面板记住（`localStorage` 的 `f2a.imageFolder`），Figma 通过 HTTP 路由读取和更换，AE 面板本身不再显示这一行。首次点击“发送到 After Effects”时，如未设置目录或原目录已失效，会先打开目录窗口；取消或选择失败时不开始导出。图片先写入所选目录，再通过该目录交给 AE 导入。

```powershell
node tests/image-folder.cjs
node tests/client-import-queue.cjs
node tests/bridge-batch.cjs
node tests/direct-aep-ui.cjs
```

检查覆盖原生 CEP 窗口调用、重选与取消、无效路径、导入期间禁止修改、真实 HTTP 接口、PNG 写入及导入数据中的路径，并确认 AE 面板已移除该行与反馈入口、样式同步删除、最小窗口尺寸可按内容缩小。Figma 和 CEP 窗口 API 由测试模拟；代码更新后需重新运行 Figma 插件并重新打开 AE 的 F2A 面板。

## AE 面板运行日志

AE 面板是只读的桥接监视器：没有工具按钮、没有通知气泡，也没有弹出层，只保留标题、Figma 桥接与 MCP 两行状态和“运行日志”。两行状态间距 6 px（body 为纵向 flex，相邻外边距不合并，由 4 px 下边距加 2 px 上边距组成）。日志按时间顺序记录桥接连接与断开、MCP 状态、收到的任务及图片数量、投影合成、图片保存目录、交给 AE 导入和最终结果；最近 200 行，可点“清空”。日志占用窗口剩余高度并在内部滚动，面板缩短时先压缩日志，不会挤出状态行；`main.js` 先于两个桥接模块加载，首个事件也能记录。

```powershell
node tests/panel-log.cjs
node tests/image-folder.cjs
```

检查覆盖时间戳格式、正常/错误行着色、桥接消息经 `MKReport` 转写、200 行上限、消息按字面显示（尖括号不会变成标记）、清空按钮、脚本顺序，以及面板已无气泡、按钮和弹出层（含对应样式）。

## AE 渐变

需要 AE 26，以及已打开的 F2A 面板（调试端口 7368）。测试使用内置 Node 和项目现有的渐变预设，不需要安装依赖。

```powershell
node tests/prepare-gradients.cjs
node scripts/ae-eval.mjs tests/ae-gradients.jsx artifacts/gradient-test/report.json
```

数据取自历史样例工程中的 `pinball_game_container`（Figma 节点 `1793:131401`），已提取为 `tests/fixtures/pinball-gradients.json`，只保留本次故障涉及的七个渐变形状、三个文字和祖先容器；运行测试不再需要样例工程。

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

导出检查覆盖已渲染 PNG 不重复旋转、原始位图保留旋转、柔光分层顺序、保留原遮罩、文字描边，以及导出失败后还原 Figma 属性。AE 检查使用真实副标题，验证普通文字和富文本的标点宽度，同时保留其他字符的字偶距，并检查图层样式中的外侧文字描边。

光效对照的历史渲染与对照图位于 `artifacts/fidelity/`，不进入 Git；当时从原 SVG 提取普通纹理和两层柔光的提取、回放脚本依赖样例工程，已随该工程一并移除。当前由 `export-fidelity.cjs` 验证 Figma 端导出状态与分层行为。

## 图层样式描边

普通闭合形状和可编辑文字的纯色描边使用 AE「图层样式 → 描边」，保留颜色、尺寸、不透明度，以及内部/外部/居中位置。形状路径不再通过偏移路径模拟位置。无填充的边框隐藏承载形状的填充；透明填充与描边分别保存透明度。渐变/多重填充或多重描边需要独立的描边层，保留各自的绘制顺序。开放线条及渐变描边继续使用路径描边；虚线和小于 1 px 的描边按下述轮廓化路径处理。

```powershell
node tests/stroke-styles.cjs
node scripts/ae-eval.mjs tests/ae-stroke-styles.jsx artifacts/stroke-styles/ae-report.json
```

第一条使用构造节点检查共享解析器的两种输入、真实 AEP 写入及二进制回读；第二条在 AE 中检查直接创建和导入 AEP 后的样式启用状态、参数可编辑性、三种位置，以及形状中没有旧描边/偏移路径。实际宿主检查以报告的 `passed` 为准。在独立空白 AE 会话中传入 `export` 可保存 `artifacts/stroke-styles/native.aep`，再用 aerender 分别渲染其中的 `F2A stroke styles direct` 和 `Stroke styles` 合成作画面对照。这些检查不代替新一次在线 Figma 文档渲染。预设通过 `.venv-aep\Scripts\python.exe scripts/build-stroke-preset.py` 从项目现有图层样式模板生成，随扩展打包。

增加 `node tests/stroke-styles.cjs --thin` 覆盖旧 CLI 原始输入的 0.6666666865348816、0.9103375673294067、0.25、0.1 和 0.5 px 兼容路径。当前插件改为在导出副本上轮廓化虚线和细描边，不再产生这些缩放预合成。

```powershell
node tests/outlined-dashes.cjs
```

此检查运行生产采集器、解析器和真实 AEP 写入，模拟 Figma `outlineStroke()` 与 `flatten()` 返回的几何，覆盖填充与独立轮廓、端点曲线、旋转、蒙版、0.667/0.125 px 描边、细描边文字、多色字形及全部文字转矢量。场景位于页面 `(-321.5,4008)`，并与原点场景比较几何及渐变坐标，防止新轮廓漏掉原点换算或共享矩阵被重复平移。全部矢量模式使用本机不存在的字体名称，断言不生成文字图层。检查源图层/选择不变、副本清理和错误定位。`tests/ae-outlined-dashes.jsx` 仅在独立空白 AE 会话中运行：检查直接创建和 AEP 导入后的路径、叠放、透明度、渐变、轨道遮罩、图层内容范围，以及不存在细描边缩放预合成；报告和渲染工程写入 `artifacts/outlined-dashes/`。这不等同于在线 Figma 文档的轮廓化或像素对照。

## 导出速度和星号标记

选中 Figma 图层后点击“标记栅格化”，名称会加上 `*` 前缀；“取消标记”只移除所选图层的前缀。标记组时包含组内文字，作为一张 PNG 导入。关闭“自动栅格化复杂组”后，星号仍生效；取消标记后恢复自动策略。

“文字 → 导出方式”提供可编辑文字、矢量形状（无需字体）、PNG 图片。PNG 模式仍逐层输出，已随父组栅格化的文字不重复导出；三个模式不能同时启用。

```powershell
node tests/export-options.cjs
node tests/bridge-batch.cjs
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

图片填充的曝光、对比度、饱和度、白平衡、着色、高光、阴影任一非零时，默认把图片本身由 Figma 渲染为 PNG，以保留调色和填充不透明度；独立蒙版不与图片合并。七项均为默认值或缺省时仍读取原始图片。勾选「图片 → 保留图片调色属性」后，可承载原生控制的图片改为在 AE 中生成调色滑块。默认关闭时该规则使用“模糊、阴影和特殊效果”权限，关闭后会定位到需要转图的图片。

```powershell
node tests/image-adjustments.cjs
node tests/raster-permissions.cjs
node tests/native-image-masks.cjs
```

`image-adjustments.cjs` 覆盖七项参数、默认原图、带渐变独立蒙版的调色图片和权限错误；不将模拟 PNG 渲染表述为真实 Figma/AE 画面对照。

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

2026-11-19 Group 转 Frame 回归补充：模拟最后一个子层移出后 GROUP 自动销毁、已删除节点的属性读取异常及锁定状态保留；实现按 PSD4V185 先缓存 Group/子层矩阵、先定位并调整 Frame 再迁移子层，父 Group 原点变化后在最终状态下重新求子层局部矩阵。另在真实 Figma 文档中复制 `01 / 摇车牌` 验证，源 GROUP 在子层迁移后自动销毁；相同绘制层序下，转换前后 750×1299 RGBA 图像的 974250 个像素零差异，绝对边界和四个直接子层位置不变。验证副本已删除，原节点未修改。

## 发送到 AE 的项目整理

每次“发送到 After Effects”完成后，面板新建的项目项会按 AEP 写入器的结构归位：在项目根目录创建以 Figma 画框名命名的文件夹（缺省名 `F2A 导入`），内含 `Assets` 与 `Precomps`；本次导入产生的素材进 `Assets`，新建的预合成进 `Precomps`，用户自己的目标合成不移动。同名画框再次导入时复用已有文件夹，不产生 `Assets 2`、`Precomps 3`。整理发生在预合成创建之后，作为同一次 `runImportBatch` 的最后一步，失败只记录在返回状态里，不中断导入。

```powershell
node scripts/ae-eval.mjs tests/ae-import-folders.jsx artifacts/import-folders/result.json
```

检查需要已打开的 F2A 面板。脚本重新载入 `figmaRunner.jsx`，在临时合成中执行一次真实整批导入（空图层树 + 一张图片），确认根文件夹、两个子文件夹、素材与子合成的归属、目标合成未被移动和文件夹复用；结束后把新增项目项移入临时文件夹删除，恢复原活动项。结果 `passed` 必须为 `true`，并已核对项目项数量回到测试前。

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

## 面板选项与默认采样

文字颜色回归：`node tests/text-colors.cjs` 使用实际 Figma 采集代码与真实 AEP 写入，检查颜色数值和 COS 数字格式；随后在独立空白 AE 会话运行 `tests/ae-text-colors.jsx`，检查 AE 实际读取的 14 组文字/富文本颜色。包含曾被读成青色的 `14/255` 深灰、黑白、接近黑白、长小数 RGB、极小值及细描边预合成。仅通过 py-aep 回读不能代替这个宿主检查；结果记录在 `artifacts/text-colors/ae-report.json`。

常用选项分为“图层”“文字”和“图片”：默认保留分组层级、保留画框裁剪并忽略隐藏图层；文字默认“矢量形状（无需字体）”，仍可选择可编辑文字或 PNG；图片蒙版默认“原图 + 独立蒙版”，可切换为“合并成图片”；切图倍率默认 1×；保留图片调色属性默认关闭，勾选后给存在调色属性的图片增加 AE 调色滑块。合成参数面板位于“发送到 After Effects”和“导出为 AEP 工程”按钮之间，导出按钮在面板底部；再往下是默认展开的“图层工具”，包含手动星号标记与原稿整理。高级选项默认折叠，包含自动栅格化、混合模式合并和按类型强制转图片；双三次缩小已从面板移除。

删除“可编辑图层”和“转换 Figma 蒙版”两个重复开关；两种导出目标均固定使用节点数据并处理蒙版。导出期间锁定所有设置。面板保持固定窗口高度，展开内容可滚动，不再因展开工具而改变窗口大小。

“图层工具”面板位于 `--panel` 底色上，六个工具按钮改用 `--surface` 填充、`--line` 描边并补充悬停、按下及焦点状态，避免与面板同色而看起来像纯文本；同时删除底部的“作用于所选内容，可在 Figma 中撤销。”说明行。

```powershell
node tests/direct-aep-ui.cjs
node tests/bridge-batch.cjs
node tests/aep-layout.cjs
node scripts/preview-export-ui.mjs
```

UI 检查覆盖默认值、独立/合并蒙版选择、关闭预合成并混用自动处理选项时仍启用节点和蒙版通道，以及导出期间的设置锁定。预览脚本隔离桥接网络，在 320、375、1280 宽度检查常用区和展开区。AEP 写入器不再赋值图层质量和采样；回读检查与新建图层默认值比较，原生 `tests/ae-aep-layout.jsx` 也逐项与 AE 新建图层比较，不强制 Best 或 Bicubic。

```powershell
node tests/raster-permissions.cjs
```

执行实际 Figma 采集代码，分别只开启效果、特殊填充、图片裁剪、复杂蒙版、布尔结果中的一项；确认其余项关闭时仍能独立完成对应处理。关闭需要的选项时必须在发送前报错，错误指出对应设置并定位原始图层。覆盖 AEP 投影、两种模糊、玻璃效果、五种特殊填充、裁剪图片、无结果路径的布尔图形；普通矢量及简单蒙版继续原生输出。复杂图片蒙版仅开启 masks 时，原始图片字节、裁剪和可编辑文字保留；明确合并蒙版和手动整组标记按各自设置处理。Figma 的 PNG 渲染由测试模拟，这些断言不代表真实 Figma 画面对照。

## 导出位置

```powershell
node tests/export-position.cjs artifacts/position-check/report.json
```

检查含小数坐标的形状、文字、图片共享同一画框原点；节点导入分支不应用 SVG 的画布位移。栅格边界重复测量不得累加平移，分层导出用透明度抑制其他绘制，避免隐藏图层导致自动布局重新排版；导出失败后恢复原透明度和混合模式。测试执行实际导出、SVG 解析和宿主入口，Figma 自动布局与裁剪行为使用模拟对象；未执行真实 Figma 或 AE 画面对照。

## 副本导出与原图对照

导出先复制选区到临时容器，在处理裁剪、文字和混合通道前，从副本生成对照 PNG。对照图和重建画面使用同一个选区范围及像素网格。多选时分别生成各选区的对照图，再组合副本。结束或失败后删除临时容器并恢复原选择。

副本中的实例在处理蒙版前由外向内自动分离，分离产生的新 Frame 和子节点 ID 重新映射到原图层。原文档里的组件关联、实例覆盖、蒙版和选区保持。整层栅格化的普通子树直接按原策略输出；蒙版源及关闭裁剪时需要修改的实例先分离副本，并保留“实例整体栅格化”策略。

```powershell
node tests/export-instances.cjs
```

该检查模拟实例内部禁止写入 `isMask`，复现原错误；分离同时替换 Frame 和后代 ID，检查嵌套顺序、同名实例、独立图片/蒙版、文本覆盖、选中嵌套实例、实例/Group 栅格化选项、关闭裁剪、分离失败和后续错误的原图层定位，以及副本清理。用实际写入器生成 AEP。Figma API/渲染为模拟，没有执行当前 Figma 文件的在线导出验收。

对照图片以“原图对照”结尾命名，随同一批图片导入 AE。导入后放在主合成最上方并关闭可见性，不参与形状占位匹配和内部预合成；最终图层整理后再次置顶并隐藏。

```powershell
node tests/export-copy.cjs
node tests/reference-layer.cjs
node tests/client-import-queue.cjs
node tests/bridge-batch.cjs
```

检查原稿及祖先属性禁止写入、对照图与重建画面的裁剪范围和像素网格、多选、副本创建和 PNG 失败后的整组清理，以及对照标记经过实际 UI、传输和图片保存流程后仍然保留。AE 图片构建器和排序逻辑通过模拟宿主检查。原生 `ae-export-smoke.jsx` 检查对照图位于主合成顶部且隐藏。

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

布尔运算的操作数不作为独立绘制内容参与不透明底图证明。`blend-merge.cjs` 覆盖镂空 Subtract 与四个分离的柔光 Rectangle，要求保留五个节点、原混合模式和透明度；即使开启混合合并，也不能将它们错误地烘焙到透明背景。`tests/ae-hollow-blend.jsx` 对照用户正常导出的 card3/card4，检查五个可编辑形状层、四个 Soft Light 以及 100%/50% 透明度，并输出全图与独立“纹理”组渲染。

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

使用实际采集代码与模拟 Figma API，检查原图字节保留、独立矢量／Alpha／亮度蒙版、蒙版内可编辑文字，以及图片自身 CROP 与外部蒙版的嵌套。生成真 AEP，再读取二进制检查素材尺寸、原图变换和轨道遮罩关系；也覆盖默认关闭、重复导出重置和自动栅格化关闭。UI 检查覆盖各选项的默认值、参数传递、导出期间禁用，以及面板不再提供双三次缩小。设置面板在 320、375、1280 像素宽度检查，无水平溢出。

原生 AE 属性检查需先生成上述测试数据，在 AE 空闲且 F2A 面板打开时运行：

```powershell
node scripts/ae-eval.mjs tests/ae-native-image-masks.jsx artifacts/native-image-masks/ae-report.json native-image-masks
```

脚本只创建并清理测试项，不替换或保存当前工程。上述独立蒙版回放已通过 AE 26 的直接导入和 AEP 导入属性检查，包含五张原图、共享图片/文字蒙版、Alpha／亮度蒙版和 CROP 嵌套。Figma 节点和 PNG 渲染仍为模拟，不代表新鲜真实 Figma 导出的像素一致性验收。

### KV 外层与组内蒙版

```powershell
node tests/nested-image-masks.cjs
node scripts/ae-eval.mjs tests/ae-nested-image-masks.jsx artifacts/nested-image-masks/ae-report.json nested-image-masks
```

样例复现最下方 `image 381`、四个带 `image 378` 的组，以及独立前景图片。检查外层共享预合成、四个独立局部遮罩、隐藏内容重新显示后的归属、原图字节、局部效果溢出、相邻蒙版边界、选项关闭和未开启预合成的提示。真实 AE 26 中两条导入路径均保留一个外层遮罩和四个局部遮罩，四张图片的组内位置为 `[40,24]`；直接导入记录的六对遮罩连接全部有效（包括相邻的独立蒙版）。预合成后用新图层引用重新记录遮罩配对，避免旧引用造成“丢失”误报。报告位于 `artifacts/nested-image-masks/`。

## AEP 导出后的线性位移

```powershell
node tests/aep-layout.cjs
node scripts/ae-eval.mjs tests/ae-position-interpolation.jsx artifacts/position-jump/ae-regression-after.json
```

第一条检查真实 AEP 中所有图层的位置、锚点空间插值元数据。第二条在真实 AE 导入该工程，为形状、文字、图片、预合成及遮罩图层的位置和锚点添加横向、纵向、斜向线性关键帧，逐帧检查，再于第 29 帧插入 AE 计算的位置并重查。120 项检查全部通过，最大位置误差约 0.00714 px。修复前首项即失败：66 px / 30 帧的位移在第一帧偏差约 5.03 px。测试只导入并清理临时条目，不替换或保存当前工程。
