---
kind: upgrade-guide
description: "Desktop Sidebar Browser 站点数据现在会在应用退出后保留，而不再被丢弃。"
---

# Desktop Browser 站点数据持久保存

[English](guide.md) | 中文

## 变更

Desktop Sidebar Browser 之前使用临时 partition 存储站点数据，现在改为存储在 Desktop 应用用户数据目录的持久 partition 中。关闭 tab、删除 Session 或退出 DSH 账号都不会清除这些数据；目前没有专门的站点数据清除入口。退出网站账号也未必会删除全部本地数据。

## 迁移

1. 安装更新后的 Desktop 应用后，按需重新登录各网站。以前的临时数据不会迁移。如果曾使用旧的按工作区分区构建，其数据不会自动迁移或删除。会话 Cookie 和网站策略仍可能要求再次登录。
2. 重启 Desktop 并重新打开网站，包括从同一 profile 的其他工作区打开，检查登录状态是否保留。同一 Electron 用户数据目录中，不同的规范化 profile 路径使用不同分区；更换用户数据目录也会使用独立存储。移动 profile 可能改变其存储身份。
3. 将应用用户数据目录及其备份视为敏感数据。不要为了单独重置浏览器而删除整个目录；其中还包含其他应用数据。
