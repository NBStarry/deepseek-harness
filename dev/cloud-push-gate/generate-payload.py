#!/usr/bin/env python3
"""Build the dispatch body for the cloud precheck workflow without running candidate code.

The body carries the unpushed commit exactly: a binary patch against a known baseline plus
the raw commit object, so the runner rebuilds the same commit id instead of inventing one.
It refuses to write a body that exceeds the workflow-dispatch input limit, so a rejected
generation never leaves a dispatchable file behind.
"""
import argparse
import base64
import gzip
import hashlib
import json
import re
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORKFLOW = 'cloud-precheck.yml'
MAX_BODY = 65535
SHA = re.compile(r'^[a-f0-9]{40}$')


def git(repo: Path, *args: str) -> bytes:
    return subprocess.check_output(['git', '-C', str(repo), *args])


def encode(data: bytes) -> str:
    return base64.b64encode(gzip.compress(data, mtime=0)).decode('ascii')


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', required=True, help='Git checkout that contains the candidate')
    parser.add_argument('--base', required=True, help='Baseline commit the patch applies to')
    parser.add_argument('--candidate', required=True, help='Unpushed candidate commit')
    parser.add_argument('--ref', default='master', help='Default branch that carries the workflow')
    parser.add_argument('--out', default=str(HERE / 'dispatch.json'))
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    if not SHA.fullmatch(args.base) or not SHA.fullmatch(args.candidate):
        raise SystemExit('base and candidate must be full commit ids')
    parent = git(repo, 'rev-parse', f'{args.candidate}^').decode().strip()
    if parent != args.base:
        raise SystemExit(f'candidate parent is {parent}, not the given base')
    tree = git(repo, 'rev-parse', f'{args.candidate}^{{tree}}').decode().strip()
    patch = git(repo, 'diff', '--binary', args.base, args.candidate)
    commit_object = git(repo, 'cat-file', 'commit', args.candidate)
    object_sha = hashlib.sha256(commit_object).hexdigest()
    body = json.dumps({'ref': args.ref, 'inputs': {
        'base': args.base,
        'candidate_commit': args.candidate,
        'candidate_tree': tree,
        'patch': encode(patch),
        'patch_sha256': hashlib.sha256(patch).hexdigest(),
        'commit_object': encode(commit_object),
        'commit_object_sha256': object_sha,
    }}, ensure_ascii=True, separators=(',', ':')).encode('utf-8')
    print(f'workflow={WORKFLOW} ref={args.ref}')
    print(f'candidate={args.candidate} tree={tree}')
    print(f'patch_bytes={len(patch)} commit_object_bytes={len(commit_object)} commit_object_sha256={object_sha}')
    print(f'dispatch_body_bytes={len(body)}')
    if len(body) >= MAX_BODY:
        raise SystemExit(f'dispatch body {len(body)} bytes exceeds the {MAX_BODY}-byte limit; nothing written')
    out = Path(args.out)
    out.write_bytes(body)
    print(f'wrote {out} sha256={hashlib.sha256(body).hexdigest()}')


if __name__ == '__main__':
    main()
