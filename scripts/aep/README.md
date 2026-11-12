# 直接导出 AEP（实验）

这一版将 F2A 数据包直接写成二进制 `.aep`。点击导出时，由已打开的 AE/F2A 面板启动本地组件；工程写入仍不调用 AE 建层。导出时选择保存位置，直接生成文件夹，内含 `project.aep`、`Assets/` 和 `report.json`；在 AE 中打开 `project.aep` 即可，不再打包 ZIP。

## 使用

分发目标为 Windows x64，工程面向 AE 2026。分发包已包含 Node、Python/Tk 与导出依赖，使用者无需另装运行环境，也无需联网安装依赖。

分发用户双击包内 `install.cmd`，组件安装到 `%LOCALAPPDATA%\F2A\AEP` 并注册当前用户的点击唤起入口。用包内 `cep-extension` 的文件更新 AE 中已有的 F2A 扩展，重新打开面板；在 Figma 中导入安装目录下的 `figma-plugin/manifest.json`。组件安装后不再依赖原解压位置。后续更新仍运行同一安装程序，它只停止并更新该安装目录内的组件进程。

构建分发包需要 Windows x64、Node.js、完整 Python（含 Tcl/Tk）与已准备好的 `.venv-aep`：

```powershell
node scripts/package-aep-service.cjs
```

结果在 `artifacts/F2A-AEP-Windows-x64/`，应完整分发该目录。构建过程会获取所用 Node 版本的许可证；安装与导出本身无需网络。Python 使用包内独立模块搜索路径，不引用构建机器的安装目录。`runtime-manifest.json` 记录版本与运行程序摘要，许可证随运行环境和依赖保留。

开发者直接在仓库中使用时，也可只注册开发目录的入口（机器需有 Node.js 18+、Python 3.11+）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-aep-launcher.ps1
```

入口使用 `f2a-aep://`，不添加开机启动项或登录任务。分发版记录当前设备安装目录内的运行环境路径；开发版记录本机 Node/Python 路径，开发目录或运行环境位置改变后需重新注册。

重新运行 Figma 开发插件，打开 AE 的 F2A 面板，选中内容并点击“导出 AEP（实验）”。服务未运行时，插件向 AE 面板的 `POST /aep/start` 请求启动；CEP 通过 Windows 唤起注册组件，插件等待服务就绪后弹出保存位置窗口。已运行时直接复用。每次导出无需手动运行脚本；AE 面板未打开、版本过旧、组件未安装或启动失败会分别提示。

启动器在后台运行本地服务 `127.0.0.1:7868`；分发版直接使用包内环境，开发版按需创建 `.venv-aep` 并安装固定依赖。重复唤起复用运行中的服务。服务使用 Tkinter 弹出原生目录窗口。日志位于安装或开发目录的 `artifacts/aep-service/`。

调试时仍可手动运行 `powershell -ExecutionPolicy Bypass -File .\scripts\start-aep-export.ps1`；加 `-Background` 在后台启动。关闭服务进程后，下一次点击导出会再次启动。卸载唤起入口可删除当前用户注册表中的 `HKCU\Software\Classes\f2a-aep`。

所选位置下会创建以选区命名的文件夹；同名时加 ` (2)`、` (3)`，不覆盖旧工程。取消选择不会采集 Figma 内容或写文件。生成结束后，插件显示完整保存路径。工程和素材直接写在所选磁盘位置，不再下载或在仓库保存额外副本。

原“导入到 After Effects”按钮仍使用原通道。新增按钮复用同一组栅格化、分组、裁剪选项，并使用可编辑节点数据。合成默认为 30 fps、10 秒。

也可从已经收集的 F2A 数据包生成工程：

```powershell
node scripts/export-aep.cjs packet.json output-directory
```

数据包的 `images` 各项包含原有图片元数据和 `data`（base64 图片）。`frame` 提供选区宽高，坐标保持 F2A 的画框相对坐标。CLI 直接写入指定的新输出目录，不弹目录窗口。`F2A_PYTHON` 可指定已有的 Python 环境。

## 可行性与取舍

| 方案 | 结论 |
| --- | --- |
| JSX 建层后保存 AEP | 沿用现有接口，但生成过程仍依赖 AE 逐层创建，不能解决本次目标 |
| 生成 AEPX | AE 官方支持 XML 工程作为自动化中间格式，但其中仍有二进制字段，不是普通 XML 模板即可完整生成 |
| 在 AE 外写二进制 AEP | 本分支采用；py-aep 0.19.0 提供项目、图层、素材和属性的写入接口，真实 AE 26 已验证能读取与渲染 |

依据：[Adobe 工程格式说明](https://helpx.adobe.com/after-effects/desktop/work-with-projects/after-effects-projects/projects.html)、[py-aep 源码与功能范围](https://github.com/forticheprod/py-aep)、[格式资料](https://forticheprod.github.io/py-aep/file_format/)、[库的已知限制](https://forticheprod.github.io/py-aep/limitations/)。依赖采用 MIT 许可证；本仓库仅固定并安装依赖，没有复制其源码。

流程为：点击导出 → 检查服务，未运行则通过 AE 的本地 HTTP 桥接请求启动 → CEP 调用当前用户注册的 `f2a-aep://start` 并等待服务就绪 → 本地服务弹出目录选择窗口 → Figma 采集节点和 PNG → 插件 UI 汇集完整数据包 → 本地 Node 服务复用 `svgParser` → Python 直接写 AEP 和素材到目标文件夹。AE 面板负责进程启动，Node 和 Python 不调用 AE 建层。启动入口只执行固定命令，不接收请求中的 URI、脚本或路径。

当前 Figma 桌面客户端的外部链接白名单不包含 `f2a-aep:`；直接使用 `figma.openExternal` 会在组件启动前被拒绝。原先测试替换了该宿主方法，因此没有覆盖这项限制。现在由具备 Node 进程接口的 CEP 执行 Windows 协议唤起，仍沿用 [Windows URI 协议注册方式](https://learn.microsoft.com/en-us/previous-versions/windows/internet-explorer/ie-developer/platform-apis/aa767914(v=vs.85))；安装路径由当前设备注册表解析。

服务协议版本为 2：`POST /select-directory` 返回目录选择标识（取消时为 `null`），`POST /export` 接收 `{destination, packet}`，返回 JSON 保存路径与报告。服务只接受本次目录窗口选出的目标，标识使用一次后失效。目录窗口使用 [Python 标准库的原生目录对话框](https://docs.python.org/3/library/dialog.html#tkinter.filedialog.askdirectory)。

## 范围

已实现：

- 图片素材、透明度、旋转、FIT/FILL、图片轮廓裁剪与隐藏原图参考层。
- 可编辑形状路径、矩形、椭圆、纯色/线性/径向渐变、描边与基础内外侧描边。
- 可编辑文字、富文本样式、段落行距/缩进/间距、字距、旋转和文字倾斜；渐变文字通过原生形状和文字遮罩实现。
- 文字整体、纯色填充与富文本各段透明度分别写入；父组透明度不重复乘到子文字。富文本透明度使用原生文字范围选择器，渐变填充自身的透明度单独保留。
- 分组预合成、绘制顺序、容器透明度、常用混合模式、矩形/圆角画框裁剪，以及节点的 alpha/luma 蒙版。
- 文件夹内的素材相对路径；文件生成无需 AE 面板或目标合成。

当前限制：

- 模糊、未烘焙的投影/内阴影等图层效果尚未写入；虚线尚未覆盖。这些明确不支持的属性现在直接报错，并显示图层名；不再生成带缺失属性的 AEP。插件会先提取独立投影；直接传给 CLI、未经提取的 `shadowBase` 图片仍会报错。
- 字体及字重需本机可用；缺失字体、样式不符或无法计算文字排版时直接报错，不再替换字体继续输出。
- 图片填充的复杂裁剪、组合蒙版、多区域亮度/透明度和多种效果叠加尚未做到全面视觉验证。已经识别出的不支持组合会报错；成功生成文件不代表完成了像素对照。
- 当前固定生成 AE 26 工程；旧版 AE 和 macOS 未验证。不能承诺与 Figma 像素一致。
- py-aep 的写入仍是实验能力，不能只依靠它回读自身生成的文件判断正确性。例如本次发现矩形内部位置在库回读时正确，而 AE 实际读成零；本分支改用图层位置，并以真实 AE 属性断言覆盖。

## 自动处理范围

普通图片填充不触发父组合并。FIT/FILL 图片保留独立素材层；CROP 或本层效果需要烘焙时，仅渲染该图片节点。手动 `*` 标记、Group 整组栅格化和实例整体栅格化仍按用户指定的边界处理。

开启自动栅格化时，背景模糊所在对象直接通过 Figma 导出为独立 PNG，保留其效果交给 Figma 渲染；不再因背景依赖直接拒绝，也不为此合并父组或背后的图层。该对象已有投影会一并写入这张 PNG，避免重复生成。关闭自动栅格化时会提示开启，并提供出错图层定位。

布尔运算优先使用节点的结果路径；没有结果路径时，只栅格化布尔节点。投影单独提取，背景、文字和其他图形继续保留；AEP 界面在生成工程前使用 Canvas 完成纯投影 PNG 的提取，失败时中止。组效果交给预合成表达，AEP 尚未支持的组效果报错。

开启自动处理时，普通纯色 alpha/luma 蒙版优先保留原生遮罩。组内容的蒙版放在预合成上，不重复施加到每个子层。复杂图片、渐变或效果蒙版仅渲染该蒙版及受其遮罩的内容；父容器的背景、效果和其他兄弟层不进入这张图片。作用范围在下一个蒙版、蒙版组或裁剪容器处停止，依据 [Figma 蒙版作用规则](https://help.figma.com/hc/en-us/articles/360040450253-Masks)。

混合模式合并会保留与后续混合内容不相交的普通图形、图片和文字，不再因为它们处于合并区间中就一起烘焙。蒙版和手动栅格化边界不被跨越。

图片读取/渲染失败、缺失素材、无效蒙版和路径解析失败都会中止本次导出。AE 桥接会丢弃未完成的图片批次；AEP 发现上述缺失或不支持的属性时不生成 `project.aep`，临时 packet 会清理。界面直接显示原因，不再只提示用户查看 report.json。

## 验证

```powershell
node tests/direct-aep.cjs
node tests/direct-aep-ui.cjs
node tests/aep-launcher.cjs
node tests/raster-scope.cjs
node tests/aep-fidelity.cjs
node tests/aep-distribution.cjs
node scripts/verify-direct-aep.mjs
```

第一条使用实际 F2A 采集代码，Figma 场景 API 和 PNG 渲染由测试模拟，生成真 AEP 文件夹，检查目录取消、中文及空格路径、名称清理、同名不覆盖、不产生 ZIP 与 HTTP 错误。HTTP 检查模拟目录窗口返回值，不弹出交互窗口。UI 检查执行实际 iframe 代码，覆盖通过 AE 面板只启动一次、就绪后才采集、启动超时、离线/旧版面板、缺少组件及系统拒绝后释放按钮；同时检查已运行时复用、目录取消、图片分片、保存路径与错误提示。`aep-launcher.cjs` 使用实际 CEP 客户端回调和 HTTP 服务，模拟进程 API，检查固定协议、隐藏启动、当前用户注册项及启动错误。

范围检查覆盖多张独立位图、选中边界、原生/回退布尔、原生/局部蒙版、裁剪边界、父容器样式隔离和异常恢复。AEP 检查通过实际采集生成二进制工程，验证原生组遮罩与独立图片，并确认路径/素材缺失及不支持属性报错后不生成工程。Figma 渲染为模拟，未进行本轮真实 Figma 与 AE 画面对照。

分发检查将组件复制到中文新路径，在 PATH 中移除 Node/Python，并将 PYTHONHOME/PYTHONPATH 指向无效目录；核对 Python 的模块与 Tcl 库来源均为分发包，实际启动包内服务并生成真 AEP 文件夹。本机系统协议检查也确认冷启动和重复唤起成功，复用同一服务进程。尚未在第二台实机或干净 Windows 虚拟机上运行，也未完成真实 Figma 客户端点击唤起的端到端检查；不能把环境隔离测试表述为第二台设备的实测。

Windows 本机额外操作了真实目录窗口，确认中文目录选择和取消均返回正确；新文件夹输出在 AE 26 中的首轮导入及移动后素材解析检查通过，素材缺失数为零。随后复跑时 AE 进程提前退出，未生成新报告，验证脚本超时后恢复了原素材目录。Figma 端仍使用采集模拟，没有进行新的在线 Figma 文件完整导出验收。

最后一条用真实 AE 导入生成的工程，检查原生图层、形状位置、渐变端点、嵌套坐标、素材缺失和渲染。它将工程文件夹复制到新目录，临时移开原素材目录，验证工程确实使用新位置的素材；结束恢复原素材并移除测试项目项。可通过 `F2A_AFTERFX` 指定 AE 程序。脚本只导入测试项，不替换或保存当前工程。

可选的完整旧样例回放目录可作为 AE 验证命令的参数，目录内应有 `project.aep`。本次使用历史本地数据生成的 832×1068 工程在真实 AE 中保留了 43 个文字层、62 个图片层、63 个预合成；识别到 10 个原生渐变，素材缺失数为零。当前导出报告仍有 7 个未写入的图层效果提示。

初版 ZIP 流程的完整样例本机测得 Python 写文件约 2.3 秒，包含 Node 准备、Python 启动和 ZIP 的调用约 3.4 秒。这是改为文件夹输出前的历史数据，不代表当前版本或完整链路加速倍数。

报告及预览位于 `artifacts/direct-aep/`，不进入 Git。完整样例是历史回放；本次没有进行真实 Figma 文件从选择、导出到生成后的像素对照验收。UI 布局及长路径换行已在本地浏览器的 320、375、1280 像素宽度查看。
