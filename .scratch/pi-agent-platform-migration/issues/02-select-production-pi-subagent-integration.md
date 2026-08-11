# 选择生产级 Pi Subagent 集成路径

Type: research

Status: resolved

## Question

在 Pi 官方示例、`@agwab/pi-subagent`、`@agwab/pi-workflow` 和本地候选中，应固定哪个
实现承载生产级 Subagent？需要验证结构化事件、Parent/Child lineage、并发与预算、
级联取消、Session 恢复、只读默认值、Mutation Grant 接入、许可证和 Electron 打包，
并说明 GenOffice 必须保留的最小 `SubagentProvider` 适配边界。

## Comments

### 2026-08-09 — 候选与版本核验

- 唯一 Runtime 继续精确固定为 Pi Web 使用的
  `@earendil-works/pi-{ai,agent-core,coding-agent,tui}@0.84.0`。本地 Pi checkout 是较旧的
  `0.78.0`，只能用于交叉阅读，不能改变生产锁定版本。
- 执行引擎选择 `@agwab/pi-subagent@0.4.8`，源码固定到
  `daa7b83819116a62008ad17aa65fcd50fefbafd0`，MIT，Node.js `>=22.19.0`，通过公开的
  `@agwab/pi-subagent/api` 接入。它提供结构化事件、并发、超时、run artifacts、
  reconcile 和 headless session ID，足以复用执行与恢复基础。
- `@agwab/pi-workflow@0.11.0`（commit
  `1d77e5fcae22292eeba548a7ce7a554b0d82d2e3`）只允许以后作为用户显式启用的 Workflow
  插件，不承担 `SubagentProvider`。Pi 官方 example 只作协议参考；无许可证且硬编码
  `~/.pi` 的 `pi-config` 实现，以及会引入第二 Runtime 的 `oh-my-pi`，均不采用。
- `pi-subagent` 不是产品权限边界：它没有权威 parent/root run tree、token/cost/depth/
  children 总预算、递归后代取消、默认只读语义或 `MutationGrant`。这些属于 GenOffice，
  不能以包内 tool allowlist 代替。
- 包当前不支持原生 Windows，async worker 及动态加载源码必须位于 Electron unpacked
  resources。macOS/Linux 可行性高；Windows 同等支持必须由 Sidecar spike 单独证明，
  未通过前不得宣称三平台 Subagent 可用。

上游证据：[`pi-subagent` package.json](https://github.com/AgwaB/pi-subagent/blob/daa7b83819116a62008ad17aa65fcd50fefbafd0/package.json)、
[事件 schema](https://github.com/AgwaB/pi-subagent/blob/daa7b83819116a62008ad17aa65fcd50fefbafd0/src/artifacts/registry.ts#L26-L132)、
[取消实现](https://github.com/AgwaB/pi-subagent/blob/daa7b83819116a62008ad17aa65fcd50fefbafd0/src/orchestrate/interrupt.ts#L41-L187)、
[headless session 分支](https://github.com/AgwaB/pi-subagent/blob/daa7b83819116a62008ad17aa65fcd50fefbafd0/src/runners/headless-model.ts#L168-L220)。

## Answer

生产路径固定为 Pi `0.84.0` + `@agwab/pi-subagent@0.4.8`，但第三方 package 只作为
Subagent execution/artifact engine。GenOffice 必须提供唯一、薄且不可绕过的
`SubagentProvider`，至少暴露：

```ts
interface SubagentProvider {
  spawn(request: SpawnSubagentRequest, context: ExecutionContext): Promise<SubagentRun>
  watch(runId: string, cursor?: string): AsyncIterable<SubagentEvent>
  status(runId: string): Promise<SubagentSnapshot>
  wait(runId: string, options?: WaitOptions): Promise<SubagentSnapshot>
  cancel(runId: string, options: { cascade: true; reason: string }): Promise<CancelReport>
  resume(runId: string, options?: ResumeOptions): Promise<SubagentRun>
  listChildren(parentRunId: string): Promise<SubagentRef[]>
}
```

Provider 自己持久化 `runId`、`parentRunId`、`rootRunId`、`parentSessionId`、`documentId`、
`providerRunId`、`attemptId`、`correlationId`、budget/grant snapshot 与 status，并只向 UI
发布 `queued`、`started`、`assistant.delta`、`tool.started`、`tool.completed`、
`usage.updated`、`child.linked`、`completed`、`failed`、`cancelled` 这些稳定事件。

没有有效 `MutationGrant` 时，Provider 必须合成只读工具集；模型传入的 tools 不得直接
透传。Grant 精确绑定 `subagentRunId + documentId + exactToolIds + expiry`，终态自动撤销。
父任务取消必须依据 GenOffice 的 run tree，child-first、幂等地终止所有后代并 reconcile；
Pi usage event 由 Provider 累计，用同一取消路径执行 depth、children、concurrency、wall
time、token 与 cost 预算。

首版采用带稳定 session ID 的 headless runner；inline 内存 Session 不承诺跨 Sidecar
重启恢复。不得使用包的 named-agent discovery，而要从 `~/.open-genoffice` 和项目级
`.open-genoffice` 解析后显式传入 prompts、tools、Skills、Extensions 与 MCP，借此保证
不读写 `~/.pi`。

验收必须覆盖：fake HOME 零 `~/.pi` 访问、默认只读、Grant 精确生效与撤销、全后代级联
取消、Sidecar 强杀后的 reconcile/resume、安装包内 spawn/watch/cancel/restart 全链路，
以及 lockfile、integrity、MIT LICENSE、Notices 与 SBOM。任一门槛未过，不得启用生产
Subagent。
