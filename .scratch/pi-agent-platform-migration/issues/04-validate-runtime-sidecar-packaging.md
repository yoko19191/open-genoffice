# 验证 Runtime Sidecar 三平台封装

Type: prototype

Status: resolved

## Question

`open-genoffice-pi-agent-runtime` 应以何种可执行文件形态随 Electron 在 macOS、Windows
和 Linux 打包，才能可靠加载 Pi ESM、Extensions、MCP stdio 子进程和原生依赖？原型
需要验证 UDS/Named Pipe、一次性握手 token、版本拒绝、崩溃重启、应用退出回收、
独立 debug 模式、签名/公证和安装路径，不得退回 `utilityProcess` 或系统常驻服务。

## Resolution

固定为**目标平台 Node `22.19.0` 可执行文件 + unpacked ESM Runtime bundle**。Node
可执行文件重命名为 `open-genoffice-pi-agent-runtime[.exe]`，Electron 从 bundle
manifest 读取 `executable` 与 `entry`，通过 `spawn(executable, [entry])` 管理。Pi、
Extensions、MCP stdio 脚本与原生模块全部保留为 `extraResources` 中的真实文件，不能
进入 `app.asar`。不采用 SEA、`utilityProcess`、系统 Node、`npx` 或自定义 native
launcher。

正式 IPC 在 macOS/Linux 使用私有目录中的 UDS，在 Windows 使用随机 Named Pipe。
256-bit 一次性 token、endpoint、协议和父 PID 只通过 inherited stdin bootstrap；
Runtime 校验实际 `ppid`，父进程保持 stdin 作为 lifetime sentinel。成功握手消费 token，
错误 token/协议/Runtime 版本和重用 token 均拒绝。stdio 只用于同一入口的独立 debug。

完整原型与证据见
[`prototypes/runtime-sidecar/README.md`](../prototypes/runtime-sidecar/README.md)：

- macOS/arm64 完整复制 bundle 的 Pi 0.84.0、动态 Extension、N-API、MCP stdio、UDS、
  崩溃重启、shutdown、父进程退出回收和 debug 实跑通过；
- Linux/arm64 glibc 在官方 `node:22.19.0-bookworm` 完整实跑通过；
- Alpine/musl 因 Pi shrinkwrap 中 arm64-musl clipboard 包没有实际 `.node` 文件而明确
  排除，Linux 基线固定 glibc/AppImage；
- Windows/x64 官方 Node zip hash、PE executable 与 Pi 两个 native DLL 静态配套通过；
  当前无 Windows runner，Named Pipe 与 process-tree 回收必须通过随原型提供的
  `windows-2025` smoke 后才能满足 `PK-001`，不得把静态证据冒充运行证据；
- 协议与负载模块覆盖率为 lines 100%、branches 97.83%、functions 100%。

Windows 执行证据、真实 Developer ID/Authenticode 签名、公证和 installer smoke 属于
实施期发行门；它们不改变本票据已经收敛的 executable form，但任一未通过都禁止发布。
