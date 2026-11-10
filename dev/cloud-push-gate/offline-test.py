#!/usr/bin/env python3
"""Verify a generated dispatch body by running the real reconstruction script with git only.

The same `scripts/cloud-precheck/reconstruct.mjs` the workflow executes runs here against a
throwaway clone, so a synthetic-commit regression fails before a dispatch costs a runner.
This never installs dependencies, type-checks, or executes candidate code.
"""
import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
RECONSTRUCT = HERE.parents[1] / 'scripts' / 'cloud-precheck' / 'reconstruct.mjs'


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('source', help='Git checkout the reconstruction clones from')
    parser.add_argument('--body', default=str(HERE / 'dispatch.json'), help='Dispatch body written by generate-payload.py')
    args = parser.parse_args()
    source = Path(args.source).resolve()
    body_path = Path(args.body)
    inputs = json.loads(body_path.read_bytes())['inputs']
    with tempfile.TemporaryDirectory(prefix='dsh-cloud-push-gate-') as temporary:
        work = Path(temporary) / 'candidate'
        command = [
            'node', str(RECONSTRUCT),
            '--source', str(source),
            '--work', str(work),
            '--base', inputs['base'],
            '--candidate-commit', inputs['candidate_commit'],
            '--candidate-tree', inputs['candidate_tree'],
            '--patch', inputs['patch'],
            '--patch-sha256', inputs['patch_sha256'],
            '--commit-object', inputs['commit_object'],
            '--commit-object-sha256', inputs['commit_object_sha256'],
        ]
        result = subprocess.run(command, capture_output=True, text=True)
        sys.stderr.write(result.stderr)
        if result.returncode != 0:
            raise SystemExit(f'reconstruction script failed with {result.returncode}')
        expected_head = f"CANDIDATE_HEAD {inputs['candidate_commit']}"
        expected_tree = f"CANDIDATE_TREE {inputs['candidate_tree']}"
        if expected_head not in result.stdout or expected_tree not in result.stdout:
            raise SystemExit(f'reconstruction did not report the candidate identity:\n{result.stdout}')
        head = subprocess.check_output(['git', '-C', str(work), 'rev-parse', 'HEAD']).decode().strip()
        if head != inputs['candidate_commit']:
            raise SystemExit(f'HEAD is {head}, not the candidate commit')
        if subprocess.check_output(['git', '-C', str(work), 'status', '--porcelain']).strip() != b'':
            raise SystemExit('reconstruction left the worktree dirty')
    print(f"offline_reconstruction=pass commit={inputs['candidate_commit']} tree={inputs['candidate_tree']}")
    print(f'dispatch_body_bytes={len(body_path.read_bytes())}')


if __name__ == '__main__':
    main()
