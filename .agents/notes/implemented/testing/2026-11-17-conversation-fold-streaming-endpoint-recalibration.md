# Agent Note: Conversation-fold streaming endpoint recalibration

Status: implemented

English | [中文](2026-11-17-conversation-fold-streaming-endpoint-recalibration.zh.md)

## Problem

The required [conversation-fold streaming benchmark](../../../../benchmarks/conversation-fold/conversation-fold.bench.client.ts)
used CI ceilings of 30/80 ms derived from historical 12/32 ms reference allowances and the shared
[two-times scale and 1.25 headroom](../../../../benchmarks/support/calibration.ts). Two independent
normal five-sample AMD hosted runs on unchanged benchmark code measured reasoning-leading-whitespace
medians of 30.95092/31.00177 ms at 4,096 fragments and 80.904117/86.159412 ms at 16,384 fragments.
The old 30/80 limits therefore failed the required gate on the current hosted runner. This note records
the explicitly authorized measurement-standard change; it does not claim a product performance
improvement or a new Mac measurement.

## Decision

Only the 4,096 and 16,384 streaming endpoints receive per-endpoint `ciBudgetMs` ceilings of **40/110 ms**.
The existing text/ordinary and reasoning/leading-whitespace cases at each fragment count share the
same ceiling. The five fresh samples, median rule, full 262144-character workload, checksum/flush
boundaries, retained-memory assertion and budget, all other endpoint budgets, and the shared
`CI_TIME_SCALE=2` / `1.25` headroom remain unchanged. The source comment points to this note.

## Calibration

| Run | 4,096 reasoning median | 16,384 reasoning median |
|---|---:|---:|
| CI 44012719045 | 30.95092 ms | 80.904117 ms |
| CI 44021529843 | 31.00177 ms | 86.159412 ms |

The larger medians are used. The reviewed 25% headroom produces 38.752 ms and 107.699 ms, rounded up
to the next 10 ms for the authorized 40/110 ms ceilings. Both runs used the AMD EPYC 7763 hosted
Ubuntu 24.04 environment and normal five-sample runs, not a Mac reference measurement. The historical
12/32 ms reference allowances and the old 30/80 gate failure remain unchanged history in the
[frontend performance budgets](2026-09-06-frontend-performance-budgets.md) record.

## Alternatives considered

**Adjust the shared scale or headroom.** Rejected: it would move unrelated endpoints, beyond the
explicitly authorized streaming-only recalibration.

**Use a dynamic platform, environment, or CPU-based ceiling.** Rejected: performance budgets are
reviewed source constants; no environment override, retry policy, or platform switch was authorized.

**Change the product algorithm or worker.** Rejected: the observed failure is a
measurement-standard mismatch on the hosted runner; no product or worker change was authorized.

## Consequences

The required streaming group now enforces 40/110 ms on the authorized hosted CI standard. The
previous required red remains historical evidence and is not reported as a fixed product performance
problem. Other benchmark endpoints and memory gates keep their prior decisions.
