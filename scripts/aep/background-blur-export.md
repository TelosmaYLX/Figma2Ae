# 保留背景模糊（导出约定）

勾选「保留背景模糊」后，含 Figma `BACKGROUND_BLUR` 效果、且能安全还原的图层不再由 Figma
栅格化成图片，而是在 AE 中用一个 **调整图层** 调用 `Figma 背景模糊` 插件（`F2A Figma
Background Blur`）实时还原 Figma 的调色数值；调整图层与源图层同尺寸、遮罩取源图层填色轮廓，
并父级到源图层，位移/旋转/缩放时模糊区域跟随。插件缺失时该图层仍按旧路径转为图片。

实现分两条独立导出路径，数据从 Figma 插件（`figma-plugin/code.js`）发出，格式见下：

- 实时导入：`figma-plugin/ui.html` → `client/mkBridgeServer.js` → `client/figmaBridge.js`
  → `host/figma/figmaRunner.jsx` → `host/figma/aeShapeBuilder.jsx`
- 离线 AEP：`figma-plugin/ui.html` → `scripts/aep-server.cjs` → `scripts/export-aep.cjs`
  → `scripts/aep/packet.cjs` → `scripts/aep/writer.py` → `scripts/aep/figma_blur.py`

## 数据：`backgroundBlurs`

Figma 插件在 `ship` 消息、离线 AEP packet 中新增可选数组 `backgroundBlurs`。每项描述
「一个源图层 → 一个调整图层」：

```json
{
  "sourceId": "505:1207",
  "name": "卡片 背景模糊",
  "container": "505:1207",
  "z": 17,
  "size": [560, 340],
  "position": [600, 400],
  "rotation": 0,
  "scale": [100, 100],
  "mask": {"d": "M0 0H560V340H0Z", "windingRule": "NONZERO"},
  "mode": "uniform",
  "radius": 40,
  "startRadius": 0,
  "endRadius": 40,
  "startOffset": [0.5, 0],
  "endOffset": [0.5, 1]
}
```

- `container`：代表源图层的容器 id，导出后它就是父合成里的那个预合成图层：
  - 容器节点（FRAME / COMPONENT / INSTANCE / GROUP）→ 容器自身 id（`<nodeId>`）；
  - 叶子节点 → 由「单图层嵌套预合成」补出的包装容器 id（`<nodeId>-layer-precomp`）。
  调整图层创建在 `source.containingComp`，即这个预合成图层所在的父合成。
- `size`：源图层本地尺寸（未乘矩阵缩放），调整图层 solid 的宽高都取它。
- `position`：源图层本地盒中心在 **父合成坐标** 中的位置（已含父合成原点偏移），
  即 `absoluteTransform * (w/2, h/2) - parentCompOrigin`。
- `rotation`：由 `absoluteTransform` 分解出的角度（度）；`scale` 为其 X/Y 百分比。
  仅接受无剪切（`a*c + b*d ≈ 0`）、无翻转的矩阵；其它情况 Figma 侧不做保留、退回栅格化。
- `mask`：源图层 `fillGeometry` 唯一一条路径的 SVG `d`，坐标是 **节点本地坐标**
  （原点在节点左上角），即调整图层本地空间；`windingRule` 原样带上。
  路径含多个子路径（带洞的布尔形状等）时不保留，退回栅格化。
- `mode`：`uniform` 用 `radius`；`progressive` 用 `startRadius` / `endRadius` 与
  `startOffset` / `endOffset`（0–1 的节点盒比例，对应 Figma `blurStartOffset` 等）。

## 调整图层契约

两条路径生成完全一致的图层：

1. 在父合成中新建 solid（颜色任意，0,0,0），宽高 = `round(size)`（至少 1），
   标记为调整图层（AE `adjustmentLayer = true`）。
2. 变换：`anchor = size/2`、`position = position`、`rotation`、`scale`。
3. 遮罩：按 `mask.d` 生成一个 `maskMode = ADD` 的 Mask Atom（无羽化、无扩展）。
4. 效果：添加 `F2A Figma Background Blur`，参数按插件顺序：
   1 模式（1 均匀 / 2 渐变）、2 背景模糊半径、3 开始半径、4 结束半径、
   5 渐变起点 X、6 渐变起点 Y、7 渐变终点 X、8 渐变终点 Y、9 柔化边缘 (AA)、
   10 Alpha源（保持默认 0 / 无）。数值恢复 Figma 的 px 与百分比（偏移 ×100）。
5. 层级与父级：调整图层放在源图层 **正下方**（AE 中先 `moveAfter(source)`，
   再 `parent = source`，保持合成中外观不变）。这样只模糊源图层背后的内容。

## 退回规则（Figma 插件内）

以下情况不做保留，维持原有行为（`模糊、阴影和特殊效果` 开启时转为图片，关闭时报错）：

- 目标为网页导出；或未开启「单图层嵌套预合成」且节点不是可组织成预合成的容器；
- 节点没有可见且不透明的填充（Figma 本身不绘制该效果）；
- `fillGeometry` 不是唯一一条、含多个子路径，或矩阵带剪切/翻转；
- 节点还被其它不能原生写入 AEP 的效果/条件栅格化。

实时导入额外做一次宿主探测：`F2A Figma Background Blur` 未加载时先尝试把打包的
`FigmaBackgroundBlur.aex` 复制到 AE 的 `Plug-ins\F2A`，本次退回图片，并提示重启 AE。
离线 AEP 始终写入效果，安装/更新流程负责把插件放进 AE 插件目录。
