---
kind: upgrade-guide
description: "Desktop Computer Use requires a user-initiated turn, even when a profile already enables it."
---

# Desktop Computer Use requires an interactive turn

English | [中文](guide.zh.md)

## Change

Use Computer Use in a top-level conversation by sending a prompt from the Desktop chat. An API peer with the same owner privileges does not qualify; neither do scheduled tasks, goal continuations or delegated agents. A saved application grant or `agentPreset: false` does not override this rule. Existing profiles keep their bundle selection.

## Migration

1. Move any desktop interaction out of unattended tasks. Send that request directly in a top-level Desktop conversation; keep the remaining background work in the task.
2. In Plugins, check that **Computer Use** is enabled or turn it off. In a supported local Apple Silicon build, new profiles start with the embedded bundle selected. To turn that copy back on after disabling it, enter `@deepseek-ai/dsh-cua-bundle` under **Add plugin** and choose **Enable**; no package download is needed. Check Accessibility, Screen Recording, and application consent separately on the [Computer Use permission page](../../../../packages/experimental/cua/README.md).
