# Cloud precheck gate

English | [中文](README.zh.md)

Pre-push verification that the exact commit being pushed installed and type-checked on a GitHub-hosted runner, instead of compiling on the developer machine.

## What the gate proves

`lefthook.yml` runs `scripts/cloud-precheck/verify-push.mjs` for `pre-push` with `use_stdin: true`, so the gate reads git's real ref updates rather than `HEAD`:

```
<local ref> <local sha> <remote ref> <remote sha>
```

For every pushed ref it resolves the pushed tip (tags peel to their commit), rejects non-fast-forward updates, and requires one verified receipt per distinct tip. Only the pushed tip needs a receipt; history behind it is not re-verified. Deleting a remote ref publishes no commit and prints an explicit note; a line whose all-zero sha is not paired with the `(delete)` marker is rejected as malformed.

A receipt is accepted only when all of the following hold:

- the pushed remote name and its resolved URL — which git passes as the first two pre-push arguments and lefthook forwards as `{1}` and `{2}` — name the approved repository; the resolved URL covers a named remote (including a `pushurl` override) and an explicit `git push <url>` target; a missing argument, an unparsable URL, or a foreign target rejects the push;
- `DSH_CLOUD_PRECHECK_RUN` names a workflow run, and authenticated `gh` calls report that run as a completed, successful `workflow_dispatch` of `.github/workflows/cloud-precheck.yml` whose `head_branch` matches the receipt's dispatched ref;
- the run's dispatched revision serves workflow, receipt-writer, and reconstruction-script bytes whose SHA-256 equals the hashes pinned in `verify-push.mjs`;
- the required `precheck` job and every required step concluded `success`, read through the attempt-specific endpoint for the attempt the run reports (a skipped or missing step rejects);
- the artifact named `cloud-precheck-<commit>-<run id>-<attempt>` exists exactly once, is not expired, and contains exactly one `receipt.json` read with `unzip -p` after listing a single archive member;
- the receipt's repository, workflow, script hashes, run id, attempt, dispatched revision and ref, and candidate commit and tree match the pushed tip's actual tree.

`DSH_CLOUD_PRECHECK_RUN` only locates the run; the run's own API metadata and artifact are the evidence. Set `GH_CONFIG_DIR` so the gate can make those authenticated calls.

Any unknown, missing, unparsable, or unreachable fact rejects the push. There is no local fallback and no bypass switch: `LEFTHOOK=0` and `--no-verify` are not permitted. The gate never installs, builds, or type-checks locally.

## What the gate proves about the candidate

The cloud run rebuilds the exact commit: it applies the binary patch to the baseline, hashes the supplied raw commit object into the object database, and requires `HEAD` to equal the candidate commit id with that tree and a clean worktree. A run that invented a synthetic commit therefore cannot satisfy the receipt. The baseline checkout stays untouched; the candidate is rebuilt in a second clone.

## What the gate does not prove

The run executes the candidate's own `package.json` scripts, so a candidate that rewrites `typecheck` to exit early is outside this gate; review still owns script changes. The gate also binds reviewable configuration rather than a malicious local `insteadOf` transport rewrite, and it cannot stop a repository administrator from editing the workflow and the pinned hashes together.

## One distinct tip per push

One receipt covers one commit, so a push may update several refs only when they share a tip. Push different commits separately; the gate rejects a multi-tip push with that instruction instead of guessing which run covers which commit.

## Issuing a receipt

The workflow accepts an unpushed commit without pushing it: it applies a binary patch plus the raw commit object to the baseline inside the runner and verifies the exact commit identity.

```sh
python3 dev/cloud-push-gate/generate-payload.py --repo <checkout> --base <baseline> --candidate <commit>
GH_CONFIG_DIR=<dedicated gh config dir> gh api --method POST \
  repos/NBStarry/deepseek-harness/actions/workflows/cloud-precheck.yml/dispatches \
  --input dev/cloud-push-gate/dispatch.json
```

The generator writes the `{ref, inputs}` body the REST endpoint accepts and refuses inputs whose serialized size exceeds the workflow-dispatch limit. Never hand-write a receipt; the workflow emits it. `dev/cloud-push-gate/offline-test.py` runs the same `scripts/cloud-precheck/reconstruct.mjs` the workflow runs, so a payload that would not rebuild the exact commit fails before a dispatch.

## Deployment needs separate authorization

GitHub registers a `workflow_dispatch` workflow only from the default branch, and `--ref` selects the execution branch of an already registered workflow. This workflow therefore cannot run until it reaches the default branch, and no receipt can exist before that. The first deployment is gate infrastructure and stays pending authorization: the authorization has to name how the first deployment happens, because every push is rejected until the workflow is registered. The gate itself offers no exception and no bypass, and this document deliberately proposes none; do not merge the gate into a branch it would then block until that authorization exists.

## Trust boundaries

This proves the exact commit installed and typed-checked on a hosted runner under pinned workflow, receipt, and reconstruction bytes, with the run, attempt, job, steps, and artifact confirmed through the GitHub API. It is not a signature or attestation scheme, and it does not replace review.
