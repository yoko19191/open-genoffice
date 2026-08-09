# 选择生产级 Pi MCP 集成路径

Type: research

Status: resolved

## Question

在当前固定的 Pi 版本与现有生态中，哪个 MCP 实现最适合成为 GenOffice 的生产依赖？
需要给出精确 Package/commit、许可证与维护状态，并验证 stdio、Streamable HTTP、OAuth、
取消、重连、日志、工具级权限、Electron 打包和 `~/.open-genoffice` 隔离。若没有单一
Package 满足契约，应明确可复用部分与 GenOffice 最小适配层边界。

## Comments

### 2026-08-09 — 候选与版本核验

- 采用官方 `@modelcontextprotocol/client@2.0.0`，release commit
  `cc4b41617ce3601b1290d67216ea0b194a3cd9ac`，npm 包声明 MIT，Node.js `>=20`；
  它覆盖 stdio、Streamable HTTP、旧 SSE 兼容、OAuth/Bearer/static headers、
  AbortSignal、超时与连接事件。
- 不采用 `pi-mcp-adapter@2.21.1`。它虽是功能最完整的 Pi 生态候选，但 optional peer 与
  开发依赖要求 Pi `^0.84.1`，而本项目必须与 Pi Web 固定的 `0.84.0` 对齐。强制 override
  后只能证明 import，不能证明 Extension lifecycle、OAuth、tool call 和 shutdown。
  `2.20.1` 在 Pi `0.84.0` 上实测又因旧 `complete` export 在加载阶段失败。
- 不采用 `pi-mcporter@1.0.2`：它要求 Node.js `>=24`，以 `~/.mcporter` 为配置真源，
  形成第二套运行与配置边界。`llm-space`、`oh-my-pi` 也分别因旧 SDK/协议能力不足和引入
  第二 Agent Runtime 被拒绝。
- 官方 SDK 不替宿主处理权限、CredentialStore、stdio 进程监督、mutation 幂等与日志
  脱敏；这些不是重复实现 MCP，而是 GenOffice 必须拥有的产品责任。

上游证据：[官方 client `2.0.0` release](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/%40modelcontextprotocol%2Fclient%402.0.0)、
[stdio transport](https://github.com/modelcontextprotocol/typescript-sdk/blob/cc4b41617ce3601b1290d67216ea0b194a3cd9ac/packages/client/src/client/stdio.ts)、
[Streamable HTTP transport](https://github.com/modelcontextprotocol/typescript-sdk/blob/cc4b41617ce3601b1290d67216ea0b194a3cd9ac/packages/client/src/client/streamableHttp.ts)、
[`pi-mcp-adapter@2.21.1` package.json](https://github.com/nicobailon/pi-mcp-adapter/blob/7dfe06899279832dd320a7c228e48e8a9f503807/package.json)。

## Answer

Pi Runtime 继续精确固定 `0.84.0`；MCP 生产依赖固定为
`@modelcontextprotocol/client@2.0.0`。在 `open-genoffice-pi-agent-runtime` 内实现一个
Pi inline Extension adapter，只保留四个窄边界：

```text
OpenGenOfficeMcpConfigResolver
  -> 合并 ~/.open-genoffice/mcp.json
     与受信任项目 .open-genoffice/mcp.json

McpConnectionSupervisor
  -> 创建、关闭和重建 stdio / Streamable HTTP transport
  -> 处理 sleep/wake 与进程退出
  -> 不重放结果不确定的 mutation

PiMcpExtensionFactory
  -> listTools() 映射为 Pi ToolDefinition
  -> execute(signal) 调用 client.callTool(..., { signal })
  -> 结果转换为 Pi content blocks

McpAuthorizationBroker
  -> 按 documentId、actorId/type、serverId、toolName、args 决策
  -> Subagent mutation 默认 deny
  -> 只接受 renderer 发起的 allow_once 显式授权
```

HTTP 默认使用 Streamable HTTP；旧 SSE 只能由用户为旧服务显式选择。OAuth callback 必须
由 GenOffice 校验 PKCE、state、issuer 与 server URL binding，凭据只进入 OS Credential
Store，service name 为 `open-genoffice.mcp.oauth`。stdio 凭据在启动时以最小环境变量注入；
配置、Session、日志与 IPC 均不得出现 secret。

Pi `0.84.0` 自带的 `agentDir`、inline `ExtensionFactory`、ToolDefinition 注册与 active-tools
allowlist 直接复用，不另造工具生命周期。工具禁用后必须同时从模型可见集合和执行入口
消失。所有非 secret 状态位于 `~/.open-genoffice` 或受信任项目的 `.open-genoffice`；
不得扫描 `~/.pi`、`.pi`、`.mcp.json`、Codex、Claude 或其他客户端配置。

验收门槛包括：精确 lockfile、三平台安装包内 stdio/HTTP 调用与无孤儿进程、Agent Stop
联动 AbortSignal、失效 HTTP session 重连但 mutation 不重放、OAuth fail-closed、默认
只读 Subagent 与逐次 Mutation Grant、日志脱敏、Genspark-Free 离线启动，以及 SDK
许可证、SBOM、asar、签名和卸载残留检查。

`pi-mcp-adapter` 可在未来统一升级 Pi 版本时重新评估；当前不得绕过其 peer 约束进入
生产依赖。
