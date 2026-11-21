from __future__ import annotations

import csv
import io
import json
import math
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from importlib.metadata import version
from typing import Awaitable, Callable
from urllib.parse import urljoin

import httpx
from curl_cffi.curl import CURL_WRITEFUNC_ERROR, CurlError
from scrapling import Selector
from scrapling.core.utils import log as scrapling_log
from scrapling.fetchers import AsyncFetcher

from .policy import CrawlDelay, check_url
from .protocol import CollectionFailure


PROXY = "http://collection-egress:3128"
ENGINE = f"scrapling-{version('scrapling')}"
MAX_BYTES = 8 * 1024 * 1024
MAX_OBSERVATIONS = 128
REDIRECT_STATUSES = {301, 302, 303, 307, 308}


@dataclass
class Budget:
    limits: dict
    requests: int = 0
    bytes: int = 0

    @property
    def bytes_remaining(self) -> int:
        return min(self.limits["bytes"], MAX_BYTES) - self.bytes

    def begin_request(self) -> None:
        if self.requests >= self.limits["requests"] or self.bytes_remaining <= 0:
            raise CollectionFailure("BUDGET_EXCEEDED")
        if self.requests >= self.limits["quotaUnits"]:
            raise CollectionFailure("FREE_QUOTA_EXHAUSTED")
        self.requests += 1

    def charge(self, size: int) -> None:
        remaining = self.bytes_remaining
        self.bytes += min(size, remaining)
        if size > remaining:
            raise CollectionFailure("BUDGET_EXCEEDED")

    def report(self) -> dict[str, int]:
        return {
            "requests": self.requests, "bytes": self.bytes, "browserSeconds": 0,
            "quotaUnits": self.requests, "costMicros": 0,
        }


@dataclass
class PageResponse:
    body: bytes
    headers: dict[str, str]
    status: int


@dataclass
class Retrieval:
    task: dict
    client: httpx.AsyncClient
    throttle: CrawlDelay
    budget: Budget
    html_reader: Callable[[str, Budget], Awaitable[PageResponse]] | None = None
    redirects: list[str] = field(default_factory=list)
    final_url: str | None = None
    status: int | None = None
    media_type: str | None = None
    content: str | None = None
    source_time: str | None = None

    async def read_native(self, url: str) -> PageResponse:
        request = httpx.Request(
            "GET", url, headers={
                "Accept-Encoding": "identity",
                "User-Agent": "Skyscrape-Collection/1.0",
            },
        )
        response = await self.client.send(request, stream=True, follow_redirects=False)
        try:
            headers = dict(response.headers)
            content = bytearray()
            if 200 <= response.status_code < 300 and response.status_code != 206:
                if headers.get("content-encoding", "identity").lower() != "identity":
                    raise CollectionFailure("PARSE_FAILED")
                content_length = headers.get("content-length", "")
                if content_length.isdecimal() and int(content_length) > self.budget.bytes_remaining:
                    raise CollectionFailure("BUDGET_EXCEEDED")
                async for chunk in response.aiter_raw(chunk_size=65536):
                    self.budget.charge(len(chunk))
                    content.extend(chunk)
            return PageResponse(bytes(content), headers, response.status_code)
        finally:
            await response.aclose()

    async def get(self, url: str) -> PageResponse:
        for redirect_count in range(11):
            hostname = check_url(self.task, url)
            await self.throttle.wait(hostname)
            self.budget.begin_request()
            if self.task["mode"] == "html" and self.html_reader:
                response = await self.html_reader(url, self.budget)
            else:
                response = await self.read_native(url)
            self.record_response(url, response)
            if response.status in REDIRECT_STATUSES:
                if redirect_count == 10 or "location" not in response.headers:
                    raise CollectionFailure("POLICY_BLOCKED", 403)
                url = urljoin(url, response.headers["location"])
                check_url(self.task, url)
                self.redirects.append(url)
                continue
            self.check_status()
            return response
        raise CollectionFailure("POLICY_BLOCKED", 403)

    def record_response(self, url: str, response: PageResponse) -> None:
        self.final_url = url
        self.status = response.status
        self.media_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()[:255]
        self.source_time = None
        if timestamp := response.headers.get("last-modified"):
            try:
                parsed = parsedate_to_datetime(timestamp)
                if parsed.tzinfo:
                    self.source_time = parsed.astimezone(UTC).isoformat().replace("+00:00", "Z")
            except (TypeError, ValueError, OverflowError):
                pass

    def check_status(self) -> None:
        assert self.status is not None
        if 200 <= self.status < 300:
            if self.status == 206:
                self.content = "unexpected"
                raise CollectionFailure("PARTIAL_CONTENT")
            return
        if self.status == 401:
            self.content = "auth_required"
            raise CollectionFailure("AUTH_REQUIRED", 401)
        if self.status == 429:
            self.content = "access_denied"
            raise CollectionFailure("RATE_LIMITED", 429, True)
        self.content = "access_denied"
        raise CollectionFailure("SOURCE_ACCESS_DENIED", retryable=self.status >= 500)

    def check_document(self, body: bytes) -> None:
        if not body.strip():
            self.content = "empty"
            raise CollectionFailure("EMPTY_CONTENT")
        if self.media_type == "text/html":
            excerpt = body[:32768].lower()
            if any(marker in excerpt for marker in (b"<title>just a moment", b"verify you are human", b"/cdn-cgi/challenge-platform/")):
                self.content = "challenge"
                raise CollectionFailure("CHALLENGE_REQUIRED")
            if b'type="password"' in excerpt or b"type='password'" in excerpt:
                self.content = "auth_required"
                raise CollectionFailure("AUTH_REQUIRED", 401)
        static_format = self.task["recipe"].get("format")
        allowed = {
            "json": {"application/json"},
            "csv": {"text/csv", "text/plain"},
            None: {"text/html"},
        }
        if self.media_type not in allowed[static_format]:
            self.content = "unexpected"
            raise CollectionFailure("PARSE_FAILED")
        self.content = "expected"

    def extract(self, body: bytes) -> tuple[list[dict], bool]:
        projection = self.task["recipe"]["fields"]
        if self.task["mode"] != "structured":
            selector = Selector(body, adaptive=False, huge_tree=False)
            values = []
            for field in projection:
                matches = selector.css(field["selector"])
                if len(matches) == 1:
                    selected = matches[0]
                    values.append((field["field"], selected.get_all_text(separator=" ", strip=True), field["selector"]))
            rows = iter(values)
        else:
            try:
                if self.task["recipe"]["format"] == "json":
                    data = json.loads(body)
                    records = data if isinstance(data, list) else [data]
                    if any(not isinstance(record, dict) for record in records):
                        raise ValueError
                else:
                    records = list(csv.DictReader(io.StringIO(body.decode("utf-8-sig"))))
            except (ValueError, csv.Error):
                raise CollectionFailure("PARSE_FAILED") from None
            rows = (
                (field["field"], record.get(field["key"]), f"/{index}/{field['key']}")
                for index, record in enumerate(records)
                for field in projection
            )

        observations = []
        for name, value, locator in rows:
            if isinstance(value, (float, int, bool)):
                if isinstance(value, float) and not math.isfinite(value):
                    continue
                value = json.dumps(value)
            if isinstance(value, str) and value.strip():
                if len(observations) == MAX_OBSERVATIONS:
                    return observations, True
                observations.append({"field": name, "original": value.strip()[:2048], "locator": locator})
        if not observations:
            self.content = "empty" if self.task["mode"] == "structured" and not records else "unexpected"
            code = "EMPTY_CONTENT" if self.content == "empty" else "SOURCE_CHANGED"
            raise CollectionFailure(code)
        return observations, False


async def fetch_html(url: str, budget: Budget, ca_file: str) -> PageResponse:
    # Upstream's standard response log includes the full URL and query.
    scrapling_log.disabled = True
    body = bytearray()
    limited = False

    def receive(chunk: bytes) -> int:
        nonlocal limited
        try:
            budget.charge(len(chunk))
        except CollectionFailure:
            limited = True
            return CURL_WRITEFUNC_ERROR
        body.extend(chunk)
        return len(chunk)

    try:
        response = await AsyncFetcher.get(
            url, proxy=PROXY, verify=ca_file, timeout=10, retries=0, follow_redirects=False,
            impersonate=None, stealthy_headers=False, http3=False, accept_encoding="identity",
            headers={"User-Agent": "Skyscrape-Collection/1.0"}, discard_cookies=True,
            content_callback=receive, selector_config={"adaptive": False, "huge_tree": False},
        )
    except CurlError:
        failure = CollectionFailure("BUDGET_EXCEEDED") if limited else CollectionFailure(
            "SOURCE_ACCESS_DENIED", retryable=True,
        )
        raise failure from None
    headers = {name.lower(): value for name, value in response.headers.items()}
    if headers.get("content-encoding", "identity").lower() != "identity":
        raise CollectionFailure("PARSE_FAILED")
    return PageResponse(bytes(body), headers, response.status)


def utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")
