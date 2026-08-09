# Spike 04：Runtime Sidecar 三平台封装

<!-- markdownlint-disable MD013 MD060 -->

## 结论

生产形态固定为一棵随目标平台构建的、完全位于 Electron `extraResources` 中的
**unpacked Runtime bundle**：固定版本的 Node.js 可执行文件重命名为
`open-genoffice-pi-agent-runtime[.exe]`，旁边保留可动态加载的 ESM 入口、Pi 依赖树、
Extensions、MCP stdio 入口和原生模块。Electron 主进程通过 manifest 找到可执行文件与
入口并以 `spawn(executable, [entry])` 启动；不使用 `utilityProcess`、系统 Node、SEA、
`npx` 或系统常驻服务。

```text
resources/
└── open-genoffice-pi-agent-runtime/
    ├── manifest.json
    ├── bin/
    │   └── open-genoffice-pi-agent-runtime[.exe]
    ├── app/
    │   ├── dist/host.mjs
    │   └── node_modules/
    └── licenses/
        ├── NODE-LICENSE
        └── THIRD-PARTY-NOTICES.txt
```

这不是“一个文件的可执行程序”，而是一个不可拆分的 Runtime bundle。这样做保留了
Pi ResourceLoader 对 project/global Extensions、Skills 和 Packages 的真实文件系统
语义，也让 MCP stdio 可以直接复用同一份固定 Node。独立调试仍使用相同二进制与入口：

```shell
open-genoffice-pi-agent-runtime app/dist/host.mjs --debug-stdio
```

Node SEA 暂不采用。Node 22 的 SEA 仍是 active development，只内嵌一个 CommonJS
入口；即使加入薄 bootstrap，Pi ESM、动态 Extensions、MCP 脚本和 `.node` 模块仍需
外置，收益只剩隐藏一个入口参数，却引入 blob 注入、逐平台构建和“注入后重新签名”的
额外链路。原生 Rust/C launcher 同样没有解决新的产品问题，首版不承担这层维护成本。

## 已验证内容

原型位于本目录，固定依赖：

- Node.js `22.19.0`；
- `@earendil-works/pi-coding-agent@0.84.0`；
- `@modelcontextprotocol/client@2.0.0`；
- MCP fixture 使用 `@modelcontextprotocol/server@2.0.0`，只属于测试依赖。

上述三个 npm Package 的声明许可证均为 MIT；Node 自身的 LICENSE 与依赖 notices 必须
进入最终 Runtime bundle，不能只在主 Electron app 中留一份无法对应 Runtime 的清单。

`npm run probe -- --copy-node-modules` 会把 Node、入口与整个依赖树复制到带空格的一次性
安装目录，不使用 workspace symlink，然后验证：

- 重命名后的 Node executable 启动 ESM Runtime；
- Pi `DefaultResourceLoader` 从真实文件路径发现并执行动态 Extension；
- Pi 的 `@mariozechner/clipboard` N-API 原生模块可加载；
- MCP client 用同一个 bundled executable 启动 stdio server，完成 `listTools` 与
  `callTool`；
- UDS/Named Pipe 只接受一次成功握手，错误 token、协议版本、Runtime 版本以及 token
  重用均被拒绝；
- bootstrap 通过继承的 stdin 传入，包含 256-bit token、endpoint、protocol 和
  `parentPid`，不会出现在 argv、环境变量或磁盘；
- Runtime 校验 `parentPid === process.ppid`，父进程持有的 stdin 同时作为 lifetime
  sentinel；管道关闭即回收 Runtime；
- 崩溃退出码为 `70`，新一代使用新 PID、endpoint 与 token；
- 有序 shutdown 与父进程退出均以 `0` 退出，UDS 被删除；
- 同一入口的 `--debug-stdio` 模式可独立运行。

测试命令：

```shell
npm ci --ignore-scripts
npm run test:coverage
npm run probe -- --copy-node-modules
```

协议与负载测试的覆盖率门槛已写入命令：lines、branches、functions 均不得低于 95%。
当前结果为 lines 100%、branches 97.83%、functions 100%。

## 平台证据矩阵

| 目标              | 证据                                                                                                                                                               | 结果                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| macOS 15+/arm64   | 本机从完整复制 bundle 运行；UDS 目录 `0700`、socket `0600`；Pi/Extension/N-API/MCP、版本拒绝、token 消耗、崩溃重启、shutdown、父进程退出、debug 全链路             | 通过                                                      |
| Linux/arm64 glibc | 官方 `node:22.19.0-bookworm` 容器从完整复制 bundle 运行相同全链路                                                                                                  | 通过                                                      |
| Linux musl        | 官方 `node:22.19.0-alpine` 暴露 Pi shrinkwrap 中 `clipboard-linux-arm64-musl` 没有实际 `.node` 文件                                                                | 不支持；Linux 发行基线固定 glibc/AppImage                 |
| Windows/x64       | 官方 `node-v22.19.0-win-x64.zip` SHA-256 与 `SHASUMS256.txt` 一致；重命名后为 PE32+ console x86-64；Pi TUI 与 clipboard 的 win32-x64 `.node` 均为 PE32+ x86-64 DLL | 静态封装通过；Named Pipe 与进程回收待 Windows runner 实跑 |

Windows 官方 Node zip 的校验值为
`ea3fad0e67a991d8477d8c01344b56e69c676ccb733f065b22436994b1253f86`。
静态检查不能替代执行证据，因此 `PK-001` 的 Windows 分支必须在 `windows-2025` runner
运行本目录的同一条 `probe -- --copy-node-modules` 后才允许发版。可直接采用
[`ci/windows-smoke.yml`](ci/windows-smoke.yml) 作为实现期 workflow 的起点。

## IPC 与进程管理规则

正式传输在 macOS/Linux 使用短路径私有目录中的 UDS，在 Windows 使用带 96-bit 随机
后缀的 Named Pipe。`readableAll` 与 `writableAll` 必须显式为 `false`；renderer 永远
不知道 endpoint 或 token，只有 Electron 主进程连接。

握手顺序固定为：

1. Electron 创建私有 instance directory、256-bit token 和新 endpoint；
2. Electron 启动 sidecar，并通过 inherited stdin 写入一条 bootstrap JSON 后保持管道
   打开；
3. Runtime 校验 bootstrap protocol 与实际 `ppid`，开始监听；
4. Electron 连接并发送 `hello(token, protocolVersion, runtimeVersion)`；
5. 只有成功握手会消费 token；之后拒绝第二条连接；
6. stdin EOF、显式 shutdown 或应用退出都进入同一关闭路径。

一次性 token 不是长期 secret。它只证明连接者持有父进程创建的匿名管道内容；凭据、
模型 token 和 MCP secret 仍由 Runtime CredentialStore 管理，不进入这条 bootstrap。

Electron supervisor 使用 `starting → ready → stopping | crashed → backoff` 状态机。崩溃后
使用新 instance directory，不复用遗留 UDS；60 秒内最多自动重启 3 次，退避为
`250ms / 1s / 4s`，超过后打开 circuit breaker 并向 UI 暴露可诊断错误。正常退出先发
shutdown，5 秒未结束再强制回收。

macOS/Linux 把 Runtime 与其 MCP 子进程放入独立 process group。Windows 首版让每个
stdio MCP 保持非 detached、记录直接子 PID，并在停止/崩溃恢复时对仍存活的 PID 执行
`taskkill /T /F`；MCP server contract 禁止 daemonize。Windows runner 还必须用一个
故意忽略 stdin EOF 的 fixture 验证整棵树被清理；若这条门失败，再引入只负责 Job
Object 的 Windows launcher，不能用无维护的 npm 进程管理包降低门槛。

## Electron 打包落点

Runtime bundle 在独立 workspace 中按 `platform-arch` 预装并生成 manifest，随后由现有
`apps/shell/electron-builder.cjs` 的 `extraResources` 复制到上述路径。不得把这棵树放进
`app.asar`，也不得依赖 electron-builder 对 native addon 的 smart unpack 猜测。

manifest 至少包含：

```json
{
  "runtimeVersion": "1.0.0",
  "protocolVersion": "1",
  "nodeVersion": "22.19.0",
  "piVersion": "0.84.0",
  "platform": "darwin",
  "arch": "arm64",
  "entry": "app/dist/host.mjs",
  "executable": "bin/open-genoffice-pi-agent-runtime",
  "filesSha256": "<generated>"
}
```

`beforePack` 必须校验 manifest、目标平台、arch、每个文件 hash 和 executable bit，缺一项
即失败；不能沿用 electron-builder 对缺失 `extraResources` 只警告的行为。各平台只装
自己的 Node 与原生模块，不把三平台 runtime 一起塞进一个安装包。

macOS 在 outer `.app` 签名前签入 Runtime executable 与所有 Mach-O/.node，之后再做
notarization；原型已验证重命名 Node 可重新 ad-hoc signing 并通过 strict verify。
Windows 对 Runtime executable、native DLL/.node、Electron app 与 NSIS installer 完成
签名后不得再修改。Linux 保留 `0755` executable bit，并校验 AppImage 解包后的 manifest
和 hash。Node LICENSE 与第三方 notices 是 bundle 的必需文件。

## 未伪装成“已通过”的部分

- 当前机器没有 Windows VM/runner，因此没有本地伪造 Named Pipe 运行结论；
- 没有发布证书，未执行真实 Developer ID/Authenticode 签名与 Apple notarization；
- 原型验证了封装和 supervisor 契约，没有实现生产 Session Registry；
- installer 体积、冷启动、10 个并发文档 Session 与活跃 MCP/Subagent 的压力指标留给
  实现期 `PK-001/QA-001` gate，不由这个封装选择提前猜测。

## 官方依据

- [Node.js 22.19.0 Single executable applications](https://nodejs.org/download/release/v22.19.0/docs/api/single-executable-applications.html)
- [Node.js 22.19.0 IPC/Named Pipe](https://nodejs.org/download/release/v22.19.0/docs/api/net.html#ipc-support)
- [electron-builder Application Contents](https://www.electron.build/docs/contents/)
- [Electron Code Signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [Microsoft Named Pipe Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)
