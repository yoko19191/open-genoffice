# 应用切换手册

状态：Scaffold

主要读者：各应用 owner、共享 UI、Runtime、QA 与发布工程师。

## 共同切换算法

[待共同编写] 冻结黄金行为 → 开发构建接入 Pi → fake/真实 Provider 与故障 E2E → 生产
入口只指向 Pi → 在进入下个应用前删除本应用旧 IPC/Agent/Genspark 路径。

## PDF 纵向切片

[待共同编写] 当前入口、工具、Session/UI、MinerU、测试、删除点和完成演示。

## Docs 纵向切片

[待共同编写] 实时 selection/document context、mutation snapshot、附件、测试和删除点。

## Sheets 纵向切片

[待共同编写] workbook/sheet/range context、顺序 mutation、公式/格式和删除点。

## Slides 与 Slide QC 原子切换

[待共同编写] 整页生成、图片、media、QC、失败保留原页和全部 GSK 路径清理。

## 共享旧层删除

[待共同编写] 何时删除 `packages/agent-core`、`packages/ai-provider`、Genspark 登录/CLI/
服务/i18n/资源，以及证明生产图中无引用的方法。

## 研发与正式发布边界

[待共同编写] developer/nightly 可见性、禁止半切换正式版本、同包无旧 Runtime fallback 和
只允许回滚上一版签名产物。

## 候选 tracer bullets

[待 `to-issues` 提取] 每张票交付一个可演示的用户流程并在同票或直接后继票删除对应旧
入口；不创建“迁移整个 PDF/Docs”这类无法独立抓取的大票。

## Reader Test

[待编写] 读者应能判断某应用当前处于哪一步、哪些旧代码必须删除、什么证据允许开始下一
应用，以及失败时是否可以发布。
