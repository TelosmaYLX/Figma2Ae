# SaaS Kit CEP 扩展

Adobe After Effects CEP 面板的本地源码仓库，来源于已安装的 `com.saaskit.panel` 扩展。

## 目录

```text
client/          CEP 面板（HTML/CSS/Node）
CSXS/manifest.xml 扩展清单
figma-plugin/    Figma 端插件（导出、层级、隐藏层选项）
host/            ExtendScript 主逻辑
host/figma/      SVG/节点树导入与 AE 图层构建
META-INF/        原始 ZXP 签名清单（修改后摘要已失效）
```

## 当前特性

- 默认按 Figma 图层树导入，一个 Figma 图层对应一个 AE 图层。
- 默认将 Figma 分组转换为嵌套预合成。
- 根画框裁剪会转换为预合成蒙版。
- 含蒙版、图片、混合模式或模糊的复杂子组默认使用 Figma 原生 PNG 渲染，文字保持可编辑。
- 透明纯文字 Frame 不再生成多余预合成。
- 默认按原版行为导入 Figma 蒙版图层；可在 Figma 插件中手动启用实验性的
  “转换 Figma 蒙版为 AE 轨道遮罩”。实验选项会保留 ALPHA/LUMA 类型。
- 默认忽略隐藏图层，可在 Figma 插件中关闭。
- 图片保存目录会被记住并复用。
- 中文界面。
- 图层排序只移动真正错序的图层。

## 使用

1. 本机需启用 CEP 调试模式：`HKEY_CURRENT_USER\Software\Adobe\CSXS.11` 下
   `PlayerDebugMode` = `1`（新版本 AE 可能同时需要 `CSXS.12`）。
2. 将本目录部署到：
   `C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\com.saaskit.panel`
3. 重启 After Effects，必要时重新打开 SaaS Kit 面板。
4. Figma 插件开发版从 `figma-plugin/manifest.json` 导入。

部署时请先备份目标目录；不要直接覆盖正在使用的扩展后继续运行 AE。

## 注意

- `META-INF/signatures.xml` 是原始包的自签名清单。源码已修改，摘要不再匹配；
  在 `PlayerDebugMode` 下使用即可，发布前应重新签名。
- 内嵌的 `.ffx`、`.aep` 和 Python 运行器位于 `host/SaaSKit.jsx` 的 base64 字面量中，
  不是独立源文件。
- 本仓库不包含构建产物、测试临时文件或用户的 AE 工程。
