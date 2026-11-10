# 云端预检门禁

[English](README.md) | 中文

推送前验证：被推送的确切提交已在 GitHub 托管的 runner 上完成安装与类型检查，而不是在开发机上编译。

## 门禁能证明什么

`lefthook.yml` 以 `use_stdin: true` 为 `pre-push` 运行 `scripts/cloud-precheck/verify-push.mjs`，因此门禁读取 git 的真实 ref 更新，而不是 `HEAD`：

```
<local ref> <local sha> <remote ref> <remote sha>
```

对每个待推送 ref，它解析待推送 tip（tag 会剥离到提交）、拒绝非快进更新，并要求每个不同 tip 有一份已核验回执。只有被推送的 tip 需要回执，其历史不再逐个核验。删除远端 ref 不发布提交，会打印明确提示；若某行的全零 sha 未与 `(delete)` 标记配对，则按畸形输入拒绝。

只有以下条件全部成立时才接受回执：

- 被推送的远端名称及其解析后的 URL——git 作为 pre-push 的前两个参数传入，lefthook 以 `{1}`、`{2}` 转发——必须指向批准的仓库；该 URL 同时覆盖具名远端（含 `pushurl` 覆盖）与显式 `git push <url>`；参数缺失、URL 不可解析或指向其他仓库都会拒绝推送；
- `DSH_CLOUD_PRECHECK_RUN` 指定的 workflow run，经已认证的 `gh` 调用确认为 `.github/workflows/cloud-precheck.yml` 的一次已完成、成功的 `workflow_dispatch`，且其 `head_branch` 与回执的 dispatch ref 一致；
- 该 run 的 dispatch 版本所提供的 workflow、回执脚本与重建脚本字节，其 SHA-256 等于 `verify-push.mjs` 中固定的哈希；
- 必需的 `precheck` job 与每个必需步骤结论均为 `success`，并且通过该 run 所报 attempt 的专用端点读取（被跳过或缺失即拒绝）；
- 名为 `cloud-precheck-<commit>-<run id>-<attempt>` 的 artifact 恰好存在一个、未过期，且在确认压缩包只有一个成员后用 `unzip -p` 读取唯一的 `receipt.json`；
- 回执中的仓库、workflow、脚本哈希、run id、attempt、dispatch 版本与 ref、候选提交与树，都与待推送 tip 的实际树一致。

`DSH_CLOUD_PRECHECK_RUN` 只用于定位 run；证据是该 run 自身的 API 元数据与 artifact。需要设置 `GH_CONFIG_DIR`，使门禁能进行这些已认证调用。

任何未知、缺失、无法解析或不可达的事实都会拒绝推送。没有本地回退，也没有绕过开关：不允许 `LEFTHOOK=0` 或 `--no-verify`。门禁不会在本地安装、构建或运行类型检查。

## 门禁能证明候选的什么

云端 run 重建确切提交：把二进制补丁应用到基线，把提供的原始 commit 对象写入对象库哈希，并要求 `HEAD` 等于候选提交、树一致且工作区干净。因此，编造合成提交的 run 无法满足回执。基线检出保持不动，候选在第二个克隆中重建。

## 门禁不能证明什么

该 run 执行候选自身的 `package.json` 脚本，因此把 `typecheck` 改成提前退出的候选不在本门禁覆盖内；脚本改动仍由 review 负责。门禁绑定的是可审查的配置，而不是恶意的本地 `insteadOf` 传输重写；也无法阻止仓库管理员同时修改 workflow 与固定哈希。

## 每次只推送一个不同的 tip

一份回执只覆盖一个提交，因此一次推送可以更新多个 ref，但它们的 tip 必须相同。不同提交要分开推送；门禁会以该说明拒绝多 tip 推送，而不是猜测哪个 run 覆盖哪个提交。

## 生成回执

该 workflow 无需先推送即可验证未推送的提交：它在 runner 内将二进制补丁与原始 commit 对象应用到基线，并核对确切的提交身份。

```sh
python3 dev/cloud-push-gate/generate-payload.py --repo <checkout> --base <baseline> --candidate <commit>
GH_CONFIG_DIR=<dedicated gh config dir> gh api --method POST \
  repos/NBStarry/deepseek-harness/actions/workflows/cloud-precheck.yml/dispatches \
  --input dev/cloud-push-gate/dispatch.json
```

生成器写出 REST 端点接受的 `{ref, inputs}` 请求体，并在序列化输入超过 workflow dispatch 限制时拒绝写出。不要手写回执；回执由 workflow 产出。`dev/cloud-push-gate/offline-test.py` 运行的正是 workflow 使用的 `scripts/cloud-precheck/reconstruct.mjs`，因此无法重建确切提交的载荷会在 dispatch 前失败。

## 首次部署需要单独授权

GitHub 只从默认分支注册 `workflow_dispatch` workflow，`--ref` 只选择已注册 workflow 的执行分支。因此在进入默认分支之前，本 workflow 无法运行，回执也不可能存在。首次部署属于门禁基础设施，仍待授权：授权必须说明首次部署如何完成，因为 workflow 注册前每次推送都会被拒绝。门禁本身不提供例外或绕过方式，本文档也不提出任何绕过步骤；在授权明确前，不要把门禁合入会被它阻挡的分支。

## 信任边界

本门禁证明：被固定的 workflow、回执与重建字节所约束的确切提交，在托管 runner 上完成安装与类型检查，且 run、attempt、job、步骤与 artifact 均经 GitHub API 核实。它不是签名或 attestation 方案，也不替代 review。
