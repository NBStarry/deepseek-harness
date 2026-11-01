---
kind: upgrade-guide
description: "Explicit service tiers require model capability declarations, and Fast controls belong to a separate plugin."
---

# Service-tier capabilities

English | [中文](guide.zh.md)

## Change

Explicit `serviceTier` values are validated against the selected model's `serviceTiers`. A route that does not advertise the requested tier rejects it with `UNSUPPORTED_OPTION` instead of silently ignoring it. Omitting the field preserves the adapter's existing default behavior; `default` explicitly requests the endpoint's default tier, and `priority` requests priority processing. The built-in Fast control is removed; an independent plugin owns that control and its new-session defaults.

The initial community Fast build accepted only `priority` in restored Session data. It rejects restored request headers containing the new explicit `default` value. Removing the plugin does not downgrade the reader or erase saved selections. The official baseline and community builds are separate compatibility targets; do not assume a community build accepts every record the official baseline preserves.

## Migration

1. For custom adapters, advertise `serviceTiers` in model metadata only when the adapter maps those values to the endpoint. Supported Responses routes in `llm-pi-ai` advertise `default` and `priority`.
2. Omit `serviceTier` in integrations that must retain provider defaults. Use explicit values only when the model advertises them; call `resolveCallConfig()` before recording an unsupported selection.
3. Use a compatible Fast plugin for the session control and configurable new-session default. Existing saved selections remain unchanged when the plugin is installed, reconfigured, or removed.
4. Keep the generic service-tier reader for sessions that contain explicit `default`; do not restore those histories with the initial priority-only community build. Changing the latest selection does not remove earlier records.
5. Confirm accepted selections survive restart and that unsupported values fail before dispatch. The authored SDK replay and adapter tests exercise these cases without provider requests.
