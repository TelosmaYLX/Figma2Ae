# AEP 默认打开顶层主合成

用户要求新导出的 AEP 默认打开主合成，避免打开工程后再在项目面板双击。

## 写入内容

原导出文件只有关闭状态的 folder-level Viewer 块，根 `fcid` 为 0。用户提供的 AE 原生另存 24.x 文件已经含有实际打开的主合成窗口：根 `fcid` 指向主合成 ID 4，主合成所在文件夹包含 Timeline 和 Composition 两类窗口记录。

`scripts/aep/writer.py` 新增 `open_main_composition`，在保存前为 `self.main` 写入对应状态：

- 将工程 `fcid` 指向顶层主合成的实际 ID。
- 在所属文件夹的 `fvdv` 至 `fifl` 块中启用打开和激活标志，保存 `AE Timeline` / `AE Composition` 两个窗口类型。
- 按原生布局保存四个 Fips 视口槽，单一活动视图采用 Fit up to 100%。
- 内部预合成保留默认关闭状态，图层内容、素材和版本选项不变。

该实现使用当前固定依赖 py-aep 0.19.0 的类型化块，与用户旧版原生文件的窗口结构对照；不依赖用户样本文件作为运行时模板。代码直接放在写入器内，适配分发包 Python 的隔离模块路径。

## 验证和范围

`node tests/aep-versions.cjs` 生成基础图层和独立遮罩工程的三个版本；`tests/check-aep-versions.py` 新增检查：

- 回读后 `project.active_item` 是所属导出文件夹中的顶层主合成。
- 主合成 Viewer 活动，且是应用的活动 Viewer；其视图为 Fit up to 100%。
- 其他所有预合成都没有打开的 Viewer。
- 格式号、原有图层、变换、alpha/luma 遮罩等版本检查继续通过。

`node tests/direct-aep.cjs` 检查通过。实际安装组件的隔离 Node/Python 环境也重新生成 24.x、25.x、26.x 文件，通过同一版本和窗口状态检查，记录在 `artifacts/aep-main-viewer/installed-cases.json`。

从用户当前首页真实归一化数据生成了一个保留新窗口状态的示例，路径记录在 `artifacts/aep-main-viewer/demo.json`；原用户目录未覆盖。

另编写 `tests/ae-main-comp-open.jsx`，仅在带测试环境标记的独立空白进程中完整打开文件，检查恢复状态，不显式调用 `openInViewer()`。本轮独立 AE 冷启动未得到脚本结果，进程退出码为 -805306369，日志显示所请求 ORT API 22 与当前运行库 1.17.1 不符。因此本轮验证结论限于真实生成文件的格式/窗口状态检查，未宣称已经完成 AE 完整打开验收。独立进程日志保存在 `artifacts/aep-main-viewer/launch-wait.*.log`。

已同步本机安装组件的 `writer.py`，无需重开 Figma 或重启服务；下一次导出会执行更新后的写入器。
