from __future__ import annotations

import hashlib
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

ACTUAL = "/internal/v1/tasks"


def run(client, name, url, mode, recipe, domain="data.austintexas.gov", limit=4096, seconds=25):
    payload = {
        "protocolVersion": 1, "taskId": name, "attemptId": "one", "runId": "synthetic",
        "correlationId": "synthetic", "sourceId": "synthetic_source", "sourceVersion": "1",
        "recipeVersion": "1", "mode": mode, "url": url, "allowedMethods": [mode], "recipe": recipe,
        "permissions": {"assessmentId": "synthetic_fixture", "allowedDomains": [domain]},
        "deadline": (datetime.now(UTC) + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z"),
        "limits": {"requests": 3, "bytes": limit, "browserSeconds": 0, "quotaUnits": 3, "costMicros": 0},
    }
    submit = client.post(ACTUAL, json=payload)
    assert submit.status_code == 202, submit.status_code
    for _ in range(150):
        response = client.get(f"{ACTUAL}/{name}", params={"attemptId": "one"})
        result = response.json()
        if result["state"] == "finished":
            return result["result"]
        time.sleep(0.1)
    raise AssertionError(f"Fixture task {name} did not finish")


def verify_result(result, expected):
    assert result["classification"] == "success", result["error"] if "error" in result else result["classification"]
    assert result["observations"][0]["original"] == expected
    assert result["counters"]["requests"] == 1
    manifest = result["evidence"][0]
    root = Path("/var/staging/collection")
    artifact = (root / manifest["artifactId"]).read_bytes()
    assert len(artifact) == manifest["bytes"]
    assert hashlib.sha256(artifact).hexdigest() == manifest["sha256"]
    try:
        (root / "forbidden").touch()
    except PermissionError:
        pass
    except OSError as error:
        assert error.errno == 30
    else:
        raise AssertionError("The consumer can write to the evidence mount")


credential = Path("/run/secrets/collection_service_token").read_text().strip()
with httpx.Client(
    base_url="http://collector",
    transport=httpx.HTTPTransport(uds="/run/collection/collection.sock"),
    headers={"Authorization": f"Bearer {credential}"},
    timeout=4,
) as client:
    for _ in range(100):
        try:
            health = client.get("/internal/v1/health")
            break
        except httpx.ConnectError:
            time.sleep(0.1)
    else:
        raise AssertionError("The authenticated collection socket never opened")
    assert health.json()["modes"] == ["structured", "html"]
    assert health.json()["engineVersion"] == "scrapling-0.5.1"
    assert client.get("/internal/v1/health", headers={"Authorization": "Bearer incorrect"}).status_code == 401

    austin_data = "https://data.austintexas.gov/resource/3syk-w9eu.json"
    permit = {"format": "json", "fields": [{"field": "permitNumber", "key": "permit_number"}]}
    verify_result(run(client, "synthetic_data", austin_data, "structured", permit), "SYNTHETIC-123")

    austin_page = "https://data.austintexas.gov/Building-and-Development/Issued-Construction-Permits/3syk-w9eu/about_data"
    html = {"fields": [{"field": "label", "selector": "#permit-label"}]}
    verify_result(run(client, "synthetic_html", austin_page, "html", html), "Synthetic public label")
    oversized = run(client, "synthetic_size_cap", austin_page, "html", html, limit=8)
    assert oversized["error"]["code"] == "BUDGET_EXCEEDED" and oversized["counters"]["requests"] == 1
    assert oversized["counters"]["bytes"] == 8 and oversized["evidence"] == []

    redirect = run(client, "synthetic_redirect", f"{austin_data}?%24offset=9", "structured", permit)
    assert redirect["error"]["code"] == "POLICY_BLOCKED" and redirect["counters"]["requests"] == 1
    seattle = {"format": "json", "fields": [{"field": "permitNumber", "key": "permitnum"}]}
    denied = run(client, "synthetic_internal", "https://data.seattle.gov/resource/76t5-zqzr.json",
                 "structured", seattle, domain="data.seattle.gov")
    assert denied["error"]["code"] == "SOURCE_ACCESS_DENIED" and denied["evidence"] == []
    assert denied["counters"]["requests"] == 1
    throttled = run(client, "synthetic_429", "https://data.austintexas.gov/d/3syk-w9eu", "html", html, limit=8)
    assert throttled["error"]["code"] == "RATE_LIMITED"
    assert throttled["counters"]["bytes"] == 8 and throttled["counters"]["requests"] == 1
    blocked = run(client, "synthetic_retry_wait", austin_data, "structured", permit, seconds=1)
    assert blocked["error"]["code"] == "BUDGET_EXCEEDED" and blocked["counters"]["requests"] == 0

print("PASS authenticated Unix socket, structured TLS, Scrapling HTTP, one-request byte cap, and private artifacts")
print("PASS municipal projection and publisher Retry-After are enforced across retrieval modes")
print("PASS redirects remain in-source and proxy blocks the internal canary")
