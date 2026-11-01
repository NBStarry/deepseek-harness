from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness
from deepseek_harness.errors import JsonRpcError


@pytest.mark.parametrize("outcome", ["restored", "missing"])
def test_resume_preserves_identity_and_propagates_failure(tmp_path: Path, outcome: str) -> None:
    script = tmp_path / "runtime.py"
    requests = tmp_path / "requests.jsonl"
    script.write_text(
        """
import json
import os
import sys

for line in sys.stdin:
    frame = json.loads(line)
    with open(os.environ["REQUESTS"], "a") as log:
        log.write(line)
    method = frame["method"]
    response = {"jsonrpc": "2.0", "id": frame["id"]}
    if method == "initialize":
        response["result"] = {"serverInfo": {"name": "fake-runtime"}}
    elif method == "session/resume":
        outcome = os.environ["OUTCOME"]
        if outcome == "missing":
            response["error"] = {"code": -32603, "message": "session not found"}
        else:
            print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {
                "sessionId": frame["params"]["sessionId"], "event": {
                    "type": "model/selection", "seq": 8, "time": 0,
                    "data": {"provider": "openai-codex", "model": "gpt-5.4", "serviceTier": "priority"}
                }
            }}), flush=True)
            response["result"] = {}
    else:
        response["result"] = {}
    print(json.dumps(response), flush=True)
    if method == "shutdown":
        break
""",
        encoding="utf-8",
    )
    with DeepSeekHarness(
        _launch_args=(sys.executable, str(script)),
        env={"OUTCOME": outcome, "REQUESTS": str(requests)},
    ) as harness:
        if outcome == "restored":
            with harness.client.subscribe_session_notifications("saved") as subscription:
                session = harness.resume_session("saved")
                notifications = []
                subscription.drain(notifications.append)
            assert session.id == "saved"
            assert session.harness is harness
            assert len(notifications) == 1
            assert notifications[0].method == "session.event"
            assert notifications[0].payload == {
                "sessionId": "saved",
                "event": {
                    "type": "model/selection", "seq": 8, "time": 0,
                    "data": {"provider": "openai-codex", "model": "gpt-5.4", "serviceTier": "priority"},
                },
            }
        else:
            with pytest.raises(JsonRpcError, match="session not found"):
                harness.resume_session("saved")
    frames = [json.loads(line) for line in requests.read_text(encoding="utf-8").splitlines()]
    assert [frame["method"] for frame in frames] == ["initialize", "session/resume", "shutdown"]
    assert frames[1]["params"] == {"sessionId": "saved"}
