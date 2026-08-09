# 验证 WebDAV 与 S3 共用的 Revision 模型

Type: prototype

Status: resolved

## Question

什么最小 manifest、revision、内容哈希和 tombstone 模型能同时支持 WebDAV、AWS S3
与 MinIO，并保证本地 current revision 不被远端静默覆盖？原型应覆盖 Office 文件、
已落盘 Pi Sessions、Skills、Extensions、Prompts、Package lock、脱敏 MCP 配置和普通
资产，验证离线队列、并发编辑、Conflict Copy、用户接受远端版本、删除恢复、TLS、
S3 provider-side encryption，以及新设备重新信任与重新配置 secret。

## Decision

WebDAV、AWS S3 与 MinIO 共用内容寻址的对象模型，见
[`../prototypes/sync-revision`](../prototypes/sync-revision/)：

```text
open-genoffice-sync/v1/{project|global}/{scopeId}/
  head.json
  blobs/sha256/{contentDigest}
  revisions/{revisionDigest}.json
```

blob 与 revision 是 `If-None-Match: *` 创建的不可变对象；`head.json` 是唯一可变对象，
以 Provider 返回的强 ETag 作为 `If-Match` CAS token。S3 ETag 只用于并发控制，不能当
内容哈希；multipart 与 provider-side encryption 都可能改变其含义。正文完整性统一用
SHA-256 验证。

Revision 最小字段固定为 schema version、namespace、scope、canonical path、kind、
content hash、size、tombstone、0–2 个 parent、author device、event 和 executable/network
标记。Manifest 保存 generation、parent manifest ID、writer 与路径到 current revision 的
映射；generation 只用于诊断，正确性只依赖 CAS、内容哈希和 ancestry，不读取 wall-clock。

## Conflict and deletion rules

- 只有一端偏离已确认 base 时安全快进；远端 tombstone 永远需要用户确认，已知路径从
  manifest 消失视为异常，不当作删除；
- 两端分叉时，本地工作文件继续作为 current，远端 revision 落为未决 Conflict Copy，
  该路径在用户选择前不发布；其他无冲突路径仍可继续同步；
- `keep-local` 和 `accept-remote` 都创建一个以本地、远端两个 head 为 parent 的新本地
  resolution revision。选中的内容成为最后一次本地写入，未选中的旧 revision 成为
  Conflict Copy；
- 离线队列只保存 `reconcile(namespace, scopeId)` 意图。恢复联网后必须重新读取 head 并
  规划，禁止重放旧 ETag、PUT 或 DELETE；
- 删除只用 tombstone 表达。immutable object 的保留与 GC 不进入首版同步关键路径。

## Provider boundary

- WebDAV 固定复用 `webdav@5.10.0`（MIT）处理 Basic/Digest/Bearer 和请求栈，薄适配层
  保留条件头与二进制 `Buffer` 转换；只接受 HTTPS、强 ETag 和条件 PUT。不能满足这些
  条件的服务在连接诊断时 fail closed；
- S3 固定官方 `@aws-sdk/client-s3@3.1106.0`（Apache-2.0），支持 AWS/S3-compatible
  endpoint、region、bucket、prefix、path-style，并映射 `AES256` 与 `aws:kms`；服务必须
  支持 conditional `PutObject`，开启 bucket versioning 不能代替 CAS；
- Project 与 Global Asset 使用不同 namespace/head。凭据、Project Trust 和设备设置
  不进入 manifest/revision/离线队列；同步到新设备的 executable/network 资源按内容
  hash 默认禁用并重新授权。

## Evidence

2026-08-09：

- 24 个 model/repository/provider contract tests 全部通过；lines 100%、branches 98.82%、
  functions 100%，ESLint 通过；
- `webdav@5.10.0` 经本机回环服务实跑 immutable PUT、manifest round-trip、强 ETag 与
  stale CAS rejection；过程中发现并修复 `Uint8Array` 必须转 `Buffer` 的传输边界；
- `@aws-sdk/client-s3@3.1106.0` 对
  `MinIO RELEASE.2026-02-14T12-00-00Z` 实跑随机 bucket，immutable object、manifest
  round-trip 和 stale CAS rejection 通过；测试 bucket 与容器已删除；
- AWS S3 TLS、SSE-S3/SSE-KMS 与常见 WebDAV 厂商矩阵仍属于 `SY-001/SY-002/SY-008`
  的发行环境证据，不再是 revision 模型的未决设计。
