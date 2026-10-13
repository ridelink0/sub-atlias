"""Unknown generation routes must be refused; metadata helpers remain usable. No model calls."""
import http.server
import json
import threading
import urllib.error
import urllib.request
import base_harness_runner as B

seen = []


class Upstream(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        seen.append(self.path)
        body = b'{"fixture":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
door = B.Door(f"http://127.0.0.1:{upstream.server_port}", "fixture", 32, 2)
for server in (upstream, door):
    threading.Thread(target=server.serve_forever, daemon=True).start()
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
results = []
try:
    for route in ("/api/generate", "/api/chat", "/v1/completions", "/v1/embeddings", "/unexpected/generate", "/v1/responses/future"):
        request = urllib.request.Request(door.base + route, data=b'{}', headers={"Content-Type": "application/json"}, method="POST")
        try:
            with opener.open(request, timeout=3) as response:
                status = response.status
                response.read()
        except urllib.error.HTTPError as error:
            status = error.code
            error.read()
        results.append((route, status == 501 and not seen and door.calls == 0 and not door.usage
                        and door.receipts[-1]["path"] == route and "refused" in door.receipts[-1]["outcome"]))
    for route in ("/api/show", "/v1/messages/count_tokens"):
        request = urllib.request.Request(door.base + route, data=b'{}', headers={"Content-Type": "application/json"}, method="POST")
        with opener.open(request, timeout=3) as response:
            status = response.status
            response.read()
        results.append((route, status == 200 and seen[-1] == route and door.calls == 0 and not door.usage))
    results.append(("metadata helpers are recorded separately", len(door.passed) == 2 and len(seen) == 2))
finally:
    for server in (door, upstream):
        server.shutdown()
        server.server_close()
for label, passed in results:
    print(("PASS " if passed else "FAIL ") + label)
print(json.dumps({"passed": sum(p for _, p in results), "total": len(results), "modelInvoked": False}))
raise SystemExit(0 if all(p for _, p in results) else 1)
