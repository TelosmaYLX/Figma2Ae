# F2A + 图层整理 Skill 安装说明（Windows x64）

本包含两部分：

| 目录 | 内容 |
| --- | --- |
| `F2A/` | After Effects ↔ Figma 桥接扩展（CEP 面板）、本地 MCP 服务、AEP 导出服务与安装脚本 |
| `skills/f2a-figma-layer-tidy/` | 「整理图层（面向 AEP 导出）」AI 技能 |

安装顺序：**① 装 F2A → ② Figma 导入插件 → ③ AE 打开面板 → ④ 接入 MCP → ⑤ 装 Skill**。

---

## 0. 前置条件

| 依赖 | 要求 |
| --- | --- |
| Windows | x64 |
| After Effects | CC 2015（13.0）及以上 |
| Figma | 桌面版 |
| Node.js | **≥ 20，x64**，安装时加入 PATH |
| Python | **≥ 3.11，x64**，勾选加入 PATH，保留 pip / venv / Tcl-Tk |

本包**不含** Node / Python 运行时，也不含任何账号配置、密钥或设计素材。装完环境后请重开终端，确认：

```powershell
node --version     # >= v20
python --version   # >= 3.11
```

---

## 1. 安装 F2A

### 1.1 先选安装位置

CEP 扩展有两个合法位置，二选一：

| 级别 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| **系统级（所有用户）** | `C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\F2A` | 需管理员 | 系统级 CEP 扩展目录，与 Colorista、Motion tools 等第三方面板同处，AE 启动时统一扫描 |
| 用户级（当前用户） | `%APPDATA%\Adobe\CEP\extensions\F2A` | 普通用户 | `install.cmd` 不带参数时的默认位置 |

> ⚠️ **写权限前置提醒**：F2A 会在**自己所在的扩展目录内**创建 `.venv-aep`（Python 依赖）和 `artifacts\aep-service\`（AEP 服务日志）。装到 `Program Files` 时，安装、修复依赖、以及 AE 面板首次拉起 AEP 服务都需要管理员权限。若希望之后以普通用户日常使用，装完请授一次写权限（管理员 PowerShell 执行一次即可）：
>
> ```powershell
> icacls "C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\F2A" /grant "$env:USERNAME:(OI)(CI)M" /T
> ```
>
> 装到用户级目录则没有这个限制。

### 1.2 系统级安装（`C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\F2A`）

关闭 After Effects，用**管理员 PowerShell**执行：

```powershell
cd "<解压目录>\F2A"
.\install.cmd -InstallDirectory "C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\F2A"
```

等价于直接调用脚本（参数相同）：

```powershell
powershell -ExecutionPolicy Bypass -File "<解压目录>\F2A\scripts\install-f2a.ps1" `
  -InstallDirectory "C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\F2A"
```

安装过程会：按 `package-manifest.json` 把文件复制到目标目录（已在目标目录内时只补依赖）→ 在目标目录建 `.venv-aep` 并安装 `scripts\aep\requirements.txt`（**需要联网**）→ 为 CSXS.9–12 开启 CEP 调试模式 → 注册当前用户的 `f2a-aep` 唤起入口。

### 1.3 用户级安装（默认，无需管理员）

1. 关闭 After Effects。
2. 双击 `F2A\install.cmd`，等待输出 `Installation complete`。

装到 `%APPDATA%\Adobe\CEP\extensions\F2A`，其余行为与上面一致。

### 1.4 手动安装（任意位置）

适合要自定义路径、或想逐项确认的情况。

1. 关闭 After Effects。
2. 把 `F2A\` 里的**全部内容**复制到目标目录（下面以系统级为例），确保该目录下**直接**有 `CSXS\manifest.xml`，不要多套一层 `F2A\F2A\`：

   ```powershell
   $dst = "C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\F2A"   # 或 "$env:APPDATA\Adobe\CEP\extensions\F2A"
   New-Item -ItemType Directory -Path $dst -Force | Out-Null
   Copy-Item "<解压目录>\F2A\*" $dst -Recurse -Force
   ```

3. 开启 CEP 调试模式（不开的话 AE 的「扩展」菜单里不会出现 F2A）：

   ```powershell
   9..12 | ForEach-Object {
     $key = "HKCU:\Software\Adobe\CSXS.$_"
     New-Item -Path $key -Force | Out-Null
     New-ItemProperty -Path $key -Name PlayerDebugMode -Value '1' -PropertyType String -Force | Out-Null
   }
   ```

4. 准备 AEP 导出的 Python 环境（必须建在安装目录内，脚本按这个位置查找）：

   ```powershell
   python -m venv "$dst\.venv-aep"
   & "$dst\.venv-aep\Scripts\python.exe" -m pip install --disable-pip-version-check -r "$dst\scripts\aep\requirements.txt"
   & "$dst\.venv-aep\Scripts\python.exe" -c "import py_aep, tkinter, uharfbuzz"
   ```

5. 注册 AEP 唤起入口（AE 面板第一次点「导出 AEP」时靠它拉起本地服务）：

   ```powershell
   powershell -ExecutionPolicy Bypass -File "$dst\scripts\install-aep-launcher.ps1"
   ```

---

## 2. 在 Figma 导入插件

Figma 桌面版 → 菜单 `Plugins` → `Development` → `Import plugin from manifest…` → 选择安装目录下的：

```
<F2A 安装目录>\figma-plugin\manifest.json
```

例如系统级安装时是 `C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\F2A\figma-plugin\manifest.json`。

导入后运行一次，面板状态显示已连接即正常。

---

## 3. 打开 AE 面板

重启 After Effects → `窗口` → `扩展` → `F2A`。

面板能正常显示、且不再提示「未找到组件 / 调试模式未开启」即安装成功。

---

## 4. 接入 MCP（让 AI 能读写 Figma / 触发导出）

MCP 是一个 stdio 服务，入口固定为**安装目录**下的 `mcp\server.cjs`，**无需** `npm install`（依赖已打包进 `server.cjs`）。

先设一个变量，避免路径写错（按你的实际安装位置改）：

```powershell
$f2a = "C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\F2A"
# 用户级安装则用：$f2a = "$env:APPDATA\Adobe\CEP\extensions\F2A"
```

### Codex

```powershell
powershell -ExecutionPolicy Bypass -File "$f2a\scripts\install-mcp.ps1"
```

脚本会先备份 `~\.codex\config.toml`，再执行 `codex mcp add f2a -- node "$f2a\mcp\server.cjs"`，并补上 `startup_timeout_sec = 60` / `tool_timeout_sec = 120`。

### DSH Desktop

```powershell
powershell -ExecutionPolicy Bypass -File "$f2a\scripts\install-mcp.ps1" -Client DshDesktop
```

要求 DSH 的 desktop profile 里已安装 `dsh-skill-mcp-panel`；脚本会备份并改写 `~\.dsh\profiles\desktop\cordis.patch.yml`。

### 其他 MCP 客户端（手动配置）

```jsonc
{
  "command": "node",
  "args": ["<F2A 安装目录>\\mcp\\server.cjs"],
  "cwd": "<F2A 安装目录>",
  "startupTimeoutSec": 60,
  "toolTimeoutSec": 120
}
```

> 服务名不要用 `figma`（会和已有的 figma MCP 冲突），用 `f2a`。
> 超时务必放宽：渲染/截图类工具有时会跑几十秒。

### 验证

重启客户端后，让 AI 调用 `get_f2a_status`：返回一个 session 即表示 MCP 已连上 Figma 里的 F2A 面板。

---

## 5. 安装「整理图层」Skill

把 `skills\f2a-figma-layer-tidy` **整个文件夹**复制到客户端的技能目录：

```powershell
Copy-Item .\skills\f2a-figma-layer-tidy "$env:USERPROFILE\.dsh\skills\"   -Recurse -Force  # DSH
Copy-Item .\skills\f2a-figma-layer-tidy "$env:USERPROFILE\.codex\skills\" -Recurse -Force  # Codex
```

再为**系统 Python**（不是 `.venv-aep`）装两个库，像素门禁脚本依赖它们：

```powershell
python -m pip install numpy pillow
python -c "import numpy, PIL; print('ok')"
```

重启客户端 / 新开会话后技能才会出现在技能列表里。

> 技能目录结构保持不变：`SKILL.md` 在根，`references/`、`scripts/` 同级。技能文档里的 `<SKILL_DIR>` 就指这个 `f2a-figma-layer-tidy` 目录。

---

## 6. 使用流程

1. 在 Figma 里**选中**要导出 AEP 的那个顶层画框（或弹窗 Frame）。
2. 对 AI 说：「用 f2a-figma-layer-tidy 整理这个画框，准备导 AEP」。
3. 技能会自动：整画框隐藏备份 → 只读诊断 → 冗余套娃精简 / 语义化命名 / 复杂特效隔离（`*` 标记）→ 像素零差异校验（`max_abs_diff == 0` 才继续）→ 删备份并清理临时图。
4. 回到 AE，用 F2A 面板「导出 AEP」。

报告里会给出：像素差异数字、图层/预合成结构对比、标 `*` 的合图清单及原因、推荐的导出面板参数。

---

## 7. 完整性校验（可选）

- `F2A\package-manifest.json` 列出 F2A 全部文件的大小与 SHA-256，可逐项核对；安装脚本也是按它复制文件的。
- 外层 `.zip.sha256` 是整包校验值：`Get-FileHash <zip> -Algorithm SHA256` 对比即可。

---

## 8. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| AE「扩展」菜单里没有 F2A | 没开 PlayerDebugMode（见 1.4-3）；或没重启 AE；或 CEP 目录多套了一层（应直接是 `...\extensions\F2A\CSXS\manifest.xml`）；确认装的是 AE 会扫描的目录（系统级 `Program Files (x86)\Common Files\Adobe\CEP\extensions` 或用户级 `%APPDATA%\Adobe\CEP\extensions`） |
| 装到 `Program Files` 后 pip 报「拒绝访问」/ 服务启动失败 | 该目录需管理员写权限：用管理员 PowerShell 装，或按 1.1 的 `icacls` 授一次写权限 |
| 面板提示找不到 AEP 服务 | `.venv-aep` 依赖没装好；点一次面板「导出 AEP」会自动拉起服务，也可手动 `powershell -File "<安装目录>\scripts\start-aep-export.ps1"`，日志在 `<安装目录>\artifacts\aep-service\` |
| `install.cmd` 报 Node/Python 版本不符 | 需要 **x64** 的 Node 20+ 与 Python 3.11+（含 pip/venv/Tcl-Tk），装完重开终端再跑 |
| MCP 连上了但工具调用超时 | 把该 MCP 的启动/调用超时调到 60s / 120s（脚本已自动写入 Codex 配置） |
| 像素校验报找不到 `before.png` | `save_screenshots` 的相对 `outDir` 是相对 **MCP 服务进程**的工作目录，可能不在你的 shell 目录；以返回的绝对 `path` 为准 |
| 导出可编辑文字后字体不对 | 目标机器需装原设计字体；或在导出面板选「矢量形状（无需字体）」 |
| 整理后画面有差异 | 技能会卡在像素门禁；让它继续排查（通常是裁剪开关、Z 序或 Auto Layout 位置被改动） |

---

## 9. 本包不包含

Node / Python 运行时、Python 虚拟环境、本机账号配置与密钥、日志与导出工程、设计素材、Git 记录与开发工具。
第三方开源许可证完整保留在 `F2A\licenses\` 与 `F2A\mcp\THIRD_PARTY_LICENSES.txt`。

## GitHub Releases

在 AE 的 F2A 面板点「检查更新」，有新版时点「更新到版本」。私有仓库使用 Git for Windows 的 Git Credential Manager 登录，需要仓库读取权限。安装完成后重新打开 AE 和 Figma 的 F2A 面板。

发布时将 `version.json` 和 `CSXS/manifest.xml` 更新到目标版本。在 Windows 运行 `node scripts/package-dist.cjs`，将 `dist/F2A-Windows-x64.zip` 和 `dist/latest.json` 一起附到 `TelosmaYLX/Figma2Ae` 的 Release，标签使用 `v<版本号>`。上传完成后再发布为 Latest。首次使用联网更新的用户先安装带更新入口的版本。
