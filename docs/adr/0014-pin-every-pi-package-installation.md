# 所有 Pi Package 安装必须固定版本

GenOffice 首版只接受本地目录、精确 npm 版本和固定 Git commit 三类 Pi Package 来源。
npm semver range、Git branch/tag 漂移和静默自动更新均不允许。全局与项目级资源分别
维护 lockfile，记录来源、解析版本、内容哈希、许可证和信任状态；本地目录也记录内容
哈希。

更新必须由用户显式触发，生成新的 lock 条目并重新执行完整性、权限和兼容性检查。
同步 lockfile 不同步信任结论，目标设备仍需对可执行 Package 重新授权。
