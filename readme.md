# Anvil Bridge

把 VS Code 工作区变成一个 **MCP 服务器**，让 Claude、ChatGPT 等任何支持 MCP 的 AI（或者只会发 HTTP 请求的 AI）直接读代码、改文件、跑命令。

## 特性

- **一键启动**：侧边栏点「启动」，自动监听本机端口，并生成带随机令牌的私有地址。
- **自动公网隧道**：启动后会自动运行下面这条命令，拿到 `https://xxx.trycloudflare.com` 地址：
  `cloudflared tunnel --url http://localhost:<端口> --http-host-header localhost:<端口>`
  没装 cloudflared 的话，可以在面板里一键安装（Windows / winget）。
- **连接提示词**：一键复制给 AI 的完整连接说明，包括 Streamable HTTP 的连接步骤、curl 示例和会话过期后的处理。
- **两种权限模式**
  - 审批模式（默认）：每次写文件、执行命令都会弹窗，由你确认。
  - 完全访问：不用逐条审批，适合你信任的 AI。
- **20 个工具**：浏览/搜索/读取文件、带版本校验的补丁、持久终端（PTY）、诊断、LSP 导航、文件大纲、Git 状态与 diff、任务清单与进度、内置技能。
- **检查点**：AI 修改文件前自动保存快照，可以按文件或整体回滚。
- **内置技能**：`debugging`（系统化调试）、`code-review`（代码审查）、`refactor`（安全重构）。

## 使用

1. 在 VS Code 中打开项目文件夹，点击活动栏里的 Anvil 图标。
2. 点击「启动」。等公网隧道显示「已连接」。
3. 点击「复制连接提示词」，粘贴给 AI。

## 设置

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `lanternBridge.port` | `0` | 本地端口，0 表示随机选一个空闲端口 |
| `lanternBridge.autoTunnel` | `true` | 启动服务后自动开启 cloudflared 隧道 |
| `lanternBridge.cloudflaredPath` | `cloudflared` | cloudflared 可执行文件的路径 |
| `lanternBridge.enableCommands` | `false` | 审批模式下是否允许 AI 执行命令（逐条审批） |
| `lanternBridge.windowsShell` | `auto` | Windows 上使用 pwsh 还是 Windows PowerShell |
| `lanternBridge.resultFormat` | `text` | 工具结果只发文本，还是同时附带 structuredContent |

## 安全须知

- MCP 地址里包含访问令牌，拿到地址的人就能访问你的工作区。不要外传；用完点「停止」，或在连接详情里轮换令牌。
- Shell 命令以你的系统用户权限运行，**没有沙箱**。开启完全访问前请确认你信任对方。
- quick tunnel 是 Cloudflare 提供的免费临时隧道，不保证可用性。

## 开发

```powershell
npm install
npm run build      # esbuild 打包到 dist/
npm test           # mock 冒烟测试
npm run package    # 生成通用 VSIX 到 release/（Windows x64/ARM64、macOS Intel/Apple 芯片可直接安装；Linux 自动用 direct 模式）
```

## 许可

MIT © Anvil Bridge
