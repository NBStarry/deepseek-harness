# Agent Note: Sidebar Browser 持久存储

Status: implemented

[English](2026-11-02-sidebar-browser-persistent-storage.md) | 中文

## 问题

Desktop Browser 的临时 partition 在应用退出时丢失网站登录状态。相关 tab 需要共享持久站点数据，但不能共享应用 Session。

## 决策

[Desktop browser webview 决策](2026-09-20-desktop-browser-webview.zh.md)保留 guest 安全策略，原按工作区划分的临时存储策略被取代。同一 Desktop profile 的所有工作区和 Session 共享带版本的 Electron `persist:` partition。profile 准备完成后，主进程解析其真实路径并计算 SHA-256 摘要以选择 partition。租约仍是随机的、进程内的；渲染进程提供的工作区标识不决定存储位置。

partition 也属于 Electron 用户数据目录：更换用户数据目录后存储独立。同一用户数据目录中不同规范化 profile 路径使用不同 partition；同一 profile 的路径别名会解析到同一位置。移动 profile 可能导致 partition 改变。哈希不是加密或授权，可能被用来推测可猜测的路径。

## 考虑过的方案

**保持临时 partition。** 这限制数据保留时间，但每次退出都会丢失登录状态。

**导入 Chrome 数据。** 这会跨越浏览器与账号边界，并依赖另一应用的凭据存储。

## 影响

持久 Cookie 与网站存储可以跨应用重启保留；会话 Cookie 和站点策略仍可能要求重新登录。原有进程内数据不会迁移。旧按工作区持久分区构建的数据也不会自动迁移或删除。关闭 tab、删除 Session 或退出 DSH 账号后，站点数据仍留在磁盘。目前没有专门的站点数据清除入口，也没有自动清理孤立 partition 的机制。站点退出登录可以撤销其登录状态，但未必会删除全部本地数据。不要将删除整个应用用户数据目录视作安全的浏览器专用重置方式。

使用隔离 Electron 用户数据和本地合成站点的测试，验证了持久 Cookie、localStorage、跨工作区共享、profile 隔离和跨独立进程的清除行为。它不覆盖产品 webview 或全部 guest 安全与生命周期行为。
