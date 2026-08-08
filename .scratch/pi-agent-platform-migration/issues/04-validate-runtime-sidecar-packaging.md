# 验证 Runtime Sidecar 三平台封装

Type: prototype

Status: open

## Question

`open-genoffice-pi-agent-runtime` 应以何种可执行文件形态随 Electron 在 macOS、Windows
和 Linux 打包，才能可靠加载 Pi ESM、Extensions、MCP stdio 子进程和原生依赖？原型
需要验证 UDS/Named Pipe、一次性握手 token、版本拒绝、崩溃重启、应用退出回收、
独立 debug 模式、签名/公证和安装路径，不得退回 `utilityProcess` 或系统常驻服务。
