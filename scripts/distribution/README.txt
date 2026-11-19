F2A（Windows x64）

一、先安装

- Figma 桌面版、After Effects。
- Node.js 20 或更高版本（64 位），安装时加入 PATH。
- Python 3.11 或更高版本（64 位），勾选加入 PATH，并保留 pip、venv、Tcl/Tk。

本包不包含 Node、Python 或 Python 虚拟环境。首次安装需要联网下载 AEP 依赖。
安装环境后，重新打开终端，确认 node --version 和 python --version 可运行。

二、安装 F2A

1. 完整解压到一个文件夹，关闭 After Effects。
2. 双击 install.cmd，等待显示 Installation complete。
3. 在 Figma 桌面版的插件开发菜单中，选择从 manifest 导入。
   选择安装程序显示的 figma-plugin\manifest.json。
4. 重启 After Effects，在“窗口 → 扩展”中打开 F2A。
5. 在 Figma 中运行 F2A，选中画框后导入 AE 或导出 AEP。

安装位置（二选一）：
- 系统级：C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\F2A（需管理员运行）
- 用户级：%APPDATA%\Adobe\CEP\extensions\F2A（install.cmd 不带参数时的默认值）
安装程序会安装固定版本的 Python 依赖、启用 CEP 扩展调试模式，
并为当前用户注册 f2a-aep 启动入口。不会自动配置 MCP 客户端。
装到 Program Files 时，安装、修复依赖和首次拉起 AEP 服务都需要管理员权限；
日常以普通用户使用请给该目录授一次写权限（见 INSTALL.md）。
如提示环境不存在，安装对应环境并重启相关应用，再运行 install.cmd。
导出可编辑文字时，目标设备仍需安装原设计使用的字体。

联网更新：打开 AE 的 F2A 面板时会自动检查一次，有新版时在面板顶部提醒。
可点“更新到版本”安装，也可点“检查更新”手动查询。
仓库为私有，需要 Git for Windows 及 Git Credential Manager，并登录有 Releases 读取权限的 GitHub 账号。
更新完成后重新打开 AE 和 Figma 的 F2A 面板。

三、MCP（可选）

在 MCP 客户端中添加 stdio 服务，名称使用 f2a：
command：node
args：填写安装目录下 mcp\server.cjs 的完整路径。

Codex CLI 已安装时，在 PowerShell 中运行（<安装目录> 换成实际路径）：
& "<安装目录>\scripts\install-mcp.ps1"

DSH Desktop 用户可运行：
& "<安装目录>\scripts\install-mcp.ps1" -Client DshDesktop

重连 f2a。使用 Figma 工具时，在 Figma 中打开 F2A。
使用 AE 工具时，先调用 ae_status。首次安装 Surehand 扩展后按提示重启 AE。
agent 可以制作动画、预览、保存 AEP 和渲染视频。MCP 依赖已打包。

四、包内内容

client、CSXS、host：AE 扩展及导入资源。
figma-plugin：Figma 插件。
mcp：已构建的 MCP 服务和许可证。
scripts：AEP 服务、依赖清单和安装脚本。
licenses：第三方许可证。
package-manifest.json：文件清单及 SHA-256。

本包不包含本机账号配置、密钥、日志、导出工程、设计素材、Git 记录或开发工具。
第三方开源许可证中的公开版权署名保持完整。
