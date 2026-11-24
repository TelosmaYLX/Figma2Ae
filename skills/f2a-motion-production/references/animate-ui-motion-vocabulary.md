# Animate UI 动效语汇与 F2A 映射参考

> 内部参考：记录 animate-ui.com 动效语言的盘点、关键参数的源码实测值，以及本轮落地到 F2A 内置动效库的 AU 条目与不可移植边界。
> 分析日期：**2026-11-24**。分析对象：Animate UI 开源仓库 `imskyleen/animate-ui` 的 `main` 分支快照（`apps/v2` + `packages/react`）。
> 本文只做记录与映射，不修改代码；所有参数以 `D:\Tools\F2A\artifacts\animate-ui-src\` 下的源码为准，不用印象值。若任务书默认值与源码冲突，以源码为准并在第 5.4 节标注。

---

## 1. 概述

Animate UI（[animate-ui.com](https://animate-ui.com)）是基于 **Motion（`motion/react`，原 Framer Motion）** 的动画下拉原语库：把 shadcn/ui 里 Radix UI / Base UI / React Aria 的 primitives 换成等价组件，只改 import 就获得动画；另有一批 Animate UI 自研组件、9 个视觉背景和两套图标动画库。真正让它区别于普通动效合集的是**一套集中式动效令牌**：`src/utils/motion/index.tsx` 用 `ease / spring / transition / scale / blur / rotate / shift / stagger` 七组令牌表达全站动效，组件只引用令牌而不写魔法数字，并支持 `createMotionTokens(tempo)` 做全局节奏缩放。

源码层面动效分三类实现：① Motion 的 `variants + transition`（绝大多数入场/弹层）；② 浏览器 **Web Animations API**（`element.animate()`，用于错峰行、toast、指示器、backdrop，令牌经 `toCssTiming()` 把 spring 转成 100 采样线性缓动）；③ **Canvas / rAF 逐帧**（9 个 Backgrounds、Cursor、Click、Particles 等）。这一分布直接决定了 F2A 的可移植边界（第 2、6 节）。

### 1.1 分析资产

| 资产 | 路径 | 说明 |
|---|---|---|
| 完整仓库快照 | `artifacts/animate-ui-src/animate-ui-main/` | GitHub `imskyleen/animate-ui` main 分支解包；React 包在 `packages/react/src/`，站点/registry 在 `apps/v2/` |
| 扁平化 React 源码 | `artifacts/animate-ui-src/src/` | `packages/react/src/` 的扁平副本，**215 个文件**，本文路径均以此为准 |
| 动效令牌 | `src/utils/motion/index.tsx` | 全站唯一自研机制，分析价值最高 |
| 站点 registry | `apps/v2/registry/{backgrounds,icons,hugeicons,buttons,components}/` | 背景、图标、按钮的最终分发源码 |
| 文档源 | `apps/v2/content/docs/{primitives,backgrounds,icons}/` | 对应线上 `https://animate-ui.com/docs/...` |
| 安装方式 | `npx @animate-ui/cli@latest animate all`，或按组件 `shadcn add` | README 与站点一致 |

### 1.2 许可与引用边界

- 仓库 `LICENSE.md` 实际是 **“MIT + Commons Clause License Condition”**（Copyright © 2025 Elliot Sutton）：可用于商业项目，但**不得把组件本身以原始形态单独或打包转售**。站点/README 口头称 “free and open source”，但许可带 Commons Clause 限制——本文按许可证原文记录，不按“完全自由”理解。
- 本文正文中的参数与行为属于对源码的技术性引用；F2A 侧资产是根据参数**自行生成的 AE 关键帧/文字动画器**，不分发 Animate UI 源码，与该许可不冲突。对外再分发 F2A 资产前仍建议复核许可证原文。

---

## 2. 全站盘点

### 2.1 家族与计数（以快照目录/文档页实测）

| 家族 | 组件目录数 | 文档页数 | 代表组件 |
|---|---:|---:|---|
| Primitives / Base UI 包装 | 25 | 28 | dialog、popover、tooltip、menu、tabs、toast、switch、checkbox、progress |
| Primitives / Radix UI 包装 | 23 | 26 | dialog、hover-card、dropdown-menu、select、slider、toggle-group |
| Primitives / React Aria 包装 | 17 | 24 | modal、list-box、disclosure、tag-group、progress-bar |
| Primitives / Animate UI 自有 | 20（含聚合目录） | 50 | effects 15 个、texts 13 个、buttons 8 个、avatar-group、carousel、pinned-list、scroll-progress、sidebar、tabs、tooltip 等 |
| Backgrounds | 9 | 9 | bubble、fireworks、glyph、gradient、gravity-stars、hexagon、hole、stars、topography |
| Icons | 2 套 | — | lucide 风格 392 个 + hugeicons 风格 381 个，每个图标是独立动画组件 |

说明：站点对外常用“约 114 个组件”的宣传口径；源码快照按目录/文档页统计更多（一个目录可对应多个文档页，如 buttons/effects/texts 聚合目录展开为数十页）。本文以**目录/文档页实测**为准，不用宣传数字推导资产。

### 2.2 三分桶判定

判定依据是“能否在 AE 中用 2D 变换 + 透明度 + 原生文字动画器（少量关键帧）重建”，不是组件是否好看。

| 桶 | 判定标准 | 代表组件 | 一句话理由 |
|---|---|---|---|
| **可直接／近似移植** | 有限时长的 2D transform（Position/Scale）或 Opacity，或可用 AE 文字动画器按字/词控制的入场 | Fade、Blur、Slide、Zoom、Effect；Splitting Text、Typing Text；Dialog / Popover / Tooltip / Dropdown 的入场段；Toast 入场；Avatar Group 悬浮抬升；Button 按压（可做强调）；Counting / Sliding / Scrolling Number 的最终落位 | 动画本体是一次性 2D 变换／透明度／逐字属性，起止值固定，可翻译成 2 个关键帧或一条文字动画器 |
| **仅部分可移植** | 需要循环、遮罩、高度动画、多层编排、布局动画或状态机才能接近 | 数字滚动（逐位数字列）、Rolling / Morphing / Swapping / Sliding / Rotating Text、Shimmering / Gradient Text、Highlight（高亮块滑移）、Auto Height、Accordion / Disclosure、Tabs 指示器、Switch / Checkbox / Radio、Progress、Carousel、Pinned List、Bottom Navigation、Scroll Fade / Progress、Shine、Image Zoom、Tilt、Magnetic、Spring、Particles / Click | 核心观感依赖循环、遮罩或布局测量，AE 单段关键帧只能还原“骨架”，需预合成/遮罩/表达式弥补 |
| **不可移植** | WebGL/Canvas 逐帧、指针实时、随机粒子、View Transitions | 9 个 Backgrounds、Icons 的逐帧 morph/loop、Cursor、Click/Particles 粒子、Page Transition（View Transitions API）、Theme Toggler 的 wipe | 动画由每帧程序化计算或用户输入驱动，不存在有限关键帧表达；视频也没有稳定“终态” |

本轮 F2A 资产刻意集中在**入场原语（Fade/Slide/Zoom/Effect/Dialog/Menu）+ 文字入场（Splitting/Typing）**两条线上，与 RB/AC 包形成互补：RB 偏文字与内容整体入场，AC 偏卡片/弹层，AU 补充**弹簧手感**与**原生文字动画器**。

---

## 3. 动效令牌表（`src/utils/motion/index.tsx`）

这是本库最有价值的部分：所有组件共享同一组令牌。令牌为模块常量，`createMotionTokens(tempo)` 可按全局节奏派生（规则见 3.6）。

### 3.1 `ease`（13 条，cubic-bezier 控制点）

| 令牌 | 数组 | 典型用途 |
|---|---|---|
| `out` | `[0.23, 1, 0.32, 1]` | fade、reveal、popOut、swap、spin |
| `soft` | `[0.215, 0.61, 0.355, 1]` | menu、overlay、dialogFade、disclosure、sheet、handoffOut |
| `draw` | `[0, 0, 0.58, 1]` | check 勾选绘制、drawer |
| `inOut` | `[0.77, 0, 0.175, 1]` | shake、collapse |
| `away` | `[0.33, 0.17, 0.67, 0.5]` | dismiss 离场 |
| `in` | `[0.4, 0, 1, 1]` | drawerOut |
| `drawer` | `[0.34, 1.2, 0.64, 1]` | drawer 抽屉（带过冲） |
| `arrive` | `[0.11, 0, 0.5, 0]` | handoffIn |
| `color` | `[0.25, 0.1, 0.25, 1]` | 颜色过渡 |
| `leave` | `[0, 0, 0.58, 1]` | panelOut、tooltipOut |
| `enter` | `[0.25, 0.1, 0.35, 1]` | panelIn、tooltipIn |
| `resize` | `[0.4, 0, 0.1, 1]` | panelHeight |
| `fill` | `[0.4, 0, 0.2, 1]` | fill、换字/位移文本 |

### 3.2 `spring`（20 条）

| 令牌 | stiffness | damping | 附加 | 用途 |
|---|---:|---:|---|---|
| `press` | 550 | 30 | `restSpeed:10` | 按钮按压 |
| `pop` | 400 | 29 | — | popover / tooltip（包装层） |
| `tooltip` | 400 | 31 | — | Animate UI 自有 Tooltip |
| `dialog` | 150 | 25 | — | Dialog 内容 |
| `toast` | 280 | 24 | — | Toast |
| `selection` | 300 | 30 | — | Tabs 指示器、选中高亮 |
| `highlight` | 500 | 40 | — | Highlight 高亮块 |
| `reflow` | 500 | 40 | — | 重排占位 |
| `handoff` | 450 | 43 | — | 菜单手递手 |
| `morph` | 660 | 52 | — | 形变/布局跟随 |
| `height` | 300 | 30 | `bounce:0`, `restDelta:0.01` | 高度动画 |
| `slide` | 300 | 35 | `restDelta:0.01` | Tabs 内容滑动 |
| `thumb` | 300 | 25 | — | Switch 滑块 |
| `slider` | 400 | 32 | — | Slider |
| `bounce` | 200 | 16 | — | radio dot、强调 |
| `glyph` | 500 | 45 | — | 图标字形 |
| `checkPop` | 500 | 24 | — | 勾选 pop |
| `entrance` | 200 | 20 | — | **所有入场原语默认** |
| `progress` | 300 | 35 | `restDelta:0.01`, `restSpeed:0.1` | Progress |
| `number` | 90 | 50 | — | 数字计数 |

### 3.3 `transition`（28 条，秒）

| 令牌 | duration | ease | 用途 |
|---|---:|---|---|
| `menu` | 0.22 | soft | Menu/Dropdown 弹层 |
| `overlay` | 0.40 | soft | Dialog backdrop |
| `dialogFade` | 0.40 | soft | Dialog 内容透明度（transform 走 spring） |
| `fade` | 0.20 | out | 通用淡入淡出 |
| `color` | 0.20 | color | 颜色 |
| `reveal` | 0.30 | out | 内容揭示 |
| `disclosure` | 0.35 | soft | Accordion/Disclosure |
| `panelOut` | 0.15 | leave | 面板离场 |
| `panelIn` | 0.30 | enter | 面板入场 |
| `tooltipIn` | 0.34 | enter | Tooltip 内容换入 |
| `tooltipOut` | 0.13 | leave | Tooltip 内容换出 |
| `panelHeight` | 0.45 | resize | 面板高度 |
| `check` | 0.30 | draw（delay 0.20） | 勾选绘制 |
| `uncheck` | 0.30 | draw | 取消勾选 |
| `fill` | 0.30 | fill | 填充/换字 |
| `popOut` | 0.15 | out | Indicator 离场 |
| `swap` | 0.15 | out | 内容替换 |
| `spin` | 0.30 | out | 旋转图标 |
| `handoffOut` | 0.22 | soft | 菜单交出 |
| `handoffIn` | 0.26 | arrive | 菜单接收 |
| `dismiss` | 0.20 | away | 弹层关闭 |
| `shake` | 0.40 | inOut | 错误抖动 |
| `drawerOut` | 0.16 | in | Drawer 关闭 |
| `drawer` | 0.40 | drawer | Drawer 打开 |
| `sheet` | 0.40 | soft | Sheet 侧滑 |
| `collapse` | 0.28 | inOut | Sidebar 折叠 |
| `collapseLabel` | 0.14 | out | 折叠标签 |
| `instant` | 0 | — | 减动效时瞬切 |

### 3.4 `scale` / `blur` / `rotate`

| scale | 值 | 用途 | scale | 值 | 用途 |
|---|---:|---|---|---:|---|
| `press` | 0.97 | 按压 | `choice` | 0.985 | 单选项 |
| `tooltip` | 0.70 | Tooltip 入场 | `popover` | 0.80 | Popover 入场 |
| `menu` | 0.90 | Menu 入场 | `dialog` | 0.80 | Dialog 入场 |
| `toast` | 0.96 | Toast 到场/堆叠 | `icon` | 0.50 | 图标替换/占位 |
| `fill` | 0.70 | 填充/换字 | `action` | 0.90 | 操作/步骤按钮 |

| blur | 值 | 用途 |
|---|---|---|
| `icon` | `blur(2px)` | 图标/占位 |
| `tooltip` | `blur(6px)` | Tooltip 换内容 |
| `disclosure` | `blur(2px)` | 折叠面板 |
| `surface` | `blur(4px)` | Dialog 内容、Toast、行错峰 |
| `panel` | `blur(5px)` | 面板/Tabs 切换 |

`rotate.icon = 90`（度），用于图标旋转。

### 3.5 `shift` 与 `stagger`

| shift | 值(px) | 用途 | stagger | 值(s) | 用途 |
|---|---:|---|---|---:|---|
| `handoff` | 6 | 菜单手递手位移 | `stack` | 0.03 | 列表行栈错峰 |
| `navigation` | 24 | 内容切换横移 | — | — | — |
| `tabs` | 12 | Tabs 面板退场 | — | — | — |
| `step` | 24 | 步骤切换 | — | — | — |
| `tooltip` | 40 | Tooltip 换内容位移 | — | — | — |
| `shake` | 3 | 错误抖动幅度 | — | — | — |

### 3.6 `tempo` 缩放规则

`createMotionTokens(tempo)`：`duration / visualDuration / delay / repeatDelay / delayChildren` 乘以 `tempo`；`stiffness` 除以 `tempo²`；`damping` 除以 `tempo`；`stagger.*` 乘以 `tempo`。即**放慢全局节奏时阻尼比保持不变**（观感一致、只是变慢）。F2A 没有等价全局开关，只能按 clip 时间缩放近似。

---

## 4. 关键动画参数（源码实测）

> 约定：Animate UI 的 `delay` 属性多为**毫秒**（组件内部 ÷1000 再交给 Motion）；`duration` 为秒。下表已按源码换算。

### 4.1 入场原语（`src/primitives/effects/*`）

| 组件/效果 | initial → animate | transition | 备注 |
|---|---|---|---|
| **Fade** | `opacity: initialOpacity(0) → opacity(1)` | `spring.entrance`(200/20) | 支持 `delay`(ms)、`inView`（滚动进入）；`Fades` 用 `holdDelay` 做 `delay + i*holdDelay` 错峰 |
| **Blur** | `filter: blur(10px) → blur(0px)` | `spring.entrance` | 纯滤镜、无透明度；`initialBlur/blur` 可调（px） |
| **Slide** | 默认 `direction=up`、`offset=100`；hidden：up→`y +100`、down→`y −100`、right→`x −100`、left→`x +100`；visible→0 | `spring.entrance` | **原语无透明度**；减动效时退化为 `opacity 0→1` |
| **Zoom** | `scale: 0.5 → 1` | `spring.entrance` | 减动效时退化为透明度 |
| **Effect** | 四个开关 `blur/slide/fade/zoom` **默认全为 false**；开启后的默认值：slide up 100、zoom 0.5→1、blur 10→0、fade 0→1 | `spring.entrance`（所有开启属性共用） | 组合入场；`slide`/`zoom` 与 `fade` 同 spring 驱动，blur 默认关闭 |

### 4.2 文字类（`src/primitives/texts/*`）

| 组件/效果 | initial → animate | transition | 备注 |
|---|---|---|---|
| **Splitting Text** | `{x:150, opacity:0} → {x:0, opacity:1}` | `{duration:0.7, ease:'easeOut'}`（字面量，非令牌） | 错峰 `stagger` 默认 chars 0.05 / words 0.2 / lines 0.3；chars 按 `Intl.Segmenter` 字素切分、词内 `nowrap`；words 用 `/\S+\s*/g`；lines 需传 `string[]`；`by` 由 `type` 或数组决定 |
| **Typing Text** | 逐字改写 DOM 文本（无 opacity/transform 动画）；每字 `duration=100ms`、`delay=0`、`holdDelay=1000`、`loop=false` | `setTimeout` 定时器（非 Motion transition） | loop 时：写完→hold→逐字回删→下一条；光标 `TypingTextCursor`：1px × 16px、`translateY(2px)`、`opacity [0,0,1,1]` / `times [0,.5,.5,1]` / 1s 无限闪烁；仅打字中常亮 |
| **Counting Number** | 数值 0→target（每帧改写文本节点） | `spring.number`(90/50) + `restDelta:0.001`、`restSpeed:0.01` | 每帧写整串文本，不逐位；支持 padStart/千分位/小数 |
| **Sliding Number** | 每位是一条 10 数字竖直列，`translateY` 到目标位（±100% 整数倍、最短路径） | 位滚 `spring`(200/20/mass 0.4)；数值 `spring.number`(90/50) | 每列 10 个绝对定位 `<span>`，容器 `overflow-y:clip`、宽 `1ch`、`tabular-nums`；千分位/小数位各占一列 |
| **Scrolling Number** | 整条 0..N 数字带整体 `translateY/X` 到终值 | **默认 `spring`(stiffness 90, damping 30)** | 注意：源码默认不是 `spring.number`(90/50)，见 5.4；`itemsSize=30`、`sideItemsCount=2`、默认 `direction=btt` |

### 4.3 弹层与通知（`src/internal/{modal,toast,anchored,stagger}.*`、`primitives/tooltip`）

| 组件/效果 | initial → animate | transition | 备注 |
|---|---|---|---|
| **Dialog 内容**（无 side） | `opacity 0 + blur(4px) + perspective(500px) rotateX(−20°) scale(0.8)` → `opacity 1 / blur 0 / rotateX 0 / scale 1` | transform+filter：`spring.dialog`(150/25)；opacity：`dialogFade` 0.4 soft；exit：`dismiss` 0.2 away | `from` 默认 `top`；`from=bottom` 为 +20°，`from=left/right` 改用 rotateY ±20°；减动效时去 3D |
| **Dialog overlay** | `background-color / backdrop-filter / opacity` 从透明到静止态 | `overlay` 0.4 soft（经 WAAPI + `toCssTiming`） | 用 `element.animate` 做可中断补间，不是 Motion variants |
| **Sheet / Drawer 内容** | `opacity 0 + translateX/Y(±100%)` → 0 | Dialog 的 `data-side` 面板（sheet）：`sheet` 0.4 soft，exit `dismiss` 0.2 away；独立 Drawer primitive：`drawer` 0.4 drawer（带过冲），exit `drawerOut` 0.16 in | 方向由 `data-side`/`swipe-direction` 决定：`top→translateY(−100%)`、`right→translateX(100%)` 等 |
| **Tooltip**（Animate UI 自有，floating-ui 定位） | `opacity 0 + scale 0.7` → 1；**换内容**时旧层向反方向 `shift 40px` + `blur(6px)` + opacity 0，新层从对侧同参数进入 | `spring.tooltip`(400/31)；换内容：out `tooltipOut` 0.13 leave、move/in `tooltipIn` 0.34 enter | 全局单例 overlay + `layoutId` 箭头跟随；内容切换用手写 `element.animate` 做 clip 视口交换 |
| **Tooltip / Popover（Base UI、Radix 包装层）** | `opacity 0 + scale(tooltip 0.7 / popover 0.8 / menu 0.9)` → 1 | tooltip/popover：`spring.pop`(400/29)；menu：`menu` 0.22 soft | 包装层只有 opacity+scale，**无 blur/shift**；与上一行是两套实现，勿混用 |
| **Menu / Dropdown 行错峰** | 行：`opacity 0 + blur(4px) + translateX(8px)`（RTL 反向）→ 静止 | 行 `duration 0.3` + soft，逐行 `delay i×0.033`；超过 10 行时 step×√(10/n)；弹层 `menu` 0.22 | 只在“从关闭态打开”时触发；手递手（同层换菜单）用 `spring.morph`(660/52) |
| **Toast** | 入场：`translateY(∓100%) + scale(0.96×rest) + blur(4px)` → 归位；堆叠位 `restScale=max(0.9, 1−index×0.05)` | `spring.toast`(280/24) | 默认 `timeout=5000ms`；滑动关闭 rubber-band 系数 0.5/上限 48px、throw 时长 80–360ms（按速度） |

### 4.4 折叠、指示器与控件（`src/internal/*`、`src/primitives/*`）

| 组件/效果 | initial → animate | transition | 备注 |
|---|---|---|---|
| **Accordion / Disclosure** | `height 0 ↔ auto`、`marginTop` 变量、`opacity 0 ↔ 1`、`blur(2px) ↔ blur(0)` | `disclosure` 0.35 soft（高度/透明度/模糊同曲线）；`panelHeight` 0.45 resize 仅用于 Tabs/侧栏的面板高度 | 展开时测量 `scrollHeight` 写入 CSS 变量；面板底部 16px 渐隐遮罩；**auto 高度不可直出 Web/Lottie** |
| **Tabs 指示器** | 高亮块位置/尺寸跟随选中项；跟手时用速度→时长的动量曲线 | `spring.selection`(300/30) | 指示器是独立层，用 `transform: translate/scale` 而非布局；面板：`panelIn` 0.3 入场、`panelOut` 0.15 离场、`panelHeight` 0.45 高度、`fade` 0.2 透明度；面板退场带 `blur.panel`(5px) + `shift.tabs`(12px) |
| **Switch** | 滑块 x/width 到目标位置；按压时滑块宽度 ×19/16 | `spring.thumb`(300/25)；按压 `spring.press`(550/30) | 位置/宽度按轨道 DOM 实测，非固定 px |
| **Checkbox / Radio** | 勾选路径 draw（或图标 pop）；取消反向 | `check` 0.3 draw（delay 0.2）/ `uncheck` 0.3 draw；pop 用 `checkPop`(500/24)+`popOut` 0.15；radio dot 用 `bounce`(200/16) | 默认 draw，可切 pop；减动效时瞬切 |
| **Progress** | 指示条 `width → percentage%`；数值同步计数 | `spring.progress`(300/35) | 数值文本与宽度共用同一 spring |
| **Avatar Group** | hover 时头像 `translateY` 抬升（按堆叠序号位移） | `spring`(300/17) | 头像 tooltip 用 `spring.pop`(400/29)；`sideOffset=25` |

---

## 5. F2A 映射表（已落地）

### 5.1 命名与机制

- **文字预设**：`kind: procedural`、`command: text_reveal`、id 为 `preset-au-*`，存于 `motion-library/builtin.json` 的 `presets[]`；生成源为 `scripts/extract-motion-library.py` 的 `procedural_presets()`（Animate UI 段）。
- **内容片段**：`kind: clip`（`clips[]`），`slug` 为 `au-*`；每轨仅 2 个关键帧（起点＋终点），无表达式；生成源为同脚本的 `animate_ui_clips()`，共享曲线常量 `AU_SPRING = (0.34, 1.40, 0.64, 1)`（模拟 entrance 弹簧约 5% 单段过冲，弱于 `back.out` 的 ~10%）。
- **文字机制**（`host/motion/aeMotionPresets.jsx` 的 `C.text_reveal`）：给文本层加一个 AE 原生**文字动画器**（Position 3D / Scale 3D / Skew / Blur / Opacity）+ 一个 **Expressible Selector**，用一条 Amount 表达式按 `textIndex/textTotal` 算错峰；全层仅此一条表达式，无逐字关键帧。
- **方向语义**：F2A 的 `direction` 是**运动方向**，起始偏移取反侧（`host/motion/aeMotionPresets.jsx` 注释 “the side the unit comes from is its opposite”）：`left` → 起点 `+distance`（右侧），`right` → 起点 `−distance`（左侧），`up` → 起点 `+distance`（下方），`down` → 起点 `−distance`（上方）。
- **面板分组**：`sourceStyle: "AnimateUI"`、`tags` 含 `AnimateUI`，与既有 RB（React Bits）、AC（Aceternity）包并列，本轮为第三个开源来源包。
- 截至本文撰写：4 条 `preset-au-*` 与 6 条 `au-*` 均已写入 `motion-library/builtin.json`，由脚本生成、可随完整抽取管线重跑复现。

### 5.2 文字预设（`text_reveal`，4 条）

| Animate UI 来源 | 源码参数 | F2A 条目（id / kind） | F2A 参数 | 差异／近似说明 |
|---|---|---|---|---|
| Splitting Text / 默认（chars） | `{x:150,opacity:0} → {x:0,opacity:1}`；0.7s；`easeOut`；stagger 0.05 | `preset-au-splitting-text` / procedural | style=rise；by=chars；**direction=left**；distance 150；0.7s；stagger 0.05；ease=expoOut；`supports={duration,textBy}` | 源码**自右 +150px 向左滑入**；F2A 以“运动方向”记 `direction=left`，AE 回读起始偏移 `+150px`（右侧）。`easeOut` 无同名曲线，取 `expoOut` 近似（前段更陡）；面板名沿用“右滑入”（强调从右侧进入） |
| Splitting Text / words | 同上，stagger 0.2 | `preset-au-splitting-words` / procedural | style=rise；by=words；direction=left；distance 150；0.7s；stagger 0.2；ease=expoOut | 整词分层；切分规则 `/\S+\s*/g`，词间空格保留 |
| Splitting Text / lines | `text: string[]`，stagger 0.3 | `preset-au-lines-slide` / procedural | style=rise；by=lines；direction=left；distance 150；0.7s；stagger 0.3；ease=expoOut | 逐行滑入；F2A 的 `by=lines` 按段落/换行计数 |
| Typing Text | 每字 100ms；delay 0；holdDelay 1000；loop=false；光标 1s 闪烁 | `preset-au-typing` / procedural | style=typewriter；by=chars；duration 0；stagger 0.1；ease=linear；`supports={textBy}` | 100ms/字 → stagger 0.1s；typewriter 的 duration 锁定为 0；**光标闪烁与回删未打包**（需独立层+循环，见第 6 节） |

### 5.3 内容片段（`kind: clip`，2 键/轨，6 条）

| Animate UI 来源 | 源码参数 | F2A 条目（id / kind） | F2A 参数 | 差异／近似说明 |
|---|---|---|---|---|
| Fade | `opacity 0→1`；`spring.entrance`(200/20) | `au-fade` / clip | Opacity 0→100；0.55s；`RB_POWER2_OUT` `cubic-bezier(0.33,1,0.68,1)` | 弹簧→单段缓出近似；透明度不用过冲曲线（避免 >100），0.55s 对应弹簧沉降观感 |
| Slide（up） | `y +100→0`；`spring.entrance`；无透明度 | `au-slide-up` / clip | Position y +100→0；0.6s；`AU_SPRING`(0.34,1.40,0.64,1) | 保留 ~5% 单段过冲；**不加透明度**，与源码一致 |
| Zoom | `scale 0.5→1`；`spring.entrance` | `au-zoom-in` / clip | Scale 50→100%；0.6s；`AU_SPRING` | 同上；单段过冲 |
| Effect（默认组合） | fade + slide up 100 + zoom 0.5；`spring.entrance`；blur 关闭 | `au-effect` / clip | Position y +100→0、Scale 50→100（`AU_SPRING`）；Opacity 0→100（`power2Out`）；0.65s | 省略可选 blur(10px)（Lottie/Web 友好）；组合属性共用同一时长 |
| Dialog（内容） | `scale 0.8 + opacity 0` + blur 4px + rotateX(−20°) + perspective 500px；`spring.dialog`(150/25) | `au-dialog-in` / clip | Scale 80→100%、Opacity 0→100；0.5s；`RB_POWER3_OUT` | dialog 弹簧过阻尼（ζ≈1.02，无过冲），用 power3Out；**3D 翻转、blur 4px、overlay 0.4s 未含** |
| Menu / Dropdown（弹层） | `scale 0.9 + opacity 0`；`transition.menu` 0.22 soft | `au-menu-in` / clip | Scale 90→100%、Opacity 0→100；0.22s；`RB_POWER3_OUT` | `ease.soft` 数组与 `power3Out` **数值相同**（`[0.215,0.61,0.355,1]`），等价；行错峰未含 |

### 5.4 实测偏差与实现取舍

1. **Tooltip 参数归属**：任务书给的 `spring.tooltip 400/31 + scale 0.7 + blur 6 + shift 40 + tooltipIn/out` 属于 **`src/primitives/tooltip`（Animate UI 自有）**；`base-ui/tooltip`、`radix-ui/tooltip` 的包装层走 `internal/anchored.ts`，用的是 `spring.pop`(400/29) + 仅 opacity/scale，无 blur/shift。文中两套分列，勿混。
2. **`scrolling-number` 默认弹簧**：源码 `DEFAULT_TRANSITION = { stiffness: 90, damping: 30 }`，不是 `spring.number`(90/50)。3.2 表的 `number` 令牌只被 counting/sliding number 使用。
3. **Effect 的默认值**：四个开关默认全 `false`；`slide up 100 / zoom .5 / blur 10 / fade 0→1` 是**开启后的单项默认**，不是默认全开。`au-effect` 按“fade+slide+zoom”组合、blur 未含，属刻意裁剪。
4. **Splitting Text 的缓动**：源码用 Motion 内建 `ease:'easeOut'`（非自定义数组）；F2A `expoOut`（闭式 `1−2^(−10u)`，预览等效 `cubic-bezier(0.16,1,0.3,1)`）比它更陡，属观感近似。
5. **`direction` 语义**：三条 Splitting 预设落为 `direction=left`，因为源码元素从右侧 +150px 向左回位；面板名“右滑入”指进入侧，不是 F2A 的运动方向。
6. **Typing 的 supports**：源码生成器里 `preset-au-typing` 的 `supports` 只有 `{textBy:true}`，`duration` 被锁定（typewriter 恒为 0），与任务书“supports={duration,textBy}”不同，以源码生成器为准。
7. **`au-fade` 的曲线**：`RB_POWER2_OUT`（power2Out）而非 `AU_SPRING`——透明度不应过冲；`au-effect` 的透明度同理，只有位移/缩放带 `AU_SPRING` 过冲。
8. **`collapse` 不属于折叠面板**：`transition.collapse 0.28 inOut` 被 `sidebar` 折叠使用；Accordion/Disclosure 用 `disclosure 0.35 soft`。

---

## 6. 不可移植与配方清单（含 AE 复刻思路）

| 组别 | 代表组件 | 为什么不可移植 | AE 复刻思路 |
|---|---|---|---|
| **循环/常驻扫光** | Counting/Sliding/Scrolling Number 的滚动过程、Gradient Text（50s 线性无限 `background-position 0%→500%`）、Shimmering Text（1s 循环高光 + 可选 wave `x/y ±5px`、`scale 1.1`、`rotateY 15°`）、Shine（1200ms、`deg −15°`、opacity 0.3）、Rolling/Morphing/Swapping/Sliding/Rotating Text | 无限循环 + 逐字/逐位多层状态，无固定终态 | 预合成一条循环：数字滚动用**逐位数字列预合成**（10 个数字竖排 + 遮罩窗口，2–3 键 `translateY` 循环，`loopOut('cycle')`）；扫光用**高光层 + 文字/图形遮罩 + 2 键位移**（可加 3 键回位）；换字类拆成两个文本层做交叉（≤3 键），不要逐帧 |
| **布局/高度动画** | Auto Height（`height 0↔auto`）、Accordion / Disclosure（height+opacity+blur 2px）、Tabs 指示器（位置/尺寸跟随）、Switch 滑块、Checkbox 勾选、Progress 填充、Carousel、Pinned List、Bottom Navigation | 依赖 DOM 布局测量与状态机；AE 无“auto 高度” | 把展开态做成独立预合成，用**固定高度** 2–3 键过渡 + 内容层遮罩；指示器/滑块用父级预合成内的两层（轨道+滑块）做 Position 键；Progress 用线性擦除或遮罩层 2 键；勾选可用“描边生长”预合成（Trim Paths 或遮罩） |
| **指针交互** | Tilt（`spring 300`）、Magnetic（`spring 100`）、Spring（跟随）、Image Zoom（`spring 200/28`、`zoomScale`）、Hover Card / Preview Link Card、Cursor（自定义光标）、Click / Particles（点击粒子） | 由鼠标/触摸输入驱动，无固定时长与终点 | 只还原“入场/离场”；交互峰值姿态用一对关键帧定格；弹性回弹用 3 键（超调→回位）；粒子和磁吸不做 AE 版，需要时把交互录屏作参考 |
| **背景（9 个）** | bubble、fireworks、glyph、gradient、gravity-stars、hexagon、hole、stars、topography | 多为 Canvas 2D / rAF 逐帧 / 指针视差：fireworks、glyph、gravity-stars、hole、topography 走 canvas，bubble/stars 走指针+motion，hexagon 为几何网格 | 预渲染为 PNG 序列 / MP4 作为素材层；或取一帧静态纹理 + 轻 2D 位移/遮罩淡入；循环背景用**预合成 + 首尾同帧**做无缝 loop（禁用逐帧关键帧，直接当素材播） |
| **页面转场** | Page Transition（3 个变体：通用 / React Router / TanStack Router） | 基于浏览器 **View Transitions API**（`document.startViewTransition`），属于浏览器行为，无法导出关键帧 | 用 F2A 自带 `preset-trans-*`（wipe/bars/iris）或预渲染转场素材；若要还原 `blur.panel` 5px + 位移的交叉感，用两层预合成 + 遮罩/模糊静态层 |
| **图标动画** | Icons（lucide 392 / hugeicons 381，逐帧 morph/path 动画、循环 loop） | 每个图标是独立的 SVG path 动画组件，逐帧或按 path 状态切换 | 只取需要的静态图标作为 AE 形状层；图标“描画出现”可用 **Trim Paths**（0→100%）替代，循环停/转用 2 键旋转 |

---

## 7. 兼容性与风险

### 7.1 缓动近似关系

| Animate UI 令牌 | 源码值 | F2A 可用曲线 | 关系 |
|---|---|---|---|
| `ease.soft` | `[0.215,0.61,0.355,1]` | `power3Out`（= `RB_POWER3_OUT`） | **数值完全相同**，等价 |
| `ease.out` | `[0.23,1,0.32,1]` | `expoOut`（闭式 `1−2^(−10u)`；预览 `cubic-bezier(0.16,1,0.3,1)`） | 近似：F2A 前段更陡、尾段更缓 |
| `ease.inOut` | `[0.77,0,0.175,1]` | `power2InOut`（弱）或 `backInOut`（过冲） | 仅近似，未发货 |
| `ease.enter` / `ease.leave` | `[0.25,0.1,0.35,1]` / `[0,0,0.58,1]` | `power2Out` / 无 | 未发货；需要时手工在 AE 曲线编辑器按同控制点换算 speed/influence |
| `ease.drawer` | `[0.34,1.2,0.64,1]` | `AU_SPRING` `[0.34,1.40,0.64,1]` | 同为单段过冲，AU_SPRING 过冲略大 |
| `spring.*` | 物理参数 | 单段过冲贝塞尔 / `power*Out` | 只保留“峰值→落位”的**一次**过冲，见 7.2 |

### 7.2 弹簧 → 单段过冲换算（阻尼比 ζ 与理论超调）

ζ = c / (2√(km))；超调 = `exp(−πζ/√(1−ζ²))`。F2A clip 最多 3 键，只能表达一次过冲。

| 令牌 | k / c | ζ | 理论超调 | F2A 处理 |
|---|---:|---:|---:|---|
| `entrance` | 200 / 20 | 0.707 | ≈4.3% | `AU_SPRING` 单段过冲（约 5%） |
| `dialog` | 150 / 25 | 1.02 | 0（过阻尼） | `au-dialog-in` 用 `power3Out`，无过冲 |
| `toast` | 280 / 24 | 0.717 | ≈4.0% | 未打包 clip；需要时用 `AU_SPRING` 近似 |
| `tooltip` | 400 / 31 | 0.775 | ≈2.1% | 未打包 clip；2% 过冲肉眼弱，可直接用无过冲曲线 |
| `pop` | 400 / 29 | 0.725 | ≈3.7% | 未打包 |
| `press` | 550 / 30 | 0.640 | ≈7.3% | 交互态，未打包 |
| `selection` | 300 / 30 | 0.866 | ≈0.4% | 近似为无过冲（`power3Out`） |
| `checkPop` | 500 / 24 | 0.537 | ≈13.6% | 交互态，未打包；AE 若复刻需 3 键（0→113%→100%） |
| `number` | 90 / 50 | 2.64 | 0（过阻尼） | counting/sliding number 的“落位”可用纯缓出 |

### 7.3 量纲、结构与交付风险

1. **AE 文字动画器 Blur ≠ CSS blur**：AE Text Blur 属性没有 px 语义，F2A 的 RB 文字预设是“按观感标定”（例如 Split Text ≈2.2px 对应 24）。AU 的 blur 4px（Dialog）与 6px（Tooltip 换内容）属**图层特效量级**，本轮未打包，不要直接套用文字动画器的 4/6。
2. **弹簧只保留单段过冲**：`spring.entrance` 的 4.3%/AU_SPRING 的 ~5% 是单次过冲近似；真实弹簧的多周期衰减不可能在 ≤3 键内复刻，视觉差异主要在中后段。
3. **文字预设 AE-only**：`preset-au-*` 依赖文字动画器 + 一条 Amount 表达式，不适合 Web/Lottie 直出；Web/Lottie 交付优先用 `au-*` clips（无表达式、无逐帧）。对外交付前按 SKILL.md 的“无表达式残留”门禁回读。
4. **`direction` 与面板名**：三条 Splitting 预设参数是 `direction=left`（从右侧进入），面板名“右滑入”是产品口径；脚本文档/教程中要同时给出两者，避免使用者误判起点。
5. **`au-effect` 省略 blur**：源码 Effect 的 blur 默认是**关闭**的，故“省略 blur”不是裁剪而是与默认一致；若用户要 blur 版，应手工加图层模糊关键帧（AE-only，Web 不友好）。
6. **命名与标签约定**：文字预设 `preset-au-*`（procedural，`supports` 只暴露 duration/textBy 时样式锁定）；内容片段 `au-*`（clip，2 键/轨）；`sourceStyle: "AnimateUI"`，`tags` 含 `AnimateUI`。与 RB/AC 包保持同一命名体系，面板可按来源过滤。
7. **tempo 全局缩放**：Animate UI 的 `tempo` 同时缩放时长与弹性参数（阻尼比不变）。F2A 对 clip 只能做时间缩放，会让“过冲幅度/节奏”一起变化；需要严格对齐时按 7.2 的单一曲线单独调。
8. **终帧落位**：所有 AU 来源都是“入场到设计稿状态”，应用 clip 时用 `position_anchor: "end"`；`au-slide-up` / `au-effect` 的位置轨只有单轴直线，应用后复核空间切线为 `[0,0,0]`。

---

## 附：源码索引

| 组件/机制 | 源码路径（`artifacts/animate-ui-src/src/`） | 文档 URL |
|---|---|---|
| 动效令牌 | `utils/motion/index.tsx` | — |
| Fade / Blur / Slide / Zoom / Effect | `primitives/effects/{fade,blur,slide,zoom,effect}/index.tsx` | `https://animate-ui.com/docs/primitives/animate-ui/{fade,blur,slide,zoom,effect}` |
| Splitting Text | `primitives/texts/splitting/index.tsx`（切分：`primitives/texts/_text.ts`） | `.../animate-ui/splitting-text` |
| Typing Text | `primitives/texts/typing/index.tsx` | `.../animate-ui/typing-text` |
| Counting / Sliding / Scrolling Number | `primitives/texts/{counting-number,sliding-number,scrolling-number}/index.tsx` | `.../animate-ui/{counting-number,sliding-number,scrolling-number}` |
| Dialog（内容/flip/backdrop） | `internal/modal-motion.ts` + `primitives/base-ui/dialog/{dialog,base-modal}.tsx` | `.../base-ui/dialog`、`.../radix-ui/dialog` |
| Tooltip（自有） | `primitives/tooltip/index.tsx` | `.../animate-ui/tooltip` |
| Tooltip/Popover 包装层 | `internal/anchored.tsx` + `primitives/base-ui/popover/base-anchored.tsx` | `.../base-ui/{tooltip,popover}` |
| Menu / 行错峰 | `internal/{anchored,stagger,menu-handoff}.ts` + `primitives/base-ui/menu/shared.tsx` | `.../base-ui/menu` |
| Toast | `internal/toast-motion.ts` + `primitives/base-ui/toast/toast.tsx` | `.../base-ui/toast` |
| Accordion / Disclosure | `internal/disclosure-panel.tsx` | `.../base-ui/accordion`、`.../react-aria/disclosure` |
| Tabs 指示器/面板 | `internal/{tabs.tsx,sliding-indicator.tsx}` + `primitives/tabs/index.tsx` | `.../animate-ui/tabs` |
| Switch / Checkbox / Progress | `internal/controls/{thumb.ts,indicator.tsx,press.ts}` + `primitives/base-ui/{switch,checkbox,progress}` | `.../base-ui/{switch,checkbox,progress}` |
| Avatar Group | `primitives/avatar-group/index.tsx` | `.../animate-ui/avatar-group` |
| Highlight / Shine / Auto Height | `primitives/effects/{highlight,shine}/index.tsx`、`effects/auto-height/use-auto-height.ts` | `.../animate-ui/{highlight,shine,auto-height}` |
| Texts（循环/换字/渐变） | `primitives/texts/{rolling,morphing,swapping,sliding,rotating,gradient,shimmering,highlight}/index.tsx` | `.../animate-ui/<name>-text` |
| Backgrounds | `animate-ui-main/apps/v2/registry/backgrounds/<name>/index.tsx` | `https://animate-ui.com/docs/backgrounds/<name>` |
| Icons | `animate-ui-main/apps/v2/registry/{icons,hugeicons}/<name>/index.tsx` | `https://animate-ui.com/docs/icons/<name>` |
| Page Transition | `animate-ui-main/apps/v2/registry/components/page-transition*/index.tsx` | `https://animate-ui.com/docs/components/page-transition` |
| 许可 | `animate-ui-main/LICENSE.md`（MIT + Commons Clause） | — |

F2A 侧引用：`motion-library/builtin.json`（`presets[]`、`clips[]`）、`scripts/extract-motion-library.py`（`animate_ui_clips()`、`AU_SPRING`、`procedural_presets()` 的 Animate UI 段）、`host/motion/aeMotionPresets.jsx`（`C.text_reveal`、`REVEAL_CURVES` 的方向语义）。
