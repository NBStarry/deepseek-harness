---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-01-service-tier-capabilities

English | [中文](2026-11-01-service-tier-capabilities.zh.md)

## Summary

Extends the optional serviceTier selection and request control from priority to default or priority.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing omitted and priority values retain their interpretation. The new reader accepts explicit default and keeps it distinct from omission. The official V4 baseline preserves unknown nested fields; the earlier community priority-only reader instead rejects a restored request/header containing default. Its prior validator is unchanged except for accepting default, and restoration runs before a live Agent can dispatch or append; no fallback truncation is requested by this semantic error. Downgrade to that community reader is not supported for such histories and is documented in the service-tier upgrade guide. The unknown-tier regression checks both read and write handles, Session restoration refusal and unchanged generation bytes. Retained historical schema records and the writer version remain unchanged; projection cache version advances independently.

<a id="verification"></a>
## Verification

Current keyless SDK replay passed both codex-fast and session-resume after updating the authored fixture to exercise omitted, priority, explicit default, same-route resume and route change. Python SDK projection and resume tests passed three cases. JSONL current-event-admission passed seven cases, including strict and recoverable three-state round trips and unsupported-tier restoration refusal without file modification. Source review compared the prior priority-only validator directly. Before artifact rebuilding, a real SDK replay resume using the prior compiled reader rejected a default request/header; no old installed desktop application was launched or modified. Adapter and model-selection focused tests use synthetic responses, not real provider requests.

<a id="dev-note"></a>
## Dev Note

None.
