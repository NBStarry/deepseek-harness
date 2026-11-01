"""Project Fast selections and resumed request headers through the built SDK profile."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / "apps" / "cli" / "lib" / "bin.js"
SCENARIO = ROOT / "snapshots" / "sdk" / "codex-fast"


@pytest.mark.skipif(not CLI.exists(), reason="requires the built dsh profile runtime")
def test_codex_fast_snapshot(tmp_path: Path) -> None:
    rows = [json.loads(line) for line in (SCENARIO / "session.v4.jsonl").read_text().splitlines()]
    fixture = tmp_path / "session.v4.jsonl"
    fixture.write_text((SCENARIO / "session.v4.jsonl").read_text().replace("{{cwd}}", str(tmp_path)))
    replay_patch = tmp_path / "replay.yml"
    replay_module = ROOT / "packages" / "test-support" / "llm-replay" / "lib" / "index.js"
    replay_patch.write_text((SCENARIO / "cordis.snapshot.yml").read_text().replace(
        "'@deepseek-ai/dsh-llm-replay'", json.dumps(str(replay_module))))
    home = tmp_path / "home"
    session_id = "fast-projection"
    events = []
    notifications = []
    responses = []
    resumed_selections = []
    for first, last, model in ((1, 2, "gpt-5.4"), (3, 5, "gpt-5.4"), (6, 6, "gpt-5.4-mini")):
        script = []
        for row in rows:
            if row["type"] != "assistant/message" or not first <= row["data"]["turn"] <= last:
                continue
            chunks = []
            for record in row["data"]["stream"]:
                if record["type"] == "chunk":
                    chunks.append(record["chunk"])
                else:
                    assert record["type"] == "text-chunks"
                    chunks.extend({"type": "text-delta", "index": record["index"], "text": text}
                                  for text in record["texts"])
            script.append({"kind": "chunks", "chunks": chunks})
        override = tmp_path / f"replay-{first}.json"
        override.write_text(json.dumps(script))
        with DeepSeekHarness(
            dsh_bin=str(CLI), dsh_home=str(home), cwd=str(tmp_path), profile="sdk",
            patches=(str(SCENARIO / "cordis.yml"), str(replay_patch)),
            provider="openai-codex", model=model,
            initialize_timeout_seconds=110, request_timeout_seconds=110,
            env={"DSH_TELEMETRY_DISABLED": "1", "DSH_SNAPSHOT": "replay",
                 "DSH_SNAPSHOT_FILE": str(fixture), "DSH_SNAPSHOT_OVERRIDE": str(override),
                 "DSH_AGENTS_HOME": str(tmp_path / "agents"),
                 "DEEPSEEK_API_KEY": "", "OPENAI_API_KEY": "", "ANTHROPIC_API_KEY": ""},
        ) as harness:
            with harness.client.subscribe_session_notifications(session_id) as subscription:
                session = harness.start_session(session_id) if first == 1 else harness.resume_session(session_id)
                resumed = []
                subscription.drain(resumed.append)
                resumed_selections.extend(n.payload["event"]["data"] for n in resumed
                                          if n.method == "session.event" and n.payload["event"]["type"] == "model/selection")
                for turn in range(first, last + 1):
                    result = session.run(f"Reply with exactly: FAST_{turn}")
                    responses.append(result.final_response)
                    events.extend(result.events)
                    notifications.extend(n.payload["event"] for n in result.notifications if n.method == "session.event")
    selected_types = ("model/selection", "request/header")
    assert [event for event in events if event["type"] in selected_types] == [
        event for event in notifications if event["type"] in selected_types]
    persisted = list((home / "sessions").rglob("*.jsonl"))
    assert len(persisted) == 1
    durable = [json.loads(line) for line in persisted[0].read_text().splitlines()]
    projection = {
        "finalResponses": responses,
        "headers": [{"config": event["data"]["header"]["config"], "reason": event["data"]["reason"]}
                    for event in events if event["type"] == "request/header"],
        "selections": [event["data"] for event in events if event["type"] == "model/selection"],
        "resumedSelections": resumed_selections,
        "durableSelections": [event["data"] for event in durable if event["type"] == "model/selection"],
    }
    expected = Path(__file__).parent / "expected" / "codex-fast.json"
    assert projection == json.loads(expected.read_text())
