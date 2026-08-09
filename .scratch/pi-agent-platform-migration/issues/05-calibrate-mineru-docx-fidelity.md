# 标定 MinerU DOCX 版式保真边界

Type: prototype

Status: resolved

## Question

用代表性 PDF 样本验证 MinerU `extra_formats: ["docx"]` 的真实质量，并决定首版应承诺
哪些版式保真边界。样本至少覆盖文本论文、双栏、表格、公式、扫描件、中英文混排和
图片密集文档；记录结构、阅读顺序、表格、公式、图片、字体与页级布局损失，并形成
自动检查、人工黄金样例和“不保证保真”提示条件。

## Contract evidence

2026-08-09 已对照 MinerU 官方 API 文档完成本地契约原型，见
[`../prototypes/mineru-docx`](../prototypes/mineru-docx/)：

- 精准解析 API 的 `extra_formats` 明确支持 `docx`、`html`、`latex`；本地文件通过
  `POST /api/v4/file-urls/batch` 获取签名 URL，以原始 PUT 上传，然后轮询
  `GET /api/v4/extract-results/batch/{batch_id}`；
- GenOffice 固定一文档一批、`model_version: "vlm"`、`extra_formats: ["docx"]`；不依赖
  官方页面中“批量 200 个”与“单次申请链接 50 个”两处不同口径；
- 已覆盖 `waiting-file`、`pending`、`running`、`converting`、`uploading`、`done`、
  `failed`，并将鉴权、配额、转换、服务、超时错误转成稳定的产品状态；
- 本地取消只中止请求、轮询与下载。官方文档没有远端取消接口，UI 不得声称云端任务
  已取消；
- 结果下载强制 HTTPS，限制压缩包与解压体积，拒绝路径穿越，只接受一个 DOCX，并
  校验 WordprocessingML content type 与 `word/document.xml`；
- 21 个 contract/security/fidelity-score tests 全部通过；lines 100%、branches 95.77%、
  functions 100%，
  ESLint 通过。测试不读取 token；真实运行不记录 token、签名 URL、结果 URL或任务 ID。

## Live fidelity evidence

质量承诺按“可编辑、语义保真”标定，不承诺逐页像素级一致或原字体保留。实测语料固定
为新生成的非敏感 1–2 页 PDF，覆盖中英文正文、双栏、合并单元格表格、行内/块级公式、
图片密集页与扫描中英文页。自动门检查 DOCX 可打开、正文和阅读顺序、表格是否仍可编辑、
公式表示、图片资源完整性；人工门记录越界、重叠、分页与字体损失。

用户于 2026-08-09 明确同意上传五个新生成、无敏感内容的单页 PDF。随后通过精准解析
Standard API 串行完成 5/5 签名上传、异步解析、结果下载、DOCX/OOXML 校验与渲染，
没有调用 Agent 轻量解析 API，也没有发生自动降级。仅扫描样本没有 PDF 文本层。

| 样本           | 自动门 | 实测边界                                                                                    |
| -------------- | ------ | ------------------------------------------------------------------------------------------- |
| 中英文正文     | 通过   | 全部 marker、正文与阅读顺序保留，文本可搜索编辑；不承诺原字体和像素版式                     |
| 双栏与公式     | 不通过 | 阅读顺序正确，但双栏展开为顺序段落，公式是普通文本，`formulaCount = 0`，没有 Word OMML 公式 |
| 合并表格与图片 | 通过   | 合并表头保留为实际 Word 表格，图片作为独立资源嵌入，正文可编辑                              |
| 图片密集页     | 不通过 | 六张图均保留，但单页重排为三页；图内 label 可见却不进入正文文本层，标题/marker 不可搜索     |
| 扫描中英文页   | 不通过 | OCR 文本及阅读顺序保留，但原扫描底图未嵌入，`imageCount = 0`                                |

修正黄金语料 marker 顺序并把 OMML 数量纳入阻断门后，最终自动结果为 2/5 通过。全部
DOCX 都能通过 ZIP/OOXML 校验并由 LibreOffice 打开；“可打开”不等于“版式保真”。

## Resolution

首版固定使用精准解析 Standard API 作为 MinerU PDF→DOCX 路径。Agent 轻量解析不能作为
失败后的静默回退；如果以后提供，只能成为用户显式选择的独立“文本 OCR”模式。

产品承诺收窄为“生成可打开的 DOCX，尽量保留可编辑正文、阅读顺序、简单/合并表格和
独立图片”。产品必须持续提示：结构化公式、原始栏布局、页数、字体、图内可搜索文字和
扫描底图不保证保留，原 PDF 始终保留。图片密集、扫描和公式文档不允许展示“高保真
转换”文案；转换完成后应提供原 PDF 与 DOCX 并排检查入口。
