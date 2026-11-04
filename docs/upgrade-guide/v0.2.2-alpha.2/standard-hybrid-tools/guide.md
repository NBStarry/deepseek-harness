---
kind: upgrade-guide
description: "Web and SDK standard sessions expose native tools alongside run_code and apply_patch."
---

# Standard sessions expose native tools and run_code

English | [中文](guide.zh.md)

## Change

Web and SDK standard sessions expose the permitted native tools alongside `run_code` and `apply_patch`. They use one PTC executor in hybrid mode; nested tool calls retain their normal policy and approval checks. PTC-only configurations continue to expose only `run_code` directly. The additional SDK declarations and schemas increase the model request and may affect prompt-cache reuse. In the recorded SDK desktop-context example, the initial system-prompt text grows from 4,575 to 59,949 bytes and the tool-schema fixture grows by 4,480 bytes. Actual token count and cache behavior depend on the model and provider; they have not been measured by this example.

`run_code` executes a sandboxed program that can use runtime APIs as well as tool bindings. Direct runtime filesystem writes follow the sandbox policy, not the filesystem tool's read-before-write observation policy. Existing shell commands have the same distinction. Platform temporary directories may also be writable under workspace-write.

## Migration

1. A Web profile overlay that replaces the entire `preset-standard` configuration can hide the new executor or filesystem option. Merge `tool-executor-ptc` with `hybrid: true` and `tool-fs` with `applyPatch: true` into that profile's existing standard plugin list without dropping its other settings. Do not mount a second executor in the same scope.
2. SDK overlays that select pure PTC must set the PTC executor's `hybrid` to `false`; the bundled PTC example also restores `applyPatch: false`. Custom tool-order lists may include `run_code` when hybrid is active.
3. Check the effective tool list in a new session after updating the composition. Existing live sessions may retain their previous preset generation. Treat `apply_patch` results as potentially partially committed and inspect their operation statuses and stopped metadata before retrying.
