# 云项目同步必须覆盖 WebDAV 与 S3

GenOffice 的云项目能力不再依赖 Genspark，改由自有 Project Sync Provider 承载，并在
首个完整版本同时支持 WebDAV 与 S3 Bucket。同步边界处理 Office Project 的文件、
资产、元数据、绑定的 Pi Agent Session，以及图片、模板、Skills、Extensions、Prompts
和脱敏 MCP 配置等 Global Asset。项目数据和 Global Asset 使用不同远端 namespace，
不能把全局资产复制进每一个项目。

凭据、Project Trust 和设备设置不得进入同步包。同步到新设备的 Extension、带脚本的
Skill 和 stdio MCP 默认禁用，必须在本机重新取得信任；内容哈希变化后原信任失效。
MCP 配置只同步结构和 CredentialStore 引用槽位，用户需在目标设备重新提供 secret。
首版强制使用 TLS，并支持 S3 provider-side encryption 配置，不实现客户端端到端
加密。

WebDAV 与 S3 共用一套本地项目清单、版本与冲突模型，避免形成两套云项目语义。远端
路径、认证和传输细节由 Provider 适配。本地工作副本始终保持主路径；检测到远端分叉
时，平台先把远端 revision 保存为 Conflict Copy，不静默覆盖本地文件。用户选择远端
版本时，该选择形成新的本地 current revision，被替换的旧 revision 转为 Conflict
Copy。排序依赖 manifest revision 和用户接受事件，不依赖跨设备 wall-clock。
