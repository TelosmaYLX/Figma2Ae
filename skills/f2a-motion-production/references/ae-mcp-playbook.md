# F2A & After Effects MCP 工具手册与实战模板

本手册整理了使用 F2A MCP 完成「Figma 导出 `.aep` → AE 动画制作 → 像素与视觉校验 → MP4 预览输出」全流程的工具选择、实操踩坑边界及常用 ExtendScript 模板。

---

## 1. 工具速查与优先级

| 阶段 | 首选工具 | 说明 |
|---|---|---|
| Figma 连接与选区 | `get_f2a_status` → `join_channel` → `get_selection` | 确认目标画框 ID、名称与尺寸 |
| Figma 导出 `.aep` | `export_aep` | `destination` 必须是 `.aep` 绝对路径；默认 `textMode: "vector"`，`aeVersion` 匹配 `ae_status` |
| AE 状态与版本 | `ae_status` | **必须先查** `appVersion` 与 `project.dirty`；若 `dirty: true` 必须先询问用户 |
| 打开 / 保存工程 | `ae_open_project` / `ae_save_project` | 严禁在未获用户确认时传 `discardChanges: true` 覆盖 `dirty: true` 的工程 |
| 结构与属性巡检 | `ae_list_comps` / `ae_get_comp_map` / `ae_get_comp_info` / `ae_get_keyframes` | 优先用 `comp` ID（数字）定位，避免同名合成（如根合成与内容预合成同名）混淆 |
| 高精度批量改造 | `ae_run_script`（单 Undo Group） | 适合：统一改帧率、单元素紧凑预合成封装、批量写入精确贝塞尔/线性关键帧、读取/锁定原始终值 |
| 简单动效预设 | `ae_animate` / `ae_stagger` / `ae_text_reveal` / `ae_transition` | **Web 模式下禁用** `spring`/`bounce`（它们依赖表达式）；`ae_text_reveal` 需 `textMode: "editable"` |
| 动效库复用 | `ae_motion_list` → `ae_motion_apply`（按需 `ae_motion_save`） | 无参考工程时先查动效库；默认不自动入库，用户要求时再 `ae_motion_save` |
| 帧渲染与接触表 | `ae_render_frame` / `ae_render_contact_sheet` | **先建父目录**再传 `outputPath`；静止校验传 `maxSize` ≥ 合成长边以获取 1:1 原分辨率 |
| 后台渲染 MP4 | `ae_render_mp4` → `ae_render_jobs` | 必须先 `ae_save_project`（`aerender` 读磁盘保存版）；传根合成 `comp_id` 与工作区帧范围 |

---

## 2. 已知工具边界与踩坑清单（必读）

1. **`ae_render_frame` 不自动创建父目录**
   - 现象：`outputPath` 指向尚未创建的子目录（如 `...\_qa\00_static.png`）时，AE 报错 `After Effects did not write the image to ...`。
   - 对策：调用前务必先创建好 `_qa` 目录（`New-Item -ItemType Directory -Force`）。
2. **`ae_render_frame` 传 `layers: [idx]` 不会临时开启已禁用图层**
   - 现象：F2A 导出的 `*_原图对照`（图层 1）默认 `enabled: false`。传 `layers: [1]` 只会隐藏其他层而不会开启图层 1，结果输出纯黑图。
   - 对策：静态保真校验直接拿 `Assets\<对照图>.png`（从 `ae_get_comp_info` 查图层 1 的 `source.name`）送入 `scripts/verify_resting_frame.py --mode static`。
3. **Figma 根 Frame `clipsContent: false` 导致整帧对照图大于主合成**
   - 现象：画框内背景图或模糊向上/向四周溢出，使 `Assets\<对照图>.png` 尺寸大于根合成（例如画框 `750×1367`，对照图 `750×1573`）。
   - 对策：**绝对不要直接 resize 对照图**！在 AE 中读取图层 1（原图对照）的 `position` 与 `anchorPoint`，算出 `refOffset = [Math.round(pos[0] - anchor[0]), Math.round(pos[1] - anchor[1])]`，传给 `verify_resting_frame.py --mode static --ref-offset-x ... --ref-offset-y ...`。
4. **高版本参考 `.aep`（如 AE 27）无法在低版本 AE（如 AE 26）中打开**
   - 现象：直接 `ae_open_project` 报错或弹窗阻塞。
   - 对策：使用本 Skill 随附的 `scripts/dump_aep_motion.py`，用 F2A 环境内带 `py_aep` 的 Python（通常为 `<F2A_ROOT>\.venv-aep\Scripts\python.exe`）离线只读解析出全部合成、入出点、关键帧与缓动参数。
5. **同名合成定位陷阱**
   - 现象：F2A 导出的根合成与第一层内容预合成往往同名（例如两个都叫 `06 / 开服时间`，ID 分别是 `4` 和 `16`）。
   - 对策：所有 MCP 工具和 ExtendScript 脚本一律用**数字 `compId`**（`aemcp.findComp(id)`），不要传名称字符串。
6. **嵌套预合成 `startTime` 时间偏移**
   - 现象：参考工程里某预合成图层设置了 `startTime = 0.1167s`（如时间线模块），则其子合成内所有局部关键帧在主合成全局时间轴上都要 `+0.1167s`。
   - 对策：复用时同步复现父层 `startTime = inPoint`，并确保父层 `outPoint >= comp.duration`，避免模块提前消失。
7. **`export_aep` 当前未暴露 `frameRate` 入参**
   - 现状：当前 MCP `export_aep` 支持 `destination`、`textMode`、`aeVersion`（默认导出 30fps）。若未来支持 `frameRate` 入参则在导出时直接传入；当前则在打开 `.aep` 后、加动画前，用下文模板 1 统一修改全部合成帧率以匹配参考工程。

---

## 3. ExtendScript 实战模板（通过 `ae_run_script` 执行）

### 模板 1：统一修改项目全部合成帧率（与参考工程一致）

> 必须在**写入任何关键帧之前**执行，保证所有关键帧按目标帧率原生对齐整帧。

```javascript
const targetFps = 60; // 与参考工程保持一致
const updated = [];
for (let i = 1; i <= app.project.numItems; i++) {
  const it = app.project.item(i);
  if (it instanceof CompItem) {
    if (it.frameRate !== targetFps) {
      it.frameRate = targetFps;
      updated.push({ id: it.id, name: it.name, fps: it.frameRate });
    }
  }
}
return { targetFps, updatedCount: updated.length, updated };
```

### 模板 2：单元素紧凑预合成封装（零像素偏移，满足“每元素独立预合成”铁律）

> 适用场景：某个待加动画的叶子图层（裸文字层、裸形状层、裸图片层）尚未被独立预合成包裹，必须先为其创建紧贴元素边界的独立预合成，再对父合成里的该预合成层加动画。
> 注意：`sourceRectAtTime(0, true)` 包含描边/内容范围；对于带外扩模糊或特效的层，适当增加 `pad` 留白避免边缘被子合成裁剪。

```javascript
function wrapLayerInTightPrecomp(parentComp, layer, precompName, pad) {
  pad = pad || 4; // 安全像素余量，防描边/抗锯齿裁切
  const t = 0;
  const rect = layer.sourceRectAtTime(t, true);
  const ap = layer.transform.anchorPoint.value;
  const pos = layer.transform.position.value;
  const sc = layer.transform.scale.value;
  const rot = layer.transform.rotation.value;
  const blend = layer.blendingMode;
  const origIndex = layer.index;

  // 若图层带旋转或非 100% 缩放，直接用 AE 原生 precompose 保持 100% 几何一致
  const isSimple = (Math.abs(rot) < 0.001 && Math.abs(sc[0] - 100) < 0.001 && Math.abs(sc[1] - 100) < 0.001);
  if (!isSimple) {
    const pre = parentComp.layers.precompose([origIndex], precompName, true);
    return { mode: 'native_precompose', compId: pre.id, name: pre.name, layerIndex: origIndex };
  }

  // 查找 Precomps 文件夹（若存在则归档到其中保持工程整洁）
  let precompFolder = null;
  for (let i = 1; i <= app.project.numItems; i++) {
    const it = app.project.item(i);
    if (it instanceof FolderItem && it.name === 'Precomps') { precompFolder = it; break; }
  }

  // 先用原生 precompose(moveAllAttributes=true) 将该层打进同尺寸预合成，再裁紧尺寸并补偿坐标
  const subComp = parentComp.layers.precompose([origIndex], precompName, true);
  if (precompFolder) subComp.parentFolder = precompFolder;

  const preLayer = parentComp.layer(origIndex);
  const innerLayer = subComp.layer(1);

  // 元素在父合成中的精确包围盒（取整数像素网格保证 0 像素亚像素模糊）
  const topLeftX = pos[0] - ap[0] + rect.left - pad;
  const topLeftY = pos[1] - ap[1] + rect.top - pad;
  const shiftX = Math.floor(topLeftX);
  const shiftY = Math.floor(topLeftY);
  const finalW = Math.max(2, Math.ceil((pos[0] - ap[0] + rect.left + rect.width + pad) - shiftX));
  const finalH = Math.max(2, Math.ceil((pos[1] - ap[1] + rect.top + rect.height + pad) - shiftY));

  subComp.width = finalW;
  subComp.height = finalH;

  const innerPos = innerLayer.transform.position.value;
  innerLayer.transform.position.setValue([innerPos[0] - shiftX, innerPos[1] - shiftY]);

  // 父合成中放置预合成层（锚点居中，位置精确还原到原始像素网格）
  preLayer.transform.anchorPoint.setValue([finalW / 2, finalH / 2]);
  preLayer.transform.position.setValue([shiftX + finalW / 2, shiftY + finalH / 2]);
  preLayer.blendingMode = blend;

  return {
    mode: 'tight_precomp',
    compId: subComp.id,
    name: subComp.name,
    size: [finalW, finalH],
    layerIndex: preLayer.index,
    preLayerPos: preLayer.transform.position.value,
  };
}
```

> **校验要求**：完成预合成封装后，务必立即渲染一帧验证与封装前完全一致（0 像素偏差），再在其上加动画关键帧。

### 模板 3：精确位置/透明度/单端缩放动画（自动锁定原始设计稿终值，绝不逐帧打点）

```javascript
// 位移：仅 2 个关键帧 + 精确 Bezier 缓动，终值严格锁定为原始 prop.value
function addPositionMove(layer, t0, t1, dx, dy, outInf, inInf) {
  const prop = layer.transform.position;
  const endVal = prop.value; // 严格锁定设计稿原值！
  const startVal = [endVal[0] + dx, endVal[1] + dy];
  if (endVal.length === 3) startVal.push(endVal[2]);

  prop.setValueAtTime(t0, startVal);
  prop.setValueAtTime(t1, endVal);

  const k1 = prop.nearestKeyIndex(t0);
  const k2 = prop.nearestKeyIndex(t1);
  prop.setInterpolationTypeAtKey(k1, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
  prop.setInterpolationTypeAtKey(k2, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
  prop.setTemporalEaseAtKey(k1, [new KeyframeEase(0, inInf)], [new KeyframeEase(0, outInf)]);
  prop.setTemporalEaseAtKey(k2, [new KeyframeEase(0, inInf)], [new KeyframeEase(0, outInf)]);
  // 强制关闭空间曲线过冲
  prop.setSpatialTangentsAtKey(k1, [0, 0, 0], [0, 0, 0]);
  prop.setSpatialTangentsAtKey(k2, [0, 0, 0], [0, 0, 0]);
}

// 透明度：仅 2 个线性关键帧
function addLinearOpacity(layer, t0, t1, v0, v1) {
  const prop = layer.transform.opacity;
  prop.setValueAtTime(t0, v0);
  prop.setValueAtTime(t1, v1);
  const k1 = prop.nearestKeyIndex(t0);
  const k2 = prop.nearestKeyIndex(t1);
  prop.setInterpolationTypeAtKey(k1, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
  prop.setInterpolationTypeAtKey(k2, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
}

// 单端（如左端）Scale X 生长：先同步平移锚点与位置保静止 0 偏差，再 Scale X 0->100
function addLeftEdgeScaleX(layer, deltaXToLeftEdge, t0, t1) {
  const ap = layer.transform.anchorPoint;
  const pos = layer.transform.position;
  const oAp = ap.value, oPos = pos.value;
  ap.setValue([oAp[0] - deltaXToLeftEdge, oAp[1]]);
  pos.setValue([oPos[0] - deltaXToLeftEdge, oPos[1]]);

  const sc = layer.transform.scale;
  const endSc = sc.value;
  const startSc = [0, endSc[1]];
  if (endSc.length === 3) startSc.push(endSc[2]);
  sc.setValueAtTime(t0, startSc);
  sc.setValueAtTime(t1, endSc);
  const k1 = sc.nearestKeyIndex(t0);
  const k2 = sc.nearestKeyIndex(t1);
  sc.setInterpolationTypeAtKey(k1, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
  sc.setInterpolationTypeAtKey(k2, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
}
```
