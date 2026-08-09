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

远端对象布局固定为
`open-genoffice-sync/v1/{project|global}/{scopeId}/`：blob 和 revision 以 SHA-256
内容寻址并不可变，`head.json` 是唯一可变对象。创建不可变对象使用
`If-None-Match: *`，更新 head 使用 Provider 强 ETag 的 `If-Match` CAS。S3 ETag 只能
作为版本 token，不得代替内容哈希。WebDAV 服务必须提供强 ETag 和条件 PUT；S3 服务
必须支持 conditional `PutObject`，bucket versioning 不能替代 CAS。

Revision 包含 namespace、scope、canonical path、kind、content hash、size、tombstone、
0–2 个 parent、author device、event 与 executable/network 标记，不保存 wall-clock。
Manifest 的 generation 只用于诊断，不能用于决定冲突胜者。删除只由 tombstone 表达；
远端 tombstone 需用户确认，已知路径从 manifest 消失视为错误，不得解释成删除。

发生分叉时，在用户选择前不发布冲突路径，本地文件保持 current，远端 revision 作为
Conflict Copy 供比较。`keep-local` 或 `accept-remote` 都创建一个以两个分叉 head 为
parent 的新本地 resolution revision，未选中的旧 revision 成为 Conflict Copy。离线
队列只保存 reconcile 意图，恢复后重新读取 head，不能重放旧 ETag 或旧请求。

实现固定复用 `webdav@5.10.0` 处理 Basic/Digest/Bearer 与请求栈，条件写由薄适配层
控制；S3 固定官方 `@aws-sdk/client-s3@3.1106.0`，支持 `AES256`、`aws:kms`、自定义
endpoint 和 path-style。同步凭据在连接时从 CredentialStore 解析，不进入上述对象。
