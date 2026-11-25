# video-shotcraft 动效词汇与 F2A 映射参考

> 内部参考：记录 video-shotcraft（Claude Code / Codex 技能）镜头配方库的盘点、逐帧参数提取、已落地到 F2A 内置动效库的条目，以及相机 / 文字 / 编排 / 数据 / 节奏各条线的 AE 复刻配方。
> 分析日期：**2026-11-24**。分析对象：GitHub `Vincentwei1021/video-shotcraft`（`main` 快照）。源快照：`D:\Tools\F2A\artifacts\video-shotcraft-src\video-shotcraft-main\`。
> 帧率约定：配方卡与 demo 的时间表全部是 **30fps**，下文写作 `22f@30`；F2A 侧时长以秒记，换 60fps 时帧值 ×2、秒值不变（见 6.3）。所有数值照录卡片与 demo 源码，不用印象值。

---

## 1. 概述

video-shotcraft 是一个「用真实页面 + Remotion 做电影感产品宣传片」的 agent skill：Claude Code / Codex 读取产品项目或网址，用无头浏览器采集真实页面（2x 纹理、元素级抠图、layout.json 坐标），从镜头配方卡里挑动效，编排分镜、卡 BGM 拍点、配 Freesound 音效，逐帧自检后交付 MP4 / Remotion 工程 / 剪映工程，并把成片导入浏览器版 **Motion Workbench**（镜头、转场、字幕、音效多轨可视化再编辑；预览与渲染逐帧一致）。

- **规模**：公开库 **124 张镜头配方卡 / 150 条动态样片（Gallery）**，分 **10 个功能类**（`references/shots/<category>/<card>.md`）；每张卡的 Remotion 参考实现在 `demos/<category>/<card>/`。README 的 2026-10 更新说明：216 条 demo 精修后收敛为「124 cards / 150 shots」。
- **卡片结构**：frontmatter（一句话 / 适用 / 时长 / 能量 / 标签）+ 意图 + 动效核心 + 参数表 + 已知坑 + 参考实现。参数表给帧值、缓动曲线、像素、错峰；SKILL.md 明确「配方卡是语义与参数表，demo 源码才是调校过的参数真相」。
- **共享件**：缓动/质感件 `demos/_fixtures/Polish.tsx`（`EASE` 缓动表、`ramp`、方向性运动模糊 `SpeedBlur`、`Grain`/`Vignette`/`Backdrop`）、`demos/_fixtures/Motion.tsx`（`E` 缓动表、`seg`/`lerp`/`rand`/`DesignStage`）；可复制组件在 `assets/lib/`（2.5D 页面相机 `PageCam`、`ClipCard`、`DigitRoll`、`FlashCut`、`VerticalTicker`、`Caption`、`FlatPanel`）。
- **声音与节奏**：`references/music-beat-sync.md` 用 librosa 网格拟合求真实 BPM/相位 + kick/snare/hihat 分类，切点误差 ≤3f；`references/sound-design.md` / `sfx-sourcing.md` 走 Freesound 选材并记录许可。
- **本次用途**：把它的镜头语汇**蒸馏成 F2A 的 AE 动效词汇**——能直接进关键帧/文字动画器的（第 3、4 节），只能按配方手搓的（第 5 节），以及不该进 AE 关键帧体系的（第 2.2 节第三桶）。

### 1.1 分析资产

| 资产 | 路径（相对快照根） | 说明 |
|---|---|---|
| 镜头卡 | `references/shots/<category>/*.md` | 124 张，UTF-8 中文；本次全文精读 13 张、抽读参数表 11 张，其余按 frontmatter 与参数表盘点 |
| 卡来源说明 | `references/shots/ATTRIBUTION.md` | 手法研究自公开产品片与开源项目，全部从零重写；2026-08 批新增 48 张，2026-10 精简后现存 38 张 |
| 参考实现 | `demos/<category>/<card>/*.tsx` | 125 个 demo 目录（与 124 卡非严格 1:1，见 2.1 注） |
| 缓动/质感 | `demos/_fixtures/Polish.tsx`、`demos/_fixtures/Motion.tsx` | `EASE`/`E` 两套缓动表、`ramp` 分段进度原语 |
| 2.5D 相机 | `assets/lib/PageCam.tsx`、`assets/lib/helpers/camera.tsx` | 页面相机关键帧（cx/cy/zoom/rotX/rotY/persp）+ three 相机 Rig + 手持噪声 |
| 转场/数字 | `assets/lib/FlashCut.tsx`、`DigitRoll.tsx`、`ClipCard.tsx` | 模板片同源组件：暖白闪、里程表数字列、视频素材卡片 |
| 技能入口 | `SKILL.md`、`README.md`、`references/pipeline.md` | 工作流、能力边界、许可与致谢 |

### 1.2 取样范围与许可

- 本次全文精读 13 张：`typography/blur-slide`、`camera/crash-zoom-punch`、`effects/impact-feedback`、`transition/white-flash-logo-simplify-cut`、`typography/type-entrance-moves`、`typography/lead-word-zoom-assemble`、`typography/document-typewriter-reveal`、`opening/crane-rise-reveal`、`camera/steep-tilt-glide`、`data/gauge-readout-moves`、`rhythm/beat-cut-moves`、`ui-entrance/card-stack`、`transition/page-turn-transitions`；另抽读 11 张的 frontmatter 与参数表（`typewriter-moves`、`outline-word-fill`、`marker-underline-title`、`flying-words`、`glitch-cycle`、`vertical-word-roll-blur-cycle`、`row-embed`、`deck-deal-flyin`、`list-reveal`、`panel-grid-moves`、`spotlight-sweep-moves`）。其余卡片只做分类与用途盘点，不臆测未读参数。
- **许可**：代码与文档 **Apache-2.0**（`LICENSE`，版权行 `Copyright 2026 Wei Yihao`）；卡片注明手法研究自公开产品片与开源项目、实现从零重写、无原片素材（`references/shots/ATTRIBUTION.md`）。
- **音频**：Freesound 素材各自按记录许可（默认 CC0，作者允许署名时可选 CC BY），须保留来源清单与 CC BY 署名；BGM 见 `assets/audio/ATTRIBUTION.md`。
- **Remotion** 有独立许可：个人与小团队免费，公司可能需要付费。
- 本文对卡片/代码的引用属技术性引用，参数照录；F2A 侧条目与脚本实现为独立重写。署名与来源索引见文末附录。

---

## 2. 全站盘点

### 2.1 十类镜头卡计数

| 分类 | 卡数 | 意图（一句话） | 代表卡 |
|---|---:|---|---|
| camera 相机 | 10 | 同一场景内的机位运动：急推、升降、俯冲、贴面、3D 场景 | `crash-zoom-punch`、`steep-tilt-glide`、`graze-face-tour`、`terminal-3d` |
| data 数据 | 5 | 让数值/图表自己运动：表盘自检、滚带、时间旅行、前后对比 | `gauge-readout-moves`、`chart-live-moves`、`scroll-brake-moves` |
| effects 效果 | 15 | 元素级打击感与光效：命中反馈、扫描线、HUD、聚光、Slam | `impact-feedback`、`spotlight-sweep-moves`、`scanline-annotate-focus` |
| interaction 交互 | 11 | 指针/输入驱动的 UI 演示：光标、磁吸、语音波形、选择态 | `collab-cursor-moves`、`type-and-filter`、`voice-waveform-live` |
| opening 开场 | 11 | 定场与首屏揭示：从细节到全局、品牌墨开场、环绕标题 | `crane-rise-reveal`、`orbit-ring-title-open`、`fracture` |
| outro 收尾 | 6 | 落版与退场：字标收缩锁版、UI 拆条退场、颗粒溶解 | `logo-shrink-wordmark-lockup`、`ui-strip-away-outro` |
| rhythm 节奏 | 8 | 多镜/多元素的节拍结构：硬切连闪、分格、四宫格、变速冻结 | `beat-cut-moves`、`panel-grid-moves`、`speed-ramp-freeze` |
| transition 转场 | 15 | 场景之间的交接：擦除、翻页、白闪、镜头移动、隐藏剪辑 | `white-flash-logo-simplify-cut`、`page-turn-transitions`、`wipe-transitions` |
| typography 文字 | 22 | 文字本体的运动：逐词模糊、坠落、打字、乱码、描边填充 | `blur-slide`、`type-entrance-moves`、`outline-word-fill` |
| ui-entrance UI 入场 | 21 | 一组 UI 元素/卡片的整体编排：堆叠、发牌、逐行嵌入、瀑布 | `card-stack`、`deck-deal-flyin`、`row-embed`、`list-reveal` |
| **合计** | **124** | — | — |

注：demo 目录 125 个，与卡片并非严格 1:1——`demos/ui-entrance/` 多出 `clipcard-looping` 与 `document-typewriter-reveal`（后者卡片在 `typography/`），`demos/opening/` 缺 `brand-ink-open`。同理，`crane-rise-reveal` 卡片实际在 `opening/`（frontmatter 标签 camera、data），引用时以 `opening/crane-rise-reveal.md` 为准。

### 2.2 三分桶（可移植性判定）

判定标准是「能否在 AE 里用 2D 变换 / 透明度 / 原生文字动画器 + 有限关键帧重建」，而不是效果是否好看。F2A 只把第一桶里最通用、最能参数化的三条打包发货（第 4 节），其余给配方。

| 桶 | 判定标准 | 代表卡 | 一句话理由 | F2A 处理 |
|---|---|---|---|---|
| **可直接／近似移植** | 有限时长的 2D transform / opacity / 文字动画器，起止值固定 | `typography/blur-slide`、`typewriter-moves`、`document-typewriter-reveal`、`marker-underline-title`、`outline-word-fill`；`camera/crash-zoom-punch`（缩放段）；`transition/wipe-transitions`、`page-turn-transitions`、`white-flash-logo-simplify-cut`（纯色块/面板可近似）；`effects/impact-feedback`（震屏段）；`rhythm/beat-cut-moves` 的硬切；`ui-entrance` 里 2–3 键的简单入场 | 本体是一次性 2D 变换、透明度或逐字属性，能翻译成 2–3 个关键帧或一条文字动画器 | 已落地 3 条（4.2），其余进 5 节配方 |
| **仅部分可移植** | 需要多层预合成、遮罩、3D 层、逐元素编排、预渲染素材才能接近 | 卡牌堆叠/发牌（`card-stack`、`deck-deal-flyin`）、多元素 stagger（`list-reveal`、`row-embed`、`panel-grid-moves`）、2.5D 相机（`crane-rise-reveal`、`steep-tilt-glide`、`graze-face-tour`、`overhead-camera-moves`）、数字滚动/图表（data 卡）、遮罩/高亮/扫描线/负片冲击帧、spotlight 灯光层、SVG 描画、跨镜头运镜（transition 卡） | 核心观感依赖层叠、遮罩跟随、透视角或逐元素时间表；单段关键帧只能还原骨架 | 给 AE 复刻配方（5.1–5.6），不进默认库 |
| **不可移植** | 3D 场景、WebGL/Canvas/物理粒子、指针交互、滚动驱动、音频/剪辑结构 | `terminal-3d`、`basic-3d-scene`、`3d-cards-tornado` 类、`cursor-flyover`、`magnetic`、`scroll-brake-moves`、`sticky`、`horizontal` 滚动段；beat sync / 剪辑结构本身 | 每帧由程序/输入/滚动行程驱动，无有限关键帧表达；或时长本身由音乐/滚动决定 | 不进入动效库；需要时预渲染素材或只取静态终帧 |

经验分布：typography / transition 里可近似的比例最高；camera 与 effects 多为「运动骨架可移植、材质与镜头感不可移植」；interaction 与 rhythm 的两头分别是交互与剪辑结构，基本不进 AE 关键帧体系。

---

## 3. 核心动效参数（帧@30fps）

### 3.1 typography/blur-slide（已落地）

卡片：`references/shots/typography/blur-slide.md`；实现：`demos/typography/blur-slide/BlurSlide.tsx`（`BLUR_SLIDE_DURATION = 120f`，4.0s）。

核心是**一条进度驱动三个通道**：单词进度 `p = ramp(frame, start, dur, EASE.out)`，然后 `opacity = p`、`translateY = (1−p)·dy`、`blur = (1−p)·B`。三通道若各写一条曲线（哪怕同公式），就会出现「位移到了但还糊着」的错位。

| 参数 | 主标题 | 副标题 | 说明 |
|---|---|---|---|
| 文案/字号 | 5 词 / 170px 衬线 400 | 9 词 / 46px 无衬线 400 | 主副字号差 3.7 倍；层级差靠**幅度**不靠时长 |
| 起止 | 第一行 10f 起、3 词；第二行停 6f 换气，`feel` 26f、主角词 `cinematic.` 30f 起 | 34f 起、9 词 | 主标题 60f 收完、副标题 80f 收完，重叠 26f 读作「一句话」 |
| 单词窗口 | 22f（主角词 30f） | 20f | 22f@30 = 0.733s；<10f 读作硬弹，>30f 整句拖沓 |
| 词间 stagger | 4f（主角词前无额外间隔） | 2.4f | 4f@30 = 0.133s；3–4f 是「逐词」甜点 |
| 位移 dy | 64px（≈0.38em） | 26px | 自下而上（CSS `translateY(+dy)→0`） |
| 模糊 B | 18px | 9px | 超过字号 ~12% 中间帧糊成色块 |
| 缓动 | `EASE.out` | 同左 | `cubic-bezier(0.22, 1, 0.36, 1)`，注释标「≈ quint-out」；`ramp` 在 `demos/_fixtures/Polish.tsx` |
| 其他 | 主角词字距随 p 从 0.03em 收到 −0.025em；整组 0–119f 推近 1→1.03（smooth） | 后景刊号 blur 24→0、慢漂 | — |

F2A 对应：`preset-sc-blur-slide` / `kind: procedural` / `command: text_reveal`，`style=riseBlur`、`by=words`、`direction=up`、`duration=0.7333`（22f@30）、`stagger=0.1333`（4f@30）、`distance=64`、`ease=power5Out`，`supports={duration,textBy}`（锁曲线，面板全局曲线不覆盖）。AE 文字动画器的 Blur 固定 10（源码 18px 是 CSS 量纲，见 6.1）；副标题一档（20f / 2.4f / 26px / 9px）未打包，需要时二次应用 `duration≈0.667`、`stagger≈0.08`、`distance=26`。

### 3.2 camera/crash-zoom-punch（回弹款 + 撞停款）

卡片：`references/shots/camera/crash-zoom-punch.md`；实现：`demos/camera/crash-zoom-punch/CrashZoomReal.tsx`（回弹款，132f）、`CrashImpactReal.tsx`（撞停款）。

| 阶段 | 源参数（帧@30fps） | 备注 |
|---|---|---|
| 全景 hold | 0–34f：zoom 0.70→0.72（smooth）、后仰 13°→11° | 机位「活着但不晃」 |
| 预备回拉 | 34–40f：zoom 回退 ~4%、后仰 +1.5°，角标外扩一呼吸 | 卡片写「急推前 6–8f 预备回拉 3–4%」 |
| 急推 | 40–46f（**6f**）：log 空间 0.69→2.48，`EASE.exit`（强 ease-in），后仰同曲线归零，目标卡中心单调收向画面中心 | 卡片参数表：急推 6f（4–8f）、目标 zoom 2.4–2.8 |
| 回弹 | 46–58f（12f）：`REST + (PEAK−REST)·e^(−t/2.2)·cos(πt/5.2)`，PEAK 2.48 / REST 2.34（**5.6%**） | 卡片写「过冲后 5f 回收 3–6%」；demo 用阻尼余弦铺到 12f |
| 到位 | 暖色曝光闪，指数衰减 ~8f；周边压暗 86% + 目标卡轮廓光 | — |
| 运动模糊 | 只包急推段：自写时间采样，快门 ≈200°，子帧 `opacity 1/(i+1)` 等权叠加，子帧数按本帧位移自适应（上限 40）；小字回波间距 ≤6px、上限 44 层 | `<CameraMotionBlur>` 也可但近静止帧发灰 |
| 撞停款 | 6f 预备回拉 0.985 → 6f ease-in(cubic) 到 2.25x；到位帧 1f 荧光 → 1f 余辉 → 近黑冲击帧；震屏 14px·e^(−t/1.8)、6f 收干 | 与回弹款不混用 |

F2A 对应：`sc-crash-zoom` / `kind: clip`，Scale 100→240（0.2s = 6f@30，ease-in）→228（0.7s，回弹 −5%），`defaultAnchor: start`、`category=缩放`、`phase=in`；**不含**运动模糊、位置收敛与震屏（见 6.7）。

### 3.3 effects/impact-feedback（命中反馈两式）

卡片：`references/shots/effects/impact-feedback.md`；实现：`demos/effects/impact-feedback/HitCounter.tsx`、`AnimeImpact.tsx`。

| 式 | 参数（帧@30fps） |
|---|---|
| B hit-counter 连招计数 | 三卡动画时间 30/58/86f（间隔 28f），命中前 10f ease-in(quad) 砸落；每次命中**全局顿帧 2f**（背景滚动一起冻）；伤害数字 scale 1.45→1 + 上浮 150px 出卡沿，落定 4f 后 12f 渐隐，字号 88/104/124px；计数器脉冲峰值 1.3/1.45/1.6、rotate −2/−4/−6°、字号 140/166/196px，`exp(−t/2.4)` 回落；三格热度条逐格点亮 |
| C anime-impact 打击帧 | 先 6f 预备回拉到 0.985，再 crash-zoom 6f ease-in(cubic) 推到 2.25x；撞停起 **3f**：`invert(1) grayscale(1) contrast(1.45)` + 34 粗楔 + 22 细针集中线 + 红/青负片副本 screen 叠加 ±8px 错位；**第 4f 全撤**；第 4f 起震屏 `6px·e^(−t/2.2)`（≈12f 收干） |

F2A 不打包这两式（负片帧需要预渲染、顿帧需要帧重映射），只给配方（5.5）。

### 3.4 transition/white-flash-logo-simplify-cut（白闪转场来源）

卡片：`references/shots/transition/white-flash-logo-simplify-cut.md`；实现：`demos/transition/white-flash-logo-simplify-cut/WhiteFlashLogoSimplifyCut.tsx`（120f）。

| 时间（30fps） | 动作 | 参数 |
|---|---|---|
| 0–34f | 液态金属词标演出 | 虹彩 300% 背景每帧 1.1% 缓流；整幅推近 1→1.035（smooth）；190px 700 字重 |
| 34–46f | 蓄力 | brightness 1→1.7、bloom 加强、横向眩光拉开（`EASE.exit` 越来越快） |
| 44–50f | 冲白 | 径向白团从字心撑满全屏，半径 80→1580px，`t²` ease-in（后 3 帧吞掉字标） |
| 50–54f | 纯白 hold（换场帧） | 白层 opacity 1；换场必须发生在 50f |
| 54–76f | 曝光回落 | 白层 1→0，**quint-out**（先快后慢，像眼睛适应强光） |
| 52–78f | 扁平字标对焦 | scale 1.03→1（snappy），不淡入 |
| 96–120f | hold | 极缓前推 1→1.01 |

F2A 对应：`preset-trans-flash` / `kind: procedural` / `command: transition`，`type=flash`、`duration=0.9`、`color=[0.97,0.97,0.97]`，`supports={duration}`。实现（`host/motion/aeMotionPresets.jsx` 的 `C.transition`）：全屏色块 `scale 5%→130%`，在开始后 `min(d/2, 0.2s)` 内炸开（0.9s 档即 0.2s = 6f@30），opacity 100 保持到切点，再在切点后 0.45s（13.5f@30）内以 AE 贝塞尔缓动（influence 60）回落。相对源码：炸开 6f 对齐、纯白 hold 由 4f 拉到 ~7.5f、回落由 22f 缩到 13.5f，且**只做色块覆盖、不做字标降维**（6.5）。

### 3.5 其他代表卡参数表（8 张）

| 卡片 | 关键参数（帧@30fps） | 观感/用途 |
|---|---|---|
| `typography/type-entrance-moves` | 字符坠落：第 i 字起跳帧 `4 + 36·(1 − (1 − i/(n−1))^1.5)`（首末字固定 4f/40f，9 字符时间隔 6.5→1.6f）；`y = −DROP + DROP·(t/24)²` 重力加速 → 30% 抛物线弹跳 → 9% 二跳；落地 rotate 到 seed hash ±6° 保持；落定后（如 110f）**6f ease-out 集体 rotate→0 + scale 1.06→1**；动作段 ~116f | 轻松调性标题破冰；三跳以上读作果冻 |
| `typography/lead-word-zoom-assemble` | 首词 2.3x、hold 12f 继续推 6%（`cubic-bezier(.25,1,.5,1)`）；缩回 12f 与整行左滑 24f 共用 `cubic-bezier(.5,0,.05,1)`；后续词延迟 6f、错峰 4f、推入 12f（0.5em→0，`cubic-bezier(.22,.8,.36,1)`）、淡入仅 2f；f32–46 整行上移 −56px（outCubic）＋副行同窗；静止 26f；末 12f scale→1.2 + blur→9px 交棒 | 品牌名 / Introducing 字卡 |
| `ui-entrance/card-stack` | 9 张 320×440；起跳 `2 + stagger(i, 9, 40f, EASE.out)`；每张 `spring(damping 13, stiffness 150)`，y 820→0，≈20f 落座；飞行 ±9° 交替倾角；落座整摞下压 5px（sin 9f）；扇形 `spring(damping 20, stiffness 95)`，`k=i−4`、`rot=k·6.5°`、`tx=k·138px`、`tz=i·2`、perspective 1800、`transform-origin: 50% 130%`；相机 1→1.06 后拉远 0.88；中心卡抽出 72px overshoot | 一组物 → 一个个体；先整体后个体 |
| `opening/crane-rise-reveal` | 起点缩放 3.0 对准追踪行、hold 24f；拉升 **102f**、`bezier(0.2,0,0.25,1)`、scale 3.0→1.0；`transform-origin` 左上，`translate = 屏幕中心 − 对准点×scale`；非追踪行压到 38%，起吊后 26f 回满；逐行洗光越线触发 ~24f；总 165f | 从一行数据到整面 dashboard |
| `camera/steep-tilt-glide` | 镜头常数：perspective 1100、origin 30% 58%、`rotateY(−60°)` + `rotateZ(−2°)`、transformOrigin left top；页面 6200×2400 沿局部 X `+60→−4100`，`bezier(0.3,0.12,0.72,0.9)`；速度重影 f−1.6 / −3.2 / −4.8 三层；起始压暗 0.7，~1.4s 揭亮 | 物动镜不动的「侧掠」炫技 |
| `data/gauge-readout-moves` | A 满弧扫针：270° 去程 12f ease-out、24f 内回落、~8° 弹簧过冲、三表错峰 4f；B 滚带定针：刻度带 5px/单位、冲刺 22f、峰值 ~100px/f、spring 刹车过冲，停位后 ≥30f 锁死 | dashboard 开机 / 单指标大跳变 |
| `rhythm/beat-cut-moves` | 三闪切点 30/52/70f（间隔 22→18f 渐紧）；白闪层 opacity 0.95→0 走 4f ease-out、±2px seed 抖动；切入视图 scale 1.03→1 走 6f + −16px 沉降；三裁切 CSS zoom 1.0 / 1.6 / 2.8；末段 hold 70f | 硬切当鼓点；全片 ≤1 次 |
| `typography/document-typewriter-reveal` | 20 块两两一对，第 g 对 cue `8 + g·4.4`、每块 wipe 9f（`bezier(0.4,0,0.6,1)`）；caret 3px 只跟最新块；双栏 cue 54/62；6 条历史条目 cue `66 + i·5`、每条 9f、起点 −48px、`bezier(0.2,1.15,0.3,1)`；相机 Hermite 样条逐帧展开（f0 zoom 1.42/rotY −18°/rotX 8° → f26 1.24 → f64 0.86 → f104 0.74） | 文档类功能镜头「正在被写出来」 |

### 3.6 共性规律（跨卡总结）

| 规律 | 观察（帧@30fps） | 对 F2A 的含义 |
|---|---|---|
| 动作窗口 | 单卡动作段普遍 6–40f（急推 6f、单卡飞行 12f、单字坠落 ~24f）；整镜 84–180f | 预设 `duration` 只覆盖动作段，落定 hold 留给时间线 |
| 错峰 | 文字 4f/词、副标题 2.4f/词；列表 10f/条；发牌间隔递减（先慢后快） | 总时长随元素数线性增长，超 8 词或 10 条要压间隔 |
| 缓动 | 入场一律 ease-out 族（`EASE.out` / `snappy` / outQuint），甩出与退场用 ease-in；只有物理/弹簧用阻尼余弦或 spring | F2A 的闭式 `power3Out` / `power5Out` / `expoOut` 足够覆盖，不需要引入新曲线 |
| 幅度分层 | 主副层级靠位移/模糊/字号倍数（64 vs 26、18 vs 9），不靠时长差 | 调层级先改 distance/blur，别先拉长时间 |
| 冲击一次 | 急推 ≤2 次/片、负片帧 1 次/片、连闪 1 次/片；冲击后必须给 ≥30f hold | 库条目只提供单次动作，不封装循环 |
| 收尾呼吸 | 落定后静止 20–30f，只留 <2% 的极缓推近 | 预设不自动加 hold；终帧落位靠接触表核对 |

---

## 4. F2A 映射表（已落地）

### 4.1 命名与机制

- **文字预设**：`kind: procedural`、`command: text_reveal`，id `preset-sc-*`，存于 `motion-library/builtin.json` 的 `presets[]`；生成源 `scripts/extract-motion-library.py` 的 `procedural_presets()`。机制沿用 `host/motion/aeMotionPresets.jsx` 的 `C.text_reveal`：一个 AE 原生文字动画器（Position 3D / Opacity，riseBlur 再加 Blur）＋ 一个 Expressible Selector，用**一条** Amount 表达式按 `textIndex`/`textTotal` 算错峰，没有逐字关键帧。
- **转场预设**：同文件 `presets[]`，`command: transition`，id `preset-trans-*`；机制是 `C.transition` 新建一个全屏形状层（色块），用关键帧控制在切点覆盖画面。
- **内容片段**：`kind: clip`（`clips[]`），`slug` 为 `sc-*`；每条 track 约 2–3 键，缓动写成 AE 的 speed/influence 时间缓动，**无表达式**，可进 Web/Lottie 链路。
- **归属标记**：三件都带 `sourceStyle: "VideoShotcraft"` 与 `VideoShotcraft` 标签，便于与 RB/AC/AU/OS 包区分。

### 4.2 引擎新增（本轮）

| 能力 | 实现位置 | 说明 |
|---|---|---|
| 文字缓动 `power5Out` | `host/motion/aeMotionPresets.jsx` 的 `REVEAL_CURVES`：闭式 `1-Math.pow(1-u,5)`；`mcp/src/ae-motion-tools.ts` 的 `textEase` 枚举；`client/motionPreview.js` 的 `EASE_CURVES` 映射 `[0.22, 1, 0.36, 1]` | 与源码 `EASE.out` 同一设计意图；AE 端用闭式 quint、面板预览用同形状贝塞尔，二者视觉一致（数值差异见 6.2） |
| 转场类型 `flash` | `C.transition` 新增分支；MCP `transition.type` 枚举；`client/motionPreview.js` 返回 `transType: flash`；`client/motionPanel.js` 的 `flashBar` 预览 | 全屏色块从中心 5%→130% 快速炸开、切点处覆盖全屏，随后 quint-out 式回落；不是双场景转场 |

补充核实：面板的**全局「曲线」下拉**（`client/index.html` 的 `f2m-p-style`）仍只列 snappy/smooth/spring/bounce/linear 五项，并没有加 `power5Out`；`preset-sc-blur-slide` 的 `supports` 不含 `style`，所以面板不会用全局曲线覆盖它，预设锁定的 `power5Out` 生效。因此「面板的 text_reveal ease 枚举已加」这句话只对**预览层曲线表与 MCP schema** 成立，不要理解为面板下拉新增了选项。

### 4.3 条目映射表

| video-shotcraft 来源 | 源码参数（帧@30） | F2A 条目 id / kind | F2A 参数 | 差异 / 说明 |
|---|---|---|---|---|
| `typography/blur-slide`（卡片 + `BlurSlide.tsx`） | 主标 y 64px、blur 18px、op 0→1 共用 `EASE.out`；每词 22f、词间 4f；副标 26px / 9px / 20f / 2.4f | `preset-sc-blur-slide` / `procedural`（command: text_reveal） | style=riseBlur；by=words；phase=in；direction=up；0.7333s（22f）；stagger 0.1333（4f）；distance 64；ease=power5Out；supports={duration,textBy} | 逐词 + 三通道同进度已还原；AE Blur 固定 10、源码 18px 属量纲近似；副标题一档未打包；中文需先按语义切词（卡片已知坑） |
| `camera/crash-zoom-punch`（卡片 + `CrashZoomReal.tsx`） | 6f ease-in 推近（卡片 1→2.4–2.8，demo log 0.69→2.48）；回弹 3–6%（demo 2.48→2.34，12f 阻尼余弦）；预备回拉 3–4%；到位闪 8f；运动模糊只包急推段 | `sc-crash-zoom` / `kind: clip` | Scale 100→240（0.2s = 6f，ease-in；首键出向 speed 70、峰值键入向 speed≈1744.6，单位 %/s）→228（0.7s，回弹 −5%）；defaultAnchor=start；category=缩放；phase=in；duration 0.7 | F2A 回弹段 15f（0.2→0.7s）比 demo 12f 略长；无位置收敛、无运动模糊、无到位闪；start 锚点保存图层原比例（6.4） |
| `transition/white-flash-logo-simplify-cut`（卡片 + `WhiteFlashLogoSimplifyCut.tsx`） | 44–50f 径向撑满（t² ease-in，半径 80→1580px）、50–54f 纯白 hold、54–76f 白层 quint-out 回落、扁平字标 1.03→1 | `preset-trans-flash` / `procedural`（command: transition） | type=flash；duration=0.9；color=[0.97,0.97,0.97]（≈#F7F7F7）；supports={duration} | 炸开 6f 对齐；纯白 hold 由 4f 拉到 ~7.5f、回落由 22f 缩到 13.5f；只做全屏色块覆盖，不做径向渐变、不做字标降维 |

### 4.4 库总量与命名

- 当前 `motion-library/builtin.json`：**58 条 curated clips / 41 条 procedural presets**（2026-11-25 去重精简后；以该文件为准）。其中 video-shotcraft 贡献 **1 clip + 2 presets**，其余为既有 Minimal / ReactBits / Aceternity / AnimateUI / Osmo 等包。
- 命名分工：`preset-sc-*`（文字/转场预设）、`sc-*`（内容片段 slug）、`sourceStyle: VideoShotcraft`、标签含 `VideoShotcraft`。对照其他包：RB `preset-rb-*` / `rb-content-*`，AC `preset-ac-*`，AU `preset-au-*`，OS 三条转场 `preset-trans-fade / split / shutter` 与 `os-highlight-sweep`；通用转场是 `preset-trans-wipe / bars / iris / fade / split / shutter`，本轮新增的 `flash` 是其中一员。
- `sc-crash-zoom` 归在「缩放」类而非「入场」，因为它是镜头语言不是元素入场；`phase: in` 只表示作用在镜头开头。

### 4.5 应用示例

面板动效库直接选中上述卡片应用即可（预设的 `defaults` 就是 4.3 表里的参数）；等价 MCP 调用如下——MCP 不按预设 id 调用，而是传等价参数：

```text
# 1) 文字：SC 逐词模糊滑入（AE 文字动画器 + Expressible Selector；仅 AE 交付）
ae_text_reveal(layer_id=<文本层>, style="riseBlur", by="words", direction="up",
               duration=0.7333, stagger=0.1333, distance=64, ease="power5Out")

# 2) 转场：白闪过曝（time = 切点；色块在切点覆盖全屏）
ae_transition(comp_id=<合成>, time=2.4, type="flash", duration=0.9, color=[0.97, 0.97, 0.97])

# 3) 片段：SC 急推特写（先 ae_motion_list 查 sc-crash-zoom 的 clip_id）
ae_motion_apply(clip_id=<sc-crash-zoom 的 id>, layer_ids=[<目标预合成>],
                position_anchor="start", replace=false)
```

注意：`ae_motion_apply` 省略 `position_anchor` 时取片段自身的 `defaultAnchor`（`sc-crash-zoom` 为 `start`）；`replace` 只在确认要覆盖已有关键帧时开。

---

## 5. 配方清单（AE 复刻思路）

> 前提：遵循 F2A 制作红线——单元素必须独立预合成后再动；默认无表达式、无逐帧关键帧、每属性 ≤3 键。需要超过 3 键的（弹簧回弹、逐字轨迹）用预渲染或分段预合成解决。

### 5.1 相机

| 卡片 | AE 复刻思路（1–3 行） |
|---|---|
| `camera/crash-zoom-punch` | 目标图层/预合成上 Scale 2–3 键：100→240（6f，ease-in 强）→228（15f 回弹）；可加「方向模糊」或运动模糊开关，只覆盖急推段；起始位置可先在 6–8f 内反向回拉 3–4% 做预备。 |
| `camera/crane-rise-reveal` | 把整页 UI 预合成为一层，Scale 300%→100%（102f，对应 AE 缓动 ease-out 强曲线），Position 联动 `屏幕中心 − 对准点×scale` 用 2–3 键近似；`transform-origin` 钉左上；hold 段先推近 1.5% 再起飞。 |
| `camera/steep-tilt-glide` | 需要 3D：页面层开 3D、`rotateY −60°` + `rotateZ −2°`、相机/图层 perspective 1100、原点 30% 58%，页面沿局部 X 位移；AE 无原生 CSS perspective 等价物时，用预渲染好的透视页面序列最稳。 |
| `camera/graze-face-tour` / `overhead-camera-moves` / `terminal-3d` | 2.5D 可用 3D 图层 + 相机做（`rotateX/rotateY` 小角度 + 位置平移），大角度/强透视建议预渲染视频或序列帧，AE 内只做时间重映射与叠光。 |
| `camera/space-camera-moves` / `basic-3d-scene` | 不可移植（three.js 场景）。只能用预渲染素材 + 2D 叠化/推近近似。 |

### 5.2 文字

| 卡片 | AE 复刻思路（1–3 行） |
|---|---|
| `typography/type-entrance-moves`（字符坠落） | 逐字拆成独立文本层或逐字预合成，每字 3 键：高处 y、触地 y、弹起 y（30%/9% 衰减），Rotation 落点 ±6°，末段 6f 集体回正 + Scale 1.06→1；或整体预渲染后贴回。 |
| `typography/lead-word-zoom-assemble` | 首词单独预合成：Scale 230%→244%（hold 12f 推近）→100%（12f），Position 同曲线左滑归位（24f）；其余词各一层，0.5em 推入 12f、淡入 2f、错峰 4f；整行上移 56px 与副行同窗。 |
| `typography/type-assembly-moves` / `flying-words` | 元素从画外/纵深汇聚：每词 2–3 键位置 + 透明度，错峰用 `ae_stagger`；纵深飞行用 Scale 由大到小 + 模糊层遮罩，z 轴排序靠图层顺序近似。 |
| `typography/glitch-cycle` | 不可逐帧复刻随机乱码；AE 侧做 2–3 帧离散替换（预渲染 3 个乱码帧）+ RGB 分离（红/青副本 ±8px screen）+ 整行位移，仅视频交付。 |
| `typography/gradient-word-sweep` / `outline-word-fill` | 文字预合成 → 用移动的渐变色块/高光层做轨道遮罩；描边填充用「空心字层」与「实心字层」在指定帧硬切（不透明度开关），配一次 glow 脉冲。 |
| `typography/marker-underline-title` | 手绘下划线用形状层「修剪路径」8–12f 从左到右；笔形宽度用路径粗细关键帧，边缘毛糙靠效果（粗糙边缘/湍流置换）静态处理。 |
| `typography/vertical-word-roll-blur-cycle` | 词列预合成 + 矩形遮罩，位置 3 段累加（每段 0.55s，outQuint 为主）；上下相邻词按距离加模糊与灰度，落定词恢复强调色。 |
| `typography/document-typewriter-reveal` | 打字机效果用「擦拭」遮罩 9f/块（宽度 100%→0）+ 3px 光标色条跟随；块间 cue `8 + g·4.4f` 用 `ae_stagger` 或手动错开；侧栏条目 9f 落下、起点 −48px。 |

### 5.3 UI 入场／编排

| 卡片 | AE 复刻思路（1–3 行） |
|---|---|
| `ui-entrance/card-stack` | 每张卡独立预合成，入场 3 键 y 820→0 + ±9° 倾角（起跳 `2 + stagger`），落座下压 5px；展开用整组父级预合成做 `rot=k·6.5°`、`tx=k·138px`、`origin 50% 130%` 的 2–3 键扇开；顺序用 `ae_stagger`。 |
| `ui-entrance/deck-deal-flyin` | 26 张卡逐张预合成，出牌间隔递减（用 `ae_stagger` 后手动拉近后段）；单卡 3 键（牌堆位→弧顶→网格位）+ Scale/旋转；相机追牌用父级预合成的 Position/Scale 2–3 键。 |
| `ui-entrance/row-embed` | 行逐条从 −120px 落下 + `rotateX 16°→0`（3D 层或预渲染），scale 1.06→1 再 press 回弹；cue 12/22/31/39/46f 用 `ae_stagger`；落点底边强调色缝用形状层展开。 |
| `ui-entrance/list-reveal` | 6 项各 3 键：Scale 82→100、y 44→0、blur 8→0（模糊用预合成/效果关键帧），起跳 2+i·10f、窗口 24f；容器匀速上移单独一层。 |
| `rhythm/panel-grid-moves` | 多预合成：每格一个预合成 + 12° 斜缝形状遮罩；每 4f 一刀用错峰，末格 2f 回拉 + 14f 扫屏吃满；定格期靠各格内部小动作保活。 |

### 5.4 数据

| 卡片 | AE 复刻思路（1–3 行） |
|---|---|
| `data/gauge-readout-moves` | 表盘拆「刻度盘 + 指针」两层：指针 Rotation 3 键（0→270°→真值，带 8° 过冲）；或数值关键帧驱动表达式（仅视频）。滚带用整条刻度带 Position 2–3 键 + 窗口遮罩。 |
| 数字滚动（`DigitRoll.tsx` 通用） | 每位数字做一列 0–9 的预合成，外层矩形遮罩只露一行，位置 `translateY` 2–3 键；每列错峰 4f、22f 落位；用统一父级控制整体字距。 |
| `data/chart-live-moves` | 图表柱/线用形状层 Scale/修剪路径 2–3 键 + 数值文本单独换字；图表区整体做一次遮罩揭示。 |
| `data/before-after-slider-scrub` / `timeline-travel` | 前后对比用两条素材层 + 垂直分割遮罩位移（2–3 键）；时间旅行用多层缩放/位移错峰模拟纵深。 |

### 5.5 节奏／转场

| 卡片 | AE 复刻思路（1–3 行） |
|---|---|
| 白闪（`white-flash-logo-simplify-cut`） | 直接 `preset-trans-flash`（0.9s 色块炸开+回落）；若要做「字标降维」，在白层 100% 的帧上把液态版换成扁平版，白层回落后只留扁平字标做 1.03→1 对焦。 |
| `rhythm/beat-cut-moves`（连闪定格） | 三次硬切分别在 30/52/70f；每切前 4f 白闪层 opacity 0.95→0 + ±2px 抖动；切后 6f Scale 1.03→1 + −16px 沉降；三裁切用预合成不同缩放（1.0/1.6/2.8）。 |
| `transition/wipe-transitions` / `page-turn-transitions` | 纯色块/面板可用 `preset-trans-wipe`、`preset-trans-split`、`preset-trans-shutter`；对开门 = 旧页两半 ±1000px 24f 加速滑出 + 新页 Scale 1.08→1 迎上，缝内 10px 受光切面用形状层。 |
| 负片冲击帧（`effects/impact-feedback` C 式） | 预渲染 3 帧反色/高对比画面（`invert(1) grayscale(1) contrast(1.45)` + 集中线）做成 3 帧序列，AE 里 2–3 帧 hold 后切回；震屏用父级 Position 2px 级 2–3 键衰减。 |
| `rhythm/speed-ramp-freeze` / `sakuga-timing-shift` | 用时间重映射（表达式）仅限视频；交付 Lottie 时改为分段变速的关键帧（不逐帧）。 |

### 5.6 光照／效果

| 卡片 | AE 复刻思路（1–3 行） |
|---|---|
| `effects/spotlight-sweep-moves` | 灯光层（径向渐变/形状）做 2–3 键位置/缩放扫过，配合「轨道遮罩」只亮目标区；可加一层静态暗角压边。 |
| `effects/scanline-annotate-focus` / `fui-hud-moves` | 扫描线用 1–2px 亮线层匀速移动 + 目标层遮罩反应；HUD 数字/边框分层错峰淡入，用 `ae_stagger`。 |
| `effects/glow-flyline-moves` / `radial-ripple-phone-chips` | 发光用预渲染 glow 素材叠加（Screen），飞线用形状层「修剪路径」；涟漪用同心圆形状层 Scale+Opacity 3 键错峰。 |
| `outro/grain-dissolve` / 质感 | 颗粒用 AE 噪波/分形噪波静态叠层（不逐帧变 seed），或预渲染循环颗粒素材；暗角/柔光用调整层。 |
| 渐进模糊 / 景深 | 复制一份模糊层（高斯模糊固定值）+ 线性渐变遮罩，扫过时只露模糊版；不要给模糊半径打逐帧关键帧。 |

### 5.7 组合示例

- **急推特写 → 白闪 → 下一镜**：`sc-crash-zoom` 应用到目标预合成（start 锚点）→ 0.7s 落定后留 15–20f → 在切点放 `preset-trans-flash`（`time` 即切点）→ 切点后切到下一场景，白层回落后新场景已就位。
- **逐词标题 → 冲击帧**：`preset-sc-blur-slide` 收完后 6–10f，在落定文字上叠预渲染负片帧 2–3f + 震屏 2 键（Position ±6px 指数衰减），再接 hold。
- **卡片堆叠 → 扇开**：每张卡独立预合成 + `ae_stagger` 错峰入场，父级预合成做扇开（6.5°/138px）与相机推拉；`row-embed` / `list-reveal` 同结构，只是元素换成行/列表项。

---

## 6. 兼容性与风险

1. **文字模糊量纲不同**：源码是 CSS `filter: blur(18px)`；AE 文字动画器的 Blur 属性不是像素量纲（RB 先例：Split Text ≈2.2px 对应 AE 24）。`preset-sc-blur-slide` 固定 10，属观感标定，不可与 18px 画等号；面板预览里画的 4px 只是示意。需要更糊时手动改动画器 Blur 值。
2. **quint-out ≠ 精确同一个函数**：源码 `EASE.out` 是 `cubic-bezier(0.22,1,0.36,1)`，注释写「≈ quint-out」；F2A `power5Out` 是闭式 `1−(1−u)^5`。本次实测两者最大差 **0.011**（t≈0.06，整段 1% 级），视觉不可辨；但并非「公式完全一致」。面板预览把 `power5Out` 映射成同一条贝塞尔，所以「预览=源码曲线、AE=闭式 quint」两侧也保持在 1% 内。引用时不要说成 bit 级一致。
3. **帧率换算**：卡片帧值都是 30fps。F2A 预设/片段的时长以秒存，60fps 合成里秒值不变；手工复刻时帧值 ×2（22f@30 = 44f@60、6f = 12f、4f = 8f）。`ae_stagger` 等以秒传参的工具不受影响。
4. **`defaultAnchor: start` 的语义**：应用片段时以「图层在首键时刻的当前 Scale」为参考，把片段的 100% 映射到它，所以手调的 150% 会作为起点、峰值变成 360%。这是「保留图层原始比例」的设计，但也会把手调缩放放大；要保终态尺寸请用 `end` 锚点（默认）或 `absolute`。
5. **转场是覆盖层不是双场景**：`flash` 生成的是全屏色块层，不会替你切场景。必须在 `time` 处放好剪辑点/两层场景，色块只负责在切点遮住画面；`duration=0.9` 意味着切点前 0.45s 开始、后 0.45s 结束，片长不足会报「start before 0s」。
6. **文字预设仅 AE**：`preset-sc-*` 依赖文字动画器 + Expressible Selector 表达式，不进 Lottie/Web 链路；Web 交付请用 `sc-*` 片段、`preset-trans-*` 转场或手搓两键内容片段。
7. **crash zoom 是纯缩放**：`sc-crash-zoom` 不含位置收敛、运动模糊、到位闪光与震屏；需要完整「急推特写」请按 5.1 手工补（或在预合成里叠模糊/闪白）。
8. **中文分词**：blur-slide 的 `split(' ')` 在中文上得到一整块，AE 文字动画器的 words 选择器同样按空格分词；中文标题需按语义手动切 3–5 段，不要退化成逐字。
9. **包命名不要混**：video-shotcraft 的东西一律 `preset-sc-*` / `sc-*` / `sourceStyle: VideoShotcraft`；不要和 RB（`preset-rb-*` / `rb-content-*`）、AC（`preset-ac-*`）、AU（`preset-au-*`）、OS（`preset-trans-fade` / `split` / `shutter`、`os-*`）混标，否则面板筛选与后续升级会串味。
10. **素材归属**：卡片描述的场景（品牌字标、真实页面）只作手法参考；F2A 条目是参数重写，不带 video-shotcraft 的文案、配色与品牌资产。对外文档引用字幕/参数时保留 Apache-2.0 署名（附录）。
11. **验证路径**：改库后跑 `node tests/motion-library.cjs`（校验 clips/presets、motionPreview、CEP 混合上下文与隐私清单）；面板里选中卡片看曲线缩略图与数值，再在 AE 里预览一遍确认键位与缓动；交付前用接触表核对终帧落位。
12. **未覆盖**：124 张卡里 F2A 只打包 3 条，其余卡片（尤其 3D、指针、滚动、剪辑结构类）不承诺还原度，按第 5 节配方手工做；卡片本身也注明参数是「调校起点非实战定稿」，首次实战须用真实素材回验。

---

## 附：来源索引

| 类别 | 路径 / 链接 |
|---|---|
| 仓库 | https://github.com/Vincentwei1021/video-shotcraft |
| 本地快照 | `D:\Tools\F2A\artifacts\video-shotcraft-src\video-shotcraft-main\` |
| 许可证 | `LICENSE`（Apache-2.0，`Copyright 2026 Wei Yihao`）；`README.md` 的 License / Acknowledgements 节 |
| 技能与工作流 | `SKILL.md`、`README.md`、`references/pipeline.md`、`references/music-beat-sync.md`、`references/sound-design.md`、`references/sfx-sourcing.md`、`references/aesthetic-rules.md` |
| 卡片目录 | `references/shots/{camera,data,effects,interaction,opening,outro,rhythm,transition,typography,ui-entrance}/`（124 张） |
| 卡来源说明 | `references/shots/ATTRIBUTION.md` |
| 关键卡片 | `references/shots/typography/blur-slide.md`、`camera/crash-zoom-punch.md`、`effects/impact-feedback.md`、`transition/white-flash-logo-simplify-cut.md`、`typography/type-entrance-moves.md`、`typography/lead-word-zoom-assemble.md`、`ui-entrance/card-stack.md`、`opening/crane-rise-reveal.md`、`camera/steep-tilt-glide.md`、`data/gauge-readout-moves.md`、`rhythm/beat-cut-moves.md` |
| 关键实现 | `demos/typography/blur-slide/BlurSlide.tsx`、`demos/camera/crash-zoom-punch/CrashZoomReal.tsx`、`demos/effects/impact-feedback/{HitCounter,AnimeImpact}.tsx`、`demos/transition/white-flash-logo-simplify-cut/WhiteFlashLogoSimplifyCut.tsx`、`demos/_fixtures/Polish.tsx`、`demos/_fixtures/Motion.tsx`、`assets/lib/{PageCam,FlashCut,DigitRoll,ClipCard}.tsx`、`assets/lib/helpers/{camera.tsx,shake.ts}` |
| 画廊 / 工作台 | `gallery/`（150 条样片索引）、`workbench/`（Motion Workbench，`node workbench/scripts/open.mjs <project>`） |
| 署名 | video-shotcraft · 作者 Wei Yihao（仓库 `Vincentwei1021/video-shotcraft`，X @VincentWei93）· Apache-2.0；F2A 侧条目为独立重写 |
