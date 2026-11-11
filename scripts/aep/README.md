# 直接导出 AEP（实验）

这一版将 F2A 数据包直接写成二进制 `.aep`，生成时无需打开 After Effects。导出文件为 ZIP，内含 `project.aep`、`Assets/` 和 `report.json`；解压后在 AE 中打开工程。

## 使用

Windows，Node.js 18+、Python 3.11+，目标 AE 2026。

在仓库根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-aep-export.ps1
```

脚本创建仓库内的 `.venv-aep` 并安装固定版本依赖，然后启动本地服务 `127.0.0.1:7868`。重新运行 Figma 开发插件，选中内容，点击“导出 AEP（实验）”。AE 桥接服务不是此导出的前置条件。服务窗口保持打开，Ctrl+C 停止。

原“导入到 After Effects”按钮仍使用原通道。新增按钮复用同一组栅格化、分组、裁剪选项，并使用可编辑节点数据。合成默认为 30 fps、10 秒。

也可从已经收集的 F2A 数据包生成工程：

```powershell
node scripts/export-aep.cjs packet.json output-directory
```

数据包的 `images` 各项包含原有图片元数据和 `data`（base64 图片）。`frame` 提供选区宽高，坐标保持 F2A 的画框相对坐标。输出文件夹应为新的文件夹。服务端的导出副本保存在 `artifacts/aep-exports/`，CLI 可自行指定输出目录。`F2A_PYTHON` 可指定已有的 Python 环境。

## 可行性与取舍

| 方案 | 结论 |
| --- | --- |
| JSX 建层后保存 AEP | 沿用现有接口，但生成过程仍依赖 AE 逐层创建，不能解决本次目标 |
| 生成 AEPX | AE 官方支持 XML 工程作为自动化中间格式，但其中仍有二进制字段，不是普通 XML 模板即可完整生成 |
| 在 AE 外写二进制 AEP | 本分支采用；py-aep 0.19.0 提供项目、图层、素材和属性的写入接口，真实 AE 26 已验证能读取与渲染 |

依据：[Adobe 工程格式说明](https://helpx.adobe.com/after-effects/desktop/work-with-projects/after-effects-projects/projects.html)、[py-aep 源码与功能范围](https://github.com/forticheprod/py-aep)、[格式资料](https://forticheprod.github.io/py-aep/file_format/)、[库的已知限制](https://forticheprod.github.io/py-aep/limitations/)。依赖采用 MIT 许可证；本仓库仅固定并安装依赖，没有复制其源码。

流程为：Figma 采集节点和 PNG → 插件 UI 汇集完整数据包 → 本地 Node 服务复用 `svgParser` → Python 写 AEP 和 ZIP → 下载。Node 和 Python 均不调用 AE；AE 只用于单独的验证脚本。Figma 沙箱不能直接访问本机文件和 Python，因此这一版仍需独立本地服务。

## 范围

已实现：

- 图片素材、透明度、旋转、FIT/FILL、图片轮廓裁剪与隐藏原图参考层。
- 可编辑形状路径、矩形、椭圆、纯色/线性/径向渐变、描边与基础内外侧描边。
- 可编辑文字、富文本样式、段落行距/缩进/间距、字距、旋转和文字倾斜；渐变文字通过原生形状和文字遮罩实现。
- 分组预合成、绘制顺序、容器透明度、常用混合模式、矩形/圆角画框裁剪，以及节点的 alpha/luma 蒙版。
- ZIP 中的素材相对路径；文件生成无需 AE 面板或目标合成。

当前限制：

- 模糊、未烘焙的投影/内阴影等图层效果尚未写入；虚线尚未覆盖。可用原有 `*` 标记或文字栅格化选项处理。包含 `shadowBase` 的单独投影图片尚未执行前景提取。
- 图片填充的复杂裁剪、组合蒙版、多区域亮度/透明度和多种效果叠加尚未做到全面视觉验证；相关条目写入报告。
- 字体需本机可用；字体或字重替换、无法精确测量的文字会写入报告。Windows 缺失字体时使用支持中文的字体，文本排版仍可能改变。
- 当前固定生成 AE 26 工程；旧版 AE 和 macOS 未验证。不能承诺与 Figma 像素一致。
- py-aep 的写入仍是实验能力，不能只依靠它回读自身生成的文件判断正确性。例如本次发现矩形内部位置在库回读时正确，而 AE 实际读成零；本分支改用图层位置，并以真实 AE 属性断言覆盖。

## 验证

```powershell
node tests/direct-aep.cjs
node tests/direct-aep-ui.cjs
node scripts/verify-direct-aep.mjs
```

第一条使用实际 F2A 采集代码，Figma 场景 API 和 PNG 渲染由测试模拟，生成真 AEP 和 HTTP ZIP，检查完整图片批次与错误处理。第二条执行实际 UI 代码，确认 AE 未连接时可走独立导出、重组图片分片、触发 ZIP 下载、显示报告提示，并在失败后释放按钮。

第三条用真实 AE 导入生成的工程，检查原生图层、形状位置、渐变端点、嵌套坐标、素材缺失和渲染。它将 ZIP 解压到新目录，临时移开原素材目录，验证工程确实使用新位置的素材；结束恢复原素材并移除测试项目项。可通过 `F2A_AFTERFX` 指定 AE 程序。脚本只导入测试项，不替换或保存当前工程。

可选的完整旧样例回放目录可作为第三条命令的参数，目录内应有 `project.aep`。本次使用历史本地数据生成的 832×1068 工程在真实 AE 中保留了 43 个文字层、62 个图片层、63 个预合成；识别到 10 个原生渐变，素材缺失数为零。当前导出报告仍有 7 个未写入的图层效果提示。

完整样例本机测得 Python 写文件约 2.3 秒，包含 Node 准备、Python 启动和 ZIP 的调用约 3.4 秒。此数字不包含 Figma 导出和网络下载，也没有与原流程做同条件基准，不能视为完整链路加速倍数。

报告及预览位于 `artifacts/direct-aep/`，不进入 Git。完整样例是历史回放；本次没有进行真实 Figma 文件从选择、导出到下载后的像素对照验收。UI 布局已在本地浏览器的 320、375、1280 像素宽度查看。
