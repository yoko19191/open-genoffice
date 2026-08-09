# Runtime IPC 使用带认证的本地 Socket

Electron 与 `open-genoffice-pi-agent-runtime` 在 macOS/Linux 使用 Unix Domain Socket，
在 Windows 使用 Named Pipe。每次启动生成一次性随机握手 token，并在连接时校验协议
版本、Runtime 版本和父进程身份；不得监听公网网卡，也不使用固定共享 secret。

Electron 先创建短路径 `0700` instance directory、新 endpoint 与 256-bit token，再把
`token + endpoint + protocolVersion + parentPid` 作为唯一一条 inherited stdin
bootstrap 传给 Runtime。token 不进入 argv、环境变量、磁盘或 renderer。Runtime 校验
`parentPid === process.ppid`，Electron 随后通过 Socket 发送 hello；只有成功 hello 才
消费 token，错误 token/版本和重用 token都必须拒绝。UDS mode 固定 `0600`；Named
Pipe 显式设置 `readableAll: false`、`writableAll: false` 并使用随机名称。

bootstrap stdin 在握手后保持打开，兼作父进程 lifetime sentinel。EOF、显式 shutdown
和应用退出进入同一个回收路径；崩溃重启必须生成新 directory、endpoint 和 token，不能
复用崩溃遗留的 UDS。renderer 只经过 Electron 的窄 IPC bridge，不直接连接 Runtime。

本地 Socket 支持 sidecar 崩溃重启、renderer reload 和多窗口重新订阅，比把 Runtime
生命周期绑死在 stdio 更适合桌面应用。stdio 只保留为独立 debug/test 模式的可选
传输，不进入正式 renderer 通信路径。
