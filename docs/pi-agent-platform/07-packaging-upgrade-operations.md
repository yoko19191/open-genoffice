# 打包、升级与运维手册

状态：Scaffold

主要读者：Electron 构建、发布、安全、支持与值班工程师。

## Runtime bundle 与 manifest

[待共同编写] Node `22.19.0`、unpacked ESM、Pi/原生模块、hash、license/notices、asar 与
`extraResources` 布局和 fail-closed 校验。

## 平台矩阵

[待共同编写] macOS signing/notarization、Windows Authenticode/Named Pipe/Job Object、
Linux glibc/executable bit/AppImage，以及哪些证据必须来自原生 runner。

## Build、安装与首次启动

[待共同编写] 可复制命令、输入 secret、artifact 命名、首次 Resource Home、Runtime
handshake 和离线启动检查。

## 升级与旧数据清理

[待共同编写] schema/version gate、旧聊天/Provider/Genspark 凭据幂等删除、失败恢复和
版本降级安全性。

## 退出、卸载与进程回收

[待共同编写] graceful shutdown、forced cleanup、MCP/Subagent child tree、socket/temp、
保留用户文档与删除应用数据的差异。

## 诊断与支持包

[待共同编写] 健康检查、日志位置、脱敏字段、用户可导出诊断、常见故障树和不得收集的
secret/document 内容。

## 发布与回滚

[待共同编写] RC hard gates、签字人、SBOM/license/notices、Genspark-Free 静态/网络审计、
上一版签名产物回滚和不可豁免项。

## 候选 tracer bullets

[待 `to-issues` 提取] 按可独立验收的发行路径拆分，如“Windows 安装包启动 Runtime 并回收
完整进程树”，而不是按 signing、installer、测试分别拆横向票。

## Reader Test

[待编写] 读者应能从干净机器完成安装、诊断启动失败、验证无孤儿进程、执行升级/回滚并
判断某个 RC 是否允许发布。
