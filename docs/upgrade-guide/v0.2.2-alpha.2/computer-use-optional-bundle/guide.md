---
kind: upgrade-guide
description: "Desktop profiles that used the shipped Computer Use bundle must install it separately after upgrading."
---

# Install the optional Computer Use bundle

English | [中文](guide.zh.md)

## Change

Desktop no longer includes `@deepseek-ai/dsh-cua-bundle` in its default runtime. An existing profile can still select the previously shipped bundle in `dsh.profile.bundles` without having installed it as a profile dependency. After upgrading, if no copy can be resolved, DSH skips the selected bundle and reports a diagnostic; the saved selection remains but Computer Use is unavailable. Updating Desktop does not install the bundle into the profile.

## Migration

1. If Computer Use is not needed, deselect the missing bundle in Plugins. If it is needed, use **Plugins → Add plugin** to install `@deepseek-ai/dsh-cua-bundle` into each macOS Desktop profile and enable it. A saved selection alone is not evidence of an installed package. Official installation targets the version matching the running DSH release, so check that a compatible package with its native helper is available before installing.
2. The published `@deepseek-ai/dsh-experimental-cua-macos@0.2.2-alpha.2` package lacks its native helper. Reinstalling that release alone cannot restore native Computer Use; use a compatible release whose provider includes its prepared helper, when available. The [Computer Use bundle documentation](../../../../packages/experimental/cua-bundle/README.md) describes source development and current limitations.
3. Restart DSH if requested and check the plugin diagnostic and Computer Use permission page. Enable PTC for the intended sessions and grant the required macOS permissions. A successful installation or saved selection does not by itself establish that the provider loaded or has permission.
