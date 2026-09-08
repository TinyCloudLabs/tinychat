"""Run inside the pinned ingress image, with Docker networking disabled.

Only local synthetic HTTP is used. The shipped nginx.conf and generated server
template are preserved apart from local ports, hostname, and certificate paths.
This measures that image, not production gateway or browser behavior.
"""

import concurrent.futures
import hashlib
import http.client
import http.server
import json
from pathlib import Path
import ssl
import subprocess
import threading
import time


class SyntheticOrigin(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        heartbeat = self.path == "/heartbeat"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        try:
            start = time.monotonic()
            self.wfile.write(b": heartbeat\n\n")
            self.wfile.flush()
            if heartbeat:
                for index in range(1, 8):
                    time.sleep(max(0, start + index * 10 - time.monotonic()))
                    self.wfile.write(b": heartbeat\n\n")
                    self.wfile.flush()
            time.sleep(max(0, start + 75 - time.monotonic()))
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


def receive(case):
    connection = http.client.HTTPSConnection(
        "127.0.0.1", 8443, timeout=85, context=ssl._create_unverified_context()
    )
    start = time.monotonic()
    comments, done, read_error, eof = [], [], None, False
    pending = b""
    connection.request("GET", "/" + case)
    response = connection.getresponse()
    try:
        while True:
            data = response.read1(4096)
            if not data:
                eof = True
                break
            pending += data
            while b"\n\n" in pending:
                frame, pending = pending.split(b"\n\n", 1)
                elapsed = round((time.monotonic() - start) * 1000, 2)
                if frame.startswith(b":"):
                    comments.append(elapsed)
                if frame == b"data: [DONE]":
                    done.append(elapsed)
    except Exception as error:
        read_error = type(error).__name__
    finally:
        connection.close()
    elapsed = round((time.monotonic() - start) * 1000, 2)
    return {
        "case": case,
        "httpStatus": response.status,
        "httpVersion": response.version,
        "commentArrivalMs": comments,
        "maxCommentGapMs": max((b-a for a, b in zip(comments, comments[1:])), default=None),
        "doneArrivalMs": done,
        "observedEof": eof,
        "readErrorClass": read_error,
        "elapsedMs": elapsed,
    }


entrypoint = Path("/scripts/entrypoint.sh").read_text()
nginx_conf = Path("/etc/nginx/nginx.conf").read_text()
template = entrypoint.split("cat <<EOF >/etc/nginx/conf.d/default.conf\n", 1)[1].split("\nEOF", 1)[0]
for source, target in {
    "${PORT}": "8443", "${DOMAIN}": "localhost", "${PROXY_CMD}": "proxy",
    "${TARGET_ENDPOINT}": "http://127.0.0.1:8000",
    "/etc/letsencrypt/live/localhost/fullchain.pem": "/tmp/cert.pem",
    "/etc/letsencrypt/live/localhost/privkey.pem": "/tmp/key.pem",
    "\\$": "$",
}.items():
    template = template.replace(source, target)
Path("/tmp/server.conf").write_text(template)
Path("/tmp/nginx.conf").write_text(nginx_conf.replace("/etc/nginx/conf.d/*.conf", "/tmp/server.conf"))
subprocess.run([
    "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-keyout", "/tmp/key.pem", "-out", "/tmp/cert.pem",
], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
subprocess.run(["nginx", "-t", "-c", "/tmp/nginx.conf"], check=True, capture_output=True)
origin = http.server.ThreadingHTTPServer(("127.0.0.1", 8000), SyntheticOrigin)
threading.Thread(target=origin.serve_forever, daemon=True).start()
nginx = subprocess.Popen(["nginx", "-c", "/tmp/nginx.conf", "-g", "daemon off;"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    time.sleep(0.3)
    assert nginx.poll() is None, "nginx did not start"
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(receive, ["idle-control", "heartbeat"]))
    report = {
        "scope": "local-pinned-ingress-loopback-synthetic",
        "network": "none",
        "image": "dstacktee/dstack-ingress@sha256:40429d78060ef3066b5f93676bf3ba7c2e9ac47d4648440febfdda558aed4b32",
        "nginxVersion": "1.27.4",
        "sourceSha256": {"entrypoint": hashlib.sha256(entrypoint.encode()).hexdigest(),
                         "nginxConf": hashlib.sha256(nginx_conf.encode()).hexdigest()},
        "heartbeatMs": 10000,
        "syntheticCompletionMs": 75000,
        "results": results,
    }
    print(json.dumps(report, indent=2), flush=True)
    idle, heartbeat = results
    assert 58000 <= idle["elapsedMs"] <= 65000, "idle control did not close near 60s"
    assert not idle["doneArrivalMs"], "idle control unexpectedly completed"
    assert len(idle["commentArrivalMs"]) == 1
    assert heartbeat["httpStatus"] == 200
    assert len(heartbeat["commentArrivalMs"]) == 8
    assert heartbeat["commentArrivalMs"][0] < 2000
    assert heartbeat["maxCommentGapMs"] < 12000, "comments buffered or delayed"
    assert len(heartbeat["doneArrivalMs"]) == 1
    assert 74000 <= heartbeat["elapsedMs"] <= 79000
    assert heartbeat["observedEof"] and not heartbeat["readErrorClass"]
finally:
    nginx.terminate()
    nginx.wait(timeout=5)
    origin.shutdown()
