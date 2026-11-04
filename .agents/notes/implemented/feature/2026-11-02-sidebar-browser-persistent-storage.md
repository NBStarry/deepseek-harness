# Agent Note: Persistent Sidebar Browser storage

Status: implemented

English | [中文](2026-11-02-sidebar-browser-persistent-storage.zh.md)

## Problem

Temporary Desktop Browser partitions lose website login state when the application exits. Related tabs need to share durable site data without sharing the application session.

## Decision

The [Desktop browser webview decision](2026-09-20-desktop-browser-webview.md) retains its guest security policy, but its workspace-keyed temporary storage policy is superseded. All workspaces and Sessions in one Desktop profile share a versioned Electron `persist:` partition. After profile preparation, the main process resolves the profile's real path and hashes it with SHA-256 to select the partition. Leases remain random and process-local; renderer-supplied workspace identity does not select storage.

The partition also belongs to Electron user data: a different user-data directory has separate storage. Different canonical profile paths use different partitions in the same user-data directory; aliases to the same profile resolve together. A moved profile may receive a different partition. Hashing is not encryption or authorization and guessable paths may be inferred.

## Alternatives considered

**Keep temporary partitions.** This limits retention but loses login state on every exit.

**Import Chrome data.** This crosses browser and account boundaries and depends on another application's credential store.

## Consequences

Persistent cookies and website storage can survive an application restart; session cookies and site policies may still require login. Existing process-local data is not migrated. Data from any earlier workspace-keyed persistent build is neither migrated nor automatically deleted. Site data remains on disk after closing tabs, deleting Sessions or signing out of DSH. There is no dedicated site-data clearing control or automatic cleanup of orphaned partitions. Site logout can revoke its login, but does not necessarily remove all local data. Do not treat deleting the entire application user-data directory as a safe browser-only reset.

A synthetic local-origin test with isolated Electron user data exercises persistent cookies, localStorage, cross-workspace sharing, profile separation and clearing across independent processes. It does not cover the product webview or all guest security and lifecycle behavior.
