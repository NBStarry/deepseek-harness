---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-01-session-codex-fast

English | [中文](2026-11-01-session-codex-fast.zh.md)

## Summary

Adds optional priority serviceTier to durable model selections and request configurations.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Absent serviceTier retains default processing for existing records. New readers accept only the optional priority value. Existing V4 event decoding preserves nested fields; the previous model-selection fold ignores this optional processing feature in header-derived selections, and the previous adapter does not forward it. Downgrade therefore does not provide Fast processing. No event discriminator or Session format version changes. Projection state version changes invalidate cached selections once; no per-request persistence read-back is introduced.

<a id="verification"></a>
## Verification

Focused offline tests passed: model-selection, system-prompt-admission, request-header, session, call-config and Codex SDK fake-fetch serialization (145 tests after final OAuth case); configured resume, adapter, sdk-options and LLM service (179 tests). SDK server resume tests passed (17); controller model-selection tests passed (27). Real provider requests and live installation have not been performed.

<a id="dev-note"></a>
## Dev Note

None.
