from __future__ import annotations

import asyncio
import hashlib
import json
import re
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from secrets import compare_digest

import httpx
from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from .artifacts import stage_artifact
from .policy import CrawlDelay, check_url
from .protocol import CollectionFailure, collection_error, parse_object, protocol_validators
from .retrieve import ENGINE, Budget, Retrieval, utc_now


MAX_BODY = 32_768
MAX_IN_FLIGHT = 8
MAX_RETAINED_ATTEMPTS = 65_536
RESULT_TTL = 900
MAX_RETAINED_RESULTS = 128
MODES = ("structured", "html")
IDENTIFIER = re.compile(r"[A-Za-z0-9_-]{1,100}")


@dataclass
class Job:
    identity: dict
    budget: Budget
    state: str = "queued"
    work: asyncio.Task | None = None
    result: dict | None = None
    finished_at: float | None = None

    def status(self) -> dict:
        if self.result is not None:
            return {"protocolVersion": 1, "state": "finished", "result": self.result}
        return {**self.identity, "state": self.state, "counters": self.budget.report()}


def create_app(
    *, token: bytes, staging: Path, schema: Path, client_factory, html_reader=None,
    crawl_delay: float = 1,
) -> FastAPI:
    validators = protocol_validators(schema)
    jobs: dict[tuple[str, str], Job] = {}
    admitted: dict[tuple[str, str], bytes] = {}
    current: dict[str, str] = {}
    concurrency = asyncio.Semaphore(2)
    throttle = CrawlDelay(crawl_delay)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        work = [job.work for job in jobs.values() if job.work and not job.work.done()]
        for running in work:
            running.cancel()
        await asyncio.gather(*work, return_exceptions=True)

    app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None, lifespan=lifespan)

    def response(name: str, body: dict, status: int = 200) -> JSONResponse:
        validators[name].validate(body)
        return JSONResponse(body, status_code=status)

    @app.exception_handler(CollectionFailure)
    async def respond_failure(request: Request, failure: CollectionFailure):
        return response("CollectionError", collection_error(failure, getattr(request.state, "task", None)), failure.status)

    async def authorize(request: Request) -> None:
        scheme, _, credential = request.headers.get("authorization", "").partition(" ")
        if not compare_digest(credential.encode("utf-8"), token) or scheme.lower() != "bearer":
            raise CollectionFailure("AUTH_REQUIRED", 401)

    async def run(job: Job, task: dict, deadline: float) -> None:
        retrieval: Retrieval | None = None
        evidence, observations = [], []
        failure = None
        try:
            async with asyncio.timeout_at(deadline):
                async with concurrency:
                    job.state = "running"
                    async with client_factory() as client:
                        retrieval = Retrieval(task, client, throttle, job.budget, html_reader)
                        document = await retrieval.get(task["url"])
                        retrieval.check_document(document.body)
                        fields, truncated = retrieval.extract(document.body)
                    await asyncio.sleep(0)
                    if asyncio.get_running_loop().time() >= deadline:
                        raise CollectionFailure("BUDGET_EXCEEDED")
                    assert retrieval.media_type
                    manifest = stage_artifact(staging, document.body, retrieval.media_type)
                    evidence.append(manifest)
                    observations.extend({**field, "artifactId": manifest["artifactId"]} for field in fields)
                    if truncated:
                        failure = CollectionFailure("PARTIAL_CONTENT")
        except asyncio.CancelledError:
            job.state = "cancelled"
            return
        except CollectionFailure as error:
            failure = error
        except TimeoutError:
            failure = CollectionFailure("BUDGET_EXCEEDED")
        except httpx.HTTPError:
            failure = CollectionFailure("SOURCE_ACCESS_DENIED", retryable=True)
        except Exception:
            failure = CollectionFailure("INTERNAL_ERROR", 500, True)
        finally:
            job.finished_at = asyncio.get_running_loop().time()

        result = {
            **job.identity, "classification": "success" if failure is None else "partial" if observations else "failed",
            "retrievedAt": utc_now(),
            "redirects": retrieval.redirects if retrieval else [],
            "engineVersion": ENGINE,
            "counters": job.budget.report(),
            "evidence": evidence,
            "observations": observations,
        }
        if retrieval:
            result.update({key: value for key, value in {
                "finalUrl": retrieval.final_url,
                "httpStatus": retrieval.status,
                "responseMediaType": retrieval.media_type,
                "contentClassification": retrieval.content,
                "sourceTimestamp": retrieval.source_time,
            }.items() if value is not None and value != ""})
        if failure:
            result["error"] = collection_error(failure, task)
        if not validators["TaskResult"].is_valid(result):
            result = {
                **job.identity, "classification": "failed", "retrievedAt": utc_now(), "redirects": [],
                "engineVersion": ENGINE, "counters": job.budget.report(), "evidence": [], "observations": [],
                "error": collection_error(CollectionFailure("INTERNAL_ERROR", 500, True), task),
            }
        job.result = result
        job.state = "finished"

    def trim_results() -> None:
        now = asyncio.get_running_loop().time()
        finished = [(key, job.finished_at) for key, job in jobs.items() if job.finished_at is not None]
        for index, (key, completed) in enumerate(sorted(finished, key=lambda item: item[1])):
            if completed < now - RESULT_TTL or index < len(finished) - MAX_RETAINED_RESULTS:
                del jobs[key]
                if current.get(key[0]) == key[1]:
                    del current[key[0]]

    def find_job(task_id: str, attempt_id: str | None) -> Job:
        if not IDENTIFIER.fullmatch(task_id) or (attempt_id is not None and not IDENTIFIER.fullmatch(attempt_id)):
            raise CollectionFailure("UNKNOWN_TASK", 404)
        trim_results()
        if attempt_id is None:
            attempt_id = current.get(task_id)
        job = jobs.get((task_id, attempt_id))
        if job is None:
            raise CollectionFailure("UNKNOWN_TASK", 404)
        return job

    auth = [Depends(authorize)]

    @app.get("/internal/v1/health", dependencies=auth)
    async def health():
        return response("Health", {"protocolVersion": 1, "engineVersion": ENGINE, "modes": list(MODES)})

    @app.post("/internal/v1/tasks", dependencies=auth)
    async def submit(request: Request):
        if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise CollectionFailure("SCHEMA_MISMATCH", 415)
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > MAX_BODY:
                raise CollectionFailure("BUDGET_EXCEEDED", 413)
            body.extend(chunk)
        try:
            task = parse_object(body)
        except ValidationError:
            raise CollectionFailure("SCHEMA_MISMATCH", 400) from None
        if "protocolVersion" in task and task["protocolVersion"] != 1:
            raise CollectionFailure("UNSUPPORTED_PROTOCOL_VERSION", 400)
        if not validators["TaskRequest"].is_valid(task):
            raise CollectionFailure("SCHEMA_MISMATCH", 400)
        request.state.task = task

        identity = {"protocolVersion": 1, "taskId": task["taskId"], "attemptId": task["attemptId"]}
        key = (identity["taskId"], identity["attemptId"])
        fingerprint = hashlib.sha256(json.dumps(task, sort_keys=True, separators=(",", ":")).encode()).digest()
        if key in admitted:
            if admitted[key] != fingerprint:
                raise CollectionFailure("POLICY_BLOCKED", 409)
            return response("TaskAccepted", {**identity, "state": "accepted"}, 202)
        trim_results()
        predecessor = jobs.get((task["taskId"], current.get(task["taskId"])))
        if predecessor is not None and predecessor.state in {"queued", "running"}:
            raise CollectionFailure("POLICY_BLOCKED", 409)
        if len(admitted) >= MAX_RETAINED_ATTEMPTS or sum(
            job.state in {"queued", "running"} for job in jobs.values()
        ) >= MAX_IN_FLIGHT:
            raise CollectionFailure("RATE_LIMITED", 429, True)

        if task["mode"] not in MODES:
            raise CollectionFailure("POLICY_BLOCKED", 403)
        hostname = check_url(task, task["url"])
        if set(task["permissions"]["allowedDomains"]) != {hostname}:
            raise CollectionFailure("POLICY_BLOCKED", 403)
        try:
            deadline = datetime.fromisoformat(task["deadline"])
        except ValueError:
            raise CollectionFailure("SCHEMA_MISMATCH", 400) from None
        if deadline.tzinfo is None:
            raise CollectionFailure("SCHEMA_MISMATCH", 400)
        timeout = (deadline - datetime.now(UTC)).total_seconds()
        if not 0 < timeout <= 600:
            raise CollectionFailure("BUDGET_EXCEEDED", 400)

        job = Job(identity, Budget(task["limits"]))
        admitted[key] = fingerprint
        current[task["taskId"]] = task["attemptId"]
        jobs[key] = job
        deadline_at = asyncio.get_running_loop().time() + timeout
        job.work = asyncio.create_task(run(job, task, deadline_at))
        return response("TaskAccepted", {**identity, "state": "accepted"}, 202)

    @app.get("/internal/v1/tasks/{task_id}", dependencies=auth)
    async def status(task_id: str, attemptId: str | None = None):
        return response("TaskStatus", find_job(task_id, attemptId).status())

    @app.post("/internal/v1/tasks/{task_id}/cancel", dependencies=auth)
    async def cancel(task_id: str, attemptId: str | None = None):
        job = find_job(task_id, attemptId)
        if job.state == "finished":
            cancellation = "already_finished"
        elif job.state == "cancelled":
            cancellation = "cancelled"
        else:
            assert job.work
            job.work.cancel()
            if job.state == "queued":
                job.state = "cancelled"
                job.finished_at = asyncio.get_running_loop().time()
            cancellation = "requested"
        return response("CancelAcknowledgement", {**job.identity, "cancellation": cancellation})

    return app
