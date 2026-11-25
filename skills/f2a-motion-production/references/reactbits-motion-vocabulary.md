# React Bits 动效语汇与 F2A 映射参考

> 内部参考：记录 reactbits.dev 动效语言的盘点、关键参数的源码实测值，以及已落地到 F2A 内置动效库的条目与不可移植边界。
> 分析日期：**2026-11-24**。分析对象：React Bits **免费组件库**（JS + CSS 变体，`<Component>-JS-CSS` registry）。
> 本文只做记录与映射，不修改代码；所有参数以 `artifacts/reactbits-src\` 下 JSON 内 `files[].content` 的 JSX/CSS 源码为准，不用印象值。

---

## 1. 概述

> **2026-11-25 去重精简**：`rb-content-focus` 与 `rb-content-zoom` 运动高度重复（97%→100% vs 95%→100%），已从内置库移除；当前库总量为 **55 clips / 41 presets**。下文保留原始分析记录，以 `motion-library/builtin.json` 为准。

React Bits（[reactbits.dev](https://reactbits.dev)）是一个开源的 React UI 动效组件集合：组件按语义分为 **Text Animations / Animations / Components / Backgrounds / Micro** 五类，每个组件提供四种实现变体（JS-TS × CSS-Tailwind），通过 shadcn 或 jsrepo registry 安装，源码可直接复制进项目。动画实现分两大阵营：**GSAP**（`gsap` + `ScrollTrigger` + `SplitText`，大量文字与滚动类组件）与 **Motion (Framer)**（`motion/react`，Blur Text、Rotating Text 等声明式 spring）；Backgrounds 与部分视觉组件则依赖 **three.js / ogl** 的 WebGL 着色器。

本文的目的不是复刻 React Bits，而是把它的动效语汇**蒸馏成 F2A 的 AE 动效词汇**：哪些可以直接用 AE 关键帧或原生文字动画器重建，哪些只能用近似，哪些不应该进入 AE 关键帧体系。F2A 已据此在 `motion-library/builtin.json` 增加 11 条 `preset-rb-*` 文字预设与 7 条 `rb-*` 关键帧片段（见第 4 节），其生成逻辑位于 `scripts/extract-motion-library.py` 的 `procedural_presets()` 与 `reactbits_clips()`。

### 1.1 分析资产

| 资产 | 路径 | 说明 |
|---|---|---|
| 全站目录（LLM 索引） | `artifacts/reactbits-src/llms.html.txt` | 五分类组件清单与官方描述，组件计数以此为准 |
| 分类目录页 | `artifacts/reactbits-src/text-animations.html.txt`、`animations.html.txt`、`components.html.txt`、`micro.html.txt` | 站点目录页快照（Backgrounds 页未单独保存） |
| 组件源码 | `artifacts/reactbits-src/<Component>.json` | 56 个组件；每个 JSON 的 `files[].content` 为完整 JSX/CSS，例如 `SplitText.json` → `SplitText/SplitText.jsx`（registry 名 `SplitText-JS-CSS`） |
| 安装方式 | `npx shadcn@latest add https://reactbits.dev/r/<Component>-JS-CSS` | 与 `llms.html.txt` 的 CLI 说明一致 |

### 1.2 取样范围与许可

- 全站免费库共 **217** 个组件；本次下载并逐份读取源码 **56** 个，覆盖 Text Animations 32/33、Animations 8/38、Components 12/48、Micro 4/34、Backgrounds 0/64（Backgrounds 未取样，相关判定只依据目录描述，已在第 2 节标注）。
- 站点声明免费库“free and open source”，另有独立的付费 **React Bits Pro**（255 组件、license-gated registry，**不在本次分析范围**，也不应据此生成 F2A 资产）。
- 仓库内只保存了组件源码快照，未随附 LICENSE 文件；对外再分发或在产品内使用前，以 reactbits.dev 的 Introduction 页许可条款为准。本文正文中的参数与行为属于对源码的技术性引用。

---

## 2. 全站盘点

### 2.1 五分类计数（以 `llms.html.txt` 的 CLI 清单为准）

| 分类 | 组件数 | 已下载源码 | 源码覆盖 | 代表组件 |
|---|---:|---:|---:|---|
| Text Animations | 33 | 32 | 97% | Split Text、Blur Text、Scroll Reveal、Scroll Float、Text Type、Rotating Text |
| Animations | 38 | 8 | 21% | Animated Content、Fade Content、Glare Hover、Logo Loop、Pixel Transition、Scroll Expand |
| Components | 48 | 12 | 25% | Animated List、Bounce Cards、Bubble Menu、Card Swap、Dock、Stepper、Stack、Masonry |
| Micro | 34 | 4 | 12% | Flip Card、Pulse Heart、Spring Check、Status Mark |
| Backgrounds | 64 | 0 | 0% | Aurora、Silk、Particles、Hyperspeed、Liquid Chrome（均未取样） |
| **合计** | **217** | **56** | **26%** | — |

唯一未取样的 Text Animations 是 `ScrambledText`（指针驱动文字扭曲，归入不可移植桶即可）；Animations/Components/Micro 未取样部分以目录描述判定，不臆测源码参数。

### 2.2 三分桶判定

判定依据是“能否在 AE 中用 2D 变换 + 透明度 + 原生文字动画器（少量关键帧）重建”，而不是组件本身是否好看。

| 桶 | 判定标准 | 代表组件（类别） | 一句话理由 | F2A 处理 |
|---|---|---|---|---|
| **可直接／近似移植** | 有限时长的 2D transform（Position／Scale／Rotation）或 Opacity，或可用 AE 文字动画器按字／词控制的入场 | Split Text、Blur Text、Scroll Reveal（enter 段）、Scroll Float（float 段）、Animated Content、Fade Content、Animated List、Bubble Menu、Bounce Cards（入场段）、Dock（launch 段） | 动画本体是一次性 2D 变换／透明度／逐字属性，起止值固定，可翻译成 2 个关键帧或一条文字动画器 | 已落地为 `preset-rb-*` 与 `rb-*`（第 4 节） |
| **仅部分可移植** | 需要动画 AE 效果（模糊半径、发光）、3D 层／相机、遮罩渐变、或多层编排才能接近；本体可近似但代价高 | Rotating Text、True Focus、Shiny Text、Glare Hover、Echo Text、Fold Text、Masked Heading、Stroke Text、Pixel Transition、Scroll Expand、Scroll Stack、Card Swap、Stepper、Pill Nav、Folder、Flip Card、Spring Check | 核心观感依赖 3D 翻转、逐层遮罩、半透明高光或顺序状态机，AE 单段关键帧只能还原“骨架” | 只取可复用的入场／退场段；其余不进默认库 |
| **不可移植** | WebGL／Canvas 着色器与流体粒子、指针／滚动实时交互、随机字形、物理拖拽、逐帧模拟 | Backgrounds 全类（64）、Particle Text、ASCII Text、Warp Text、Gradient Text、Shuffle、Decrypted Text、Split Flap Text、Glitch Text、Fuzzy Text、Falling Text、Text Cursor、Text Pressure、Variable Proximity、Depth Text、Magnet、Splash Cursor | 动画由每帧程序化计算或用户输入驱动，不存在有限关键帧表达；视频输出也无稳定的“终态” | 不进入动效库；需要时按第 5 节替代方案处理 |

经验分布（仅就 56 份已读源码）：文字类可近似、需多层或效果近似、不可移植三者并存，分布较均匀；Components 类大多“入场可移植、交互不可移植”；Backgrounds 全部不可移植。因此 F2A 的 React Bits 资产刻意集中在**文字入场**与**内容整体入场／退场**两条线上。

---

## 3. 关键动画参数（源码实测）

> 约定：React Bits 的 `delay` 是毫秒、`duration` 是秒；F2A 统一用秒，毫秒参数在映射时 ÷1000。`em` 值按运行时字号换算（下文以 16px 字号给出参考像素）。

### 3.1 Text Animations

#### 3.1.1 Split Text（`SplitText.json` → `SplitText/SplitText.jsx`，registry `SplitText-JS-CSS`）

组件默认：`delay=50`（ms 错峰）、`duration=1.25`（s）、`splitType='chars'`、`effect='rise'`、`staggerFrom='start'`、`mask=false`、`trigger='view'`、`threshold=0.1`、`rootMargin='-100px'`、`loop=false`、`loopDelay=1.5`、`hoverEffect='none'`。默认 `rise` 的 from/to 是 `{opacity:0,y:40}` → `{opacity:1,y:0}`。

| 组件/效果 | 默认时长 | 延迟/错峰 | 缓动 | 起点 → 终点值 | 备注 |
|---|---|---|---|---|---|
| Split Text / rise（默认） | 1.25s | 50ms | power3.out | opacity 0→1；y +40px→0 | `DEFAULT_FROM/TO` |
| Split Text / fade | 1.25s | 50ms | power2.inOut | opacity 0→1 | 无位移 |
| Split Text / blur | 1.25s | 50ms | power2.out | opacity 0→1；blur `round(fontSize×1.4)÷10`px→0 | 16px 字号≈2.2px；20px≈2.8px |
| Split Text / flip | 1.25s | 50ms | power3.out | opacity 0→1；rotationX −90°→0；perspective=fontSize×6；origin 50% 100% | 3D，AE 文字动画器无逐字 rotateX |
| Split Text / pop | 1.25s | 50ms | back.out(1.6) | opacity 0→1；scale 0→1 | 0 缩放起跳 |
| Split Text / skew | 1.25s | 50ms | expo.out | opacity 0→1；x −0.4em→0（16px≈−6.4px）；skewX −24°→0；origin 50% 100% | |
| Split Text / wave | 1.25s | 50ms | 自定义 wave：`1−cos(t·π·1.5)·(1−t)^1.2` | opacity 0→1；y +0.45em→0（16px≈+7.2px） | 与 F2A 的 `wave` 曲线公式相同 |
| Split Text / 退场 conceal | max(0.35, 0.55×duration) | 同上 | power2.in | 反向回到 from 值 | hover／click／loop 触发时使用 |

补充：`hoverEffect='lift'`／`'wave'` 走独立 rAF 物理弹簧（`STIFFNESS=180`、`DAMPING=19`、`KICK=0.024`），属于交互态，不进入关键帧映射。

#### 3.1.2 Blur Text（`BlurText.json` → `BlurText/BlurText.jsx`，registry `BlurText-JS-CSS`）

组件默认：`delay=200`（ms 错峰）、`stepDuration=0.35`、`blur=10`、`distance=50`、`animateBy='words'`、`direction='top'`、`effect='blur'`、`staggerFrom='start'`、`trigger='view'`。步进数固定为 3（`from + 2 steps`），`totalDuration = stepDuration×2 = 0.7s`；**位移键使用 spring（visualDuration = totalDuration×settle，bounce），透明度／模糊走 tween**。缓动常量：`EASE_OUT=[0.33,1,0.68,1]`、`EASE_IN_OUT=[0.65,0,0.35,1]`、`EASE_IN=[0.55,0,0.9,0.45]`、`CSS_EASE=cubic-bezier(0.22,1,0.36,1)`。`top` 表示从上方进入（y 为负）。

| 组件/效果 | 默认时长 | 延迟/错峰 | 缓动 | 起点 → 终点值 | 备注 |
|---|---|---|---|---|---|
| Blur Text / blur（默认） | 0.7s（2×0.35） | 200ms | 位移 spring（visualDuration 0.35s、bounce 0.35）／透明度与模糊 linear | opacity 0→1；blur 10px→0；y −50px→0 | `settle=0.5` |
| Blur Text / zoom | 0.7s | 200ms | 位移 spring（0.35s、bounce 0.25）／其余 EASE_OUT | opacity 0→1；blur 12px→0；scale 1.4→1；y −17.5px→0 | 中段 scale 0.97、y +1.5px 仅为自定义关键帧路径 |
| Blur Text / tilt | 0.7s | 200ms | 位移 spring（0.56s、bounce 0.3）／其余 EASE_OUT | opacity 0→1；blur 10px→0；rotateX 或 rotateY ±55°→0；y −25px→0；perspective 600 | 3D；中段 ∓8° 仅在自定义动画时使用 |
| Blur Text / focus | 0.7s | 200ms | EASE_IN_OUT（无 spring） | opacity 0.32→1；blur 14px→0；scale 1.12→1 | 中段 scale 0.995 被压缩为单段 |
| Blur Text / drift | 0.7s | 200ms | 位移 spring（0.385s、bounce 0.3）／其余 EASE_OUT | opacity 0→1；blur 10px→0；x ±80px→0；skewX ±28°→0；y −15px→0 | |
| Blur Text / 退场 | 0.35×1.3=0.455s | 错峰×0.4 | EASE_IN | 反向回到 exit 快照 | loop／hover 重播用 |

#### 3.1.3 Scroll Reveal（`ScrollReveal.json` → `ScrollReveal/ScrollReveal.jsx`，registry `ScrollReveal-JS-CSS`）

组件默认：`enableBlur=true`、`baseOpacity=0.1`、`baseRotation=3`（度）、`blurStrength=4`、`baseOffset=0`、`stagger=0.05`、`splitBy='words'`、`effect='fade'`、`mode='scrub'`、`duration=0.8`、`smoothing=0`。**注意：`duration=0.8` 只在 `mode='enter'` 时生效；默认 scrub 模式下每片段的归一化长度恒为 `SCRUB_SPAN=0.5`，由滚动进度驱动，没有秒级总时长。** 全部效果都从 `baseOpacity=0.1` 起，并且 `enableBlur` 时带 `blurStrength`px 模糊。

| 组件/效果 | 默认时长 | 延迟/错峰 | 缓动 | 起点 → 终点值 | 备注 |
|---|---|---|---|---|---|
| Scroll Reveal / fade（默认） | scrub；enter 时 0.8s | 0.05（归一化进度单位） | 线性进度映射 | opacity 0.1→1；blur 4px→0 | 逐词 |
| Scroll Reveal / rise | 同上 | 0.05 | `1−(1−t)^3`（easeOut） | opacity 0.1→1；y +0.8em→0（词内遮罩时 +100%+0.2em） | 自下而上；带 clip-path 遮罩 |
| Scroll Reveal / flip | 同上 | 0.05 | `easeBack(t,1.2)` | opacity 0.1→1；perspective 6em；rotateX 90°→0；origin 50% 100% | 3D |
| Scroll Reveal / scale | 同上 | 0.05 | `easeBack(t,1.6)` | opacity 0.1→1；scale 0.35→1 | easeBack 带过冲 |
| Scroll Reveal / 容器旋转 | 同上 | — | power3.out（enter）或 scrub | 容器 rotate 3°→0；origin 0% 50% | `baseRotation` |
| Scroll Reveal / highlight | 同上 | 0.05 | smoothstep | 颜色从 `highlightColor` 混回 currentColor | 需要逐字颜色动画 |

#### 3.1.4 Scroll Float（`ScrollFloat.json` → `ScrollFloat/ScrollFloat.jsx`，registry `ScrollFloat-JS-CSS`）

组件默认：`effect='float'`、`splitBy='chars'`、`direction='up'`、`order='start'`、`animationDuration=1`、`ease='back.inOut(2)'`、`stagger=0.03`、`distance=120`、`stretch=2.3`、`scrollStart='center bottom+=50%'`、`scrollEnd='bottom bottom-=40%'`。全部效果都挂在 ScrollTrigger 上 `scrub`，`animationDuration=1` 是 scrub 时间线单位，不是秒。`reach=distance/120`（默认 1）。

| 组件/效果 | 默认时长 | 延迟/错峰 | 缓动 | 起点 → 终点值 | 备注 |
|---|---|---|---|---|---|
| Scroll Float / float（默认） | scrub，时间线 1 | 0.03 | back.inOut(2) | opacity 0→1；yPercent 120%×reach→0；scaleY 2.3→1；scaleX 0.70→1；origin 50% 0%（up） | `2.3^-0.43≈0.70` |
| Scroll Float / flip | 同上 | 0.03 | back.inOut(2) | rotationX −90°→0；perspective fontSize×4；origin 50% 50% −fontSize×0.55×reach | 透明度单独 smoothstep |
| Scroll Float / scatter | 同上 | 0.03 | back.inOut(2) | 每字 x／y 随机（±1.3 字宽内）、rotation ±(40°–160°)、scale 0.35–1.25→正常 | 确定性伪随机 |
| Scroll Float / blur | 同上 | 0.03 | back.inOut(2) | opacity 0→1；y ±0.3em→0；scale 1.45→1；blur 0.2em→0 | |
| Scroll Float / wave | 同上 | 0.03 | 自定义 swell/sway 曲线 | yPercent 120%→0；scaleY 2.3→1；scaleX 0.70→1；rotation 0→−16°×sign | 波动双曲线 |

#### 3.1.5 Text Type（`TextType.json` → `TextType/TextType.jsx`，registry `TextType-JS-CSS`）

| 组件/效果 | 默认时长 | 延迟/错峰 | 缓动 | 起点 → 终点值 | 备注 |
|---|---|---|---|---|---|
| Text Type / 逐字节奏 | 每字 50ms | 首字前 0 | 无（定时器） | 已显示字符数 0→全文 | `typingSpeed=50`、`deletingSpeed=30`、`pauseDuration=2000` |
| Text Type / 光标闪烁 | 0.5s 周期 | hold 0.35s | sine.inOut | 光标 opacity 1→0（0.225s）→1（0.775s 起 0.225s） | `cursorBlinkDuration=0.5` |
| Text Type / 光标滑移 | 60–180ms | — | power3.out | 光标位置追踪上一字符 | `glideTime = clamp(pace×0.0016, 0.06, 0.18)` |
| Text Type / 字符入场 | 360–520ms | — | fade：cubic-bezier(0.25,1,0.5,1)；blur：(0.22,1,0.36,1)；rise：(0.34,1.4,0.64,1) | fade opacity 0→1；blur blur 0.3em→0；rise top 0.6em→0 | `typeEffect` 默认 `none` |

#### 3.1.6 Rotating Text（`RotatingText.json` → `RotatingText/RotatingText.jsx`，registry `RotatingText-JS-CSS`）

组件默认：`effect='slide'`、`direction='up'`、`splitBy='characters'`、`rotationInterval=2000`（ms 自动轮播）、`staggerDuration=0`、`blur=0`、`loop=true`、`animatePresenceMode='wait'`。`LAYOUT_SPRING={damping:25,stiffness:300}`，`WIDTH_SPRING={damping:34,stiffness:320}`。

| 组件/效果 | 默认时长 | 延迟/错峰 | 缓动 | 起点 → 终点值 | 备注 |
|---|---|---|---|---|---|
| Rotating Text / slide（默认） | spring 无固定时长 | 0（可设 staggerDuration） | spring(damping 25, stiffness 300) | y ±100%→0；opacity 0→1；exit y 到 ∓120% | 逐字 |
| Rotating Text / flip | 0.6s | 0 | tween(0.34,1.4,0.64,1)；exit 0.32s(0.5,0,0.75,0) | rotationX ±90°→0；opacity 0→1；perspective 480；origin 50% 50% −0.45em | 3D |
| Rotating Text / blur | 0.55s | 0 | tween(0.22,1,0.36,1) | y ±45%→0；opacity 0→1；可选 blur 10px→0 | `blur` prop >0 时叠加 |
| Rotating Text / scale | spring 无固定时长 | 0 | spring(damping 17, stiffness 240) | scale 0.35（up）或 1.7（down）→1；opacity 0→1 | |
| Rotating Text / drop | spring 无固定时长 | 0 | spring(damping 18, stiffness 320, mass 0.9)；exit 0.3s(0.55,0,1,0.45) | y −110%→0；opacity 0→1 | |

### 3.2 Animations

#### 3.2.1 Animated Content（`AnimatedContent.json` → `AnimatedContent/AnimatedContent.jsx`，registry `AnimatedContent-JS-CSS`）

组件默认：`distance=100`、`direction='vertical'`、`duration=0.8`、`ease='power3.out'`、`initialOpacity=0`、`animateOpacity=true`、`scale=1`、`blur=0`、`rotate=0`、`tilt=0`、`wipe='none'`、`threshold=0.1`、`delay=0`、`stagger=0`、`trigger='scroll'`、`once=true`。默认效果即“整体位移 + 渐显”。

| 组件/效果 | 默认时长 | 延迟/错峰 | 缓动 | 起点 → 终点值 | 备注 |
|---|---|---|---|---|---|
| Animated Content / slide（默认） | 0.8s | delay 0；stagger 可选 | power3.out | x 或 y +100px→0；opacity 0→1 | vertical／horizontal；reverse 取负 |
| Animated Content / blur | 0.8s | 同上 | power3.out | filter blur(blur px)→0；配合位移与透明度 | 需图层模糊效果 |
| Animated Content / rotate | 0.8s | 同上 | power3.out | rotation ±rotate→0 | 2D 旋转，可移植 |
| Animated Content / tilt | 0.8s | 同上 | power3.out | rotationX／Y ±tilt→0；perspective 900 | 3D |
| Animated Content / wipe | 0.8s | 同上 | power3.out | maskImage 渐变进度 `--ac-wipe` 0→1 | 遮罩擦除 |
| Animated Content / stagger | 0.8s | `stagger` 每子元素 | power3.out | 各子元素依次执行上述变换 | `staggerFrom` |
| Animated Content / disappear | 0.5s | `disappearAfter`（默认 0，不启用） | power3.in | 反向：x／y −100px；scale 0.8；opacity→0 | 退场 |

#### 3.2.2 Fade Content（`FadeContent.json` → `FadeContent/FadeContent.jsx`，registry `FadeContent-JS-CSS`）

组件默认：`effect='fade'`、`blur=false`、`duration=1`、`ease='power2.out'`、`delay=0`、`threshold=0.1`、`initialOpacity=0`、`stagger=0`、`trigger='scroll'`、`once=true`。**源码中 `effect` 的取值是 `fade`／`focus`／`develop`／`dissolve`／`mist`／`pixel`；`blur` 是独立布尔/数值 prop（`true`=10px），不是 effect 值。**

| 组件/效果 | 默认时长 | 延迟/错峰 | 缓动 | 起点 → 终点值 | 备注 |
|---|---|---|---|---|---|
| Fade Content / fade（默认） | 1s | delay 0；stagger 可选 | power2.out | opacity 0→1 | `initialOpacity` 可改起点 |
| Fade Content / focus | 1s（透明度分 0.6、滤镜分 1.0） | 同上 | power2.out | opacity 0→1；blur(12+blur)px→0；scale 0.97→1 | 两条子时间线 |
| Fade Content / develop | 1s（透明度分 0.5） | 同上 | power2.out | opacity 0→1；grayscale 1→0、contrast 0.55→1、brightness 1.3→1、blur→0 | 显影 |
| Fade Content / blur 布尔 | 1s | 同上 | power2.out | blur(blur px)→0，配合 opacity | `blur=true` → 10px |
| Fade Content / dissolve·mist·pixel | 1s | 同上 | power2.out | SVG feTurbulence 噪波遮罩进度 0→1 | 逐像素溶解，不可移植 |
| Fade Content / disappear | 0.5s | disappearAfter | power2.in | 按 looks 反向 | `exit`／`once` 组合 |

### 3.3 Components 与 Micro 的入场参数

#### Animated List（`AnimatedList.json` → `AnimatedList.jsx`，registry `AnimatedList-JS-CSS`）

| 组件/效果 | 默认时长 | 延迟/错峰 | 缓动 | 起点 → 终点值 | 备注 |
|---|---|---|---|---|---|
| Animated List / 行入场 | transform 620ms；opacity 300ms | stagger 0.05s | transform：采样 spring `linear(...)`，回退 cubic-bezier(0.34,1.4,0.64,1)；opacity：cubic-bezier(0.22,1,0.36,1) | pop：y ±12px + scale 0.8 → 正常；slide：y ±28px + scale 0.98；fade：y ±4px | `animation='pop'` 默认；filter 200ms ease |
| Animated List / 选中指示条 | rAF 弹簧 | — | 弹簧 | y／height 追踪选中行 | 交互态，不移植 |

#### Bubble Menu（`BubbleMenu.json` → `BubbleMenu.jsx`，registry `BubbleMenu-JS-CSS`）

| 组件/效果 | 默认时长 | 延迟/错峰 | 缓动 | 起点 → 终点值 | 备注 |
|---|---|---|---|---|---|
| Bubble Menu / 气泡展开 | 0.5s | 每个气泡 i×0.12s，另加 ±0.05 随机 | back.out(1.5) | scale 0→1；origin 50% 50% | `animationEase`、`staggerDelay` |
| Bubble Menu / 标签浮现 | 0.5s | 与气泡重叠 `−0.45s` | power3.out | y +24px→0；autoAlpha 0→1 | 标签跟气泡 |
| Bubble Menu / 关闭 | 0.2s | — | power3.in | 气泡 scale→0；标签 y→24、autoAlpha→0 | 关闭更快 |

#### Bounce Cards（`BounceCards.json` → `BounceCards.jsx`，registry `BounceCards-JS-CSS`）

| 组件/效果 | 默认时长 | 延迟/错峰 | 缓动 | 起点 → 终点值 | 备注 |
|---|---|---|---|---|---|
| Bounce Cards / 入场 | 物理弹簧，无固定时长 | animationDelay 0.5s；animationStagger 0.06s | scale 弹簧：stiffness 170，damping `2×(1−0.85×bounciness)×√170`（bounciness 0.6 → ≈12.8，阻尼比≈0.49） | scale 0→1（位置直接落在槽位） | 阻尼比 <1，回弹明显 |
| Bounce Cards / 悬停扩散 | 物理弹簧 | — | 位移弹簧：stiffness 210，damping `2×0.72×√210`≈20.9 | 被悬停卡 lift 4% 卡高并 scale 1.06；邻卡外推 160px | 交互态，不移植 |

#### Dock（`Dock.json` → `Dock.jsx`，registry `Dock-JS-CSS`）

| 组件/效果 | 默认时长 | 延迟/错峰 | 缓动 | 起点 → 终点值 | 备注 |
|---|---|---|---|---|---|
| Dock / 菜单·子面板开合 | 340ms；嵌套 220ms | — | cubic-bezier(0.2,1.25,0.4,1)（`POP`） | scale 0.82→1；嵌套 0.94→1 | 同批图层 opacity 160ms／120ms ease-out |
| Dock / 图标 launch 跳跃 | HOP_TIME 0.38s | — | 物理抛物线（无固定 easing） | 起跳高度 = 图标尺寸×0.4；落地速度×−0.36 回弹 | 源码 `HOP=0.4`、`HOP_TIME=0.38` |
| Dock / 磁放大 | 弹簧逐帧 | — | spring(mass 0.1, stiffness 150, damping 12) | 图标尺寸 50→70（默认 base 50、magnification 70、distance 200） | 指针驱动，不移植 |

> 注意：`POP` 的 220–340ms 是**菜单/子面板开合**的缩放，不是图标 launch 跳跃；launch 是上面 HOP_TIME 0.38s 的物理弹跳。

#### Card Swap（`CardSwap.json` → `CardSwap.jsx`，registry `CardSwap-JS-CSS`）

| 组件/效果 | 默认时长 | 延迟/错峰 | 缓动 | 起点 → 终点值 | 备注 |
|---|---|---|---|---|---|
| Card Swap / 自动换卡 | 每 4000ms | 落位错峰 0.05/speed | 卡组内部弹簧 + 拖动惯性 | 前卡移到队尾；depth 90、cardDistance 60、verticalDistance 70 | `autoplay=true`、`pauseOnHover=true`、`bounce=0.35` |
| Card Swap / 入场 intro | 舞台淡入 420ms；卡片归位按 pos×70ms 错峰 | 每卡 `hold = now + pos×70/speed` | ease-out（舞台）；卡组弹簧 | 舞台 opacity 0→1；卡片从 from=0 归位到堆叠槽位 | `intro=true`；3D 堆叠本体不可移植 |

#### Stepper（`Stepper.json` → `Stepper.jsx`，registry `Stepper-JS-CSS`）

| 组件/效果 | 默认时长 | 延迟/错峰 | 缓动 | 起点 → 终点值 | 备注 |
|---|---|---|---|---|---|
| Stepper / 步骤切换 slide | 560ms | — | 采样 spring `linear(0,...,1)`，回退 cubic-bezier(0.34,1.4,0.64,1) | 内容面板 translateX／Y ±36px→0 | `transition='slide'` |
| Stepper / 新面板淡入 | 420ms | — | ease-out | opacity 0（0–25% 保持）→1 | 三段关键帧式 |
| Stepper / 旧面板离场 | 140ms + 200ms | — | cubic-bezier(0.2,0,0.4,1) 淡出；cubic-bezier(0.4,0,1,1) 位移 | opacity 1→0；translate ∓36px | 两条并列动画 |
| Stepper / 高度与滑块 | 560ms（滑块 opacity 200ms） | — | 同 spring | 容器 height、滑块 translate/width/height 到目标 | 滑块宽高与位移共用 spring |
| Stepper / 勾选绘制 | 360ms | — | cubic-bezier(0.22,1,0.36,1) | strokeDashoffset 24→0 | 状态确认，不可直接移植到文字 |

---

## 4. F2A 映射表

### 4.1 命名与机制

- **文字预设**：`kind: procedural`、`command: text_reveal`，id 为 `preset-rb-*`（提示里的短名 `rb-split-rise` 即去掉 `preset-` 前缀的形式），`name` 是「RB 逐字上浮」这类中文面板名，存于 `motion-library/builtin.json` 的 `presets[]`；生成源为 `scripts/extract-motion-library.py` 的 `procedural_presets()`。
- **内容片段**：`kind: clip`（`clips[]`），`slug` 为 `rb-*`；每个 track 仅 2 个关键帧（起点＋终点），缓动以 AE 的 speed/influence 表达，无表达式。生成源为同一脚本的 `reactbits_clips()`。
- **文字机制**（`host/motion/aeMotionPresets.jsx` 的 `C.text_reveal`）：给文本层加一个 AE 原生 **文字动画器**（Position 3D／Scale 3D／Skew／Blur／Opacity），再加一个 **Expressible Selector（表达式选择器）**，用一条 Amount 表达式按 `textIndex`／`textTotal` 计算每个字的错峰；全层仅此一条表达式，没有逐字关键帧。该机制与既有 `preset-text-*` 完全一致，只是样式与曲线按 React Bits 的时序参数化。表达式里的缓动是闭式 GSAP 兼容曲线，例如 `power3Out = 1−(1−u)³`、`backOut = 1+2.70158(u−1)³+1.70158(u−1)²`、`wave = 1−cos(u·π·1.5)(1−u)^1.2`（与 React Bits Split Text 的 waveEase 相同）、`backInOut` 采用 GSAP `back.inOut(2)` 的 3.05 系数。
- **速率控制**：`preset-rb-*` 的 `supports` 只暴露 `duration` 与 `textBy`，未启用 `supports.style`，避免面板的全局曲线控制把 React Bits 的时序“压平”；样式（含 distance/direction 默认）由预设锁定，必要时可在应用后用 `ae_set_keyframes`／脚本覆写。

### 4.2 文字预设（`text_reveal`，11 条）

| ReactBits 来源 | ReactBits 参数 | F2A 条目（id / kind） | F2A 参数 | 差异／近似说明 |
|---|---|---|---|---|
| Split Text / rise | 1.25s；delay 50ms；power3.out；y +40px→0 | `preset-rb-split-rise` / procedural | style=rise；by=chars；1.25s；stagger 0.05；ease=power3Out；distance 40 | 等价；F2A 用文字动画器 Position 偏移，无滚动触发，起点为图层 inPoint |
| Split Text / fade | 1.25s；50ms；power2.inOut | `preset-rb-split-fade` / procedural | style=fade；chars；1.25s；0.05；power2InOut | 等价 |
| Split Text / pop | 1.25s；50ms；back.out(1.6) | `preset-rb-split-pop` / procedural | style=pop；chars；1.25s；0.05；backOut | 等价；backOut 闭式公式对应 back.out(1.7)，略强于源码 1.6 |
| Split Text / blur | 1.25s；50ms；power2.out；模糊≈2.2px@16px | `preset-rb-split-blur` / procedural | style=blur；chars；1.25s；0.05；power2Out | 等价；AE 文字动画器 Blur 值取 24（AE 单位与 CSS px 不同，按观感标定） |
| Split Text / skew | 1.25s；50ms；expo.out；x −0.4em；skewX −24° | `preset-rb-split-skew` / procedural | style=skewIn；chars；1.25s；0.05；expoOut；distance=字号×0.4 | 等价；AE 逐字 Skew −24°、Skew Axis 0，原点由逐字默认决定 |
| Split Text / wave | 1.25s；delay 50ms；自定义 wave；y +0.45em | `preset-rb-split-wave` / procedural | style=wave；chars；1.25s；0.05；ease=wave；distance=字号×0.45 | 曲线公式完全相同，错峰与源码 50ms 对齐 |
| Blur Text / blur | 200ms 错峰；stepDuration 0.35；blur 10px；distance 50；direction top | `preset-rb-blurtext` / procedural | style=riseBlur；by=words；0.7s；stagger 0.2；power2Out；distance 50；direction=down | 模糊 10px 对齐；RB 的位移是 spring（两段 0.35s，总 0.7s），F2A 压成单段缓动，无弹簧过冲 |
| Blur Text / focus | 200ms；blur 14px；scale 1.12；opacity 0.32 | `preset-rb-focus` / procedural | style=focus；words；0.7s；0.2；power2InOut | 等价（源码 blur=10×1.4=14px；F2A AE Blur 取 14）；中段 scale 0.995 被压缩为单段 |
| Blur Text / zoom | 200ms；blur 12px；scale 1.4；y −17.5px | `preset-rb-zoom` / procedural | style=zoomIn；words；0.7s；0.2；power2Out；distance 50；direction=down | 等价：F2A zoomIn 自动取 140% 缩放、12px AE Blur、位移=50×0.35=17.5px |
| Scroll Reveal / rise | 默认 scrub；baseOpacity 0.1；blurStrength 4；stagger 0.05；splitBy words；enter 模式 duration 0.8 | `preset-rb-scroll-reveal` / procedural | style=riseBlur；words；0.8s；0.05；power3Out；distance 16；direction=up | 有限段近似：RB 默认由滚动进度驱动（无秒级时长），F2A 固定 0.8s；RB 词内遮罩分支是 translateY 100%＋0.2em（随词高变化），非遮罩分支才是 0.8em，F2A 用 16px 固定值近似；RB 起点透明度 10%，F2A 用 0；方向已显式对齐源码（自下而上） |
| Scroll Float / float | scrub；duration 1；back.inOut(2)；stagger 0.03；distance 120；yPercent 120%＋scaleY 2.3＋scaleX 0.70 | `preset-rb-wave-float` / procedural | style=float；chars；1.0s；0.03；backInOut；distance=字号×1.2；Scale 96.5/110/100→100/100/100 | 保留 Y 位移与轻微纵向拉伸／横向挤压，省略源码 ±16° 的逐字 rotation sway |

### 4.3 内容片段（`kind: clip`，2 键/轨，7 条）

| ReactBits 来源 | ReactBits 参数 | F2A 条目（id / kind） | F2A 参数 | 差异／近似说明 |
|---|---|---|---|---|
| Animated Content / vertical slide | distance 100；0.8s；power3.out；opacity 0→1 | `rb-content-rise` / clip | Position y +100→0；Opacity 0→100；0.8s；power3Out | 等价；RB 的 `distance` 是水平/垂直通用值，F2A 固定为 Y |
| Animated Content / horizontal | distance 100；0.8s；power3.out | `rb-content-glide` / clip | Position x +100→0；Opacity 0→100；0.8s；power3Out | 等价；RB 自右向左 |
| Fade Content / fade | 1s；power2.out；initialOpacity 0 | `rb-content-fade` / clip | Opacity 0→100；1.0s；power2Out | 等价 |
| Animated Content / scale | scale 95→100（组件 prop）；0.8s；power3.out | `rb-content-zoom` / clip | Scale 95→100%；Opacity 0→100；0.8s；power3Out | 等价；RB 的 scale 是入参，95% 为 F2A 选定值 |
| Fade Content / focus | 1s；power2.out；scale 0.97→1；blur 12px→0 | `rb-content-focus` / clip | Scale 97→100%；Opacity 0→100；1.0s；power2Out | 去掉 blur 的 Lottie 友好近似：RB 的模糊收敛替换为纯缩放＋渐显 |
| Bubble Menu / 气泡展开 + Split Text / pop | 0.5s；back.out(1.5)／back.out(1.6)；scale 0→1 | `rb-back-pop` / clip | Scale 0→100%；Opacity 0→100；0.5s；scale 用 backOut（cubic-bezier(0.34,1.56,0.64,1) 换算 speed/influence） | 单段速度曲线近似 back.out 过冲；AE 26 实测落位峰值约 109.7%（单次小过冲），弱于 GSAP 多段弹簧 |
| Animated Content / disappear | disappearDuration 0.5；power3.in；axis −distance（−100px）；scale 0.8 | `rb-exit-sink` / clip | Position y 0→−100；Opacity 100→0；0.5s；power3In；phase=out | 未加 scale 0.8 轨（保持双轨精简）；退场方向为向上（AE 负 Y），与组件 `disappear` 一致；面板名“下沉”是语气词，实际为上浮退场 |

补充：`rb-back-pop` 的 Scale 起点速度约 917.6%/s、out influence 34，目标是在单段内产生过冲；若接触表显示未过冲，应改用 3 个关键帧（0→112%→100%）以符合“最多 3 键”铁律。所有 clip 位置轨只有一条直线轴，应用后仍需按铁律复核空间切线为 `[0,0,0]`。

### 4.4 实测偏差与实现取舍

1. **Fade Content 的 effect 枚举**：提示中的写法暗示 `blur` 是 effect 值；源码实际是 `effect='fade'|'focus'|'develop'|'dissolve'|'mist'|'pixel'`，`blur` 是独立布尔/数值 prop。F2A 只取了 fade／focus 的骨架。
2. **Dock 的 220–340ms**：`POP=cubic-bezier(0.2,1.25,0.4,1)` 绑定的是菜单/子面板开合；图标 launch 是 `HOP_TIME=0.38s` 的物理抛物线（落地速度×−0.36）。两者不应混为一谈。
3. **Scroll Reveal 的 0.8s**：源码 `duration` 只在 `mode='enter'` 时生效；默认 `mode='scrub'`，由滚动进度驱动、无秒级时长。F2A 的 0.8s 是“有限段化”的选择，不是组件默认播放时长。
4. **Scroll Float 的 float 形体**：源码用 `yPercent 120%` + `scaleY 2.3` + `scaleX≈0.70` 做拉伸漂浮，并叠加 `rotation → -16°×sign` 的逐字摆动；F2A `float` 样式保留 Y 位移（字号×1.2）与轻微的 ScaleY 110%／ScaleX 96.5% 回正，省略逐字 rotation。
5. **错峰时长**：Split Text 所有效果（含 wave）源码共用 `delay=50ms`，F2A 预设统一取 `stagger=0.05`，与源码一致。
6. **Blur Text 的弹簧位移**：RB 的模糊效果把位移拆成两段 spring（visualDuration 0.35s，总 0.7s），F2A 用单段 0.7s 缓动近似，没有弹簧过冲；`preset-rb-blurtext` 的时长即为 0.7s。
7. **rb-scroll-reveal 方向**：Scroll Reveal 的 rise 自下而上（`translateY(+0.8em)→0`），F2A 预设已显式传 `direction=up`，与源码方向一致。
8. **rb-wave-float 距离**：Scroll Float 默认 `distance=120`、`reach=distance/120`，即 120% 字高；F2A `float` 样式按字号×1.2 落位，与源码的 1.2em 对齐。
9. **模糊量级**：RB 用 CSS `filter: blur()`（Split Text ≈2.2px、Blur Text 10/12/14px）；AE 文字动画器的 Blur 属性是不同量纲，F2A 取 24／10／12／14（24 为 Split Text blur 的观感标定），不能用像素逐一对应。

### 4.5 近似或未发货说明

- **Split Text / flip**：AE 文字动画器没有逐字 rotateX／rotateY，只有 2D Rotation；用 Scale Y 压扁模拟半翻或对每字建 3D 层都会破坏“单文本层＋单动画器”的可编辑性，故不发货。
- **Blur Text / tilt、drift**：同样依赖 3D 逐词旋转与 skew 组合，超出当前“Position/Scale/Skew/Blur 四属性”模式；`zoom` 的中段关键帧已压缩为单段，观感差异在毫秒级。
- **Scroll Float / scaleY 拉伸**：可以在文字动画器再挂 Scale 3D（逐字非等比），但与 F2A 的“Position 为唯一空间属性”约定冲突，暂不纳入。
- **Rotating Text**：词组切换需要多个文本层或 Source Text 切换动画，属“序列编排”而非单条入场，默认库不提供；需要时可手工做两段预合成交叉。
- **True Focus**：逐词 blur/opacity 循环需要每个词独立图层或可动画的模糊半径，交互（指针进入哪词就聚焦）不可移植。
- **Text Type**：已有 `preset-text-typewriter`（文字动画器逐字显示）可近似“敲入”，但 RB 的随机速度、打错字回删、光标独立滑移与 blink 时序不在其内。
- **Animated Content / stagger 子元素**：RB 支持按 `el.children` 逐子错峰；F2A 有 `ae_stagger` 但只对已有键做偏移，不生成逐子入场，故未打包成 clip。
- **Animated Content / wipe**：渐变遮罩擦除需要给多个目标设置 maskImage 并动画 CSS 变量，AE 侧等价物是动画遮罩层（可做但会新增大量图层，且不是单元素预合成能覆盖的），未发货。

---

## 5. 不可移植清单

| 组别 | 代表组件 | 为什么不可移植 | 最接近的 F2A 做法 |
|---|---|---|---|
| WebGL／Canvas 着色器、流体、粒子 | Backgrounds 全部 64 个（Aurora、Silk、Particles、Hyperspeed、Liquid Chrome 等）、Particle Text、Warp Text、ASCII Text、Splash Cursor | 每帧由着色器／Canvas 生成，不存在关键帧表达；导出为视频也无稳定终态 | 预渲染为 PNG 序列或 MP4，作为 AE 图片序列／素材层；或取一帧静态纹理＋轻微 2D 位移与遮罩淡入 |
| 指针跟随、悬停、拖拽、物理弹簧 | Magnet、Falling Text、Stack、Lanyard、Elastic Slider、Dock 磁放大、Bounce Cards 悬停扩散、Card Swap 拖拽、Split Text hover lift/wave | 动画由输入驱动，无固定时长与固定终点 | 只还原“入场／离场”；交互峰值姿态用一对关键帧定格；弹性用 3 键回弹近似（不超过铁律上限） |
| 滚动绑定／scrub | Scroll Reveal（默认）、Scroll Float（默认）、Animated Content（trigger=scroll，scrub 选项）、Scroll Expand、Scroll Stack、Scroll Velocity | 时长由滚动行程决定，同一组件在不同页面长度下时长不同；不存在统一“入场时长” | 截取 0.6–1.2s 的有限段，按 F2A 的固定时长重建；若要保留滚动同步，只能走 AE 时间重映射（表达式，违反 Web/Lottie 红线，仅作视频） |
| 随机字形／乱码／逐字替换 | Decrypted Text、Shuffle、Split Flap Text、Glitch Text、Scrambled Text、Fuzzy Text、Variable Proximity | 每帧随机码点或字形抖动，无法用少量关键帧表达；逐帧打点会违反“严禁逐帧关键帧” | 还原遮罩扫过／淡入的“骨架”，做 2–3 个离散字符切换（AE-only，仍非逐帧）；或直接放弃该效果 |
| 逐字颜色／渐变／高光扫过 | Gradient Text、Shiny Text、Stroke Text、Masked Heading、Glare Hover、True Focus | 需要逐字 Fill／Stroke／渐变停靠点动画，或一条跟随字形的高光遮罩；AE 文字动画器只支持整层属性，不支持逐字渐变停靠点 | 单色文字＋一个移动的渐变／高光遮罩层（遮罩跟随文字预合成）；或静态高光＋整体淡入 |
| 需要动画 AE 效果（非文字模糊、发光、噪波） | Fade Content 的 dissolve/mist/pixel、Shape Blur、Gradual Blur、Noise、Glow Cursor、Blur Text focus 的完整合成 | 文字模糊尚可用文字动画器 Blur ＋选择器完成；图层级模糊半径／发光／噪波强度动画要给 AE 效果打关键帧，属 Web/Lottie 红线外 | 固定模糊值＋透明度入场（`rb-split-blur`／`rb-focus` 的思路）；或预渲染两张清晰／模糊素材交叉溶解 |
| 3D DOM 变换 | Rotating Text flip、Card Swap、Flip Card、Fold Text、Folder、Echo Text 的层叠、Bounce Cards 的 3D 姿态 | AE 默认导出链路与 Lottie 不支持 3D 层／相机；F2A 默认只允许 2D Transform | 用 2D scaleX／scaleY 压缩模拟 ≤90° 半翻，中段换图＋交叉淡化；或只取 2D 位移／缩放段（如 `rb-content-rise`） |
| 多阶段状态机／交互编排 | Stepper、Carousel、Masonry、Pill Nav、Staggered Menu、Dock 菜单、Bubble Menu 开合 | 逻辑是“状态切换”而不是单条动画；交互触发无法进入视频 | 按状态拆成多个 2–3 键片段（开／关／换页），在 AE 时间线上组接；每个元素仍各用独立预合成 |

---

## 6. 落地与兼容性说明

### 6.1 两种产物，两种兼容性

| 产物 | 依赖 | 导出友好度 | 使用建议 |
|---|---|---|---|
| `preset-rb-*`（文字预设） | AE 原生文字动画器 + **一条 Amount 表达式**（表达式选择器） | AE 工程内可编辑、可逆；**带表达式，不适合 Web/Lottie 直出** | 仅 AE／视频输出优先；Web/Lottie 交付时改用 clip，或先按逐字拆层／关键帧重建再删除表达式（会破坏可编辑性） |
| `rb-*`（内容片段） | 纯 2D Transform／Opacity，每轨 2 键，AE speed/influence 缓动 | Web/Lottie 友好（无表达式、无逐帧键） | 作为默认推荐；应用后用 `position_anchor: "end"` 保持终帧落位 |

这与 F2A 的默认红线一致：普通动效优先 `rb-content-*`／`rb-exit-sink` 这类两键片段；文字入场若用户明确“只出视频/AE 工程”，再用 `preset-rb-*`。

### 6.2 结构与关键帧约束

- **单元素独立预合成**：文字动画器挂在文本层本身，但该文本层必须先被封装进独立预合成；父合成上的入场/退场用 clip 或对预合成层打键，不得对裸文本层加位移关键帧。
- **≤3 关键帧**：一条单向运动段 2 键；出现过冲或两段变速最多 3 键。`rb-*` 片段全部是 2 键/轨，符合上限；`rb-back-pop` 若单段过冲不足，可升为 3 键而不是增加更多采样。
- **无逐帧关键帧**：不接受为“复刻 spring”而按帧烘焙；弹簧观感用 3 键或单段速度曲线近似。
- **空间切线**：位移轨只有单轴直线，应用后回读确认空间切线 `[0,0,0]`（库数据本身不携带切线，依赖 AE 默认与应用器）。
- **终帧落位**：所有 React Bits 来源都是“入场到设计稿状态”，`rb-*` 的终点值需与图层原始 Transform 完全一致（`position_anchor: "end"` 的下游校验）；`rb-exit-sink` 作为退场需首帧对齐静态画面。
- **表达式剥离检查**：交付 Web/Lottie 前，必须回读确认无 `preset-rb-*` 的 Amount 表达式残留（门禁见 SKILL.md 的“无表达式残留”条款）。文字动画器不作为 Lottie 兼容承诺：导出器对表达式的处理不可依赖，必要时转关键帧或改用 `rb-*` 片段。

### 6.3 已知风险

1. `rb-back-pop` 的过冲依赖单段速度曲线；AE 26 实测峰值约 109.7%，需要更强回弹时改 3 键（0→120%→100%）而不是增加更多采样。
2. AE 文字动画器 Blur 与 CSS blur 不同量纲，跨字号时模糊观感会漂移，必要时按字号在应用后覆写。
3. `preset-rb-*` 的 Amount 表达式在 AE 内可编辑可逆，但 Web/Lottie 直出不可依赖；对外交付前按 6.2 的表达式剥离门禁处理。
4. Scroll Float 的逐字 rotation sway（±16°）未发货，`preset-rb-wave-float` 只保留位移与拉伸；需要摆动感时可对预合成层叠加 `rb-content-*` 或手工打旋转键。

## 附：本文引用源码索引

| 组件 | 源码路径（`artifacts/reactbits-src/`） | registry |
|---|---|---|
| Split Text | `SplitText.json` → `SplitText/SplitText.jsx` | `SplitText-JS-CSS` |
| Blur Text | `BlurText.json` → `BlurText/BlurText.jsx` | `BlurText-JS-CSS` |
| Scroll Reveal | `ScrollReveal.json` → `ScrollReveal/ScrollReveal.jsx`（含 `.css`） | `ScrollReveal-JS-CSS` |
| Scroll Float | `ScrollFloat.json` → `ScrollFloat/ScrollFloat.jsx`（含 `.css`） | `ScrollFloat-JS-CSS` |
| Text Type | `TextType.json` → `TextType/TextType.jsx`（含 `.css`） | `TextType-JS-CSS` |
| Rotating Text | `RotatingText.json` → `RotatingText/RotatingText.jsx`（含 `.css`） | `RotatingText-JS-CSS` |
| Animated Content | `AnimatedContent.json` → `AnimatedContent/AnimatedContent.jsx` | `AnimatedContent-JS-CSS` |
| Fade Content | `FadeContent.json` → `FadeContent/FadeContent.jsx` | `FadeContent-JS-CSS` |
| Animated List | `AnimatedList.json` → `AnimatedList.jsx`、`AnimatedList.css` | `AnimatedList-JS-CSS` |
| Bubble Menu | `BubbleMenu.json` → `BubbleMenu.jsx`、`BubbleMenu.css` | `BubbleMenu-JS-CSS` |
| Bounce Cards | `BounceCards.json` → `BounceCards.jsx`、`BounceCards.css` | `BounceCards-JS-CSS` |
| Dock | `Dock.json` → `Dock.jsx`、`Dock.css` | `Dock-JS-CSS` |
| Card Swap | `CardSwap.json` → `CardSwap.jsx`、`CardSwap.css` | `CardSwap-JS-CSS` |
| Stepper | `Stepper.json` → `Stepper.jsx`、`Stepper.css` | `Stepper-JS-CSS` |

F2A 侧引用：`motion-library/builtin.json`（`presets[]`、`clips[]`）、`scripts/extract-motion-library.py`（`procedural_presets()`、`reactbits_clips()`、`RB_*` 曲线常量）、`host/motion/aeMotionPresets.jsx`（`C.text_reveal` 与 `REVEAL_CURVES`）。
