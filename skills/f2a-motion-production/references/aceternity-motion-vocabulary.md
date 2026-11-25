# Aceternity UI 动效语汇与 F2A 映射参考

> 内部参考：记录 ui.aceternity.com 免费组件的动效盘点、关键参数的源码实测值、已落地到 F2A 内置动效库的条目，以及"不可移植 / 仅配方"部分的 AE 重建方案。
> 分析日期：**2026-11-24**；目录快照 `meta.lastUpdated = 2026-11-23T18:17:51.534Z`。
> 分析对象：Aceternity UI 免费组件（Tailwind CSS v4 + Framer Motion `motion/react`，shadcn registry 分发）。
> 本文只做记录与映射，不修改代码；所有参数以 `D:\Tools\F2A\artifacts\aceternity-src\<component>.json` 内 `files[].content` 的 TSX 源码为准，不用印象值。

---

## 1. 概述

> **2026-11-25 去重精简**：`preset-ac-typewriter`（逐字 fade）与通用 `preset-text-fade` 高度重复、`preset-ac-container-flip`（逐字 blur）与 `preset-text-blur` / `preset-rb-split-blur` 高度重复，均已从内置库移除；当前库总量为 **55 clips / 41 presets**。下文保留原始分析记录，以 `motion-library/builtin.json` 为准。

### 1.1 它是什么

Aceternity UI（[ui.aceternity.com](https://ui.aceternity.com)）是 Tailwind + Framer Motion 的 React/Next.js 动效组件集合。它不发 npm 包，而是用 shadcn CLI 把源码直接写进项目：`npx shadcn@latest add @aceternity/<component>`，因此**组件源码就是交付形态**——动效参数"可抄"，但没有统一运行时抽象：一部分是 `motion/react` 声明式动画，一部分是 CSS transition / Tailwind keyframes，一部分把 `style.transform` 直接绑到指针事件或 `requestAnimationFrame`，还有一部分是 three.js / Canvas 着色器或 tsparticles 粒子引擎。

本文的目标不是复刻 Aceternity，而是把它的动效语汇**蒸馏成 F2A 的 AE 动效词汇**：哪些能用 2D 变换 + 透明度 + 原生文字动画器（有限时长）重建，哪些只能近似，哪些不应进入关键帧体系。据此 F2A 在 `motion-library/builtin.json` 新增 5 条 `preset-ac-*` 文字预设与 4 条 `ac-*` 关键帧片段（见第 4 节），生成源为 `scripts/extract-motion-library.py` 的 `procedural_presets()` 与 `aceternity_clips()`。

### 1.2 分析资产

| 资产 | 路径 | 说明 |
|---|---|---|
| 全站目录 | `artifacts/aceternity-src/components-api.json` | `components` 114、`blocks` 9、`hooks` 1、`totalExamples` 184，含 `categories` 十分类映射 |
| 组件源码 | `artifacts/aceternity-src/<component>.json` | 98 份；`files[].content` 为完整 TSX（`apple-cards-carousel`、`card-spotlight`、`cover` 各 2 个文件，其余单文件） |
| 关键词报告 | `artifacts/aceternity-motion-report.txt` | 按 motion 关键词抽取的行号索引，仅用于定位；本文参数均回读源码核对 |
| registry 端点 | `https://ui.aceternity.com/registry/<component>.json` | 与本地快照同源；例 `registry/infinite-moving-cards.json`（2026-11-24 复核 HTTP 200，内容与快照一致） |
| F2A 落地方 | `motion-library/builtin.json`、`scripts/extract-motion-library.py`、`host/motion/aeMotionPresets.jsx` | `presets[]` / `clips[]` 与 `C.text_reveal` 实现 |

取样口径：`components` 共 114 个，`categories` 恰好覆盖 98 个（十类之和 = 98），下载集与这 98 个一一对应；**未进 `categories` 的 16 个新组件未取样**（`parallax-hero-images`、`squiggly-text`、`magnetic-button`、`notch`、`image-generation-loader`、`canvas-text`、`cloud-shader`、`chromatic-image`、`images-badge`、`keyboard`、`terminal`、`3d-globe`、`ascii-art`、`text-flipping-board`、`background-cubes-grid`、`liquid-glass`），涉及它们的判定只依据目录描述，不臆测参数。

### 1.3 许可与引用边界

- 站点内容按其 Terms 使用；本文对源码时序、缓动、变换值只做**技术参数引用**（组件代码本身即为供用户复制的交付物）。
- 不在仓库内再分发 Aceternity 源码；`artifacts/` 下的快照仅作分析证据保留。
- 不复制其视觉资产（图片、字体、装饰 SVG），只记录数值与结构。

---

## 2. 全站盘点

### 2.1 十分类计数（`components-api.json` → `categories`）

| 分类 | 组件数 | 已读源码 | 代表组件 |
|---|---:|---:|---|
| backgrounds | 12 | 12 | background-beams、aurora-background、wavy-background、vortex |
| text | 8 | 8 | text-generate-effect、typewriter-effect、flip-words、encrypted-text |
| cards | 11 | 11 | 3d-card、card-stack、glare-card、wobble-card、tooltip-card |
| navigation | 6 | 6 | floating-navbar、floating-dock、tabs、resizable-navbar |
| hero | 7 | 7 | hero-highlight、spotlight、lamp、container-scroll-animation |
| animations | 14 | 14 | animated-modal、animated-testimonials、carousel、infinite-moving-cards |
| effects | 16 | 16 | sparkles、meteors、shooting-stars、pointer-highlight、lens、compare |
| layout | 6 | 6 | bento-grid、sticky-scroll-reveal、timeline、moving-line |
| forms | 5 | 5 | input、file-upload、placeholders-and-vanish-input |
| utilities | 13 | 13 | 3d-pin、loader、multi-step-loader、stateful-button、macbook-scroll |
| **合计** | **98** | **98** | 目录 snapshot 114 个组件中已分类且已读取的部分 |

统计口径修正：提示中的"183 blocks"是站点画廊口径，本次 registry 目录只携带 **9 个 block**（`cards-demo-1~3`、`features-section-demo-1~3`、`expandable-card-demo-standard/grid`、`hero-section-demo-1`），blocks 不在本文范围；`totalExamples` 为 184，是示例页计数，不等于组件数。

### 2.2 三分桶判定

判定依据是"能否在 AE 中用 2D 变换 + 透明度 + 原生文字动画器（有限时长、≤3 键）重建"，与组件视觉复杂度无关。

| 桶 | 判定标准 | 代表组件 | F2A 处理 |
|---|---|---|---|
| **可直接／近似移植** | 有限时长 2D transform / opacity，或可用文字动画器按字、词控制入场 | Text Generate Effect、Typewriter Effect、Flip Words（字级段落）、Layout Text Flip、Container Text Flip、Animated Modal、Animated Tooltip、Animated Testimonials（手动切换段）、Animated Tabs 内容切换、Tooltip Card（高度弹簧）、Apple Cards Carousel 入场段、Images Slider 入场段、Hero Highlight 高亮扫入、Compare 自动播放段 | 已落地 5 条 `preset-ac-*` + 4 条 `ac-*`（第 4 节）；Compare/Carousel 类给配方（第 5 节） |
| **仅部分可移植** | 需 AE 效果（模糊/发光）、遮罩、多层编排或短循环才能接近；本体可近似但代价高 | Loader 系列、Multi Step Loader、Stateful Button、Infinite Moving Cards（marquee）、Card Stack（定时换卡）、Carousel / Apple Cards Carousel（滑动、布局动画）、Moving Border、Meteors / Shooting Stars / Glowing Stars（元素循环）、Hero Highlight / Pointer Highlight / Text Hover Effect（SVG 描边与渐变）、Wobble Card / Glare Card / Card Spotlight / 3D Card / 3D Pin（指针）、Container Scroll / Macbook Scroll / Hero Parallax / Parallax Scroll / Sticky Scroll Reveal / Tracing Beam（滚动）、Animated Testimonials 自动轮播（5000ms） | 只取入场/离场段；循环与交互给配方（第 5 节） |
| **不可移植** | WebGL/Canvas/着色器、运行时粒子、实时指针、随机化、布局弹簧 | Sparkles（tsparticles）、Vortex、Wavy Background、Canvas Reveal Effect、Card Spotlight 内的着色器、Globe、Pixelated Canvas、Webcam Pixel Grid、Dither Shader、Stars Background、Noise Background、Dotted Glow Background、Encrypted Text、Colourful Text、Text Reveal Card、Lens、Background Beams（随机时长） | 不进关键帧体系；需要时按 5.5/5.6 预渲染或降级 |

修正说明：提示把 Sparkles 同时列在"部分可移植"与"不可移植"，源码是 **tsparticles 运行时粒子引擎**（`@tsparticles/react` + `@tsparticles/slim`），归入不可移植；真正可预合成循环的是 Meteors / Shooting Stars / Glowing Stars。提示中的"Shine Border"在 Aceternity 无同名组件，对应物是 `hover-border-gradient`（悬停渐变边框）与 `glowing-effect`（光标跟随边框），均为指针驱动。Aceternity 也没有 React Bits 那种 "Animated List"：接近物是 `card-stack`（定时换卡）、`timeline`（滚动进度）与 `focus-cards`。

### 2.3 盘点结论

- 98 份源码中，约 **20 个**具备可直接落地的有限入场段（文字类 5、弹层类 4、卡片/滑动入场 3、高亮类 3、其余若干），构成本次发货的主体。
- 约 **40 个**属"入场可移、交互/循环不可移"：入场段能给 2 键片段，本体需配方重建。
- 约 **30 个**完全由 Canvas/WebGL 着色器、随机数或指针实时驱动（`Math.random` 出现 60+ 次的组件集中在 beams/lines/meteors/stars 类），不进入承诺范围。

---

## 3. 关键动画参数（源码实测）

> 约定：源码 `duration` / `delay` 除注明外为**秒**（Framer Motion 语义）；`FlipWords`、`LayoutTextFlip`、`ContainerTextFlip`、`AnimatedTestimonials` 的轮播间隔是**毫秒**，已单独标注；`spring(stiffness, damping)` 为 Framer Motion spring 参数。组件名后括号为该组件 registry 名。

### 3.1 文字类

| 组件 / 效果 | 源码文件 | initial → animate | transition | 备注 |
|---|---|---|---|---|
| Text Generate Effect（`text-generate-effect`） | `components/ui/text-generate-effect.tsx` | 每词 span：class `opacity-0` + `filter: blur(10px)` → `{opacity: 1, filter: "blur(0px)"}` | `duration: 0.5`、`delay: stagger(0.2)`；**未给 ease**（走 Motion 默认 tween） | `filter` 默认 true、`duration` 默认 0.5；`useAnimate` + `useEffect` 触发，无 inView |
| Flip Words（`flip-words`，字级） | `components/ui/flip-words.tsx` | 字：`{opacity: 0, y: 10, filter: "blur(8px)"}` → `{opacity: 1, y: 0, filter: "blur(0px)"}` | 字：`delay: wordIndex*0.3 + letterIndex*0.05`，`duration: 0.2`；词：`delay: wordIndex*0.3`，`duration: 0.3`；无 ease | 轮播 `duration = 3000` ms；字级与词级两层错峰叠加 |
| Flip Words（外层词容器） | 同上 | `{opacity: 0, y: 10}` → `{opacity: 1, y: 0}` | `{type: "spring", stiffness: 100, damping: 10}` | exit：`{opacity: 0, y: -40, x: 40, filter: "blur(8px)", scale: 2, position: "absolute"}` |
| Typewriter Effect（`typewriter-effect`） | `components/ui/typewriter-effect.tsx` | span：`opacity 0` + `hidden` → `{display: "inline-block", opacity: 1, width: "fit-content"}` | `duration: 0.3`、`delay: stagger(0.1)`、`ease: "easeInOut"`；由 `useInView(scope)` 触发 | 光标 `opacity 0 → 1`，`{duration: 0.8, repeat: Infinity, repeatType: "reverse"}`；`TypewriterEffectSmooth` 变体把容器宽度 0→fit-content 用 2s linear + delay 1 |
| Container Text Flip（`container-text-flip`） | `components/ui/container-text-flip.tsx` | 字母：`{opacity: 0, filter: "blur(10px)"}` → `{opacity: 1, filter: "blur(0px)"}` | 字母仅 `{delay: index * 0.02}`（无 duration/ease）；外层宽 `animate={{width}}` = `animationDuration/2000`（默认 700 → **0.35s**）；词容器 `animationDuration/1000` = **0.7s**、`ease: "easeInOut"` | 轮播 `interval = 3000` ms；宽度按 `scrollWidth + 30` 计算 |
| Layout Text Flip（`layout-text-flip`） | `components/ui/layout-text-flip.tsx` | `{y: -40, filter: "blur(10px)"}` → `{y: 0, filter: "blur(0px)"}` | `{duration: 0.5}`（无 ease） | exit `{y: 50, filter: "blur(10px)", opacity: 0}`；`AnimatePresence mode="popLayout"`；轮播 `duration = 3000` ms；initial 未设 opacity（默认 1） |

### 3.2 卡片、弹层与切换

| 组件 / 效果 | 源码文件 | initial → animate | transition | 备注 |
|---|---|---|---|---|
| Animated Modal（`animated-modal`） | `components/ui/animated-modal.tsx` | 遮罩 `{opacity: 0}` → `{opacity: 1, backdropFilter: "blur(10px)"}`；面板 `{opacity: 0, scale: 0.5, rotateX: 40, y: 40}` → `{opacity: 1, scale: 1, rotateX: 0, y: 0}` | 遮罩未声明（Motion 默认）；面板 `{type: "spring", stiffness: 260, damping: 15}` | 遮罩 exit `blur(0px)`；面板 exit `{opacity: 0, scale: 0.8, rotateX: 10}`；容器 `[perspective:800px]` |
| Animated Tooltip（`animated-tooltip`） | `components/ui/animated-tooltip.tsx` | 卡：`{opacity: 0, y: 20, scale: 0.6}` → `{opacity: 1, y: 0, scale: 1}`；指针：`rotate = useSpring(useTransform(x, [-100,100], [-45,45]))`、`translateX = useSpring(useTransform(x, [-100,100], [-50,50]))` | 卡 `{type: "spring", stiffness: 260, damping: 10}`；指针两个 spring 均为 `{stiffness: 100, damping: 15}` | 卡 exit 同 initial；`x = clientX - offsetWidth/2`，rAF 节流 |
| Animated Testimonials（`animated-testimonials`） | `components/ui/animated-testimonials.tsx` | 卡：`{opacity: 0, scale: 0.9, z: -100, rotate: random(-10…10)}` → active `{opacity: 1, scale: 1, z: 0, rotate: 0, y: [0,-80,0]}`、非 active `{opacity: 0.7, scale: 0.95, z: -100, rotate: random}` | `{duration: 0.4, ease: "easeInOut"}` | exit `{opacity: 0, scale: 0.9, z: 100, rotate: random}`；`randomRotateY = floor(random*21) - 10` |
| Animated Testimonials（文案） | 同上 | 块：`{y: 20, opacity: 0}` → `{y: 0, opacity: 1}`；quote 逐词 `{filter: "blur(10px)", opacity: 0, y: 5}` → `{blur(0px), 1, 0}` | 块 0.2s easeInOut；词 `{duration: 0.2, ease: "easeInOut", delay: 0.02*index}` | `autoplay`（默认 false）时 `setInterval(handleNext, 5000)` |
| Tooltip Card（`tooltip-card`） | `components/ui/tooltip-card.tsx` | `{height: 0, opacity: 1}` → `{height: scrollHeight, opacity: 1}` | `{type: "spring", stiffness: 200, damping: 20}` | exit `{height: 0, opacity: 0}`；指针偏移 12px、边缘翻转；触摸 2s 后隐藏 |
| Animated Tabs（`tabs`） | `components/ui/tabs.tsx` | active 背景 `layoutId="clickedbutton"`；内容层 `scale: 1 - idx*0.1`、`opacity: idx < 3 ? 1 - idx*0.1 : 0`、`zIndex: -idx`、`top: hovering ? idx*-50 : 0` | 背景 `{type: "spring", bounce: 0.3, duration: 0.6}`；active 内容 `animate={{y: [0, 40, 0]}}` | 内容切换靠 z 序 + 缩放，不是淡入淡出 |
| Card Stack（`card-stack`） | `components/ui/card-stack.tsx` | `animate={{top: index * -CARD_OFFSET, scale: 1 - index*SCALE_FACTOR, zIndex: cards.length - index}}` | 未声明（Motion 默认弹簧） | `CARD_OFFSET = 10`、`SCALE_FACTOR = 0.06`（默认值）；`setInterval(…, 5000)` 轮转；`transformOrigin: "top center"` |
| Carousel（`carousel`，CSS 驱动） | `components/ui/carousel.tsx` | 非 active：`scale(0.98) rotateX(8deg)`；active：`scale(1) rotateX(0deg)` | `transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)`；`ul` 位移 `translateX(-current * (100 / slides.length)%)`，`transition-transform duration-1000 ease-in-out` | 指针倾斜 `translate3d(calc(var(--x)/30), calc(var(--y)/30), 0)`，rAF 写入 |
| Apple Cards Carousel（`apple-cards-carousel`） | `components/ui/apple-cards-carousel.tsx` | 卡：`{opacity: 0, y: 20}` → `{opacity: 1, y: 0, transition: {duration: 0.5, delay: 0.2*index, ease: "easeOut"}}` | 入场 0.5s / `0.2*index` / easeOut | 点击滚动 `scrollBy({left: ±300, behavior: "smooth"})`；放大层 `opacity 0→1` + `backdrop-blur-lg`；`layoutId` 共享布局；缩略图 `blur-sm → blur-0` `duration-300` |

### 3.3 循环与加载

| 组件 / 效果 | 源码文件 | 关键帧值 | transition | 备注 |
|---|---|---|---|---|
| Loader One | `components/ui/loader.tsx` | 3 点 `animate={{y: [0, 10, 0]}}` | `{duration: 1, repeat: Infinity, repeatType: "loop", delay: x*0.2, ease: "easeInOut"}` | x = 0/1/2 → 延迟 0/0.2/0.4s |
| Loader Two | 同上 | `animate={{x: [0, 20, 0]}}` | `{duration: 2, repeat: Infinity, repeatType: "loop", delay: x*0.2, ease: "easeInOut"}` | 三个圆的 x 延迟 0/0.4/0.8s |
| Loader Three | 同上 | SVG `pathLength: 0 → 1` + fill 变量 `--fill-initial → --fill-final` | `{duration: 2, ease: "easeInOut", repeat: Infinity, repeatType: "reverse"}` | 路径即闪电图标，**reverse 往返**而非循环 |
| Loader Four / Five | 同上 | Four：`skewX [0,-40,0]`、`scaleX [1,2,1]`、glitch 0.05s + 两层 RGB 幽灵 0.5s/0.8s；Five：逐字 `scale [1,1.1,1]`、`textShadow 0→1px→0`、`opacity [0.5,1,0.5]` | Four `{duration: 0.05, repeatType: "reverse", repeatDelay: 2, ease: "linear", times: [0,0.2,0.5,0.8,1]}`；Five `{duration: 0.5, delay: i*0.05, ease: "easeInOut", repeatDelay: 2}` | 需要"3 点 scale 循环"时对应的是 Five |
| Multi Step Loader（`multi-step-loader`） | `components/ui/multi-step-loader.tsx` | 每行 `initial {opacity: 0, y: -(value*40)}` → `animate {opacity: max(1 - Math.abs(index - value)*0.2, 0), y: -(value*40)}` | `{duration: 0.5}`（无 ease） | 步骤每 `duration = 2000` ms 推进，`loop` 默认 true；**y 随步骤值整列上移 40px/步**（initial 与 animate 同式，靠 `value` 变化驱动）；外层 overlay `opacity 0→1` + `backdrop-blur-2xl` |
| Stateful Button（`stateful-button`） | `components/ui/stateful-button.tsx` | loader / check 三段时间线：宽 20px/scale 1 展开，结束 check 收 0 | 每段 `duration: 0.2`；check 收起 `delay: 2` | loader 自转 `rotate: [0, 360]`，`{duration: 0.3, repeat: Infinity, ease: "linear"}`；`layout` + `layoutId="button"` |
| Infinite Moving Cards（`infinite-moving-cards`） | `components/ui/infinite-moving-cards.tsx` | 见下方专表 | CSS 动画 | `cloneNode(true)` 复制一遍 + Tailwind 主题层 keyframes |

Infinite Moving Cards（源码只给变量与类名，keyframes 在 Tailwind 主题层，不在下载的 `.tsx` 内）：

| 项 | 源码值 |
|---|---|
| 内容复制与几何 | `scrollerContent.forEach(item => appendChild(item.cloneNode(true)))` → 列表长度 ×2；卡宽 `350px`（`md:450px`）+ `gap-4`（16px）；复制一倍 + 位移 `-50%` 构成无缝循环 |
| 速度变量 | `--animation-duration`：`fast = 20s`、`normal = 40s`、`slow = 80s`（默认 `speed = "fast"`）；线速度 ≈ 半列表宽 ÷ duration（9 卡 × 466px 半宽 ≈ 2097px，20s → ≈105px/s） |
| 方向与悬停 | `--animation-direction`：`left → forwards`、`right → reverse`（默认 left）；`pauseOnHover` 默认 true → `hover:[animation-play-state:paused]` |
| 动画注册 | 类名 `animate-scroll`；主题层 `--animate-scroll: scroll var(--animation-duration, 40s) var(--animation-direction, forwards) linear infinite` + `@keyframes scroll { to { transform: translateX(-50%) } }`（**属 Tailwind 主题层，本次快照未含，按站点片段记录**） |

### 3.4 指针 / 滚动 / 元素循环速记

| 组件 | 源码关键值 | 性质 |
|---|---|---|
| Moving Border（`moving-border`） | `duration = 3000` ms 走完一圈 SVG rect（`getTotalLength()` 换算 px/ms）；`rx/ry = "30%"`；光斑 `80×80`、`radial-gradient(#0ea5e9 40%, transparent 60%)`、`opacity 0.8`；内层 `backdrop-blur-xl` | 循环 |
| Container Scroll（`container-scroll-animation`） | `useScroll` 进度 → `rotateX 20° → 0`、`scale [1.05, 1]`（移动端 `[0.7, 0.9]`）、`translateY 0 → -100`；父级 `perspective: 1000px`；容器高 `60rem`（`md:80rem`） | 滚动 |
| Macbook Scroll（`macbook-scroll`） | `translateY 0 → 1500`；`rotate [-28, -28, 0]`（进度 `[0.1, 0.12, 0.3]`）；标题 `translateY 0 → 100`、`opacity 1 → 0`（`[0, 0.2]`）；基座 `perspective(800px) rotateX(-25deg)` | 滚动 |
| Parallax Scroll（`parallax-scroll`） | 三列 y：`0 → -200`、`0 → +200`、`0 → -200` | 滚动 |
| Sticky Scroll Reveal（`sticky-scroll-reveal`） | `activeCard` 取最近断点 `index / n`；标题/描述 `opacity: 1`（active）或 `0.3`；背景色 `#0f172a` / `#000000` / `#171717` 轮换 | 滚动 |
| Tracing Beam（`tracing-beam`） | y1/y2 均为 `useSpring(…, {stiffness: 500, damping: 90})`；y1 `[0,0.8] → [50, h]`、y2 `[0,1] → [50, h-200]`；渐变 `#18CCFC → #6344F5(0.325) → #AE48FF` | 滚动 |
| Hero Highlight（`hero-highlight`） | `backgroundSize: "0% 100%" → "100% 100%"`，`{duration: 2, ease: "linear", delay: 0.5}`；指针点亮圆点纹理（`radial-gradient(200px circle …)`） | 入场 + 指针 |
| Pointer Highlight（`pointer-highlight`） | 线框 `width/height: 0 → 实际尺寸`，`{duration: 1, ease: "easeInOut"}`；指针 `x/y = 尺寸 + 4`，`opacity` 0.1s；容器 `{opacity: 0, scale: 0.95} → {1, 1}` 0.5s easeOut | 入场 |
| 3D Marquee（`3d-marquee`） | 4 列 `y ±100`；偶列 `duration: 10`、奇列 `duration: 15`，`repeat: Infinity, repeatType: "reverse"`；容器 `rotateX(55deg) rotateZ(-45deg)`，缩放 50%/75%/100%；图 hover `y: -10`（0.3s easeInOut） | 循环（DOM 3D） |
| Sparkles（`sparkles`） | tsparticles：`particleDensity = 120`、size `1–3`、opacity `0.1–1`（动画速度 4）、`onClick push quantity 4`；外层 `controls.start({opacity: 1})` `duration: 1` | 运行时粒子 |
| Meteors / Shooting Stars / Glowing Stars | Meteors：容器 `opacity 0→1`（0.5s），每颗 `animationDelay: random*5s`、`animationDuration: floor(random*5)+5 → 5–10s`。Shooting Stars：`minSpeed 10 / maxSpeed 30`、`minDelay 1200 / maxDelay 4200`、`starWidth 10 / starHeight 1`、`scale = 1 + distance/100`、色 `#9E00FF` / `#2EB9DF`。Glowing Stars：星 `scale: [1, 1.2, 2.5, 2.2, 1.5]`，`{duration: 2, ease: "easeInOut", delay: (idx%10)*0.1}` | 循环 |

---

## 4. F2A 映射表（已落地）

### 4.1 命名与机制

- **文字预设**：`kind: procedural`、`command: text_reveal`、`id = preset-ac-*`，存于 `motion-library/builtin.json` 的 `presets[]`；生成源 `scripts/extract-motion-library.py` → `procedural_presets()`（Aceternity 段）。
- **内容片段**：`kind: clip`，存于 `clips[]`；`id` 是 UUID，**稳定短名是 `slug`**（`ac-modal-pop` 等）；生成源同脚本 `aceternity_clips()`。
- **文字机制**（`host/motion/aeMotionPresets.jsx` 的 `C.text_reveal`）：给文本层加一个 AE 原生**文字动画器**（Opacity + 按样式选配 Position 3D / Scale 3D / Blur），再加一个 **Expressible Selector（表达式选择器）**，用一条 Amount 表达式按 `textIndex/textTotal` 算错峰；全层仅此一条表达式，无逐字关键帧。
- **速率控制**：5 条 `preset-ac-*` 的 `supports` 只有 `{duration, textBy}`，未启用 `style`（等价于提示中的 `supports.style = false`）——样式与默认 distance/direction 由预设锁定，避免面板全局曲线把时序压平。
- **片段形态**：4 条 `ac-*` 全部是 2 键/轨，仅 Scale（ThreeD）、Position（ThreeD_SPATIAL，单轴）、Rotate Z、Opacity 四类属性；无表达式、无第 3 键、无逐帧。
- **缓动词汇**：`REVEAL_CURVES` 的闭式曲线（`power2Out = 1-(1-u)^2`、`power2InOut`、`backOut = 1+2.70158(u-1)^3+1.70158(u-1)^2` 等）同时用于预设表达式与片段速度/影响值。

### 4.2 文字预设（`text_reveal`，5 条）

| Aceternity 来源 | 源码参数 | F2A 条目（id / kind） | F2A 参数 | 差异／近似说明 |
|---|---|---|---|---|
| Text Generate Effect | 逐词 `opacity 0→1` + `blur 10px→0`；`duration 0.5`；`delay stagger(0.2)`；无 ease | `preset-ac-text-generate` / procedural | style=blur；by=words；0.5s；stagger 0.2；ease=power2Out；`supports={duration, textBy}` | 近似：源码未写 ease，`power2Out` 逼近其默认 tween 的缓出；**AE 文字动画器 Blur 实测固定 24**（`style=blur` 的标定值，非源码 10px，量纲见 6.2） |
| Flip Words（字级） | 字：`opacity 0→1`、`y 10→0`、`blur 8px→0`；`duration 0.2`；`delay = 词序*0.3 + 字序*0.05`；外层 spring(100, 10) | `preset-ac-flip-words` / procedural | style=riseBlur；by=chars；0.2s；stagger 0.05；ease=power2Out；distance 10 | 近似：只保留字序 `0.05`，词级 `+0.3s` 偏移与外壳弹簧未打包；**方向偏差**：源码 y 10→0 为自下上升，预设未传 direction 而 `riseBlur` 默认 down → 实际自上方下落，应补 `direction=up`；模糊 8px → AE Blur 10（riseBlur 标定值） |
| Typewriter Effect | 逐字 `opacity 0→1`；`duration 0.3`；`stagger 0.1`；`easeInOut`；光标 `0.8s repeat reverse` | `preset-ac-typewriter` / procedural | style=fade；by=chars；0.3s；stagger 0.1；ease=power2InOut | 近似；光标闪烁与打字回删不在片段内（需单独形状层 2 键） |
| Container Text Flip | 字母 `opacity 0→1` + `blur 10px→0`；`delay = index*0.02`（无 duration/ease）；宽度 0.35s、词容器 0.7s easeInOut | `preset-ac-container-flip` / procedural | style=blur；by=chars；0.3s；stagger 0.02；ease=power2InOut | 近似：源码字级无 duration/ease（走默认 tween），0.3s/power2InOut 取"容器 0.7s easeInOut + 默认 tween"折中；AE Blur 固定 24（源码 10px）；宽度/布局动画未打包 |
| Layout Text Flip | 词条 `y -40→0` + `blur 10px→0`；`duration 0.5`；无 ease；exit `y 50 / blur 10 / opacity 0` | `preset-ac-layout-flip` / procedural | style=riseBlur；by=words；0.5s；stagger 0.02；ease=power2Out；distance 40；direction=down | 入场等价（y -40→0、模糊 10→0）；旧词 exit 需两层交叉，未打包；`stagger 0.02` 是新增的整词错峰（源码同一条词同时播放） |

### 4.3 内容片段（`kind: clip`，2 键/轨，4 条）

| Aceternity 来源 | 源码参数 | F2A 条目（slug / kind） | F2A 参数 | 差异／近似说明 |
|---|---|---|---|---|
| Animated Modal | 面板 spring(260, 15)：`scale 0.5→1`、`rotateX 40→0`、`y 40→0`、`opacity 0→1`；遮罩 `backdrop blur 10px` | `ac-modal-pop` / clip（id `077d7a74-b8c5-5d33-84ab-b8ea1a3b2289`） | Scale 50→100%（backOut 速度曲线）、Position y +40→0、Opacity 0→100；0.55s；位移/透明度 power2Out | 近似：单段过冲近似 spring，无 >100% 的第二过冲键；`rotateX 40`（3D）与遮罩 `backdrop-filter` 未打包 |
| Animated Tooltip | spring(260, 10)：`scale 0.6→1`、`y 20→0`、`opacity 0→1` | `ac-tooltip-pop` / clip（id `f8c9503d-7c03-5b09-997a-7f32a000db4e`） | Position y +20→0、Scale 60→100%（backOut）、Opacity 0→100；0.5s | 近似：单段过冲；指针跟随 spring(100, 15) 与 `±45° / ±50px` 映射未打包 |
| Animated Testimonials | `duration 0.4 easeInOut`：`scale 0.9→1`、`rotate random(-10…10)→0`、`opacity 0→1`、`z -100→0`、active `y [0,-80,0]` | `ac-testimonial-turn` / clip（id `a7f4b750-fa87-555f-8556-ff306b271da8`） | Rotate Z -8→0、Scale 90→100%、Opacity 0→100；0.4s；三轨 power2InOut | 近似：随机角固定 -8°；`z`/透视与 active 卡的 `y [0,-80,0]` 关键帧未打包 |
| Layout Text Flip | 词条 `y -40→0`，`duration 0.5`，无 ease | `ac-flip-line` / clip（id `fcfa51a5-6432-560c-b1cc-3822ab250de9`） | Position y -40→0、Opacity 0→100；0.5s power2Out | 近似：`blur 10→0` 省略（图层级模糊不在 2 键片段能力内，且违反 Web/Lottie 友好约定） |

### 4.4 实测偏差与实现取舍

1. **片段 id 形态**：提示把 `ac-modal-pop` 称为"条目 id"，实际 `builtin.json` 的 `id` 是 UUID，`ac-modal-pop` 是 `slug`；引用条目请用 `slug`（面板按中文 `name` 展示）。
2. **"backOut 过冲"是意图而非字面键值**：`ac-modal-pop` / `ac-tooltip-pop` 的 Scale 轨只有 2 键（50→100、60→100），过冲由 `RB_BACK_OUT` 的 speed/influence 曲线在 AE 内解释，不存在 >100% 的第三键；与 `rb-back-pop` 同理，若接触表看不到过冲，应升为 3 键而不是加更多采样。
3. **`preset-ac-flip-words` 方向与源码相反**：源码字级 `y: 10 → 0` 是自下上升；`riseBlur` 默认 `direction = "down"`（自上方下落，为 Blur Text 的 `direction='top'` 而设），预设未显式传值。修正只需补 `direction: "up"`，其余参数不变。
4. **模糊量纲**：`preset-ac-text-generate` / `preset-ac-container-flip` 用 `style=blur`，其 AE 文字动画器 Blur 硬编码 `[24, 24]`（Split Text 观感标定值），而 Aceternity 源是 `blur(10px)`；`preset-ac-flip-words` / `preset-ac-layout-flip` 用 `riseBlur` 的 `[10, 10]`（源 8px / 10px）。跨字号时观感会漂移，需要时应用后覆写。
5. **`preset-ac-container-flip` 的时长是折中**：源码字级只给 `delay`（时长/缓动走 Motion 默认），容器给 0.7s easeInOut；`0.3s + power2InOut` 是二者的折中，不是源码的显式值。
6. **Multi Step Loader 的 y 不是静态值**：`initial` 与 `animate` 都写 `-(value*40)`，但 `initial` 只首帧生效，`value` 推进时 `animate` 目标变化 → 整列按 40px/步上移，0.5s 无显式缓动；透明度按 `1-|index-value|*0.2`（下限 0）衰减。
7. **Loader 的时长对应关系**：`LoaderOne` 是 y 1s、`LoaderTwo` 是 x 2s、`LoaderThree` 才是 `pathLength` 2s（**reverse 往返**）、`LoaderFour` 是 glitch 0.05s、`LoaderFive` 是逐字 0.5s；"3 点 y/scale 1/2s"是概括，scale 关键帧实际在 LoaderFive。
8. **AnimatedTooltip 有两套 spring**：入场 260/10，指针跟随 100/15（提示只给了前者）；后者是指针态，不进入关键帧。
9. **`supports.style`**：提示说 `supports.style = false`；源码 JSON 中 `supports` 只有 `{duration: true, textBy: true}`，没有 `style` 键，效果等价（样式锁定），但措辞应以后者为准。

### 4.5 近似发货与未发货

- **未发货：Flip Words 外层弹簧**（spring 100/10 的词整体上浮）——字级错峰已表达主要观感，词级弹簧在 AE 里需要第二条动画器或拆层，收益低于成本。
- **未发货：Layout Text Flip 的 exit**（旧词 `y +50 / blur / opacity 0` 与新词交叉）——`AnimatePresence` 的交叉需要两个文本层，属于编排而非单条入场。
- **未发货：Modal 的 rotateX 40 与 backdrop blur**——`rotateX` 是 3D 逐层属性，`backdrop-filter` 无 AE 图层等价物，均超出"2D 变换 + 透明度"片段约定。
- **未发货：Typewriter 光标、Shooting Stars / Meteors / Sparkles 类循环**——前者可用形状层 2 键 opacity 单独做，后者是随机相位与运行时粒子，只给配方（5.1）。

---

## 5. 不可移植 / 仅配方清单（含 AE 重建方案）

> 以下组件**没有**内置库条目，按配方在 AE 内手工搭建；所有配方遵守"单元素独立预合成、≤3 键/段、无逐帧、Web/Lottie 交付不带表达式"。

### 5.1 循环类

| 组件 | 源码机制 | AE 配方 | 限制 |
|---|---|---|---|
| Infinite Moving Cards | 复制一倍内容 + CSS `translateX(-50%)`，`20/40/80s` linear infinite，方向 `forwards/reverse` | 内容预合成宽 `W`；层复制两份首尾相接；父级 Position X：`0 → -W`，2 键，时长取 20s/40s/80s，linear；需要多圈就整段复制（每段仍 2 键，不叠表达式） | 若要 `loopOut("cycle")` 属表达式，仅 AE-only；Web/Lottie 用"3 段线性拼接"替代 |
| Loader 三点 / 逐字 | `y [0,10,0]` 1s、`x [0,20,0]` 2s、`scale [1,1.1,1]` 0.5s；delay 0.2 递进 | 每个点独立预合成：y 轨 3 键（0 → +10 → 0）1s，easeInOut；三点 delay 0/0.2/0.4；循环用 2 个周期拼接 | 每周期 3 键，符合上限；超过 2 个周期改用时间重映射 |
| Loader 路径绘制 | `pathLength 0→1`，2s easeInOut，reverse 往返 | 形状层 **Trim Paths**：End `0% → 100% → 0%`（3 键）2s easeInOut；配合描边粗细与端点圆角 | AE 无 `pathLength` 属性，用 Trim Paths 等价 |
| Shooting Stars / Meteors | 每元素随机起点、随机 1.2–4.2s / 0–5s 延迟、1–4s 位移、scale 随距离增长 | 预合成 8–12 个长条（渐变尾迹：白→透明），手动分布起点；每元素 2 键线性位移（2–4s），错峰 0–4s；用多个副本周期堆出"随机感" | 随机不可复现；同一构图需固化一组种子并复用 |
| Glowing Stars | 星 `scale [1,1.2,2.5,2.2,1.5]` 2s easeInOut，列错峰 `(idx%10)*0.1` | 每星 4 键 scale（1 → 2.5 → 1.5 → 1）2s；光晕层 2 键 opacity 0→100 | 4 键超过单段上限，拆成"放大段 + 收小段"两段各 2–3 键 |
| 打字机光标 | `opacity 0↔1` 0.8s repeat reverse | 形状层 2 键 opacity（0 → 100）0.8s + 周期复制 | 闪烁节奏固定；打字节奏不可复刻 |

### 5.2 滚动驱动

| 组件 | 源码驱动 | AE 配方（有限段化） |
|---|---|---|
| Container Scroll | `scrollYProgress` → `rotateX 20→0`、`scale 1.05→1`、`translateY 0→-100` | 1.2s 3 键：`rotateX 20→0`（3D 层或 scaleY 压缩近似）、`scale 105→100%`、`y 0→-100`；Lottie 交付去掉 rotateX，只留 scale/y |
| Macbook Scroll | `translateY 0→1500`、`rotate -28→0`（进度 0.1–0.3）、标题 `y 0→100` + `opacity 1→0` | 拆两段：屏幕 `rotateX -25→0` + `y +1500→0`（1.5s，3 键）；标题 2 键上移淡出（0.8s） |
| Hero Parallax | 双向 `translateX ±1000`（spring）、`rotateX 15→0`、`rotateZ 20→0`、`scale 0.2→1`、`y -700→500` | 预合成两排卡；各排 `x 0→±1000`（2 键 1.2s）、整体 `rotateX 15→0 + scale 20→100%`；正反方向错开 |
| Parallax Scroll | 三列 `y 0→-200 / 0→+200 / 0→-200` | 三列分别 2 键 y（1.5s），列间延迟 0.1s；上/下方向交替 |
| Sticky Scroll Reveal | 断点 `index/n` 切换 active；标题/描述 opacity `1` 或 `0.3`；背景色轮换 | 每个步骤一个预合成：标题/描述 2 键 opacity（30→100）0.4s；背景色 2 键切换；时间线上按停留时长排序 |
| Tracing Beam | y1/y2 spring(500, 90) 扫过渐变 | 渐变层沿路径 2 键 y（1.5s，缓出近似 spring）；路径用描边层，渐变用 mask 或 Trim Paths |
| Hero Highlight | `backgroundSize 0%→100%` 2s linear delay 0.5 | 高亮层 scale X `0→100%`（2 键）2s linear + 0.5s 延迟；或从左到右的矩形遮罩 |

### 5.3 指针交互（AE 中改为自动播放预演）

| 组件 | 源码机制 | AE 预演做法 |
|---|---|---|
| 3D Card / 3D Pin | `±(offset/25)°` 旋转，200ms linear；Pin 涟漪 6s 循环 + hover 线高 `20→40` | 卡：`rotateY 0→-12°→0`、`rotateX 0→6°→0`（各 3 键，1.2s 往返）；Pin：3 个圆环预合成 `scale 0→100%` + opacity `[0,100,50,0]`（拆两层各 3 键） |
| Glare Card | 指针写 `--r-x/--r-y`、`--m-x/--m-y`，`--duration: 300ms`，hover 200ms | 高光层沿对角线 2 键位移 + opacity `0→60%→0`（3 键）；彩虹箔为静态渐变层 |
| Wobble Card | 位移 `(offset/20)`px，`transition: transform 0.1s ease-out`；内层反向 + `scale3d(1.03)` | 卡 2 键 `x/y ±20px`（0.3s 往返），内层反向 2 键 + `scale 100→103%` |
| Card Spotlight / Spotlight | 指针/静态光斑（Spotlight 为 SVG + `feGaussianBlur stdDeviation=151` + 主题层 `animate-spotlight`） | 光斑层（椭圆 + 高斯模糊）2 键位移（0→中心→0）+ opacity；静态版直接贴图 |
| Floating Dock | 磁放大 spring(150, 12)：尺寸 `40→80`，范围 `[-150, 0, 150]` | 选中图标 2 键 `scale 100→200%`（0.4s），相邻图标错峰 0.05s；不还原磁吸跟随 |
| Moving Border | 3000ms 沿 rect 路径匀速，`rx/ry 30%` | 光斑沿圆角矩形路径：路径层做运动路径（2–3 键）+ 光斑位移；或直接 Trim Paths 画边框扫光 |

### 5.4 3D / 透视类

| 组件 | 3D 性质 | AE 处理 |
|---|---|---|
| Animated Modal | 面板 `rotateX 40→0`，容器 `perspective: 800px` | 3D 层（`rotateX`）或预渲染两帧交叉；Web/Lottie 用 `scaleY` 压缩近似 |
| Flip Words exit | `scale 2` + `blur 8` + `y -40/x 40` 离场 | 2 键 scale/位移 + 图层模糊（AE-only）；或只做淡出 |
| 3D Marquee | 容器 `rotateX 55° rotateZ -45°`，4 列反向缓移 | 预合成整面墙 → 3D 层旋转后整体位移；或直接预渲染为 PNG 序列（推荐） |
| Carousel / Images Slider | `rotateX 8°`（非 active）、`rotateX 45→0` 入场 | 3D 层 `rotateX` 或 `scaleY` 压缩；Lottie 交付只留 scale/opacity |
| Container Scroll / Macbook | `rotateX` 搭配 `scale`/`translate` | 同 5.2；`rotateX` 用 3D 层，Lottie 里退化 |

### 5.5 WebGL / Canvas / 着色器（不可移植原因）

| 组件 | 技术依赖 | 不可移植原因 |
|---|---|---|
| Sparkles | `@tsparticles/react` + `@tsparticles/slim` | 运行时粒子引擎：120 粒子、opacity/rotate 连续随机、`onClick push`；无有限关键帧表达 |
| Vortex | `simplex-noise` + Canvas | 每帧噪声场推动粒子 |
| Wavy Background | `simplex-noise` + Canvas | 每帧噪声波形重绘 |
| Canvas Reveal Effect / Card Spotlight | `three` + `@react-three/fiber` + GLSL `ShaderMaterial` | 片元着色器逐像素输出点阵/扫描 |
| Globe | `three` + `three-globe` + R3F | WebGL 球体与弧线 |
| Pixelated Canvas | Canvas 逐像素 | 像素化 + 指针扰动 |
| Webcam Pixel Grid | `getUserMedia` + Canvas | 摄像头实时像素化 |
| Dither Shader | Canvas + 着色器抖动 | 逐像素抖动算法 |
| Stars Background / Noise Background / Dotted Glow Background | Canvas 绘制 + rAF | 星点随机闪烁 / 逐帧噪波 / 点阵光晕 |
| Background Beams / Beams Collision | SVG path + `Math.random()` 时长 10–20s、随机延迟 0–10s | 随机相位不可复现；可静态化后接近似（见 5.2 手法） |

补充（**非着色器，勿误列**）：`Lamp` 是 `whileInView` 宽度 `15rem→30rem` / `8rem→16rem`、opacity、delay 0.3 / 0.8s easeInOut；`Spotlight` 是 SVG 椭圆 + 高斯模糊 + 主题层 `animate-spotlight`；`Aurora Background` 是 `repeating-linear-gradient(100deg)` + `blur(10px)` + `mix-blend-difference` + 主题层 `animate-aurora`；`SVG Mask Effect` 是指针驱动 `maskPosition/maskSize`（10px→600px）；`Google Gemini Effect` 是滚动进度驱动 5 条 `pathLength`（组件内 `transition: {duration: 0}`）。四者都可用 2–3 键或预合成近似，属"可配方"而非"不可移植"。

### 5.6 文本类不可移植

| 组件 | 源码机制 | 为什么不可移植 | 最接近做法 |
|---|---|---|---|
| Encrypted Text | rAF 乱码：`revealDelayMs 50`、`flipDelayMs 50`、`useInView({once:true})` | 每 50ms 随机替换未揭示字符，随机码点无关键帧表达 | 只还原"遮罩扫过 + 淡入"骨架；或 2–3 个离散字符切换（AE-only） |
| Colourful Text | 逐字 `y [0,-3,0]`、`scale [1,1.01,1]`、`blur [0,5,0]`、`opacity [1,0.8,1]`，0.5s，`delay index*0.05`；每 5000ms 随机洗牌颜色 | 逐字颜色随机 + 逐字模糊/位移四属性组合，文字动画器无法逐字改色 | 逐字位移/模糊可做（预设外手工）；颜色改用整体渐变层扫过 |
| Text Hover Effect | SVG 描边 `strokeDashoffset 1000→0` 4s easeInOut；光标径向遮罩 `r 20%` + 5 色渐变 | 需要整块 SVG 描边与光标遮罩 | 预渲染 SVG 为形状层，Trim Paths 做描边 4s；光标遮罩改为固定椭圆遮罩 |
| Text Reveal Card | 指针写 `clipPath: inset(0 X% 0 0)`；80 个随机星点 `duration random*10+20` repeat linear | 指针实时 + 随机星点 | 遮罩矩形 2 键横向展开（0.8s）；星点固化一组并循环 |
| Squiggly Text | **未取样**（未进 categories） | 站点描述为字形扰动，无源码参数 | 不参数化；如需，按"逐字位移抖动 3 键 + 循环"手工做 |

---

## 6. 兼容性与风险

### 6.1 缓动近似关系

| 源码缓动 | F2A 对应 | 等价度 |
|---|---|---|
| Motion 默认 tween（未写 ease） | `power2Out` | 近似：默认 tween 呈缓出形态，但不是同一条曲线；用于 Text Generate、Flip Words 字级、Layout Text Flip |
| `easeInOut`（cubic-bezier 0.42, 0, 0.58, 1） | `power2InOut` | 近似：中点对称、端点零速一致，中段曲率不同 |
| `easeOut`（Apple Cards 入场） | `power2Out` | 近似 |
| `spring(stiffness, damping)`（260/15、260/10、200/20） | 单段 backOut 速度曲线（Scale/位移轨） | 只保留**一次过冲**，无二次振荡；过冲幅度由 AE 缓动解释决定，未逐帧标定 |
| `spring(100, 10)` / `spring(150, 12)`（Flip Words 外壳 / Dock 磁放大） | 不打包 | 指针/交互态，不进入库 |

### 6.2 量纲与结构约束

- **CSS blur ≠ AE 文字动画器 Blur**：AE 侧是 `ADBE Text Blur` 的标定值（`style=blur` 24、`riseBlur` 10、`zoomIn` 12、`focus` 14），与 CSS `filter: blur(Npx)` 不是 1:1；跨字号/跨分辨率时观感会漂移，必要时应用后覆写。
- **弹簧只保留单段**：所有 `spring(...)` 都是"起 → 终"一次过冲近似，没有二次振荡；需要更强回弹时升为 3 键（如 0 → 110% → 100%），而不是加采样。
- **逐字 3D 不可达**：AE 文字动画器只有 2D Rotation，没有逐字 `rotateX/rotateY`，所以 Modal 的 `rotateX 40`、Images Slider 的 `rotateX 45` 都不进文字预设。
- **布局弹簧不进关键帧**：`layout` / `layoutId` 的共享布局过渡（Tabs、Apple Cards、Card Stack）依赖 DOM 尺寸计算，AE 内只能用预合成错峰位移近似。

### 6.3 两种产物与交付建议

| 产物 | 依赖 | 导出友好度 | 使用建议 |
|---|---|---|---|
| `preset-ac-*`（文字预设） | AE 原生文字动画器 + **1 条 Amount 表达式** | AE 内可编辑可逆；**带表达式，不适合 Web/Lottie 直出** | 仅 AE／视频输出；Web 交付前按 SKILL.md 的"无表达式残留"门禁处理，或改拆层关键帧 |
| `ac-*`（内容片段） | 纯 2D Transform／Opacity，每轨 2 键，AE speed/influence | Web/Lottie 友好 | 默认推荐；应用后用 `position_anchor: "end"` 保证终帧落位与设计稿一致 |

### 6.4 命名与标签约定

- 预设 id 前缀 `preset-ac-`；片段 `slug` 前缀 `ac-`（`id` 为 UUID，勿混用）。
- `sourceStyle = "Aceternity"`；`tags` 首项固定 `"Aceternity"`，其后是中文语义标签（`文字/入场/模糊/整词`、`组合/入场/弹窗/弹性` 等）。
- 面板展示用中文 `name`（`AC 文字逐词生成`、`AC 弹窗弹性入场`），`description` 里保留来源组件英文名与近似说明，便于溯源。

### 6.5 已知风险

1. `preset-ac-flip-words` 的方向与源码相反（4.4 第 3 条），未修正前会看到"自上落下"而非"自下升起"。
2. `preset-ac-text-generate` / `preset-ac-container-flip` 的 AE 模糊是 24 而非源码 10px，重字号差异大时观感偏差明显。
3. `ac-modal-pop` / `ac-tooltip-pop` 的过冲依赖单段速度曲线；AE 版本/解释器不同可能出现"看不到过冲"，需按接触表决定是否升 3 键。
4. `preset-ac-*` 的 Amount 表达式是 AE-only 依赖；任何 Web/Lottie 交付都必须先剥离表达式，否则导出器行为不可依赖。
5. Infinite Moving Cards 的 keyframes 在 Tailwind 主题层、不在组件源码内；若上游改主题（如 `--animate-scroll` 默认 40s），本地记录的 20/40/80s 需同步复核。

---

## 附：源码索引

> registry 端点前缀 `https://ui.aceternity.com`，本地快照根目录 `artifacts/aceternity-src/`；未注明的组件源码与 `<component>.json` 同名。

| 组件 | 本地快照 | registry 端点 |
|---|---|---|
| Text Generate Effect | `text-generate-effect.json` | `/registry/text-generate-effect.json` |
| Flip Words | `flip-words.json` | `/registry/flip-words.json` |
| Typewriter Effect | `typewriter-effect.json` | `/registry/typewriter-effect.json` |
| Container Text Flip | `container-text-flip.json` | `/registry/container-text-flip.json` |
| Layout Text Flip | `layout-text-flip.json` | `/registry/layout-text-flip.json` |
| Animated Modal | `animated-modal.json` | `/registry/animated-modal.json` |
| Animated Tooltip | `animated-tooltip.json` | `/registry/animated-tooltip.json` |
| Animated Testimonials | `animated-testimonials.json` | `/registry/animated-testimonials.json` |
| Tooltip Card | `tooltip-card.json` | `/registry/tooltip-card.json` |
| Animated Tabs | `tabs.json` | `/registry/tabs.json` |
| Card Stack | `card-stack.json` | `/registry/card-stack.json` |
| Carousel | `carousel.json` | `/registry/carousel.json` |
| Apple Cards Carousel | `apple-cards-carousel.json`（含 `hooks/use-outside-click.tsx`） | `/registry/apple-cards-carousel.json` |
| Images Slider | `images-slider.json` | `/registry/images-slider.json` |
| Infinite Moving Cards | `infinite-moving-cards.json` | `/registry/infinite-moving-cards.json` |
| Loader | `loader.json` | `/registry/loader.json` |
| Multi Step Loader | `multi-step-loader.json` | `/registry/multi-step-loader.json` |
| Stateful Button | `stateful-button.json` | `/registry/stateful-button.json` |
| Moving Border | `moving-border.json` | `/registry/moving-border.json` |
| Container Scroll Animation | `container-scroll-animation.json` | `/registry/container-scroll-animation.json` |
| Macbook Scroll | `macbook-scroll.json` | `/registry/macbook-scroll.json` |
| Hero Parallax | `hero-parallax.json` | `/registry/hero-parallax.json` |
| Parallax Scroll | `parallax-scroll.json` | `/registry/parallax-scroll.json` |
| Sticky Scroll Reveal | `sticky-scroll-reveal.json` | `/registry/sticky-scroll-reveal.json` |
| Tracing Beam | `tracing-beam.json` | `/registry/tracing-beam.json` |
| Hero Highlight | `hero-highlight.json` | `/registry/hero-highlight.json` |
| Pointer Highlight | `pointer-highlight.json` | `/registry/pointer-highlight.json` |
| Sparkles | `sparkles.json` | `/registry/sparkles.json` |
| Meteors | `meteors.json` | `/registry/meteors.json` |
| Shooting Stars | `shooting-stars.json` | `/registry/shooting-stars.json` |
| Glowing Stars | `glowing-stars.json` | `/registry/glowing-stars.json` |
| 3D Card | `3d-card.json` | `/registry/3d-card.json` |
| 3D Pin | `3d-pin.json` | `/registry/3d-pin.json` |
| 3D Marquee | `3d-marquee.json` | `/registry/3d-marquee.json` |
| Wobble Card | `wobble-card.json` | `/registry/wobble-card.json` |
| Glare Card | `glare-card.json` | `/registry/glare-card.json` |
| Vortex | `vortex.json` | `/registry/vortex.json` |
| Aurora Background | `aurora-background.json` | `/registry/aurora-background.json` |
| Spotlight | `spotlight.json` | `/registry/spotlight.json` |
| Lamp | `lamp.json` | `/registry/lamp.json` |
| Google Gemini Effect | `google-gemini-effect.json` | `/registry/google-gemini-effect.json` |
| SVG Mask Effect | `svg-mask-effect.json` | `/registry/svg-mask-effect.json` |
| Canvas Reveal Effect | `canvas-reveal-effect.json` | `/registry/canvas-reveal-effect.json` |
| Card Spotlight | `card-spotlight.json`（引用 `canvas-reveal-effect`） | `/registry/card-spotlight.json` |
| Globe | `globe.json` | `/registry/globe.json` |
| Lens | `lens.json` | `/registry/lens.json` |
| Compare | `compare.json`（引用 `sparkles`） | `/registry/compare.json` |
| Pixelated Canvas | `pixelated-canvas.json` | `/registry/pixelated-canvas.json` |
| Webcam Pixel Grid | `webcam-pixel-grid.json` | `/registry/webcam-pixel-grid.json` |
| Dither Shader | `dither-shader.json` | `/registry/dither-shader.json` |
| Encrypted Text | `encrypted-text.json` | `/registry/encrypted-text.json` |
| Colourful Text | `colourful-text.json` | `/registry/colourful-text.json` |
| Text Reveal Card | `text-reveal-card.json` | `/registry/text-reveal-card.json` |
| Text Hover Effect | `text-hover-effect.json` | `/registry/text-hover-effect.json` |

F2A 侧引用：`motion-library/builtin.json`（`presets[]`、`clips[]`）、`scripts/extract-motion-library.py`（`procedural_presets()`、`aceternity_clips()`）、`host/motion/aeMotionPresets.jsx`（`C.text_reveal`、`REVEAL_CURVES`）。
