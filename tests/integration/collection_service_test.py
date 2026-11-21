from __future__ import annotations

import asyncio
import hashlib
import json
import os
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

from collector.protocol import protocol_validators
from collector.service import create_app

ROOT = Path(__file__).resolve().parents[2]
SCHEMA = ROOT / "packages/contracts/src/collection/v1.schema.json"
FIXTURES = ROOT / "tests/fixtures/contracts/collection"
TOKEN = "synthetic-test-credential-not-for-deployment"
HOST = "https://data.austintexas.gov"
DATA = f"{HOST}/resource/3syk-w9eu.json"
PAGE = f"{HOST}/Building-and-Development/Issued-Construction-Permits/3syk-w9eu/about_data"
TASKS = "/internal/v1/tasks"


class Chunks(httpx.AsyncByteStream):
    def __init__(self, *chunks: bytes) -> None:
        self.chunks = chunks

    async def __aiter__(self):
        for chunk in self.chunks:
            yield chunk


def request(**updates):
    payload = json.loads((FIXTURES / "request.json").read_bytes())
    payload.update({
        "taskId": "synthetic_permit",
        "sourceId": "austin_permits",
        "url": DATA,
        "permissions": {"assessmentId": "synthetic_qualified_fixture", "allowedDomains": ["data.austintexas.gov"]},
        "deadline": (datetime.now(UTC) + timedelta(seconds=45)).isoformat().replace("+00:00", "Z"),
        "recipe": {"format": "json", "fields": [{"field": "permitNumber", "key": "permit_number"}]},
        **updates,
    })
    return payload


class CollectionServiceTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.artifacts = Path(self.tmp.name)
        self.calls = []

    async def api(self, respond):
        async def record(call):
            self.calls.append(str(call.url))
            return await respond(call)

        instance = create_app(
            token=TOKEN.encode(), staging=self.artifacts, schema=SCHEMA,
            client_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(record)),
            crawl_delay=0,
        )
        client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=instance), base_url="http://collector",
            headers={"Authorization": f"Bearer {TOKEN}"},
        )
        self.addAsyncCleanup(client.aclose)
        return client

    async def terminal(self, client, task, state="finished"):
        async with asyncio.timeout(2):
            while True:
                status = await client.get(f"{TASKS}/{task['taskId']}", params={"attemptId": task["attemptId"]})
                self.assertEqual(status.status_code, 200)
                payload = status.json()
                if payload["state"] == state:
                    return payload
                await asyncio.sleep(0.01)

    async def test_shared_goldens(self):
        validators = protocol_validators(SCHEMA)
        for kind, filename in (("TaskRequest", "request.json"), ("TaskResult", "result.json"),
                               ("TaskResult", "challenge-result.json")):
            validators[kind].validate(json.loads((FIXTURES / filename).read_bytes()))

    async def test_authorized_idempotent_collection_and_staging(self):
        body = b'[{"permit_number":"SYNTHETIC-12","salary_private":"never an observation"}]'
        expired = self.artifacts / ("0" * 32)
        expired.write_bytes(b"synthetic expired artifact")
        os.utime(expired, (0, 0))

        async def respond(_):
            return httpx.Response(200, headers={"Content-Type": "application/json"}, stream=Chunks(body))

        client = await self.api(respond)
        self.assertEqual((await client.get("/internal/v1/health", headers={"Authorization": "Bearer wrong"})).status_code, 401)
        self.assertEqual((await client.get("/docs")).status_code, 404)
        invalid = await client.post(TASKS, json=request(protocolVersion=2))
        self.assertEqual(invalid.json()["code"], "UNSUPPORTED_PROTOCOL_VERSION")

        task = request()
        first, duplicate = await asyncio.gather(*(client.post(TASKS, json=task) for _ in range(2)))
        self.assertEqual(first.status_code, 202)
        self.assertEqual(first.json(), duplicate.json())
        conflicting = await client.post(TASKS, json={**task, "correlationId": "different"})
        self.assertEqual(conflicting.status_code, 409)
        result = (await self.terminal(client, task))["result"]
        self.assertEqual(result["classification"], "success", result)
        self.assertEqual(self.calls, [DATA])
        artifact = result["evidence"][0]
        self.assertEqual((self.artifacts / artifact["artifactId"]).read_bytes(), body)
        self.assertFalse(expired.exists())
        self.assertEqual(artifact["sha256"], hashlib.sha256(body).hexdigest())
        self.assertEqual(artifact["bytes"], len(body))
        self.assertEqual(result["observations"], [{
            "field": "permitNumber", "original": "SYNTHETIC-12", "locator": "/0/permit_number",
            "artifactId": artifact["artifactId"],
        }])
        self.assertEqual((await client.post(f"{TASKS}/{task['taskId']}/cancel")).json()["cancellation"], "already_finished")

    async def test_policy_redirect_quota_and_bytes(self):
        async def respond(call):
            if call.url.params.get("$limit") == "1":
                return httpx.Response(302, headers={"Location": "https://data.seattle.gov/resource/76t5-zqzr.json"})
            return httpx.Response(200, headers={"Content-Type": "application/json"}, stream=Chunks(b"large-body"))

        client = await self.api(respond)
        invalid = await client.post(TASKS, json=request(url=f"{HOST}/other", taskId="wrong_path"))
        self.assertEqual(invalid.status_code, 403)
        cases = [
            (request(taskId="redirect", url=f"{DATA}?%24limit=1"), "POLICY_BLOCKED", 1),
            (request(taskId="quota", limits={**request()["limits"], "quotaUnits": 0}), "FREE_QUOTA_EXHAUSTED", 0),
            (request(taskId="bytes", limits={**request()["limits"], "bytes": 4}), "BUDGET_EXCEEDED", 1),
        ]
        for task, code, count in cases:
            self.assertEqual((await client.post(TASKS, json=task)).status_code, 202)
            result = (await self.terminal(client, task))["result"]
            self.assertEqual(result["error"]["code"], code, result)
            self.assertEqual(result["counters"]["requests"], count)
            self.assertEqual(result["evidence"], [])
        self.assertEqual(self.calls, [f"{DATA}?%24limit=1", DATA])
        self.assertEqual(list(self.artifacts.iterdir()), [])

    async def test_classifies_challenge_and_missing_selector_without_staging(self):
        async def respond(_):
            return httpx.Response(
                200, headers={"Content-Type": "text/html"},
                stream=Chunks(b"<title>Verify you are human</title>" if len(self.calls) == 1 else
                              b'<div id="new-class">Permit details moved elsewhere</div>'),
            )

        client = await self.api(respond)
        for identity, field, code in (("challenge", "title", "CHALLENGE_REQUIRED"),
                                      ("drift", "#old-class", "SOURCE_CHANGED")):
            task = request(
                taskId=identity, mode="html", allowedMethods=["html"], url=PAGE,
                recipe={"fields": [{"field": "label", "selector": field}]},
            )
            self.assertEqual((await client.post(TASKS, json=task)).status_code, 202)
            result = (await self.terminal(client, task))["result"]
            self.assertEqual(result["error"]["code"], code, result)
            self.assertEqual(result["observations"], [])
        self.assertEqual(list(self.artifacts.iterdir()), [])

    async def test_cancels_io_then_accepts_new_attempt(self):
        started, stopped = asyncio.Event(), asyncio.Event()

        async def respond(_):
            started.set()
            try:
                await asyncio.Future()
            finally:
                stopped.set()

        client = await self.api(respond)
        task = request()
        self.assertEqual((await client.post(TASKS, json=task)).status_code, 202)
        await asyncio.wait_for(started.wait(), 2)
        next_task = {**task, "attemptId": "next_attempt"}
        self.assertEqual((await client.post(TASKS, json=next_task)).status_code, 409)
        cancellation = await client.post(f"{TASKS}/{task['taskId']}/cancel", params={"attemptId": task["attemptId"]})
        self.assertEqual(cancellation.json()["cancellation"], "requested")
        await self.terminal(client, task, state="cancelled")
        self.assertTrue(stopped.is_set())
        self.assertEqual((await client.post(TASKS, json=next_task)).status_code, 202)
        self.assertEqual((await client.post(f"{TASKS}/{task['taskId']}/cancel")).json()["attemptId"], "next_attempt")
        await self.terminal(client, next_task, state="cancelled")
        self.assertEqual(list(self.artifacts.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
