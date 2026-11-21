from __future__ import annotations

import fcntl
import os
import re
import socket
import ssl
from pathlib import Path

import httpx
import uvicorn

from .retrieve import PROXY, fetch_html
from .service import create_app


SOCKET_PATH = Path("/run/collection/collection.sock")
SCHEMA_PATH = Path("/opt/collection/v1.schema.json")
STAGING_PATH = Path("/var/staging/collection")
TOKEN_PATH = Path("/run/secrets/collection_service_token")


def main() -> None:
    os.umask(0o027)
    with TOKEN_PATH.open("rb") as source:
        token = source.read(257).rstrip(b"\n")
    if not re.fullmatch(rb"[A-Za-z0-9_-]{32,256}", token):
        raise SystemExit("Invalid collection service credential")
    ca_file = os.environ.get("COLLECTION_CA_FILE", "/etc/ssl/certs/ca-certificates.crt")
    tls_context = ssl.create_default_context(cafile=ca_file)
    app = create_app(
        token=token,
        staging=STAGING_PATH,
        schema=SCHEMA_PATH,
        html_reader=lambda url, budget, on_retry_after: fetch_html(url, budget, ca_file, on_retry_after),
        client_factory=lambda: httpx.AsyncClient(
            proxy=PROXY, verify=tls_context, trust_env=False, timeout=10, follow_redirects=False,
        ),
    )
    with SOCKET_PATH.with_suffix(".lock").open("w") as lock, socket.socket(socket.AF_UNIX) as listener:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        SOCKET_PATH.unlink(missing_ok=True)
        listener.bind(str(SOCKET_PATH))
        SOCKET_PATH.chmod(0o660)
        try:
            server = uvicorn.Server(uvicorn.Config(app, access_log=False, server_header=False))
            server.run(sockets=[listener])
        finally:
            SOCKET_PATH.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
