# 升级时抛弃旧 Agent 聊天记录

迁移到 Pi Agent Platform 时不转换、不归档旧 Project Store 中的 Agent 聊天记录，
新版本只读取 Pi 原生 Session。旧记录缺少完整的 tool-call/result graph、compaction
和 lineage，保留一条不完整的兼容路径会使两套历史格式长期存在，并模糊唯一事实源。

升级也不迁移旧 Provider 配置、明文 API key 或 Genspark token；安装器直接删除这些
旧数据，用户在新 CredentialStore 和 Provider UI 中重新配置。迁移不保留 Genspark
兼容层、自动导入或只读回退入口。
