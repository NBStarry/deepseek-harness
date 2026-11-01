---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-01-session-codex-fast

[English](2026-11-01-session-codex-fast.md) | 中文

## 概述

为持久化模型选择和请求配置增加可选的 priority serviceTier。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-01-session-codex-fast
baseline: false
changes:
  - root: "event:model/selection"
    previous: "2026-09-11-initial"
    after: "f2fb450e60ded86e1cae7734d3ca103e4d46add15f3e7267bf4bcb211333065d"
    decision: same-version
  - root: "event:request/header"
    previous: "2026-09-16-session-format-v4"
    after: "fcdea6a5a9acc421c24067202095b6ab4f8804bb6c57d0a1fbf420934277695c"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录缺少 serviceTier 时保留默认处理行为。新读取器仅接受可选的 priority 值。原有 V4 事件解码保留嵌套字段；旧模型选择投影从请求头派生选择时忽略此可选处理功能，旧适配器不转发该字段，因此降级后不提供 Fast 处理。不改变事件判别字段或 Session 格式版本。投影状态版本变化使选择缓存重新计算一次，不增加逐请求持久化回读。

<a id="verification"></a>
## 验证

离线针对性测试通过：模型选择、系统提示准入、请求头、会话、调用配置及使用模拟 fetch 的 Codex SDK 序列化（加入最终 OAuth 用例后 145 项）；配置恢复、适配器、SDK 选项和 LLM 服务（179 项）。SDK 服务端恢复测试通过 17 项，控制器模型选择测试通过 27 项。未执行真实提供方请求或在线安装。

<a id="dev-note"></a>
## 开发备注

无。
