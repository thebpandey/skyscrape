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

from .policy import CrawlDelay, prepare_url
from .protocol import CollectionFailure


PROXY = "http://collection-egress:3128"
ENGINE = f"scrapling-{version('scrapling')}"
MAX_BYTES = 8 * 1024 * 1024
MAX_OBSERVATIONS = 128
MAX_ORIGINAL_LENGTH = 2048
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
    failure: CollectionFailure | httpx.HTTPError | None = None


@dataclass
class Extraction:
    observations: list[dict]
    error: str | None


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
        headers = dict(response.headers)
        try:
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
        except (CollectionFailure, httpx.HTTPError) as failure:
            return PageResponse(b"", headers, response.status_code, failure)
        finally:
            await response.aclose()

    async def get(self, url: str) -> PageResponse:
        hostname, url = prepare_url(self.task, url)
        for redirect_count in range(11):
            async with self.throttle.request(hostname):
                self.budget.begin_request()
                if self.task["mode"] == "html" and self.html_reader:
                    response = await self.html_reader(url, self.budget)
                else:
                    response = await self.read_native(url)
                if retry_after := response.headers.get("retry-after"):
                    self.throttle.defer(hostname, retry_after)
                if response.failure is not None:
                    raise response.failure
            self.record_response(url, response)
            if response.status in REDIRECT_STATUSES:
                if redirect_count == 10 or "location" not in response.headers:
                    raise CollectionFailure("POLICY_BLOCKED", 403)
                hostname, url = prepare_url(self.task, urljoin(url, response.headers["location"]))
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

    def extract(self, body: bytes) -> Extraction:
        projection = self.task["recipe"]["fields"]
        html = self.task["mode"] == "html"
        if html:
            selector = Selector(body, adaptive=False, huge_tree=False)
            values = []
            for field in projection:
                matches = selector.css(field["selector"])
                value = matches[0].get_all_text(separator=" ", strip=True) if len(matches) == 1 else None
                values.append((field["field"], value, field["selector"]))
            rows = iter(values)
        else:
            try:
                if self.task["recipe"]["format"] == "json":
                    data = json.loads(body)
                    records = data if isinstance(data, list) else [data]
                    if any(not isinstance(record, dict) for record in records):
                        raise ValueError
                    projected_keys = {field["key"] for field in projection}
                    if any(record.keys() - projected_keys for record in records):
                        self.content = "unexpected"
                        raise CollectionFailure("POLICY_BLOCKED", 403)
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
        source_changed = False
        limited = False
        for name, value, locator in rows:
            if isinstance(value, (float, int, bool)):
                if isinstance(value, float) and not math.isfinite(value):
                    continue
                value = json.dumps(value)
            if not isinstance(value, str) or not value.strip():
                source_changed |= html
                continue
            # The TypeScript contract applies its string cap in UTF-16 code units.
            if len(value) > MAX_ORIGINAL_LENGTH or len(value.encode("utf-16-le")) > 2 * MAX_ORIGINAL_LENGTH:
                limited = True
                continue
            if len(observations) == MAX_OBSERVATIONS:
                limited = True
                break
            observations.append({"field": name, "original": value.strip(), "locator": locator})
        if not observations and not limited:
            self.content = "empty" if not html and not records else "unexpected"
            code = "EMPTY_CONTENT" if self.content == "empty" else "SOURCE_CHANGED"
            raise CollectionFailure(code)
        error = "SOURCE_CHANGED" if source_changed else "PARTIAL_CONTENT" if limited else None
        return Extraction(observations, error)


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
    except CurlError as error:
        failed = getattr(error, "response", None)
        failure = CollectionFailure("BUDGET_EXCEEDED") if limited else CollectionFailure(
            "SOURCE_ACCESS_DENIED", retryable=True,
        )
        if failed is None or not failed.status_code:
            raise failure from None
        headers = {name.lower(): value for name, value in failed.headers.items()}
        if failed.status_code == 429:
            return PageResponse(b"", headers, 429)
        return PageResponse(b"", headers, failed.status_code, failure)
    headers = {name.lower(): value for name, value in response.headers.items()}
    if response.status < 300 and headers.get("content-encoding", "identity").lower() != "identity":
        return PageResponse(b"", headers, response.status, CollectionFailure("PARSE_FAILED"))
    return PageResponse(bytes(body), headers, response.status)


def utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")
