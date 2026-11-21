from __future__ import annotations

import json
import ssl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


class Publisher(BaseHTTPRequestHandler):
    def do_GET(self):
        host = self.headers["Host"]
        url = urlsplit(self.path)
        if host == "data.seattle.gov":
            Path("/fixture/canary-reached").touch()
        if url.path.startswith("/resource/"):
            query = parse_qs(url.query)
            if host == "data.austintexas.gov" and query.get("$select") != ["permit_number"]:
                self.send_error(400)
                return
            if query.get("$offset") == ["9"]:
                self.send_response(302)
                self.send_header("Location", "https://data.seattle.gov/resource/76t5-zqzr.json")
                self.end_headers()
                return
            body = json.dumps([{"permit_number": "SYNTHETIC-123"}]).encode()
            media_type = "application/json"
        else:
            body = b'<main><p id="permit-label">Synthetic public label</p></main>'
            media_type = "text/html"
        limited = url.path == "/d/3syk-w9eu"
        self.send_response(429 if limited else 200)
        if limited:
            self.send_header("Retry-After", "60")
        self.send_header("Content-Type", media_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


server = ThreadingHTTPServer(("0.0.0.0", 443), Publisher)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain("/fixture/cert.pem", "/fixture/key.pem")
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
