# F2A MCP

F2A 内置 [Cursor Talk to Figma MCP](https://github.com/grab/cursor-talk-to-figma-mcp)
的工具和 Figma 命令。打开 Figma 中的 F2A，agent 即可读写当前文档；不需要另开
Cursor MCP 插件、启动 Bun 服务或复制频道。

## 本机配置

首次在 Codex 中配置一次：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\Tools\F2A\scripts\install-mcp.ps1
```

配置后重连 MCP 或重新启动 Codex。已有 `figma` 服务会改为本仓库内的入口，其他 MCP
保持不变；配置备份保存在 Codex 配置目录的 `backups/f2a`。后续只需打开 Figma 中的
F2A，看到“MCP 已就绪”后即可调用工具。MCP 本身不要求启动 After Effects。

DSH Desktop 使用：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\Tools\F2A\scripts\install-mcp.ps1 -Client DshDesktop
```

使用本机已有的 `dsh-skill-mcp-panel` 管理模块，更新 desktop profile 中的 `figma`
入口并保留原条目 ID 与超时；其余 MCP 保持不变。原配置备份到 DSH 目录的
`backups/f2a`，支持 `DSH_HOME`。DSH 在线时由现有配置监听热加载，可在“Skill / MCP”
中检查 `figma` 的连接；连接后提供 45 个工具。

其他支持 stdio 的 MCP 客户端可使用：

```json
{
  "mcpServers": {
    "figma": {
      "command": "node",
      "args": ["D:/Tools/F2A/mcp/server.cjs"]
    }
  }
}
```

分发包可将 `command` 指向随包提供的 `runtime/node/node.exe`，无需安装依赖或联网。

## 使用

- 只有一个 F2A 文档时，`get_selection`、`get_document_info`、`create_frame`、
  `create_text` 等工具自动连接。
- `get_f2a_status` 列出打开的 F2A 文档。多个文档同时打开时，用
  `join_channel({"channel":"文档 ID"})` 选择目标；也可使用文件 key 或唯一文档名称。
- 文档关闭后，原 agent 的目标保持固定并提示断开；重开后用 `join_channel` 重新选择。
- MCP 操作与导出互斥。命令按顺序执行，进度消息延长操作等待时间，关闭文档立即结束等待。

本地中继只监听 `127.0.0.1:7869`。agent 调用工具或打开 AE 的 F2A 面板时自动启动，
没有插件连接和请求后空闲一分钟退出。Figma 插件自动重连。原 AE 导入和 AEP 导出
继续使用 7867 / 7868。上游源码、版本和 MIT 许可见 `vendor/cursor-talk-to-figma-mcp`。

## 开发

```powershell
cd D:\Tools\F2A\mcp
npm ci --ignore-scripts
npm run build
npm test
```

`server.cjs`、`relay.cjs` 和嵌入 `figma-plugin/code.js` 的命令代码均已提交，运行时
不依赖 `node_modules`。构建保留上游工具，替换传输与连接管理，不加载上游独立 UI 和分析统计。
`THIRD_PARTY_LICENSES.txt` 保留打包依赖的许可证。
