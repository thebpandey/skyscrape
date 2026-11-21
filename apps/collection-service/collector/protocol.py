from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from pydantic import JsonValue, TypeAdapter


def protocol_validators(schema_path: Path) -> dict[str, Draft202012Validator]:
    schema = json.loads(schema_path.read_bytes())
    return {
        name: Draft202012Validator(
            {
                "$schema": schema["$schema"],
                "$defs": schema["$defs"],
                "$ref": f"#/$defs/{name}",
            },
            format_checker=FormatChecker(),
        )
        for name in (
            "TaskRequest", "TaskAccepted", "TaskStatus", "TaskResult",
            "CancelAcknowledgement", "Health", "CollectionError",
        )
    }


parse_object = TypeAdapter(dict[str, JsonValue]).validate_json


class CollectionFailure(Exception):
    def __init__(self, code: str, status: int = 400, retryable: bool = False) -> None:
        self.code = code
        self.status = status
        self.retryable = retryable


MESSAGES = {
    "AUTH_REQUIRED": ("Authorization is required", "Check the permitted service or source access"),
    "BUDGET_EXCEEDED": ("A collection limit was reached", "Review the attempt limits"),
    "CHALLENGE_REQUIRED": ("The source returned a human verification page", "Review source access before retrying"),
    "EMPTY_CONTENT": ("The source returned no usable content", "Review coverage and source results"),
    "FREE_QUOTA_EXHAUSTED": ("Free request quota was exhausted", "Wait for a qualified free quota"),
    "INTERNAL_ERROR": ("Collection could not complete", "Check collector health and the correlation ID"),
    "PARSE_FAILED": ("The response could not be parsed", "Review the expected response format"),
    "PARTIAL_CONTENT": ("Collection reached a response or observation limit", "Review the evidence and attempt limits"),
    "POLICY_BLOCKED": ("Collection policy denied the request", "Review the qualified source and attempt policy"),
    "RATE_LIMITED": ("The source or collector is at capacity", "Wait before attempting another request"),
    "SCHEMA_MISMATCH": ("The request does not match the collection protocol", "Check the request schema"),
    "SOURCE_ACCESS_DENIED": ("The source refused access", "Review source eligibility before retrying"),
    "SOURCE_CHANGED": ("Expected fields were missing", "Review the connector recipe"),
    "STORAGE_FAILED": ("Evidence could not be staged", "Check the staging volume and its capacity"),
    "UNKNOWN_TASK": ("The collector has no current status for this attempt", "Reconcile the attempt with the worker"),
    "UNSUPPORTED_PROTOCOL_VERSION": ("The requested protocol is unsupported", "Use collection protocol version 1"),
}


def collection_error(failure: CollectionFailure, task: dict[str, Any] | None = None) -> dict[str, Any]:
    message, next_action = MESSAGES[failure.code]
    value: dict[str, Any] = {
        "code": failure.code,
        "message": message,
        "retryable": failure.retryable,
        "correlationId": task["correlationId"] if task else "collector",
        "action": "Collect from a qualified source",
        "outcome": message,
        "nextAction": next_action,
    }
    if task:
        value["provenance"] = {
            "sourceId": task["sourceId"],
            "taskId": task["taskId"],
            "runId": task["runId"],
            "connectorVersion": task["recipeVersion"],
        }
    return value
