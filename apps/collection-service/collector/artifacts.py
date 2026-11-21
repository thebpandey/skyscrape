from __future__ import annotations

import hashlib
import os
import re
from contextlib import suppress
from pathlib import Path
from time import time
from uuid import uuid4

from .protocol import CollectionFailure


STAGING_TTL_SECONDS = 1800
STAGED_NAME = re.compile(r"(?:\.pending-)?[0-9a-f]{32}")


def stage_artifact(root: Path, body: bytes, media_type: str) -> dict[str, str | int]:
    artifact_id = uuid4().hex
    pending = root / f".pending-{artifact_id}"
    try:
        expire_before = time() - STAGING_TTL_SECONDS
        for candidate in root.iterdir():
            if STAGED_NAME.fullmatch(candidate.name) and candidate.lstat().st_mtime < expire_before:
                candidate.unlink()
        descriptor = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(body)
            handle.flush()
            os.fsync(handle.fileno())
        pending.rename(root / artifact_id)
    except OSError:
        with suppress(OSError):
            pending.unlink(missing_ok=True)
        raise CollectionFailure("STORAGE_FAILED", retryable=True) from None

    return {
        "artifactId": artifact_id,
        "sha256": hashlib.sha256(body).hexdigest(),
        "bytes": len(body),
        "mediaType": media_type,
    }
