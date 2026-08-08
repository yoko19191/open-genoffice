# 验证 WebDAV 与 S3 共用的 Revision 模型

Type: prototype

Status: open

## Question

什么最小 manifest、revision、内容哈希和 tombstone 模型能同时支持 WebDAV、AWS S3
与 MinIO，并保证本地 current revision 不被远端静默覆盖？原型应覆盖 Office 文件、
已落盘 Pi Sessions、Skills、Extensions、Prompts、Package lock、脱敏 MCP 配置和普通
资产，验证离线队列、并发编辑、Conflict Copy、用户接受远端版本、删除恢复、TLS、
S3 provider-side encryption，以及新设备重新信任与重新配置 secret。
