---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-01-service-tier-capabilities

[English](2026-11-01-service-tier-capabilities.md) | 中文

## 概述

将可选 serviceTier 选择与请求控制从 priority 扩展为 default 或 priority。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-01-service-tier-capabilities
baseline: false
changes:
  - root: "event:model/selection"
    previous: "2026-11-01-session-codex-fast"
    after: "d61dc5ca6ca41e0ede2ffe77cbc65a35ed5815586f4bd46da6854ccf61fb369c"
    decision: same-version
  - root: "event:request/header"
    previous: "2026-11-01-session-codex-fast"
    after: "09bbb27cea36ef5c8a4e02515d361d52fc736a0d7a98d4c7cff4be138b41b6c6"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有省略和 priority 值保留原有含义。新读取器接受显式 default，且保持其与省略的区别。官方 V4 基线保留未知嵌套字段；此前仅支持 priority 的社区读取器则会拒绝恢复包含 default 的 request/header。其既有校验器仅增加对 default 的接受，恢复在活跃 Agent 能派发或追加之前执行；这种语义错误不请求截断回退。服务层级升级指南说明包含这些请求头的历史不支持降级到该社区读取器。未知层级回归覆盖读取与写入句柄、Session 恢复拒绝和代际文件字节不变。保留历史 schema 记录与写入格式版本不变，投影缓存版本独立递增。

<a id="verification"></a>
## 验证

更新人工编写的 fixture 后，当前无密钥 SDK 的 codex-fast 与 session-resume 回放均通过，覆盖省略、priority、显式 default、同路由恢复及路由变更。Python SDK 投影与恢复测试通过三项。JSONL current-event-admission 通过七项，包含严格与可恢复三态往返，以及拒绝不支持的层级恢复而不修改文件。源码审查直接比较此前仅支持 priority 的校验器。重建产物之前，使用旧编译读取器的真实 SDK 回放恢复曾拒绝 default 请求头；未启动或修改旧桌面安装。适配器与模型选择针对性测试使用模拟响应，不发真实提供方请求。

<a id="dev-note"></a>
## 开发备注

无。
