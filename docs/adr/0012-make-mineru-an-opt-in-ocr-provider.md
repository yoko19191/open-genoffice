# MinerU 作为默认关闭的 OCR 服务商

产品把 MinerU 归类为“**OCR 服务商**”，而不是内置 PDF 引擎或通用转换运行时。
设置中提供独立开启按钮，默认关闭；关闭状态下不向 MinerU 发送请求，也不要求配置
token。首次开启时必须弹窗说明文档会上传到第三方云端、授权持续生效以及关闭入口；
用户确认并完成凭据配置后，平台才暴露 MinerU OCR 与 PDF→DOCX 能力。后续不逐文件
重复确认，但相关界面持续显示这是云端处理。

MinerU 失败、配额耗尽或未配置不能影响本地 PDF 阅读编辑或 Pi Agent Runtime。其
DOCX 直接输出替代 Pandoc 主链路，token 仍由 CredentialStore 保存。
