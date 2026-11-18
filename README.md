# F2A

F2A 将 Figma 画框和图层送入 After Effects。可以直接导出 `.aep` 工程，也可以把选区导入正在编辑的 AE 合成。

## 安装

需要 **Windows x64**、Figma 桌面版、After Effects、Node.js 20+ 和 Python 3.11+（64 位）。把 Node.js 和 Python 加入 `PATH`，安装 Python 时保留 pip、venv 和 Tcl/Tk。首次安装需要联网下载 AEP 依赖。

1. 从 [GitHub Releases](https://github.com/TelosmaYLX/Figma2Ae/releases/latest) 下载 `F2A-Windows-x64-v<版本号>.zip`，完整解压。使用有仓库读取权限的 GitHub 账号。
2. 关闭 AE，双击 `install.cmd`。默认安装到 `%APPDATA%\Adobe\CEP\extensions\F2A`。
3. 在 Figma 桌面版的「插件 → 开发」菜单中从 manifest 导入插件，选择安装程序显示的 `figma-plugin/manifest.json`。启动 F2A。
4. 在 AE 中打开「窗口 → 扩展 → F2A」。Figma 面板显示「已连接到 After Effects」后即可使用。

已有系统级安装时，在解压目录中用**管理员 PowerShell**运行以下命令，更新到原路径。

```powershell
.\install.cmd -InstallDirectory "C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\F2A"
```

## 导出 AEP（推荐）

1. 在 Figma 选中要导出的画框或图层。
2. 在「导出 AEP（推荐）」右侧选择目标版本。支持 AE 2024（24.x）、2025（25.x）和 2026（26.x），默认 26.x。
3. 点击「导出 AEP（推荐）」，等待生成完成后，在保存窗口选择位置和工程名。

F2A 会生成同名工程文件夹，内含 `.aep`、配套 `Assets/` 素材和 `report.json`。在 AE 中打开 `.aep` 即可。移动或交付工程时，请带上整个文件夹。

## 导入到当前 AE 合成

在 AE 打开目标合成，在 Figma 选中图层后点「导入到 After Effects」。首次导入时，按提示设置「图片保存位置」。AE 没有活动合成时，单选一个 Frame 会自动新建同名、同尺寸的合成。

只发送画框中的部分图层时，可以先选中 Frame，在「图层工具」点「标记基准画框」。名称会加上 `[root]`。随后发送子图层，F2A 会保留它们相对最近标记画框的位置。多选时使用最近的共同标记画框。AE 没有活动合成时，F2A 按基准画框的名称和尺寸新建合成。选中 Frame 后点「取消基准标记」即可移除 `[root]`。

## 图层选项

- **保留分组层级**：将 Figma 分组保留为 AE 预合成。
- **文字**：默认导出为矢量形状。需要在 AE 修改内容时选「可编辑文字」，并在本机安装相应字体和字重。
- **标记为图片**：为选中图层加上 `*`，将它作为 PNG 导出。需要保留复杂效果外观时可用此选项。

## 更新与 MCP

打开 AE 的 F2A 面板时会检查一次更新，也可手动点「检查更新」。正式安装版发现新版后，可点「更新到版本」，完成后重新打开 AE 和 Figma 的 F2A 面板。私有仓库的联网更新通过 Git for Windows 的 Git Credential Manager 登录。

v1.1.0 若检查更新时报 `listener` 错误，请下载新版 ZIP，按上面的安装步骤更新到原目录。更新器已在 v1.1.1 修复。

需要让 AI 读取或编辑 Figma 时，可按 [MCP 配置说明](mcp/README.md) 注册 `f2a` 服务。更多安装选项见 [Windows 安装说明](scripts/distribution/INSTALL.md)。
