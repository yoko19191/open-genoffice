# Runtime IPC 使用带认证的本地 Socket

Electron 与 `open-genoffice-pi-agent-runtime` 在 macOS/Linux 使用 Unix Domain Socket，
在 Windows 使用 Named Pipe。每次启动生成一次性随机握手 token，并在连接时校验协议
版本、Runtime 版本和父进程身份；不得监听公网网卡，也不使用固定共享 secret。

本地 Socket 支持 sidecar 崩溃重启、renderer reload 和多窗口重新订阅，比把 Runtime
生命周期绑死在 stdio 更适合桌面应用。stdio 只保留为独立 debug/test 模式的可选
传输，不进入正式 renderer 通信路径。
