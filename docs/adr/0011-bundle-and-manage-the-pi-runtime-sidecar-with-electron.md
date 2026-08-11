# Pi Runtime Sidecar 随 Electron 交付和管理

`open-genoffice-pi-agent-runtime` 作为独立 sidecar 随 Electron 安装包交付，由桌面端
负责启动、版本握手、健康检查、崩溃恢复和退出回收。它不是 Electron
`utilityProcess`，也不是要求用户单独安装、升级或管理的常驻系统服务。

Runtime 的同一入口应可由工程师独立启动并连接测试客户端，以便调试 AgentSession、
MCP、Extension 和 Subagent；正式运行时只接受当前 Electron 实例建立的本地认证连接。

封装固定为目标平台 Node.js `22.19.0` 加 unpacked ESM Runtime bundle。Node executable
重命名为 `open-genoffice-pi-agent-runtime[.exe]`；Pi 依赖、Extensions、MCP stdio 入口
与 `.node` 原生模块作为 `extraResources` 中的真实文件交付，Electron 通过 bundle
manifest 启动 `spawn(executable, [entry])`。各安装包只带本平台和架构的 Runtime，
不得读取系统 Node、调用 `npx`，也不得把 Runtime 树放入 `app.asar`。

不采用 Node SEA。Node 22 的 SEA 仍只内嵌单个 CommonJS 主脚本，而 Pi ESM、动态
Extension、MCP 与原生模块仍需外置；它只会增加逐平台 blob 注入与重新签名，没有减少
本产品的 Runtime 资源树。首版也不增加 native launcher；若 Windows 非协作 MCP
进程树的发行测试证明 PID ledger 与 `taskkill /T` 不足，再用单独 ADR 决定 Job Object
launcher。

Runtime bundle 必须在 `beforePack` 校验 Node/Pi/协议版本、目标 platform/arch、入口、
executable bit 与全树 hash。macOS 在 outer app 签名前签入 Runtime Mach-O/.node，随后
公证；Windows 签 Runtime PE/native DLL、Electron app 与 installer；Linux 固定
glibc/AppImage，保留 executable bit。Node LICENSE 与第三方 notices 随 bundle 交付。

封装 spike 的完整证据位于
[`../../.scratch/pi-agent-platform-migration/prototypes/runtime-sidecar/README.md`](../../.scratch/pi-agent-platform-migration/prototypes/runtime-sidecar/README.md)。
