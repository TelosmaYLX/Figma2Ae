# Osmo 动效语汇与 F2A 映射参考

> 内部参考：记录 [Osmo](https://www.osmo.supply) 公开资源目录的盘点、公开预览视频的行为观察，以及本轮落地到 F2A 内置动效库的 `OS` 转场与宽度扫入片段。
> 分析日期：**2026-11-24**；分析对象：Osmo 公开 `/collection` 页面快照（`artifacts/osmo-src/collection.html`）与该页面引用的 **14 条公开预览视频**。
> 本文**不含任何 Osmo 源码、会员资源或精确参数**：Osmo 是付费会员制资源库，源码/工程文件仅对会员开放。除特别标注外，动效时长、缓动与错峰均为 **F2A 的实现选择**，不是 Osmo 的默认值；需要逐参数复刻时应由用户提供其会员资源（录屏或代码导出）。
> 阅读约定：**观察**＝公开预览视频/公开页面文字中直接可见；**估读**＝由 30 fps 抽帧推算且带误差；**推断**＝依据名称/文案/常识判断，未获源码证实。

---

## 1. 概述

> **2026-11-25 去重精简**：`os-underline-draw` 与 `os-highlight-sweep` 同为 Scale X 0→100% 宽度扫入、仅时长/曲线略异，已移除下划线版；当前库总量为 **55 clips / 41 presets**。下文保留原始分析记录，以 `motion-library/builtin.json` 为准。

### 1.1 Osmo 是什么

Osmo（[osmo.supply](https://www.osmo.supply)）是面向 **Webflow 与 HTML/CSS/JS** 的**付费会员制**创意动效资源平台，由 Dennis Snellenberg、Ilja van Eck 等创作（公开页脚与 FAQ 口径）。公开页标题为“Osmo Resources Collection - Webflow & HTML/CSS/JS Components”，公开导航可见的产品线：

| 产品线（公开导航） | 说明（公开页面口径） |
|---|---|
| The Vault | “所有 Osmo 资源所在的地方”：组件、片段、效果与技法，含 Webflow 与 HTML/CSS/JS 两套文档，使用 GSAP 等 Web 工具 |
| Page Transition Course | 页面转场课程（独立产品线） |
| Button Pack（NEW） | 按钮样式/动效包 |
| Icon Library / Community Icon Library | 图标库与社区图标库 |
| Easings（New） | 缓动曲线资源 |
| Showcase / Collection / Pricing | 案例展示、公开资源目录（234 条）、会员定价 |

会员默认**单用户**授权（团队账号除外）：可把资源用于个人与客户项目，但**不得转售或作为库/产品再分发**，也不得把资源下载/存储到 Vault 之外；取消会员后仅已合法落入项目中的实现可继续使用（公开 FAQ 原文口径）。资源以“每周/定期新增”节奏更新，公开 `/collection` 页卡列出标题、分类与公开预览视频。

### 1.2 分析资产与本轮取样

| 资产 | 路径 | 规模/说明 | 本轮用途 |
|---|---|---|---|
| 公开 collection 快照 | `artifacts/osmo-src/collection.html` | 659,259 B；含标题/分类/预览视频引用 | 站点结构、产品线、许可 FAQ、资源清单来源 |
| 解析清单 | `artifacts/osmo-src/resources.json` | 234 条 `{slug,title,category,video,date}`；18 分类 | 全站盘点、可移植性分类 |
| 公开预览视频 | `artifacts/osmo-src/videos/*.mp4` | 14 条；1440×900、30 fps、44–168 帧（1.47–5.60 s 循环） | 逐资源行为观察的唯一动态依据 |
| 预览联系表 | `artifacts/osmo-src/contact/*.png` | 12 张预览视频的 3×3 等距抽帧图 | 快速观察（`read_image` 可读） |
| 自测 AE 渲染 | `artifacts/osmo-src/contact/ae-split-transition.png` | F2A 新 split 转场的 AE 渲染 9 帧（0.9–2.1 s，30 fps） | 校验 F2A 实现，**非 Osmo 素材** |
| 允许但未取用 | `https://www.osmo.supply/llms.txt` | robots 允许的公开索引 | 本轮未下载、未引用其内容 |

补充事实：234 条中 **210 条带公开预览视频 URL**（`osmo.b-cdn.net`），24 条为空；仅 5 条带发布日期（2026-11-09 至 2026-11-23，最新为 `interactive-wave-lines-background`）。页面上的数量占位符由脚本填充，快照里显示为 `000`，因此数量以 `resources.json` 为准。

### 1.3 许可与合规声明

- Osmo 是**付费会员制**产品；本文档与 F2A 资产**不复制、不分发**任何 Osmo 源码、模板、视频或素材文件。
- 本轮**遵守 robots.txt**：其允许 `/`、`/llms.txt`、`/product/`、`/plans*`、`/collection`、`/updates`、`/showcase`、`/submit`、`/try`、`/faq`、`/newsletter`、`/legal/`，其余路径 `Disallow`；演示子域（如 `osmo-*.webflow.io`）整站 `Disallow`。
- 本轮**只把公开 `/collection` 页面及其引用的公开预览视频用于分析**；`/resource/*`、`/easings` 与演示子域属 robots 禁止/会员内容，发现后立即停止并删除临时快照，未从中提取任何参数或素材，**未获取会员源码或工程文件**。
- 预览视频只用于“看行为”；抽帧与联系表仅作分析证据，不进入产品、不随 F2A 分发。
- F2A 的 `os-*` 片段与 Osmo 风格转场均为**独立 AE 重建**（形状层 + 关键帧），参数由 F2A 选定，与 Osmo 无代码/资产依赖。
- 如需逐参数对齐某个会员资源，应让用户提供**其本人授权范围内的录屏或代码导出**，再在本地分析；不得要求或使用来源不明的会员文件。

---

## 2. 全站盘点

### 2.1 分类计数（`resources.json`，共 234 条 / 18 类）

| 分类 | 数量 | 分类 | 数量 |
|---|---:|---|---:|
| Sliders & Marquees | 24 | Navigation | 14 |
| Scroll Animations | 24 | Sections & Layouts | 13 |
| Utilities & Scripts | 22 | Gimmicks | 12 |
| Buttons | 15 | Dropdowns & Information | 9 |
| Gallery & Images | 15 | Hover Interactions | 9 |
| Page Transitions | 14 | Loaders | 7 |
| Video & Audio | 14 | Forms | 5 |
| Cursor Animations | 14 | Visual Effects | 5 |
| Text Animations | 14 | Filters & Sorting | 4 |
| **合计** | **234** | | |

### 2.2 可移植性三分桶判定

判定标准是“能否在 AE 中用 2D 变换/透明度/遮罩/预合成 + 少量关键帧（≤3 键/轨）重建”，而不是资源本身是否好看。分类为**基于公开清单与预览的判断**，未逐条查看会员源码。

| 桶 | 判定标准 | 代表资源 |
|---|---|---|
| **可直接/近似移植** | 有限时长的 2D 变换、宽度/缩放扫入、透明度或单段遮罩；可直接落成 `clip` 或简单转场层 | masked text reveal 的入场段、typewriter、highlight marker、highlight text on scroll 的入场段、rotating/looping words 的换词入场段；cross fade / double wipe / shutter / column wipe / masked window 等 2D 面板类转场；按钮字符错峰与下划线；简单堆叠/下落 loader；部分 Sections 入场 |
| **仅部分可移植（配方级）** | 需要循环、遮罩编排、滚动进度映射、多面板或状态机才能接近；AE 只能还原“骨架” | Scroll Animations（queued reveal、stacking cards、sticky title、horizontal sections、arc/pixelated/overlapping parallax 转场）；Sliders & Marquees（wavy marquee、radial marquee、cascading/flick sliders）；Navigation（stacked drawer、mega nav）；Forms/Checkbox；Dropdowns/Accordion/Tabs；Gallery 的 2D 部分；Visual Effects（film grain、progressive blur）；Gimmicks；Utilities（Lenis/Locomotive 平滑滚动） |
| **不可移植** | WebGL/Canvas 逐帧、指针实时驱动、视频/音频播放器、第三方地图/Rive 运行时；不存在有限关键帧表达 | Cursor Animations（image-preview follower、cursor marquee、Spotlight Cursor with Unicorn Studio）；Hover Interactions（image trail/momentum、interactive wave/dots backgrounds）；WebGL/3D（3D cube 转场、3D cards tornado、globe gallery、infinite dome grid、depth tiles）；Video & Audio；Mapbox store locator/globe；Rive setup；pixelated/WebGL 效果 |

### 2.3 可直接/近似移植（清单）

- **Text Animations**：`masked-text-reveal`、`typewriter-effect`、`highlight-marker-text-reveal`、`highlight-text-on-scroll`（仅入场段）、`rotating-text` 与 `looping-words-with-selector`（仅单次换词段）。
- **Page Transitions**：`cross-fade-page-transition`、`double-wipe-page-transition`、`shutter-page-transition`、`column-wipe-page-transition`、`masked-window-page-transition` 等“整屏色板/遮罩”类 2D 家族。
- **Buttons**：`button-with-css-character-stagger`、`underline-link-animation`（可加 `draw-random-underline` 的简化版）。
- **Loaders**：`logo-stack-loader`、`dropping-cards-loading-animation` 等简单堆叠/下落序列。
- **Sections & Layouts**：部分块级入场/切换（如 tabs 内容入场的 2D 段），需按资源逐个确认。

### 2.4 仅部分可移植（配方级清单）

- **Scroll Animations**：`queued-scroll-reveal`、`stacking-cards-3d-css`、`horizontal-scrolling-sections`，以及滚动驱动的 `arc-scroll-transition`、`pixelated-scroll-transition`；另含 Text Animations 中滚动驱动的 `sticky-title-scroll-effect` 与 Page Transitions 中的 `overlapping-parallax-page-transition`。
- **Sliders & Marquees**：`wavy-marquee`、`radial-cards-marquee-css`、`cascading-slider`、`flick-cards-slider`。
- **Navigation**：`stacked-drawer-navigation`、`mega-navigation-directional-hover`。
- **Forms**：`animated-checkbox-css`、`custom-select-single-multiple`。
- **Dropdowns & Information**：`accordion-css-animation`、`tab-system-with-autoplay-option`、`expanding-feature-pills`。
- **Gallery**：`before-after-split-slider`、`parallax-image-gallery-with-thumbnails`、`wavy-accordion` 等 2D 部分。
- **Visual Effects**：`film-grain-effect`、`progressive-blur`（AE 效果可做，但不是关键帧库能力）。
- **Gimmicks / Utilities**：`elastic-line`、`sticker-effect-on-click`、`draggable-stickers`；`lenis-smooth-scroll-setup`、`locomotive-smooth-scroll-setup`。

### 2.5 不可移植（清单）

- **Cursor Animations**：`image-preview-cursor-follower`、`cursor-with-marquee-effect`、`image-trail-following-cursor`、`velocity-based-custom-cursor`；Visual Effects 中的 `spotlight-cursor-unicorn-studio` 同样依赖 Unicorn Studio 运行时，归入本桶。
- **Hover Interactions**：`momentum-based-hover`、`interactive-wave-lines-background`、`interactive-dots-grid-background`、`collage-focus-card-on-hover`（指针驱动部分）。
- **WebGL/3D**：`3d-cube-page-transition`、`3d-cards-tornado`、`globe-gallery`、`infinite-dome-grid`、`depth-tiles-infinite-loop`、`pixelated-wave-page-transition`（像素/逐帧质感）。
- **Video & Audio**：全部 14 条（Bunny HLS 播放器、Vimeo 播放器、Howler 音频等）。
- **第三方运行时**：`store-locator-mapbox`、`interactive-globe-mapbox`、`rive-setup`、`lottie-setup`。

> 判定冲突的处理：`globe-gallery` / `infinite-dome-grid` / `depth-tiles` 在“Gallery 仅部分可移植”和“WebGL 不可移植”中都会出现，本文统一按“能否用 2D 关键帧重建”判为**不可移植**；`cascading-slider` 等滑杆只保留其“逐卡入场”骨架，滑动/拖拽本体不移植。

---

## 3. 观察到的动效特征（观察 / 估读 / 推断）

### 3.1 方法与边界

- 预览视频均为 **1440×900、30 fps 短循环**（44–168 帧，1.47–5.60 s），是**展示页演示**，不是资源的完整行为（滚动量、悬停区域、页面切换逻辑都不在其中）。
- 观察手段：12 张 3×3 等距联系表 + 对 2 条缺联系表的视频（`underline-link-animation`、`text-scramble-load-scroll-hover`）按帧号临时抽帧（`%TEMP%`，未入库）；另对 typewriter / number-odometer / masked-text-reveal 做了逐帧序列抽帧以估节奏。
- **无法获得 Osmo 的精确 duration / ease / stagger**：视频没有时间码与曲线标注，源码/文档为会员内容。任何“看起来是 power2Out”的说法都只能算推断；F2A 条目使用的是 F2A 自有参数（见第 4 节）。
- 估读误差来源：30 fps 采样、联系表等距抽样（0.1–0.7 s 步长，随片长）、视频循环截断。

### 3.2 逐资源可观察行为

| 资源（slug） | 帧数/时长 | 可观察行为（观察） |
|---|---:|---|
| `masked-text-reveal` | 130 / 4.33 s | 段落文字在行框/词框内被裁切后上浮显形，整段按切分单位错峰；界面有 **Lines / Words / Letters** 三档切换，切换后重播；画面文案自述“GSAP SplitText…staggered tweens, custom ease functions, dynamic transforms” |
| `typewriter-effect` | 130 / 4.33 s | 首帧只有紫色细光标；随后逐字出现，光标始终贴在末字右侧；第一行打完后第二行开始；完成前后可见光标有/无两种帧（闪烁或隐藏），未见回删 |
| `highlight-marker-text-reveal` | 155 / 5.17 s | 高亮色块自上而下扫过，文字只在色块内显形；紫色/白色两套主题；画面文案：“CONTROL THEME, DIRECTION, STAGGER, AND MORE WITH ATTRIBUTES”“THESE WILL REVEAL TOP TO BOTTOM…”；另有长段落/小字号演示 |
| `cross-fade-page-transition` | 120 / 4.00 s | 真正的双画面交叉溶解：中间帧同时可见 A 页标题与 B 页图像；顶部有 Page A / Page B 切换；含去程与回程 |
| `double-wipe-page-transition` | 160 / 5.33 s | 整屏被大色板分块横扫覆盖后露出 B 页，随后反向退出；可见色板边缘与分块错位 |
| `shutter-page-transition` | 116 / 3.87 s | 多根细横条（目测约 20 根）像百叶一样开合，A 页透过缝隙可见，闭合后换 B 页 |
| `masked-window-page-transition` | 105 / 3.50 s | 画面中央一块矩形窗口从小到大展开、露出 B 页，再收缩回 A 页；窗口内文字随之可见 |
| `underline-link-animation` | 110 / 3.67 s | 两个并排链接的细下划线出现/消失（悬停联动）；抽帧可见一词有线、另一词无线；线条具体是宽度展开还是位移擦入无法确认（推断） |
| `number-odometer` | 117 / 3.90 s | 每位数字是独立竖向滚轮，中间帧可见上下数字被裁切；滚动到 €248.750 后静置，再反向滚回起始值循环 |
| `rotating-text` | 168 / 5.60 s | 句子中固定词位轮换（tools → systems → help → routines…，绿色高亮）；换词瞬间词位出现空白帧；具体是纵向滚动、遮罩还是淡入无法确认 |
| `text-scramble-load-scroll-hover` | 44 / 1.47 s | 首帧整段为随机字符，随后逐字/逐词从左向右落定成正常句子；标题表明还支持滚动/悬停触发，但预览只演示载入 |
| `logo-stack-loader` | 88 / 2.93 s | 同一 OSMO 字标反复自下向上滑入并逐层堆叠（带拖影/重影），尾部白色面板扩张转场 |
| `dropping-cards-loading-animation` | 120 / 4.00 s | 多张照片卡片依次下落入堆，带轻微旋转/错位，落位后整屏大图接着出场 |
| `button-with-css-character-stagger` | 90 / 3.00 s | 悬停时按钮文字按字符错峰上下位移（字符在按钮内被裁切），移出后回落；按钮本身不变形 |

### 3.3 节奏估读（30 fps 逐帧；均为估读，不是 Osmo 参数）

| 资源 | 估读节奏 | 采样依据 |
|---|---|---|
| `typewriter-effect` | 约 **3–4 帧/字（0.10–0.13 s/字）**；首行 10 字约 1.2 s，完成后第二行同速 | 按帧号 0/6/12/18/24/30/36/42/48 抽帧，字数递增 |
| `text-scramble-load-scroll-hover` | 全句约 **0.6–0.9 s** 落定，逐字由左向右 | 每 2 帧抽帧，0–0.7 s 内由全随机到基本可读 |
| `number-odometer` | 进滚约 **1.2–1.5 s**，静置约 **1.0 s**，回滚约 **0.5–0.8 s** | 每 12 帧抽帧（0.4 s 步长） |
| `cross-fade-page-transition` | 交叉溶解约 **0.4–0.8 s**（单帧即进入混合） | 联系表 9 帧等距（约 0.5 s 步长），中间仅 1 帧混合态 |
| `double-wipe` / `shutter` / `masked-window` | 单次遮/揭约 **1.0–1.5 s**，含往返与停留 | 联系表 9 帧等距（约 0.4–0.7 s 步长，随片长） |
| `masked-text-reveal` | 整段 reveal 约 **0.9–1.2 s**；单位错峰小于 0.3 s 采样间隔，无法估读 | 每 9 帧抽帧（0.3 s 步长） |
| `logo-stack-loader` | 每层约 **0.3–0.4 s** 叠加一层 | 联系表 9 帧等距（约 0.35 s 步长），层数递增 |
| `rotating-text` | 约 **1.2–1.6 s/词**（5.6 s 内 4 个词） | 9 帧等距（0.7 s 步长） |

### 3.4 推断项与不可确认项

- **参数不可得**：Osmo 的精确 duration/ease/stagger 只有会员文档/源码才有；本文不对其做数值断言，F2A 参数见第 4 节。
- **实现推断**：`masked-text-reveal` 画面文案提到 GSAP SplitText（观察文字），据此**推断**其实现为逐行/词/字拆分的遮罩上浮；“Lines/Words/Letters”是界面显示的模式（观察），不是参数值。
- **属性推断**：Highlight Marker 的 theme/direction/stagger 来自画面文案（观察），但属性名、取值范围、默认方向均为推断。
- **机制推断**：`rotating-text` 是纵向滚动、遮罩位移还是淡入淡出，抽帧无法区分；`underline-link` 的展开方向同理（F2A 选择左端固定向右，未逐帧确认 Osmo 方向）。
- **触发不可见**：Scroll / Hover / Cursor 类资源的触发逻辑、缓动曲线与滚动映射不在预览里；不能据短片推断其真实参数。
- **循环截断**：短循环首尾可能被剪辑，末帧不一定是资源的真实终态。

---

## 4. F2A 映射表（已落地）

### 4.1 命名与机制

- **转场预设**：`kind: procedural`、`command: transition`，id 为 `preset-trans-*`（本轮新增 `preset-trans-fade` / `preset-trans-split` / `preset-trans-shutter`，与既有 `wipe/bars/iris` 并列）；不带 `slug`，存于 `motion-library/builtin.json` 的 `presets[]`，生成源为 `scripts/extract-motion-library.py` 的 `procedural_presets()`（Osmo 段带 `sourceStyle: "Osmo"` 与 `Osmo` 标签）。
- **内容片段**：`kind: clip`（`clips[]`），`slug` 为 `os-*`（本轮 2 条）；每轨仅 2 个关键帧、无表达式；生成源为同脚本的 `osmo_clips()`。
- **转场实现**（`host/motion/aeMotionPresets.jsx` 的 `C.transition`）：在当前合成上新建一个形状层 `Transition (<type>)`，以 **`time` 为遮屏切点**、时长 `d` 对称分布：层入点 `time−d/2`、出点 `time+d/2`（+1 帧），画面在 `time` 被完全遮住（换页点）。`fade` 是“经底色渐隐→全屏→渐显”，`split/shutter` 是两块半屏色板从两侧合拢、再交错穿出；全部为可编辑形状层，无表达式。
- **`os-*` 片段机制**：只动 **Scale X 0→100%**（Y/Z 保持 100），因此必须先把图层**锚点设到左侧**，否则宽度会从中心向两侧展开。
- **截至本轮库总量**：**62 clips / 43 presets**（含 6 条转场预设：wipe、bars、iris、fade、split、shutter）。

### 4.2 转场预设（3 条，本轮新增）

| Osmo 来源 | 公开观察 | F2A 条目（id / kind） | F2A 参数 | 差异／说明 |
|---|---|---|---|---|
| Cross Fade Page Transition | 双画面交叉溶解，中间帧 A/B 同屏混合 | `preset-trans-fade` / procedural（`command: transition`，`type: fade`） | `duration: 0.9`；颜色 `[0.06,0.06,0.08]`；Opacity 0→100→0 三键（influence 60） | **2D 近似**：经深底色淡出到全屏再淡入，**不是真正的双画面 cross-dissolve**；真正交叉需两个预合成叠化（见 5.5） |
| Double Wipe Page Transition | 大色板分块横扫覆盖，再反向退出 | `preset-trans-split` / procedural（`type: split`） | `duration: 1.0`；颜色 `[0.08,0.07,0.12]`；左右两块半屏色板对向合拢，切点各覆盖半屏，随后交错穿出对侧（smooth 曲线） | **简化**：Osmo 是多块大面板/分块；F2A 固定左右 2 块；`direction` 参数对此类型不生效 |
| Shutter Page Transition | 多根细横条百叶式开合 | `preset-trans-shutter` / procedural（`type: shutter`） | `duration: 1.0`；颜色 `[0.08,0.07,0.12]`；上下两块半屏合拢遮屏，再交错揭开 | **简化**：Osmo 目测约 20 根细横条逐根错峰；F2A 只有 2 块，观感是“上下合幕”，不是百叶 |

> 共同要求：`time`（切点）必须满足 `time − duration/2 ≥ 0`，否则报 `BAD_ARGS`；若 `time + duration/2` 超出合成末尾，尾段会被裁掉（出点取 `min(合成时长, time+d/2+1帧)`）。三者的 `supports` 只暴露 `duration`。

### 4.3 内容片段（2 条，本轮新增）

| Osmo 来源 | 公开观察 | F2A 条目（id / kind） | F2A 参数 | 差异／说明 |
|---|---|---|---|---|
| Highlight Marker Text Reveal | 高亮色块自上而下扫过，文字仅在块内显形 | `os-highlight-sweep` / clip | Scale X 0→100%（Y/Z=100）；0.45 s；**power3Out**；`defaultAnchor: end`；category 强调 / phase in | 只移植“色块宽度展开”这一底层运动；遮罩显形、主题、方向、错峰不在 clip 内，需按 5.2 手工搭建 |
| Underline Link Animation | 细下划线以宽度展开方式出现/消失 | `os-underline-draw` / clip | Scale X 0→100%；0.35 s；**power2Out**；`defaultAnchor: end`；category 强调 / phase in | 同理只移植线条展开；悬停触发与收回不包含；方向按左端固定向右实现 |

> 应用要点：两条 clip 都要求**锚点左置**；语义上它们表达“宽度从 0 展开到设计稿宽度”，终态即设计稿。

### 4.4 文字预设：本轮未发货

| Osmo 来源 | 公开观察 | F2A 条目 | 差异／说明 |
|---|---|---|---|
| Masked Text Reveal / Typewriter / Highlight Marker / Rotating Words 等 | 逐行/逐词/逐字遮罩、独立高亮条、逐帧字形替换 | **本轮 0 条**（既有近似：`preset-text-typewriter`、`preset-au-typing` 做逐字打字；`preset-text-rise` 等 6 条做逐字/逐词上浮） | 逐行遮罩需要“每行独立文本层 + 矩形蒙版”，高亮需要“独立色块层 + track matte”，字形替换需要逐帧换字；均超出“单文本层 + 单一文字动画器”的表达范围，硬塞会牺牲可编辑性。需要时按 5.1/5.2/5.4 手工搭建 |

### 4.5 本轮增量与库统计

| 项 | 数量 | 说明 |
|---|---:|---|
| 新增 clips | 2 | `os-highlight-sweep`、`os-underline-draw` |
| 新增 presets | 3 | `preset-trans-fade/split/shutter` |
| 转场预设总数 | 6 | wipe、bars、iris、fade、split、shutter |
| 带 `Osmo` 标签的条目 | 5 | 3 转场 + 2 片段 |
| 文字预设 | 0 | 见 4.4 |
| **库总量** | **62 clips / 43 presets** | 截至本轮提交 |

---

## 5. 配方清单（不可移植/仅配方）

以下为 AE 复刻思路，均遵守 F2A 动效生产红线：单轨 ≤3 键、避免逐帧、Web/Lottie 交付优先无表达式。循环类的 `loopOut` 仅限 AE 交付，Web/Lottie 改用预合成循环或静置终态。

### 5.1 Masked Text Reveal

- 把整段文字**按行拆成独立文本层**（或每行一个预合成）；每行上方建一个矩形蒙版/轨道遮罩，只露行框。
- 行内容 `yPercent 100→0`（或 `+行高→0`）约 0.7 s、ease-out；**行错峰 0.06–0.1 s**；遮罩静态不动，靠内容位移显形。
- 整段是“逐行遮罩 + 行内上浮”的组合：如需 Words/Letters 模式，再在行内按词/字拆层（工作量陡增，通常只做 Lines）。
- 无逐字关键帧；可用预合成整体套用到多行，改字只改预合成内文本。

### 5.2 Highlight Marker

- 文本层 + **独立高亮矩形层**（置于文本下方）：高亮块自上向下（或按 `direction`）以蒙版/位移擦入。
- 文本用高亮块的 **track matte（Alpha）** 显形——即“文字只在色块覆盖处出现”；高亮块与文本层错峰。
- 主题（深底/白底）用两套色值；错峰用多层高亮块的起始时间差实现；文字排版变化需重做蒙版，属于“逐资源定制”。
- 若只要“色块宽度展开”的极简版，直接用 `os-highlight-sweep`。

### 5.3 Number Odometer / Scrolling Number

- 每位数字做 **10 个数字竖排的预合成** + 一个固定高度的**遮罩窗口**；窗口内只露一位。
- 按最终数值做 **2–3 键 `translateY` 滚动**（起点、终点，必要时 1 个中间键）；不同位的滚动距离不同。
- 循环演示可用 `loopOut('cycle')`（AE-only）；交付 Web/Lottie 时改为“静置终态 + 独立的循环预合成素材”，避免表达式。
- 滚动方向、每位起始偏移、相邻位错峰都按需设置；本节不给出 Osmo 参数。

### 5.4 Rotating / Looping / Swapping / Rolling Text

- 用**两个文本层（或两个预合成）**做交叉位移/淡出：旧词上移淡出、新词自下移入，各 2–3 键，≤3 键铁律。
- 内联词位宽度变化：把词位放进独立预合成，宽度用固定占位或 3 键缩放近似；或让每个词独立长度、父级用段落文本对齐。
- 循环同上：AE 用循环表达式/预合成循环，Web/Lottie 用预渲染素材或终态静置。

### 5.5 其他 Page Transition 家族

| 家族 | AE 复刻思路 |
|---|---|
| 3D Cube | 前后两页各做预合成，AE 3D 层 + 相机旋转 90° 交换；或直接预渲染立方体转场素材 |
| Curved Wipe | 形状遮罩（含曲边）+ 遮罩路径 2–3 键扩展；曲边用贝塞尔路径固定 |
| Pixelated Wave | 预渲染像素化素材/分块遮罩序列；AE 内用马赛克效果 + 遮罩错峰，避免逐帧 |
| Stacked Cards | 多层卡片预合成，各自 Position/Rotation 2–3 键，按顺序交替进出 |
| Overlapping Parallax | 两层反向位移（前层快、后层慢），2 键即可；换页点用全屏色板/遮罩遮住切点 |
| Draw SVG | 形状层 Trim Paths 0→100%（或预合成描边），配合底色层遮屏 |
| 真正的 Cross-Dissolve | 前后两页各一个预合成，A 的 Opacity 100→0、B 的 0→100 同时进行（两轨各 2 键）；不是 F2A fade 的“经底色”写法 |

### 5.6 Scroll Animations

- `queued-scroll-reveal` / `elements-reveal-on-scroll`：2 键入场 + 固定时间错峰；AE 中用“滚动进度→时间”的映射表（每段 2 键）或直接按演示节奏排时间。
- `stacking-cards` / `sticky-title` / `horizontal-sections`：在 AE 里用**预合成 + 关键帧按滚动进度换算时间**，或先录屏再逐段对齐；不建议逐帧。
- 滚动驱动的 arc / pixelated / overlapping parallax 转场：分层预合成 + 遮罩/位移，按进度点打 2–3 键。

### 5.7 Loaders

- `logo-stack-loader`：同一字标预合成复制 N 层，每层 2 键上移 + 透明度，层间错峰；尾部白板扩张用 2 键缩放/遮罩。
- `dropping-cards-loading-animation`：卡片预合成，各 2–3 键“下落 + 轻微旋转 + 落位”，按顺序错峰；落位后可接整屏大图。
- 序列类 loader 一律“预合成 + 层错峰”，不逐帧。

### 5.8 Film Grain / Progressive Blur

- Film Grain：AE 分形噪波/噪波效果 + 极轻的透明度抖动（或预渲染噪波素材叠层）；**不是关键帧库能表达的 2D 变换**。
- Progressive Blur：模糊层 + 渐变遮罩（或摄像机镜头模糊）实现“越往下越糊”；属于图层效果配方，不打包为 clip。
- 两者均属 AE-only 效果，Web/Lottie 交付需预渲染为素材。

### 5.9 Cursor / Hover / WebGL

- 不可移植：指针位置、拖拽惯量、WebGL 顶点动画都不存在有限关键帧表达。
- 处理方式：只做“静态构图 + 录屏参考”；需要成片时把交互录屏作为素材层，或在引擎侧实现，不进入 F2A 动效库。

---

## 6. 许可与合规（复核）

- Osmo 资源是**会员授权内容**：个人/客户项目可用，但**不得转售、不得作为库或产品再分发**，不得把资源下载/存储到 Vault 之外。
- 本文所有结论只来自：公开 `/collection` 页面（标题、分类、资源清单、公开 FAQ 文案）与**公开预览视频**；未使用任何会员源码，未从 `/resource/*`、`/easings` 或演示子域提取任何内容（这些路径属 robots 禁止/会员内容，发现后即停止访问并删除临时快照），未下载资源包。
- F2A 的 `os-*` 与 `preset-trans-fade/split/shutter` 是**独立实现**（AE 形状层 + 关键帧，参数为 F2A 选择），不包含 Osmo 代码或素材。
- 预览视频/联系表仅是分析证据，**不得**随 F2A 打包分发或在公开仓库长期保留原始素材（本仓库的 `artifacts/` 属内部分析资料，按团队规范管理）。
- 若有人要求“1:1 对齐某 Osmo 资源”，先确认其会员授权，并由其提供录屏/导出；分析结果只描述行为，不复制代码。

---

## 7. 兼容性与风险

| 风险 | 说明 | 处理 |
|---|---|---|
| 转场不是真 cross-dissolve | `preset-trans-fade` 是“经底色渐隐→全屏→渐显”，中间会短暂被底色盖住，双画面不同时可见 | 需要真叠化时用两个预合成交叉（5.5），或改用 `preset-trans-wipe` 类擦除表达 |
| 转场时间约束 | `time` 是切点；`time−duration/2` 小于 0 会报错，`time+duration/2` 超出合成会裁尾 | 排时间线时先给切点，再检查前后各留半段；合成时长 ≥ 转场时长 |
| `direction` 对 fade/split/shutter 无效 | 只有 wipe/bars 使用 `direction`；split/shutter 的方向由几何固定 | 需要上下/左右换向时改实现或手工关键帧 |
| split/shutter 与 Osmo 观感不同 | Osmo 是多面板/细百叶，F2A 是两块半屏，整体节奏更像“合幕” | 作为“F2A 风格近似”使用；要百叶感需手工多面板（5.5） |
| `os-*` 锚点依赖 | 只动 Scale X，锚点默认居中时会从中心向两侧展开 | 应用前把图层锚点设到左侧；或应用后改 Anchor Point |
| 转场是全屏形状层 | 会覆盖下层所有内容；换页前后需自行准备两个“页”预合成并留出遮屏窗口 | 转场层只负责遮屏；页面内容分预合成摆放，切点后可切换 |
| 文字/遮罩类不可直接打包 | 逐行遮罩、独立高亮层、逐帧字形替换都不是单文本层+单动画器能表达的 | 文字类按 5.1/5.2/5.4 手工搭；F2A 文字预设 `preset-text-*` / `preset-au-typing` 仅能近似打字机/上浮 |
| 命名与来源区分 | RB/AC/AU 包条目为 `preset-rb-*`、`preset-ac-*`、`preset-au-*` 与 `rb-*`/`ac-*`/`au-*`；Osmo 为 `os-*` + 带 Osmo 标签的 `preset-trans-*`；本轮**没有** `preset-os-*` 文字预设 | 面板按 `sourceStyle`/标签过滤；文档中不要把 `preset-trans-*` 整体说成 Osmo（wipe/bars/iris 是本轮之前的通用转场） |
| Web/Lottie 兼容 | 转场层与 `os-*` 片段都是形状层/缩放关键帧，无表达式；文字预设依赖文字动画器+Amount 表达式 | Web/Lottie 用转场与 `os-*` 片段；文字预设仅 AE/视频交付 |
| 观察证据有限 | 预览只是 1.47–5.60 s 的展示循环，滚动/悬停/指针触发不可见；短于采样步长（0.3–0.7 s）的错峰可能被漏采 | 精确对齐前先向用户索取资源录屏/导出，或按本文的“估读”区间先做观感近似 |
| 目录会变 | 234 条/18 类是 2026-11-24 快照；Osmo 持续新增 | 需要更新时重跑清单解析，不改本文的历史结论；库总量以 `builtin.json` 为准（本轮 62/43） |

---

## 附：公共来源索引

| 来源 | URL / 本地路径 | 用途 | 使用情况 |
|---|---|---|---|
| 公开资源目录 | `https://www.osmo.supply/collection`；快照 `artifacts/osmo-src/collection.html` | 标题/分类/资源清单/公开 FAQ/许可口径 | 已用（公开页面） |
| robots 规则 | `https://www.osmo.supply/robots.txt` | 确定允许路径，避免触碰会员/演示区 | 已遵守 |
| 公开索引（允许） | `https://www.osmo.supply/llms.txt` | 官方 llms 索引 | 已读（仅用于产品结构核对） |
| 公开产品页（允许） | `https://www.osmo.supply/product/page-transition-course` | 页面转场课程的产品说明与转场家族词汇 | 已用（公开文案） |
| 解析清单 | `artifacts/osmo-src/resources.json` | 234 条结构化盘点 | 已用 |
| 公开预览视频 CDN | `https://osmo.b-cdn.net/resource-video/<slug>-1440x900.mp4` | 预览视频来源（只播不看源码） | 已用（14 条本地副本） |
| 预览视频本地副本 | `artifacts/osmo-src/videos/*.mp4` | 行为观察/抽帧 | 已用 |
| 预览联系表 | `artifacts/osmo-src/contact/*.png`（12 张） | 3×3 等距抽帧 | 已用 |
| 自测 AE 渲染 | `artifacts/osmo-src/contact/ae-split-transition.png` | F2A split 转场 9 帧验证（非 Osmo 素材） | 已用 |

按合规要求，本索引**不列出**会员资源路径（`/resource/*`）与 Osmo 演示子域；这些路径属 robots 禁止/会员内容，本轮未纳入分析、未提取任何源码或素材。

<details>
<summary>14 条公开预览视频的路径、帧数与联系表状态（点击展开）</summary>

| 视频文件（`artifacts/osmo-src/videos/`） | 帧数 | 时长 | 联系表 |
|---|---:|---:|---|
| `masked-text-reveal.mp4` | 130 | 4.33 s | 有 |
| `typewriter-effect.mp4` | 130 | 4.33 s | 有 |
| `highlight-marker-text-reveal.mp4` | 155 | 5.17 s | 有 |
| `cross-fade-page-transition.mp4` | 120 | 4.00 s | 有 |
| `double-wipe-page-transition.mp4` | 160 | 5.33 s | 有 |
| `shutter-page-transition.mp4` | 116 | 3.87 s | 有 |
| `masked-window-page-transition.mp4` | 105 | 3.50 s | 有 |
| `number-odometer.mp4` | 117 | 3.90 s | 有 |
| `rotating-text.mp4` | 168 | 5.60 s | 有 |
| `logo-stack-loader.mp4` | 88 | 2.93 s | 有 |
| `dropping-cards-loading-animation.mp4` | 120 | 4.00 s | 有 |
| `button-with-css-character-stagger.mp4` | 90 | 3.00 s | 有 |
| `underline-link-animation.mp4` | 110 | 3.67 s | 无（本轮按帧临时抽帧） |
| `text-scramble-load-scroll-hover.mp4` | 44 | 1.47 s | 无（本轮按帧临时抽帧） |

</details>

F2A 侧引用：`motion-library/builtin.json`（`presets[]` 的 6 条转场、`clips[]` 的 `os-*`）、`scripts/extract-motion-library.py`（`osmo_clips()`、`procedural_presets()` 的 Osmo 段）、`host/motion/aeMotionPresets.jsx`（`C.transition` 的 fade/split/shutter 分支）、`tests/motion-library.cjs`（Osmo 条目断言）、`README.md` 与 `skills/f2a-motion-production/SKILL.md`（参考文档索引）。
