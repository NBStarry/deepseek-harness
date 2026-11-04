---
kind: upgrade-guide
description: "Desktop Sidebar Browser website data now persists after application exit instead of being discarded."
---

# Desktop Browser website data persists

English | [中文](guide.zh.md)

## Change

Desktop Sidebar Browser website data previously used temporary partitions. It now uses persistent partitions in the Desktop application user-data directory. Closing tabs, deleting Sessions or signing out of DSH does not remove this data, and there is no dedicated site-data clearing control. Website logout does not necessarily delete all local data.

## Migration

1. After installing the updated Desktop application, sign in to each website again if needed. Previously temporary data is not migrated. If an earlier workspace-partition build was used, its data is not migrated or deleted automatically. Session cookies and website policies can still require repeated login.
2. Restart Desktop and reopen the site, including from another workspace in the same profile, to check whether its login persists. Different canonical profile paths use separate partitions within the same Electron user-data directory; another user-data directory is separate. Moving a profile can change its storage identity.
3. Treat the application user-data directory and its backups as sensitive. Do not delete the entire directory as a browser-only reset; it also contains other application data.
