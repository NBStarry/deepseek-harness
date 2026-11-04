---
kind: upgrade-guide
description: "Web 和 SDK 标准会话在原生工具旁提供 run_code 与 apply_patch。"
---

# 标准会话同时提供原生工具和 run_code

[English](guide.md) | 中文

## 变更

Web 和 SDK 标准会话在允许的原生工具旁提供 `run_code` 和 `apply_patch`。它们使用一个混合模式的 PTC 执行器；嵌套工具调用仍遵循原有策略和审批检查。纯 PTC 配置仍仅直接提供 `run_code`。额外的 SDK 声明和 schema 会增大模型请求，并可能影响提示词缓存复用。在已录制的 SDK desktop-context 示例中，首次系统提示词从 4,575 字节增至 59,949 字节，工具 schema 测试数据增加 4,480 字节。实际 token 数量和缓存行为取决于模型及服务商，该示例未测量这两项。

`run_code` 执行受沙箱约束的程序，既可使用运行时 API，也可使用工具绑定。直接通过运行时写入文件遵循沙箱策略，而不遵循文件工具的先读后写观察策略。既有 shell 命令也有这一差别。工作区可写模式下，平台临时目录也可能可写。

## 迁移

1. 整体替换 `preset-standard` 配置的 Web profile 覆盖可能遮蔽新执行器或文件系统选项。将带 `hybrid: true` 的 `tool-executor-ptc` 和带 `applyPatch: true` 的 `tool-fs` 合并进该 profile 原有的 standard 插件列表，保留其他设置。不要在同一作用域挂载第二个执行器。
2. 选择纯 PTC 的 SDK 覆盖须将 PTC 执行器的 `hybrid` 设为 `false`；随附的 PTC 示例还会恢复 `applyPatch: false`。启用混合模式时，自定义工具顺序列表可包含 `run_code`。
3. 更新组合后，在新会话中检查有效工具列表。已有活动会话可能仍使用先前的预设版本。`apply_patch` 结果可能只部分提交；重试前应检查各操作状态和 stopped 元数据。
