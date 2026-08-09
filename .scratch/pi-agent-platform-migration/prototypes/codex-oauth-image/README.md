# Codex OAuth 图片生成兼容性探针

> PROTOTYPE — 对比公开 OpenAI API 与 ChatGPT Codex Responses 两条图片路径，不能直接进入
> 生产包。

这个探针精确固定 Pi Web 当前使用的 `@earendil-works/pi-ai@0.84.0` 与
`@earendil-works/pi-coding-agent@0.84.0`，通过 Pi 0.84 的公开 `ModelRuntime.login()`
完成 ChatGPT/Codex device-code OAuth 登录。凭据存储和模型存储都在内存中，进程的
`HOME` 也被隔离到一个不会主动创建的原型目录；它不会读取 `~/.pi`、`~/.codex` 或其他
客户端凭据，也不会把 access token、refresh token 写入文件或输出到终端。

目录包含两个互相独立的探针：

- `probe.mjs` 是负向对照，验证 Codex OAuth token 不能直接作为公开
  `api.openai.com/v1` 的 Bearer token。
- `probe-responses.mjs` 参考 Sub2API 的协议设计，直接使用同一 token 请求
  `chatgpt.com/backend-api/codex/responses`，并把 `gpt-image-2` 作为
  `image_generation` 服务端工具模型。

## 运行与费用边界

```bash
npm install --ignore-scripts
npm run probe -- --check-runtime
npm run probe
```

`--check-runtime` 只验证 Pi 版本、Provider 与内存存储契约，不启动登录，也不访问 OpenAI。

默认只请求 `GET /v1/models/gpt-image-2`，用于判断这枚 OAuth access token 是否被公开
OpenAI API 接受，不产生图片费用。若鉴权通过，命令以状态码 `2` 退出并要求人工确认。

公开 API 探针默认不会生成图片。Codex Responses 探针会产生一次真实图片生成用量，只有
用户明确接受后才运行：

```bash
npm run probe:responses -- --output=/tmp/open-genoffice-codex-oauth-response.png
```

输出只包含 HTTP 状态、Responses ID、事件计数、图片格式/尺寸/字节数/SHA-256、脱敏 usage
和 verdict。OAuth token、refresh token、ChatGPT account ID 和图片 base64 均不输出；只有
显式传入 `--output` 时才写入一个使用 `wx` 防覆盖的本地文件。

## 协议形状

参考的 Sub2API 版本是 commit
`cc67b1aca1d3b590609abef2fcd3a6ca31c5c651`。只参考协议行为，不依赖或复制其 LGPL
实现。首版请求固定为：

```text
POST https://chatgpt.com/backend-api/codex/responses
outer model: gpt-5.4-mini
tool.type: image_generation
tool.action: generate
tool.model: gpt-image-2
stream: true
```

单图请求不能传 `tools[0].n: 1`；实测会返回
`400 unknown_parameter`。因此首版一次只生成一张图并完全省略 `n`。最终图片从
`response.output_item.done.item.result` 或
`response.completed.response.output[]` 提取，`partial_image_b64` 只用于进度和故障诊断。

## 2026-08-09 真实账户结果

真实账户最初通过同一 Pi OAuth 实现的 `0.78.0` 源码完成 device-code 登录；免费鉴权
探针返回 HTTP `403`，OpenAI request ID 为
`8192ddcb-6ecd-4440-9ae2-df5714d0bbdf`。探针没有进入计费调用。随后对齐到 `0.84.0`：
该版本仍使用相同的 OpenAI OAuth client ID、`auth.openai.com`、device-code 流、scope
`openid profile email offline_access`，并仍把 Provider 指向 `chatgpt.com/backend-api`；
`--check-runtime` 已验证公开 `ModelRuntime` 接口可用且没有创建隔离 HOME。

这只证明公开 API 直连不成立，不再把它外推为“Codex OAuth 不能生成图片”。

## 2026-08-09 Codex Responses 真实账户结果

Pi `0.84.0` 的公开 `ModelRuntime.login()` 完成 device-code 登录后，探针使用 Pi 自己的
`originator: pi` 与 User-Agent 发起请求，没有伪装官方 Codex CLI。第一次请求因携带
`tools[0].n: 1` 得到 `400 unknown_parameter`，按 Sub2API 的省略规则修正后，同一协议
端到端通过：

| 项目         | 实测结果                                                           |
| ------------ | ------------------------------------------------------------------ |
| HTTP         | `200`                                                              |
| Response ID  | `resp_02e707e575c6076d016a77d978fc0c8199bbab20c5b409d883`          |
| 外层模型     | `gpt-5.4-mini`                                                     |
| 图片工具模型 | `gpt-image-2`                                                      |
| 生命周期     | 包含 generating、partial image、output item done、completed        |
| 图片         | PNG，1254×1254，651446 bytes                                       |
| SHA-256      | `7147b4fc7343432a29a7302859b6f3bd71a6df1178a554d6c1ae61ac9cc5bb68` |
| 图片工具用量 | input 44、output 229、total 273 tokens                             |
| 凭据落盘     | 无；隔离 HOME 未创建                                               |

请求指定 `1024x1024`，实际文件为 1254×1254，因此生产实现必须读取和展示真实输出尺寸，
不能把请求尺寸当作文件尺寸。`file` 与 macOS `sips` 均验证文件是可解码 PNG。

结论：Codex OAuth 图片生成可以通过 ChatGPT Codex Responses 的
`image_generation` 工具实现；公开 Images API 仍不可直连。生产发布前仍需覆盖 OAuth
refresh/revoke、超时取消、限额、协议回归、安装包和错误映射。
