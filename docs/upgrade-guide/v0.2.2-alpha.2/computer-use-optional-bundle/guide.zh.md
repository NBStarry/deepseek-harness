---
kind: upgrade-guide
description: "此前使用内置 Computer Use 组合包的 Desktop profile 升级后需要单独安装。"
---

# 安装可选的 Computer Use 组合包

[English](guide.md) | 中文

## 变更

Desktop 的默认运行环境不再包含 `@deepseek-ai/dsh-cua-bundle`。现有 profile 可能仍在 `dsh.profile.bundles` 中选中了此前内置的组合包，但没有将它安装为 profile 依赖。升级后若无法解析到该组合包，DSH 会跳过它并报告诊断信息；已保存的选择保留，但 Computer Use 不可用。更新 Desktop 不会向 profile 安装该组合包。

## 迁移

1. 如不需要 Computer Use，在插件页取消选择缺失的组合包。如需使用，在每个 macOS Desktop profile 的“插件 → 添加插件”中安装 `@deepseek-ai/dsh-cua-bundle` 并启用。已有选择不代表软件包已安装。官方安装目标与正在运行的 DSH 版本匹配，安装前请确认已有包含原生 helper 的兼容软件包。
2. 已发布的 `@deepseek-ai/dsh-experimental-cua-macos@0.2.2-alpha.2` 软件包缺少原生 helper。单独重新安装该版本不能恢复原生 Computer Use；请在可用时使用提供方包含预构建 helper 的兼容版本。[Computer Use 组合包文档](../../../../packages/experimental/cua-bundle/README.zh.md)说明源码开发方式和当前限制。
3. 按提示重启 DSH，检查插件诊断信息和 Computer Use 权限页。在目标会话中启用 PTC，并授予所需的 macOS 权限。安装成功或保留选择本身不能证明提供方已加载或已获得权限。
