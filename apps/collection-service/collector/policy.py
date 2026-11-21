from __future__ import annotations

import asyncio
from collections import defaultdict
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qsl, urlsplit

from .protocol import CollectionFailure


@dataclass(frozen=True)
class SourcePolicy:
    dataset: str
    page: str
    keys: frozenset[str]

    @property
    def data_path(self) -> str:
        return f"/resource/{self.dataset}.json"


SOURCES = {
    "data.austintexas.gov": SourcePolicy(
        "3syk-w9eu", "/Building-and-Development/Issued-Construction-Permits/3syk-w9eu",
        frozenset((
            "project_id", "permit_number", "permittype", "permit_type_desc", "permit_class",
            "permit_class_mapped", "work_class", "description", "applieddate", "issue_date",
            "expiresdate", "statusdate", "status_current", "permit_location", "original_address1",
            "tcad_id", "original_zip", "latitude", "longitude", "total_job_valuation", "housing_units",
        )),
    ),
    "data.seattle.gov": SourcePolicy(
        "76t5-zqzr", "/Built-Environment/Building-Permits/76t5-zqzr",
        frozenset((
            "permitnum", "permitclass", "permitclassmapped", "permittypemapped", "permittypedesc",
            "description", "applieddate", "issueddate", "expiresdate", "completeddate",
            "statuscurrent", "originaladdress1", "originalzip", "development_site", "latitude",
            "longitude", "location1", "estprojectcost", "housingunits", "housingunitsadded",
            "housingunitsremoved",
        )),
    ),
}
CENSUS_HOST = "www2.census.gov"
CENSUS_PATH = "/econ/bps/County/co2025a.txt"


def _deny() -> None:
    raise CollectionFailure("POLICY_BLOCKED", 403)


def check_url(task: dict[str, Any], url: str) -> str:
    try:
        parts = urlsplit(url)
        hostname = parts.hostname
        if (
            not hostname or parts.scheme != "https" or parts.netloc != hostname or parts.fragment
            or not url.startswith("https://") or len(url) > 2048
            or any(character.isspace() or ord(character) < 32 or character in "\\\x7f" for character in url)
            or hostname not in task["permissions"]["allowedDomains"]
            or hostname != urlsplit(task["url"]).hostname
        ):
            _deny()
        source = SOURCES.get(hostname)
        if task["mode"] == "structured":
            if hostname == CENSUS_HOST:
                if parts.path != CENSUS_PATH or parts.query or task["recipe"]["format"] != "csv":
                    _deny()
                return hostname
            if not source or parts.path != source.data_path or task["recipe"]["format"] != "json":
                _deny()
            if any(field["key"] not in source.keys for field in task["recipe"]["fields"]):
                _deny()
            parameters = parse_qsl(parts.query, strict_parsing=True, max_num_fields=5)
            query = dict(parameters)
            if len(query) != len(parameters) or query.keys() - {"$select", "$where", "$order", "$limit", "$offset"}:
                _deny()
            if "$select" in query and not {key.strip() for key in query["$select"].split(",")} <= source.keys:
                _deny()
            if any(key in query and (not query[key].isascii() or not query[key].isdecimal())
                   for key in ("$limit", "$offset")):
                _deny()
            if "$limit" in query and int(query["$limit"]) > 1000:
                _deny()
        elif (
            not source or parts.query or parts.path not in (
                f"/d/{source.dataset}", source.page, f"{source.page}/about_data",
            )
        ):
            _deny()
    except (ValueError, TypeError):
        _deny()
    return hostname


class CrawlDelay:
    def __init__(self, seconds: float = 1) -> None:
        self.seconds = seconds
        self.locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self.next_request: dict[str, float] = {}

    async def wait(self, hostname: str) -> None:
        async with self.locks[hostname]:
            clock = asyncio.get_running_loop()
            delay = self.next_request.get(hostname, 0) - clock.time()
            if delay > 0:
                await asyncio.sleep(delay)
            self.next_request[hostname] = clock.time() + self.seconds
