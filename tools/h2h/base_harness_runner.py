"""Base-harness head-to-head for Gev: stock nanobot against stock OpenCode on atlias's task
corpora, with the same local model, to choose the harness atlias is built on.

Each task is run once by the chosen harness as it ships: its own prompt, its own loop and its own
built-in file and shell tools, and nothing of atlias (no atlias tools, skills, hooks or prompt).
Both arms get the same things from this runner and nothing else:
  - the task files in an empty directory and the task's prompt as the one message;
  - the same model through one metering door (below), so sampling and limits cannot differ;
  - the task's `rounds` as the number of model calls allowed, as atlias and the plain arm have;
  - the same wall-clock limit per task, the same grading (the task's check, hidden files written
    only after the harness has stopped, protected files restored first), and no way off this PC.

The metering door is a loopback HTTP server that forwards /v1/chat/completions to Ollama's
OpenAI-compatible endpoint. On every call it sets the model, temperature 0.2 and max_tokens to
--num-predict (atlias's ollamaNumPredict), asks for the usage block, and writes down Ollama's own
prompt and output token counts. The window is the server's own (the private Ollama is started with
OLLAMA_CONTEXT_LENGTH equal to atlias's ollamaNumCtx; --num-ctx is recorded, and checked against
/api/ps after each task, so a run at another window is reported and not passed off as matched).
Past the allowed number of calls the door answers by itself with a plain "stop" message, so the
harness ends its own loop, and the row says so. Any request for somewhere else is refused with 403:
HTTP_PROXY and HTTPS_PROXY of the harness point here.

The report is shaped like `atlias eval --save` output and the plain arm's, so the same summary
reads all of them: id, pass, promptTotal, outputTotal, peakPrompt per task.

Usage:
  python tools/h2h/base_harness_runner.py --harness nanobot|opencode --tasks <dir> [<dir>...]
      --out report.json --model qwen3.5:9b [--ids-from atlias.json] [--only id,id] [--resume]
"""
import argparse
import hashlib
import http.server
import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from mini_swe_runner import case_counts, make_shims, sha  # noqa: E402
from owned_process import LIVE, _LIVE_LOCK, WIN, end_all, kill_tree, release, run_tree, start_owned, watch_parent  # noqa: E402

STOP_TEXT = "The step limit for this task has been reached. Stop now."
KEEP_ENV = {"SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "PATH", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "LANG", "TZ", "SYSTEMDRIVE"}


class Door(http.server.ThreadingHTTPServer):
    """The metering door for one task."""
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, upstream, model, num_predict, budget, skip_titles=False):
        super().__init__(("127.0.0.1", 0), DoorHandler)
        self.upstream = upstream.rstrip("/")
        self.model, self.num_predict, self.budget = model, num_predict, budget
        self.skip_titles = skip_titles  # OpenCode only: its title calls are kept apart from the budget (council 1013b)
        self.titles = 0         # title calls seen; they are in calls, usage and receipts, not in the budget
        self.lock = threading.Lock()
        self.calls = 0          # chat calls asked for
        self.usage = []         # one (prompt, output) per call sent to the model; None where Ollama gave no count
        self.capped = 0         # calls answered by the door itself, past the budget
        self.refused = []       # requests for somewhere else
        self.errors = []        # upstream failures, as text
        self.passed = []        # every other request let through to the model server: seconds in, method, path, status
        self.t0 = time.time()
        self.first = None       # when the first chat call arrived: the task's clock starts there
        self.receipts = []      # one per call the harness made, model or not: raw usage blocks, the parts read, how it ended
        self.partial = 0        # calls whose answer ended before its terminal event
        self.cut = 0            # calls the model server ended at the output cap (council 1013b: never read before)

    @property
    def base(self):
        return f"http://127.0.0.1:{self.server_address[1]}"


def _usage_of(obj):
    u = obj.get("usage") if isinstance(obj, dict) else None
    if not isinstance(u, dict):
        return None
    p, c = u.get("prompt_tokens"), u.get("completion_tokens")
    return (p, c) if isinstance(p, int) and isinstance(c, int) and not isinstance(p, bool) and not isinstance(c, bool) and p >= 0 and c >= 0 else None


MESSAGE_PARTS = (("input_tokens", "uncached"), ("cache_creation_input_tokens", "cacheCreate"), ("cache_read_input_tokens", "cacheRead"), ("output_tokens", "output"))


def _count(v):
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None


def _message_counts(u, got):
    """Folds one usage block in Claude's wire format into got: new input, cache writes and cache
    reads (three parts of what was read, each counted once) and output. A count the block carries
    in a form that is not a whole number of tokens (negative, true or false, text, null, 1.5) makes
    that part unknown, never 0; a later block's count for the same part replaces an earlier one, as
    Claude's stream does."""
    if isinstance(u, dict):
        for key, name in MESSAGE_PARTS:
            if key in u:
                got[name] = _count(u[key]) if _count(u[key]) is not None else "unknown"


def _message_totals(got):
    """Prompt and output tokens out of folded counts; either is None when not known. A cache part
    no block mentioned is 0."""
    parts = [got.get("uncached"), got.get("cacheCreate", 0), got.get("cacheRead", 0)]
    p = sum(parts) if all(_count(x) is not None for x in parts) else None
    return p, _count(got.get("output"))


def _responses_usage(u):
    """Input and output tokens out of a usage block in the Responses format. Cached input and
    reasoning output are parts of those two totals, not additions to them."""
    if not isinstance(u, dict):
        return None
    p, c = _count(u.get("input_tokens")), _count(u.get("output_tokens"))
    return (p, c) if p is not None and c is not None else None


CUT_STOPS = {"length", "max_tokens", "max_output_tokens"}  # chat, messages and Responses names for "ended at the output cap"


def _note_stop(door, rec, why):
    """Keeps why the model server ended a call (finish_reason, stop_reason or the Responses
    incomplete reason) on its receipt, and counts a call ended at the output cap."""
    if not isinstance(why, str) or not why:
        return
    rec["stop"] = why[:40]
    if why in CUT_STOPS and not rec.get("cut"):
        rec["cut"] = True
        with door.lock:
            door.cut += 1


def ended_cut(receipts):
    """Whether the last call that reached the model ended at the output cap: the run then stopped
    on a reply that was never finished, which is not ending by itself (council 1013b, b02 b10 b11 b14)."""
    sent = [r for r in receipts if r.get("slot") is not None]
    return bool(sent) and bool(sent[-1].get("cut"))


def measured_complete(rc, stopped, door):
    """Complete cost observation, separately from native/task completion.

    A budget stop spent no model tokens for its synthetic reply. Every request
    that did reach the provider still needs one terminal, counted receipt.
    """
    if rc != 0 or stopped or door.errors or door.partial or not door.usage:
        return False
    if any(not isinstance(u, (list, tuple)) or len(u) != 2
           or any(_count(v) is None for v in u) for u in door.usage):
        return False
    sent = [r for r in door.receipts if r.get("slot") is not None]
    slots = [r.get("slot") for r in sent]
    if (any(type(slot) is not int for slot in slots)
        or sorted(slots) != list(range(len(door.usage)))
        or any(r.get("outcome") != "complete" for r in sent)):
        return False
    caps = [r for r in door.receipts if str(r.get("outcome", "")).startswith("capped:")]
    return (all(r.get("slot") is None for r in caps)
            and _count(door.capped) is not None and len(caps) == door.capped
            and door.calls == len(door.usage) + door.capped)


ROLE_HEADER = "X-Atlias-Role"  # set by a helper of the harness (the planner and the reporter); it is never copied upstream
ROLE_VALUES = ("planner", "reporter")
# Helper roles only. A primary call past the budget keeps its frozen 200 stop reply; a helper call past the budget is told
# so in a form no reply text can imitate (Codex review 1015, finding 3: a 200 stop with zero usage read as a helper success).
OUTCOME_HEADER = "X-Atlias-Door-Outcome"
OUTCOME_BUDGET_CAPPED = "budget-capped"
# The output cap the door actually sent upstream for a helper call: the smaller of the helper's own cap and the door's
# num_predict, so a helper's cap is honoured but never raised past the run's.
MAX_TOKENS_HEADER = "X-Atlias-Door-Max-Tokens"


def helper_output_cap(body, key, num_predict):
    """(asked, sent) for a helper call: asked is the helper's own positive whole-number cap under key, or None; sent is
    the smaller of asked and num_predict, or num_predict when nothing valid was asked."""
    asked = body.get(key)
    if not (isinstance(asked, int) and not isinstance(asked, bool) and asked > 0):
        asked = None
    return asked, num_predict if asked is None else min(asked, num_predict)


def request_role(headers):
    """The role of one request through the door: planner or reporter when its X-Atlias-Role header says exactly that,
    primary when the header is absent (Claude Code and Codex never send it), and invalid for any other value, an empty
    one, or the header given twice. Each forward upstream builds its own header list, so the header is not copied."""
    values = headers.get_all(ROLE_HEADER) or []
    if not values:
        return "primary"
    if len(values) == 1 and values[0] in ROLE_VALUES:
        return values[0]
    return "invalid"


def _api_of(route):
    """The API a request is for, from its route: chat, messages, responses, or other."""
    if route.endswith("/chat/completions"):
        return "chat"
    if route.endswith("/v1/messages"):
        return "messages"
    if "/v1/responses" in route:
        return "responses"
    return "other"


def role_summary(receipts, usage):
    """The door's figures for each role, from the same receipts and usage slots as the aggregate.
    calls: the calls the door counted for the role, sent to the model or answered by the door past the budget. Over all
    roles these add up to the door's calls. failures: receipts that did not end complete and were not answered by the
    door (an upstream failure, a partial answer, a refused or unmetered request, an invalid role); they are not calls.
    capped: calls answered by the door past the budget. input, output, total and peak: the prompt and output tokens of
    the role's sent calls, total their sum, and peak is the largest prompt plus output of one call. A sent call whose
    count is unknown makes that role's input, output, total and peak None, never a smaller number."""
    rows = {}
    for r in receipts:
        row = rows.setdefault(r["role"], {"calls": 0, "failures": 0, "capped": 0, "slots": []})
        capped = str(r.get("outcome", "")).startswith("capped:")
        if capped:
            row["capped"] += 1
        if capped or r.get("slot") is not None:
            row["calls"] += 1
        if r.get("slot") is not None:
            row["slots"].append(r["slot"])
        if not capped and r.get("outcome") != "complete":
            row["failures"] += 1
    out = {}
    for role in sorted(rows):
        row = rows[role]
        pairs = [usage[i] for i in row["slots"]]
        known = all(p is not None for p in pairs)
        inp = sum(p for p, _ in pairs) if known else None
        outp = sum(c for _, c in pairs) if known else None
        out[role] = {"calls": row["calls"], "failures": row["failures"], "capped": row["capped"], "input": inp, "output": outp,
                     "total": inp + outp if known else None, "peak": max((p + c for p, c in pairs), default=0) if known else None}
    return out


def sum_role_summaries(summaries):
    """Several tasks' role figures added up. A role is None for input, output, total and peak once any task's figure for it is None."""
    out = {}
    for s in summaries:
        for role, c in s.items():
            t = out.setdefault(role, {"calls": 0, "failures": 0, "capped": 0, "input": 0, "output": 0, "total": 0, "peak": 0})
            for k in ("calls", "failures", "capped"):
                t[k] += c[k]
            for k in ("input", "output", "total"):
                t[k] = None if t[k] is None or c[k] is None else t[k] + c[k]
            t["peak"] = None if t["peak"] is None or c["peak"] is None else max(t["peak"], c["peak"])
    return dict(sorted(out.items()))


TITLE_MARKER = "You are a title generator. You output ONLY a thread title."  # OpenCode's title agent (packages/core/src/plugin/agent.ts PROMPT_TITLE, d2905b8 and 026b106)


def is_title_call(body):
    """OpenCode's title request: the title agent's prompt is its system message, sent as a string or as text parts.
    A user message that happens to carry the same words is an ordinary call (council 1013b, b10 F5, b11 F1)."""
    for m in body.get("messages") or []:
        if not isinstance(m, dict) or m.get("role") != "system":
            continue
        c = m.get("content")
        if isinstance(c, list):
            c = "".join(p["text"] for p in c if isinstance(p, dict) and isinstance(p.get("text"), str))
        if isinstance(c, str) and TITLE_MARKER in c:
            return True
    return False


def _message_usage(u):
    """Prompt and output tokens out of one usage block in Claude's wire format. The prompt is all
    that was read: new tokens, tokens served from cache and tokens written to it."""
    got = {}
    _message_counts(u, got)
    return _message_totals(got)


class DoorHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"  # one request per connection; the body ends when the door closes it
    _role = "primary"  # set for each request by do_GET or do_POST, before anything is recorded

    def log_message(self, *_):
        pass

    def _send(self, code, body, ctype="application/json", extra=None):
        data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            for name, value in (extra or {}).items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(data)
        except OSError:
            pass  # the harness closed the connection first (OpenCode does as it exits); nobody is left to answer

    def _local(self):
        return self.path.startswith("/")

    def _body(self):
        """The request body, whether it came with a length or in chunks (bun's fetch sends chunks)."""
        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            out = b""
            while True:
                line = self.rfile.readline(65537).split(b";")[0].strip()
                size = int(line, 16) if line else 0
                if size <= 0:
                    while self.rfile.readline(65537).strip():  # trailers, up to the blank line
                        pass
                    return out
                out += self.rfile.read(size)
                self.rfile.readline(65537)  # the line end after each chunk
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        return self.rfile.read(n) if n > 0 else b""

    def _note(self, status):
        s = self.server
        with s.lock:
            if len(s.passed) < 200:
                s.passed.append([round(time.time() - s.t0, 1), self.command, self.path[:120], status, self._role])

    def _refuse(self):
        with self.server.lock:
            self.server.refused.append(f"{self.command} {self.path}"[:200])
        self._send(403, {"error": {"message": "this run cannot leave the PC", "type": "refused"}})

    def _role_refused(self, api, route):
        """A request whose X-Atlias-Role is neither absent, planner nor reporter: answered 400 and never sent upstream, and the
        attempt is recorded under role invalid. It is not a call and spends no budget or usage, but like every other refusal
        it is an error, so the run's measurement is not complete: a helper the arm needed did not run."""
        with self.server.lock:
            self.server.receipts.append({"api": api, "path": route[:120], "slot": None, "role": "invalid",
                                         "outcome": "failed: X-Atlias-Role is not planner, reporter or absent"})
            self.server.errors.append(f"refused invalid X-Atlias-Role on {route}"[:200])
        msg = "the X-Atlias-Role header must be planner or reporter, or left out"
        if api == "messages":
            return self._send(400, {"type": "error", "error": {"type": "invalid_request_error", "message": msg}})
        self._send(400, {"error": {"message": msg, "type": "invalid_request_error"}})

    def do_CONNECT(self):
        self._refuse()

    def do_GET(self):
        if not self._local():
            return self._refuse()
        self._role = request_role(self.headers)
        if self._role == "invalid":
            return self._role_refused("other", self.path.split("?")[0].rstrip("/"))
        self._pass(None)

    def do_POST(self):
        if not self._local():
            return self._refuse()
        self._role = request_role(self.headers)
        route = self.path.split("?")[0].rstrip("/")
        try:
            raw = self._body()
        except Exception:
            raw = None
        # The body is read before any refusal: closing a socket with an unread body makes Windows reset the connection,
        # and the client then sees an abort instead of the 400 (a flaky selftest abort, 2026-10-15).
        if self._role == "invalid":
            return self._role_refused(_api_of(route), route)
        if raw is None:
            return self._send(400, {"error": {"message": "the request body could not be read"}})
        if route.endswith("/chat/completions"):
            return self._chat(raw)
        if route.endswith("/v1/messages"):
            return self._messages(raw)
        if route.endswith("/v1/responses") or route.endswith("/v1/responses/compact"):
            return self._responses(raw, route[route.index("/v1/responses"):])
        # Only known non-generation helpers may pass without model metering.
        # Unknown POSTs can include /api/generate, embeddings or new generation
        # routes, so forwarding them would silently omit their cost.
        if route in ("/api/show", "/v1/messages/count_tokens"):
            return self._pass(raw)
        else:
            with self.server.lock:
                self.server.receipts.append({"api": "responses" if "/responses" in route else "unmetered", "path": route[:120], "slot": None, "role": self._role, "outcome": "refused: not a metered path"})
                self.server.errors.append(f"refused unmetered POST {route}"[:200])
            return self._send(501, {"error": {"message": "this path is not metered by the door", "type": "invalid_request_error"}})

    def _pass(self, raw):
        """Anything that is not a chat call (the model list, say) goes to Ollama unchanged."""
        try:
            req = urllib.request.Request(self.server.upstream + self.path, data=raw, method=self.command,
                                         headers={"Content-Type": self.headers.get("Content-Type") or "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                self._note(r.status)
                self._send(r.status, r.read(), r.headers.get("Content-Type") or "application/json")
        except urllib.error.HTTPError as e:
            self._note(e.code)
            self._send(e.code, e.read(), e.headers.get("Content-Type") or "application/json")
        except Exception as e:
            self._note(f"{type(e).__name__}"[:40])
            self._send(502, {"error": {"message": f"the model server did not answer: {e}"[:300]}})

    def _failed(self, rec, e):
        """An upstream failure on a model call: its status, the start of its text (trial-07's HTTP 500
        left nothing to read it by), an unknown count, and the same answer passed back to the harness."""
        try:
            body = e.read()
        except Exception:
            body = b""
        rec.update(status=e.code, outcome=f"HTTP {e.code}", error=body[:300].decode("utf-8", errors="replace"))
        with self.server.lock:
            self.server.errors.append(f"HTTP {e.code}"[:200])
        try:
            self._send(e.code, body, e.headers.get("Content-Type") or "application/json")
        except Exception:
            pass

    def _helper(self):
        return self._role in ROLE_VALUES

    def _helper_capped(self, api):
        """A helper call past the budget: answered by the door with no model call, as 429 with a machine-readable outcome
        in a header and in the body. Its receipt and the door's capped count are the same as a primary call's cap."""
        msg = "the run's call budget is spent; the door answered this helper call itself and no model was called"
        body = {"error": {"message": msg, "type": "atlias_door_budget_capped"}, "atlias_door": {"outcome": OUTCOME_BUDGET_CAPPED, "modelCalled": False}}
        if api == "messages":
            body = {"type": "error", **body}
        self._send(429, body, extra={OUTCOME_HEADER: OUTCOME_BUDGET_CAPPED})

    def _stop_reply(self, stream):
        s = self.server
        now, mid = int(time.time()), "chatcmpl-step-limit"
        if not stream:
            return self._send(200, {"id": mid, "object": "chat.completion", "created": now, "model": s.model,
                                    "choices": [{"index": 0, "message": {"role": "assistant", "content": STOP_TEXT}, "finish_reason": "stop"}],
                                    "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}})
        chunk = lambda delta, fin: {"id": mid, "object": "chat.completion.chunk", "created": now, "model": s.model,  # noqa: E731
                                    "choices": [{"index": 0, "delta": delta, "finish_reason": fin}]}
        parts = [chunk({"role": "assistant", "content": STOP_TEXT}, None), chunk({}, "stop"),
                 {"id": mid, "object": "chat.completion.chunk", "created": now, "model": s.model, "choices": [],
                  "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}}]
        body = "".join(f"data: {json.dumps(p)}\n\n" for p in parts) + "data: [DONE]\n\n"
        self._send(200, body.encode("utf-8"), "text/event-stream")

    def _stop_message(self, stream):
        """The stop past the budget, in the shape of Claude's wire format."""
        s = self.server
        msg = {"id": "msg_step_limit", "type": "message", "role": "assistant", "model": s.model,
               "content": [{"type": "text", "text": STOP_TEXT}], "stop_reason": "end_turn", "stop_sequence": None,
               "usage": {"input_tokens": 0, "output_tokens": 0}}
        if not stream:
            return self._send(200, msg)
        events = [("message_start", {"type": "message_start", "message": {**msg, "content": [], "stop_reason": None}}),
                  ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
                  ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": STOP_TEXT}}),
                  ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                  ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 0}}),
                  ("message_stop", {"type": "message_stop"})]
        self._send(200, "".join(f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events).encode("utf-8"), "text/event-stream")

    def _stop_response(self, stream):
        """The stop past the budget, in the shape of the Responses format."""
        s = self.server
        item = {"type": "message", "id": "msg_step_limit", "role": "assistant", "status": "completed",
                "content": [{"type": "output_text", "text": STOP_TEXT, "annotations": []}]}
        resp = {"id": "resp_step_limit", "object": "response", "status": "completed", "model": s.model, "output": [item],
                "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}}
        if not stream:
            return self._send(200, resp)
        events = [("response.created", {"type": "response.created", "response": {**resp, "status": "in_progress", "output": []}}),
                  ("response.output_item.done", {"type": "response.output_item.done", "output_index": 0, "item": item}),
                  ("response.completed", {"type": "response.completed", "response": resp})]
        self._send(200, "".join(f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events).encode("utf-8"), "text/event-stream")

    def _responses(self, raw, path):
        """A call in the Responses format (/v1/responses, and the compaction call beside it), which
        Codex speaks and Ollama answers itself: passed through whole (instructions, every tool kind,
        call ids and patch text untouched), held to the same model, temperature and output cap as the
        rest, and metered from the usage of its terminal event. The door keeps no response state, so a
        call that leans on an earlier response by id is refused, never guessed at."""
        s = self.server
        try:
            body = json.loads(raw.decode("utf-8"))
            if not isinstance(body, dict):
                raise ValueError("not an object")
        except Exception:
            return self._send(400, {"error": {"message": "the request body is not a JSON object", "type": "invalid_request_error"}})
        stream = body.get("stream") is True
        if body.get("previous_response_id"):
            with s.lock:
                s.receipts.append({"api": "responses", "path": path, "stream": stream, "slot": None, "role": self._role, "outcome": "refused: previous_response_id needs response state the door does not keep"})
                s.errors.append("refused previous_response_id")
            return self._send(400, {"error": {"message": "this door keeps no response state; send the whole conversation", "type": "invalid_request_error"}})
        with s.lock:
            s.calls += 1
            if s.first is None:
                s.first = time.time()
            over = s.calls > s.budget
            if over:
                s.capped += 1
                s.receipts.append({"api": "responses", "path": path, "stream": stream, "slot": None, "role": self._role, "outcome": "capped: answered by the door, no model call"})
            else:
                slot = len(s.usage)
                s.usage.append(None)
                rec = {"api": "responses", "path": path, "stream": stream, "slot": slot, "role": self._role, "at": round(time.time() - s.t0, 3), "status": None, "outcome": "sent", "usage": []}
                s.receipts.append(rec)
        if over:
            return self._helper_capped("responses") if self._helper() else self._stop_response(stream)
        body["model"] = s.model
        body["temperature"] = 0.2
        if self._helper():
            asked, sent_cap = helper_output_cap(body, "max_output_tokens", s.num_predict)
            rec["maxTokens"] = {"asked": asked, "sent": sent_cap}
            body["max_output_tokens"] = sent_cap
        else:
            body["max_output_tokens"] = s.num_predict
        sent = json.dumps(body).encode("utf-8")
        rec["sent"] = {"bytes": len(sent), "sha256": hashlib.sha256(sent).hexdigest()}
        terminal = {"response.completed": "complete", "response.incomplete": "incomplete", "response.failed": "failed"}
        try:
            req = urllib.request.Request(s.upstream + path, data=sent, method="POST", headers={"Content-Type": "application/json", "Authorization": "Bearer local"})
            with urllib.request.urlopen(req, timeout=1800) as r:
                rec["status"] = r.status
                if not stream:
                    data = r.read()
                    try:
                        answer = json.loads(data.decode("utf-8"))
                        rec["usage"].append(answer.get("usage"))
                        s.usage[slot] = _responses_usage(answer.get("usage"))
                        rec["outcome"] = "complete" if answer.get("status") in (None, "completed") else str(answer.get("status"))[:40]
                        _note_stop(s, rec, (answer.get("incomplete_details") or {}).get("reason") or answer.get("status"))
                    except Exception:
                        rec["outcome"] = "answer not readable"
                    self._send(r.status, data, r.headers.get("Content-Type") or "application/json")
                else:
                    self.send_response(r.status)
                    self.send_header("Content-Type", r.headers.get("Content-Type") or "text/event-stream")
                    self.send_header("Cache-Control", "no-cache")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    ended, left = None, False
                    for line in r:
                        # The usage comes once, with the terminal event; a repeated one replaces it, never adds.
                        if line.startswith(b"data:") and b'"response.' in line and (b"completed" in line or b"incomplete" in line or b"failed" in line):
                            try:
                                ev = json.loads(line[5:].decode("utf-8").strip())
                                if ev.get("type") in terminal:
                                    ended = ev["type"]
                                    resp = ev.get("response") or {}
                                    rec["usage"].append(resp.get("usage"))
                                    s.usage[slot] = _responses_usage(resp.get("usage"))
                                    if ended != "response.completed":
                                        rec["detail"] = resp.get("incomplete_details") or resp.get("error")
                                    _note_stop(s, rec, (resp.get("incomplete_details") or {}).get("reason") or resp.get("status"))
                            except Exception:
                                pass
                        try:
                            self.wfile.write(line)
                            self.wfile.flush()
                        except Exception:
                            left = True
                            break  # the harness went away; the count seen so far stands
                    rec["outcome"] = terminal.get(ended) or ("harness left before the end" if left else "partial: no terminal event")
                    if ended is None:
                        with s.lock:
                            s.partial += 1
        except urllib.error.HTTPError as e:
            self._failed(rec, e)
        except Exception as e:
            rec["outcome"] = f"{type(e).__name__}: {e}"[:200]
            with s.lock:
                s.errors.append(f"{type(e).__name__}: {e}"[:200])
            try:
                self._send(502, {"error": {"message": f"the model server did not answer: {e}"[:300], "type": "api_error"}})
            except Exception:
                pass

    def _messages(self, raw):
        """A call in Claude's wire format (/v1/messages), which Ollama answers too: Claude Code's
        calls are metered, capped and held to the same model, temperature and output cap as the rest."""
        s = self.server
        try:
            body = json.loads(raw.decode("utf-8"))
            if not isinstance(body, dict):
                raise ValueError("not an object")
        except Exception:
            return self._send(400, {"type": "error", "error": {"type": "invalid_request_error", "message": "the request body is not a JSON object"}})
        stream = body.get("stream") is True
        with s.lock:
            s.calls += 1
            if s.first is None:
                s.first = time.time()
            over = s.calls > s.budget
            if over:
                s.capped += 1
                s.receipts.append({"api": "messages", "stream": stream, "slot": None, "role": self._role, "outcome": "capped: answered by the door, no model call"})
            else:
                slot = len(s.usage)
                s.usage.append(None)
                got = {}  # the parts read and written, as the answer gives them
                rec = {"api": "messages", "stream": stream, "slot": slot, "role": self._role, "at": round(time.time() - s.t0, 3), "status": None, "outcome": "sent", "usage": [], "counts": got}
                s.receipts.append(rec)
        if over:
            return self._helper_capped("messages") if self._helper() else self._stop_message(stream)
        body["model"] = s.model
        body["temperature"] = 0.2
        if self._helper():
            asked, sent_cap = helper_output_cap(body, "max_tokens", s.num_predict)
            rec["maxTokens"] = {"asked": asked, "sent": sent_cap}
            body["max_tokens"] = sent_cap
        else:
            body["max_tokens"] = s.num_predict

        def note(u):
            # Keep provisional blocks too, but never commit them as exact spend before final usage.
            if isinstance(u, dict):
                rec["usage"].append(u)
                _message_counts(u, got)

        def commit_usage():
            p, c = _message_totals(got)
            s.usage[slot] = (p, c) if p is not None and c is not None else None
        sent = json.dumps(body).encode("utf-8")
        rec["sent"] = {"bytes": len(sent), "sha256": hashlib.sha256(sent).hexdigest()}  # exactly what the model server was given
        try:
            req = urllib.request.Request(s.upstream + "/v1/messages", data=sent, method="POST",
                                         headers={"Content-Type": "application/json", "x-api-key": "local",
                                                  "anthropic-version": self.headers.get("anthropic-version") or "2023-06-01"})
            with urllib.request.urlopen(req, timeout=1800) as r:
                rec["status"] = r.status
                if not stream:
                    data = r.read()
                    try:
                        answer = json.loads(data.decode("utf-8"))
                        note(answer.get("usage"))
                        commit_usage()
                        _note_stop(s, rec, answer.get("stop_reason"))
                        rec["outcome"] = "complete"
                    except Exception:
                        rec["outcome"] = "answer not readable"
                    self._send(r.status, data, r.headers.get("Content-Type") or "application/json")
                else:
                    self.send_response(r.status)
                    self.send_header("Content-Type", r.headers.get("Content-Type") or "text/event-stream")
                    self.send_header("Cache-Control", "no-cache")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    ended, left, final_output, seen_start, stream_valid = False, False, False, False, True
                    for line in r:
                        # The prompt count comes with message_start, the output count with message_delta.
                        if line.startswith(b"data:") and (b'"usage"' in line or b"message_stop" in line or b'"stop_reason"' in line):
                            try:
                                ev = json.loads(line[5:].decode("utf-8").strip())
                                if ended:
                                    stream_valid = False
                                if ev.get("type") == "message_start":
                                    if seen_start:
                                        stream_valid = False
                                    seen_start = True
                                elif ev.get("type") in ("message_delta", "message_stop") and not seen_start:
                                    stream_valid = False
                                ended = ended or ev.get("type") == "message_stop"
                                note((ev.get("message") or {}).get("usage"))
                                note(ev.get("usage"))
                                if ev.get("type") == "message_delta" and isinstance(ev.get("usage"), dict) and "output_tokens" in ev["usage"]:
                                    final_output = True
                                _note_stop(s, rec, (ev.get("delta") or {}).get("stop_reason"))
                            except Exception:
                                pass
                        try:
                            self.wfile.write(line)
                            self.wfile.flush()
                        except Exception:
                            left = True
                            break  # the harness went away; the count seen so far stands
                    rec["outcome"] = "complete" if ended else "harness left before the end" if left else "partial: no message_stop"
                    # message_start's output count (usually zero) is provisional. A closed connection,
                    # even after a delta, cannot establish final spend without the terminal event.
                    if ended and final_output and stream_valid:
                        commit_usage()
                    if not ended:
                        with s.lock:
                            s.partial += 1
        except urllib.error.HTTPError as e:
            self._failed(rec, e)
        except Exception as e:
            rec["outcome"] = f"{type(e).__name__}: {e}"[:200]
            with s.lock:
                s.errors.append(f"{type(e).__name__}: {e}"[:200])
            try:
                self._send(502, {"type": "error", "error": {"type": "api_error", "message": f"the model server did not answer: {e}"[:300]}})
            except Exception:
                pass

    def _chat(self, raw):
        s = self.server
        try:
            body = json.loads(raw.decode("utf-8"))
            if not isinstance(body, dict):
                raise ValueError("not an object")
        except Exception:
            return self._send(400, {"error": {"message": "the request body is not a JSON object"}})
        stream = body.get("stream") is True
        with s.lock:
            s.calls += 1
            if s.first is None:
                s.first = time.time()
            title = s.skip_titles and is_title_call(body)  # OpenCode's title call: sent, counted in every total, not in the budget
            if title:
                s.titles += 1
            over = not title and s.calls - s.titles > s.budget
            if over:
                s.capped += 1
                s.receipts.append({"api": "chat", "stream": stream, "slot": None, "role": self._role, "outcome": "capped: answered by the door, no model call"})
            else:
                # The call's place is kept before it is sent, and filled the moment Ollama's count is
                # seen, so a harness that hangs up straight after its answer cannot lose the count.
                slot = len(s.usage)
                s.usage.append(None)
                rec = {"api": "chat", "stream": stream, "slot": slot, "role": self._role, "at": round(time.time() - s.t0, 3), "status": None, "outcome": "sent", "usage": []}
                if title:
                    rec["title"] = True
                s.receipts.append(rec)
        if over:
            return self._helper_capped("chat") if self._helper() else self._stop_reply(stream)
        body["model"] = s.model
        body["temperature"] = 0.2
        extra = None
        if self._helper():
            asked, sent_cap = helper_output_cap(body, "max_tokens", s.num_predict)
            rec["maxTokens"] = {"asked": asked, "sent": sent_cap}
            extra = {MAX_TOKENS_HEADER: str(sent_cap)}
            body["max_tokens"] = sent_cap
        else:
            body["max_tokens"] = s.num_predict
        body.pop("max_completion_tokens", None)
        if stream:
            body["stream_options"] = {"include_usage": True}
        sent = json.dumps(body).encode("utf-8")
        rec["sent"] = {"bytes": len(sent), "sha256": hashlib.sha256(sent).hexdigest()}  # exactly what the model server was given
        try:
            req = urllib.request.Request(s.upstream + "/v1/chat/completions", data=sent, method="POST",
                                         headers={"Content-Type": "application/json", "Authorization": "Bearer local"})
            with urllib.request.urlopen(req, timeout=1800) as r:
                rec["status"] = r.status
                if not stream:
                    data = r.read()
                    try:
                        answer = json.loads(data.decode("utf-8"))
                        rec["usage"].append(answer.get("usage"))
                        s.usage[slot] = _usage_of(answer)
                        rec["outcome"] = "complete"
                        for choice in answer.get("choices") or []:
                            _note_stop(s, rec, (choice or {}).get("finish_reason"))
                    except Exception:
                        rec["outcome"] = "answer not readable"
                    self._send(r.status, data, r.headers.get("Content-Type") or "application/json", extra)
                else:
                    self.send_response(r.status)
                    self.send_header("Content-Type", r.headers.get("Content-Type") or "text/event-stream")
                    self.send_header("Cache-Control", "no-cache")
                    self.send_header("Connection", "close")
                    for name, value in (extra or {}).items():
                        self.send_header(name, value)
                    self.end_headers()
                    ended, left, stream_valid = False, False, True
                    stream_usage = None
                    for line in r:
                        if line.startswith(b"data:") and line[5:].strip() == b"[DONE]":
                            if ended:
                                stream_valid = False
                            ended = True
                        elif line.startswith(b"data:") and (b'"usage"' in line or b'"finish_reason":"' in line or b'"finish_reason": "' in line):
                            try:
                                ev = json.loads(line[5:].decode("utf-8").strip())
                                if ended:
                                    stream_valid = False
                                if b'"usage"' in line:
                                    rec["usage"].append(ev.get("usage"))
                                    # Ordinary chunks may have null usage. An actual later count,
                                    # including a malformed one, replaces the earlier observation.
                                    if ev.get("usage") is not None:
                                        stream_usage = _usage_of(ev)
                                for choice in ev.get("choices") or []:
                                    _note_stop(s, rec, (choice or {}).get("finish_reason"))
                            except Exception:
                                pass
                        try:
                            self.wfile.write(line)
                            self.wfile.flush()
                        except Exception:
                            left = True
                            break  # the harness went away; the count seen so far stands
                    rec["outcome"] = "complete" if ended else "harness left before the end" if left else "partial: no [DONE]"
                    if ended and stream_valid:
                        s.usage[slot] = stream_usage
                    if not ended:
                        with s.lock:
                            s.partial += 1
        except urllib.error.HTTPError as e:
            self._failed(rec, e)
        except Exception as e:
            rec["outcome"] = f"{type(e).__name__}: {e}"[:200]
            with s.lock:
                s.errors.append(f"{type(e).__name__}: {e}"[:200])
            try:
                self._send(502, {"error": {"message": f"the model server did not answer: {e}"[:300]}})
            except Exception:
                pass


def run_harness(argv, *, cwd, env, door, start_limit, task_limit, stdout, stdin_text=None, process_memory=0):
    """argv as the root of its own process tree, with the prompt on stdin when given. Two limits,
    each ending the whole tree: `start_limit` seconds to make the first model call (OpenCode run
    from source needs about 150 s on this PC before it asks for anything, nanobot a few), then
    `task_limit` seconds from that first call, so both harnesses get the same time to work.
    Returns (returncode, why it was stopped or '')."""
    kw = {"cwd": cwd, "env": env, "stdin": subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL,
          "stdout": stdout, "stderr": subprocess.STDOUT}
    if not WIN:
        kw["start_new_session"] = True
    p = start_owned(argv, process_memory=process_memory, **kw)
    with _LIVE_LOCK:
        LIVE.add(p)
    try:
        if stdin_text is not None:
            try:
                p.stdin.write(stdin_text.encode("utf-8"))
                p.stdin.close()
            except Exception:
                pass  # a harness that never read its prompt fails the task by itself
        t0 = time.time()
        while True:
            try:
                return p.wait(timeout=1), ""
            except subprocess.TimeoutExpired:
                pass
            now, first = time.time(), door.first
            why = ""
            if first is None and now - t0 > start_limit:
                why = f"timeout: no model call in the first {start_limit} s"
            elif first is not None and now - first > task_limit:
                why = f"timeout: {task_limit} s passed since its first model call"
            if why:
                kill_tree(p)
                try:
                    p.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    pass
                return -1, why + " and the harness was stopped with everything it started"
    finally:
        release(p)


def offline_env(state, door, shims, extra_path=(), extra=None, harness=""):
    """A child environment built from nothing: what a process needs to start, a home of its own
    under `state`, and proxies that lead to the door, which refuses anything but the model."""
    env = {}
    for k, v in os.environ.items():
        if k.upper() in KEEP_ENV and k.upper() not in {e.upper() for e in env}:
            env[k] = v
    key = next((k for k in env if k.upper() == "PATH"), "PATH")
    env[key] = os.pathsep.join([shims, *[str(x) for x in extra_path], env.get(key, "")])

    def d(*parts):
        x = pathlib.Path(state).joinpath(*parts)
        x.mkdir(parents=True, exist_ok=True)
        return str(x)
    home = d("home")
    env.update({"HOME": home, "USERPROFILE": home, "APPDATA": d("appdata", "Roaming"), "LOCALAPPDATA": d("appdata", "Local"),
                "XDG_DATA_HOME": d("xdg", "data"), "XDG_CACHE_HOME": d("xdg", "cache"), "XDG_CONFIG_HOME": d("xdg", "config"),
                "XDG_STATE_HOME": d("xdg", "state"), "TMP": d("tmp"), "TEMP": d("tmp"), "TMPDIR": d("tmp"),
                "HTTP_PROXY": door.base, "HTTPS_PROXY": door.base, "http_proxy": door.base, "https_proxy": door.base,
                "NO_PROXY": "127.0.0.1,localhost,::1", "no_proxy": "127.0.0.1,localhost,::1",
                "NO_COLOR": "1", "DO_NOT_TRACK": "1", "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"})
    env.update(extra or {})
    if harness == "opencode":  # OpenCode's system config folder is %ProgramData%\opencode; this folder has none (council 1013b, b10 F3, b11)
        env["ProgramData"] = str(state)
    return env


def nanobot_command(a, task, ws, state, door, budget, env):
    """Stock nanobot, one message, its workspace the task directory. Nothing is added to it: no MCP
    server, no skill, no channel; its own file and shell tools are its harness."""
    cfg = {"agents": {"defaults": {"workspace": str(ws), "model": a.model, "provider": "custom", "maxTokens": a.num_predict,
                                   "contextWindowTokens": a.num_ctx, "temperature": 0.2, "maxToolIterations": budget}},
           "providers": {"custom": {"apiKey": "local", "apiBase": door.base + "/v1"}}}
    cfg_file = pathlib.Path(state) / "nanobot-config.json"
    cfg_file.write_text(json.dumps(cfg, indent=1), encoding="utf-8")
    return [a.nanobot, "agent", "-m", task["prompt"], "-w", str(ws), "-c", str(cfg_file), "-s", "h2h", "--no-markdown"], str(ws), None


def opencode_command(a, task, ws, state, door, budget, env):
    """Stock OpenCode (the pinned source, run by the pinned bun), one `run`, its directory the task
    directory. Its own prompt and tools; every tool allowed but leaving the task directory."""
    keep = 1024 if a.num_ctx <= 8192 else 2048
    agent = {"mode": "primary", "description": "base harness head-to-head", "steps": budget,
             "permissions": [{"action": "*", "resource": "*", "effect": "allow"},
                             {"action": "external_directory", "resource": "*", "effect": "deny"}]}
    cfg = {"model": f"ollama/{a.model}", "default_agent": "base", "update": "disable", "share": "disabled", "warming": False,
           "snapshots": False, "lsp": False, "formatter": False, "websearch": False,
           "compaction": {"auto": True, "keep": {"tokens": keep}, "buffer": a.num_predict + 512},
           # The package is named here, as OpenCode's own Ollama plugin sets it once it has listed the
           # server's models: without it a run that starts before that listing ends has no route
           # to its model (seen 2026-10-11, one start in two).
           "providers": {"ollama": {"package": "@opencode/ai/providers/openai-compatible", "settings": {"baseURL": door.base + "/v1", "apiKey": "local"},
                                    "models": {a.model: {"limit": {"context": a.num_ctx, "output": a.num_predict}}}}},
           "agents": {"base": agent}}
    (pathlib.Path(state) / "opencode-config.json").write_text(json.dumps(cfg, indent=1), encoding="utf-8")
    env.update({"OPENCODE_TEST_HOME": env["HOME"], "OPENCODE_CONFIG_PROJECT_DISABLE": "1", "OPENCODE_DISABLE_MODELS_FETCH": "1",
                "OPENCODE_DISABLE_FFF": "1", "OPENCODE_FILEWATCHER_DISABLE": "1", "OPENCODE_CONFIG_CONTENT": json.dumps(cfg), "PWD": str(ws)})
    cli = pathlib.Path(a.opencode_source) / "packages" / "cli"
    argv = [a.bun, "run", str(cli / "src" / "index.ts"), "run", "--format", "json", "--model", f"ollama/{a.model}", "--agent", "base", "--standalone"]
    return argv, str(cli), task["prompt"]


def claude_command(a, task, ws, state, door, budget, env):
    """Base Claude Code, one print-mode run in the task directory with a profile of its own: no
    plugin, no skill, no instruction file, nothing but its defaults. Its own prompt and tools drive
    the local model through the door, which speaks Claude's wire format to Ollama. With
    --claude-plugin-dir the same run also loads those plugin folders (atlias as a sub-harness, a
    mod), which is the second arm of Gev's comparison: base Claude Code against base Claude Code
    plus atlias."""
    profile = pathlib.Path(state) / "claude-profile"
    profile.mkdir(parents=True, exist_ok=True)
    env.update({"CLAUDE_CONFIG_DIR": str(profile), "ANTHROPIC_BASE_URL": door.base, "ANTHROPIC_AUTH_TOKEN": "local",
                "ANTHROPIC_MODEL": a.model, "ANTHROPIC_SMALL_FAST_MODEL": a.model, "CLAUDE_CODE_MAX_OUTPUT_TOKENS": str(a.num_predict),
                "DISABLE_TELEMETRY": "1", "DISABLE_AUTOUPDATER": "1", "DISABLE_ERROR_REPORTING": "1",
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "PWD": str(ws)})
    argv = [a.claude, "-p", task["prompt"], "--model", a.model, "--dangerously-skip-permissions"]
    for d in a.claude_plugin_dir or []:
        argv += ["--plugin-dir", str(d)]
    return argv, str(ws), None


def codex_command(a, task, ws, state, door, budget, env):
    """Base Codex, one `exec` run in the task directory with a home of its own (CODEX_HOME and
    ATLIAS_HOME), its model reached through the door by a loopback provider of its own (a built-in
    provider id cannot be pointed elsewhere) on the Responses wire API with websockets off, the
    prompt on stdin, and no approval or sandbox stop, as base Claude Code runs. With
    --codex-home-from the same run starts from a copy of a prepared home (atlias installed into it),
    which is the second arm; both arms get the same flags, so neither skips its home's config."""
    home = pathlib.Path(state) / "codex-home"
    if a.codex_home_from:
        shutil.copytree(a.codex_home_from, home, dirs_exist_ok=True)
    home.mkdir(parents=True, exist_ok=True)
    env.update({"CODEX_HOME": str(home), "ATLIAS_HOME": str(pathlib.Path(state) / "atlias-home"), "PWD": str(ws)})
    p = "atlias_local_meter"
    argv = [a.codex, "exec", "--ignore-rules", "--strict-config", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-C", str(ws),
            "-c", f'model="{a.model}"', "-c", f'model_provider="{p}"', "-c", f'model_providers.{p}.name="Atlias local meter"',
            "-c", f'model_providers.{p}.base_url="{door.base}/v1"', "-c", f'model_providers.{p}.wire_api="responses"',
            "-c", f"model_providers.{p}.requires_openai_auth=false", "-c", f"model_providers.{p}.supports_websockets=false",
            "-c", f"model_context_window={a.num_ctx}", "-c", 'web_search="disabled"']
    # Disable only the pre-recorded personal skill files in both arms. Keep the
    # native/system and project catalog, including explicit skill invocation.
    skill_file = getattr(a, "codex_disabled_skills", "")
    if skill_file:
        snapshot = json.loads(pathlib.Path(skill_file).read_text(encoding="utf-8-sig"))
        files = snapshot.get("files", []) if isinstance(snapshot, dict) else snapshot
        if not isinstance(files, list) or any(not isinstance(f, str) for f in files):
            raise ValueError("invalid frozen Codex skill exclusion list")
        rows = ",".join("{path=" + json.dumps(f) + ",enabled=false}" for f in files)
        argv += ["-c", "skills.config=[" + rows + "]"]
    if getattr(a, "codex_bypass_hook_trust", False):
        argv += ["--dangerously-bypass-hook-trust"]
    argv += ["-"]
    return argv, str(ws), task["prompt"]


def atlias_command(a, task, ws, state, door, budget, env):
    """Atlias's own agent (lib/loop.mjs), one task in the task directory, with no Claude Code and no
    other harness under it (Gev 2026-10-16: the real harness for 20x). tools/h2h/atlias_task.mjs runs
    it the way `atlias eval` runs a task, on the task's own round budget, its model reached through
    the door's OpenAI path; the door's call budget still holds above that. Its configuration is
    ATLIAS_HOME/config.json, which the caller writes (the controller writes the spec's)."""
    home = pathlib.Path(state) / "atlias-home"
    home.mkdir(parents=True, exist_ok=True)
    env.update({"ATLIAS_HOME": str(home), "ATLIAS_TASK_URL": door.base + "/v1", "ATLIAS_TASK_MODEL": a.model,
                "ATLIAS_NO_DETACH": "1", "PWD": str(ws)})
    node = shutil.which("node")
    if not node:
        raise RuntimeError("node is not on PATH; the atlias harness needs it")
    driver = pathlib.Path(__file__).resolve().parent / "atlias_task.mjs"
    return [node, str(driver), "--rounds", str(int(task.get("rounds") or 0))], str(ws), task["prompt"]


HARNESS = {"nanobot": nanobot_command, "opencode": opencode_command, "claude": claude_command, "codex": codex_command, "atlias": atlias_command}


def _digest(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def canonical_parameters(text):
    """Ollama's /api/show renders a model's stored parameters as one line each, in an order that
    changed with every server start for the same blob (sprint runs 2026-10-16: three hashes for one
    params digest). Sorted lines keep every value, repeated ones included, in one order."""
    return "\n".join(sorted(line.strip() for line in text.splitlines() if line.strip()))


def file_digest(path):
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for block in iter(lambda: f.read(1 << 20), b""):
                h.update(block)
    except OSError:
        return None
    return h.hexdigest()


def tree_digest(root):
    """One hash over every file under root, path and bytes, so a changed plugin is a changed arm."""
    root = pathlib.Path(root)
    if not root.exists():
        return None
    if root.is_file():
        return file_digest(root)
    skip = {".git", "__pycache__", "node_modules"}
    return _digest([[f.relative_to(root).as_posix(), file_digest(f)] for f in sorted(root.rglob("*"))
                    if f.is_file() and not skip & set(f.relative_to(root).parts)])


def model_facts(api_base, model):
    """What the server holds under the model's name: its digest, the template and parameters it
    renders with, its quantization, and the server's version. Metadata only: nothing is loaded."""
    def ask(path, body=None):
        try:
            req = urllib.request.Request(api_base.rstrip("/") + path, data=None if body is None else json.dumps(body).encode("utf-8"),
                                         method="GET" if body is None else "POST", headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception:
            return None
    tags, show = ask("/api/tags") or {}, ask("/api/show", {"model": model}) or {}
    return {"name": model, "server": (ask("/api/version") or {}).get("version"),
            "digest": next((m.get("digest") for m in tags.get("models", []) if model in (m.get("name"), m.get("model"))), None),
            "template": _digest(show["template"]) if isinstance(show.get("template"), str) else None,
            "parameters": _digest(canonical_parameters(show["parameters"])) if isinstance(show.get("parameters"), str) else None,
            "quantization": (show.get("details") or {}).get("quantization_level")}


def provenance(a):
    """What every number of a run came from, the same for each of its tasks: the client program and
    its version, this runner and the source tree it sits in, the plugin folders, the model server and
    the model's digest and template, and the settings the door holds the model to. None marks a
    fact that could not be read; it is never filled in by a guess."""
    root = pathlib.Path(__file__).resolve().parents[2]
    def run(argv):
        try:
            done = subprocess.run(argv, capture_output=True, timeout=60, cwd=str(root))
            return done.stdout.decode("utf-8", errors="replace").strip() if done.returncode == 0 else None
        except Exception:
            return None
    # The atlias harness's client is Atlias's own agent code, the lib tree its driver imports.
    client = {"claude": getattr(a, "claude", None), "codex": getattr(a, "codex", None), "nanobot": getattr(a, "nanobot", None),
              "atlias": str(root / "lib")}.get(a.harness) or str(pathlib.Path(a.opencode_source) / "packages" / "cli")
    status = run(["git", "status", "--porcelain"])
    return {"harness": a.harness, "client": {"path": str(client), "sha256": tree_digest(client),
                                             "version": run([client, "--version"]) if a.harness in ("claude", "codex") else None},
            "codexHomeFrom": {"path": a.codex_home_from, "sha256": tree_digest(a.codex_home_from)} if getattr(a, "codex_home_from", None) else None,
            "codexDisabledSkills": {"sha256": file_digest(a.codex_disabled_skills)} if getattr(a, "codex_disabled_skills", None) else None,
            "codexBypassHookTrust": bool(getattr(a, "codex_bypass_hook_trust", False)),
            "runner": file_digest(__file__), "source": {"head": run(["git", "rev-parse", "HEAD"]), "dirty": _digest(status) if status else status},
            "pluginDirs": [{"path": str(d), "sha256": tree_digest(d)} for d in (getattr(a, "claude_plugin_dir", None) or [])],
            "model": model_facts(a.api_base, a.model),
            "door": {"temperature": 0.2, "numPredict": a.num_predict, "numCtx": a.num_ctx, "budget": a.budget or "per task"}}


def task_digests(task):
    """The task as the harness got it and the grader that judged it, so two arms can be shown to
    have run the same thing."""
    return {"prompt": _digest(task.get("prompt")), "files": _digest(task.get("files")),
            "grader": _digest({"check": task.get("check"), "hidden": task.get("hidden"), "protect": task.get("protect")})}


def loaded_window(api_base, model):
    """The window Ollama has this model loaded at right now, or None."""
    try:
        with urllib.request.urlopen(api_base.rstrip("/") + "/api/ps", timeout=10) as r:
            for m in json.loads(r.read().decode("utf-8")).get("models", []):
                if m.get("name") == model or m.get("model") == model:
                    return m.get("context_length")
    except Exception:
        return None
    return None


class WindowWatch:
    """Reads the loaded window every few seconds while the harness runs. One reading after the task
    is not enough: in trial-06 the model started a command that never ended, Claude Code waited nine
    minutes for it in the background, the server unloaded the idle model, and the reading after the
    task found nothing, which held the whole trial."""
    def __init__(self, api_base, model, every=10.0):
        self.readings = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, args=(api_base, model, every), daemon=True)
        self._thread.start()

    def _run(self, api_base, model, every):
        while not self._stop.wait(every):
            w = loaded_window(api_base, model)
            if w is not None:
                self.readings.append(w)

    def stop(self):
        self._stop.set()
        self._thread.join(timeout=15)
        return list(self.readings)


def window_of(readings, end, asked):
    """The window to report for a task, and every window seen. No reading at all is unknown, never
    matched; a model the server unloaded while idle gives no reading, not another window; any reading
    at a window other than the one asked for is the one reported, so a reload at another window is
    never passed off as matched."""
    seen = [w for w in [*readings, end] if w is not None]
    if not seen:
        return None, []
    other = next((w for w in seen if w != asked), None)
    return (asked if other is None else other), sorted(set(seen))


def run_one(task, a, shims):
    budget = a.budget or int(task.get("rounds") or 25)
    stamp = f"{task['id']}-{int(time.time() * 1000)}"
    ws = pathlib.Path(a.work) / stamp
    state = pathlib.Path(a.work) / "_state" / stamp
    ws.mkdir(parents=True, exist_ok=True)
    state.mkdir(parents=True, exist_ok=True)
    for name, body in task["files"].items():
        p = ws / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(body.encode("utf-8"))
    shipped = {str(p.relative_to(ws)).replace("\\", "/") for p in ws.rglob("*") if p.is_file()}
    protect = task.get("protect") or []
    before = {p: sha(ws / p) for p in protect}
    door = Door(a.api_base, a.model, a.num_predict, budget, skip_titles=a.harness == "opencode")
    threading.Thread(target=door.serve_forever, daemon=True).start()
    watch = WindowWatch(a.api_base, a.model)
    t0 = time.time()
    stop, rc, starts = "", None, 1
    log = state / "harness-output.txt"
    try:
        # Start-up caches kept between tasks, so no task pays for them again and neither harness needs
        # the network: nanobot's token-counter file, and bun's compiled copy of OpenCode's source.
        caches = {"TIKTOKEN_CACHE_DIR": str(a.tiktoken_cache)} if a.harness == "nanobot" else {"BUN_RUNTIME_TRANSPILER_CACHE_PATH": str(pathlib.Path(a.work) / "_bun-cache")} if a.harness == "opencode" else {}
        env = offline_env(state, door, shims, extra_path=[pathlib.Path(a.ripgrep).parent] if a.harness == "opencode" and a.ripgrep else (), extra=caches, harness=a.harness)
        argv, cwd, stdin_text = HARNESS[a.harness](a, task, ws, state, door, budget, env)
        with open(log, "wb") as buf:
            rc, stopped = run_harness(argv, cwd=cwd, env=env, door=door, start_limit=a.start_timeout, task_limit=a.task_timeout, stdout=buf, stdin_text=stdin_text,
                                 process_memory=int(getattr(a, "harness_process_memory_mib", 0) or 0) * 1024 * 1024)
            # A start that never reached the model is tried once more: no call was made, so the task
            # is not attempted twice (stock OpenCode sometimes asks for its model before it has found it).
            if door.calls == 0 and rc != 0 and not stopped:
                starts = 2
                buf.write(b"[no model call was made; started again]" + os.linesep.encode())
                buf.flush()
                rc, stopped = run_harness(argv, cwd=cwd, env=env, door=door, start_limit=a.start_timeout, task_limit=a.task_timeout, stdout=buf, stdin_text=stdin_text,
                                 process_memory=int(getattr(a, "harness_process_memory_mib", 0) or 0) * 1024 * 1024)
        stop = stopped or f"exit {rc}"
    except Exception as e:  # a harness that cannot start is a fail, not a skipped task
        stop = f"crash: {type(e).__name__}: {e}"[:200]
    finally:
        door.shutdown()
        door.server_close()
        readings = watch.stop()
    agent_ms = int((time.time() - t0) * 1000)
    # What the harness itself left behind, listed before the hidden files are written: listed after,
    # the grader's own files looked as if the harness could have read them (council member h11, 2026-10-12).
    added = sorted(str(p.relative_to(ws)).replace("\\", "/") for p in ws.rglob("*") if p.is_file() and str(p.relative_to(ws)).replace("\\", "/") not in shipped)[:40]
    try:  # what went through the door, kept beside the harness's own output
        (state / "door-log.json").write_text(json.dumps({"calls": door.calls, "usage": door.usage, "capped": door.capped, "refused": door.refused,
                                                         "errors": door.errors, "passed": door.passed, "partial": door.partial, "receipts": door.receipts,
                                                         **({"titles": door.titles} if door.skip_titles else {})}, indent=1), encoding="utf-8")
    except Exception:
        pass
    window, windows = window_of(readings, loaded_window(a.api_base, a.model), a.num_ctx)
    tampered =[p for p, h in before.items() if sha(ws / p) != h]
    for p in tampered:  # grade against the shipped file, as atlias does
        (ws / p).write_bytes(task["files"][p].encode("utf-8"))
    for rel, body in (task.get("hidden") or {}).items():
        p = ws / rel
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(str(body).encode("utf-8"))
        except Exception:
            pass  # the check then fails, which is the honest result
    chk = task["check"] if isinstance(task["check"], list) else task["check"].split()
    limit = max(5, task.get("timeoutMs", 60000) / 1000)
    env_chk = os.environ | {"PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    with tempfile.TemporaryFile() as buf:
        try:
            # --check-memory-mib (0 = off): the grade runs model-written code; a cap makes a runaway fail its check.
            crc, ctimed = run_tree(chk, cwd=str(ws), env=env_chk, timeout=limit, stdout=buf,
                                   job_memory=int(getattr(a, "check_memory_mib", 0) or 0) * 1024 * 1024)
        except Exception as e:
            crc, ctimed = -1, False
            buf.write(str(e).encode("utf-8"))
        buf.seek(0)
        full = buf.read().decode("utf-8", errors="replace")
    check_ok = crc == 0 and not ctimed
    tail = (f"[the check ran past {limit:.0f} s and was stopped with everything it started]\n" if ctimed else "") + full[-300:]
    usage = list(door.usage)
    # No call at all is a true count of nothing; one call Ollama gave no count for leaves the totals unknown.
    counted = all(u is not None for u in usage)
    toks = [u[0] if u else None for u in usage]
    outs = [u[1] if u else None for u in usage]
    passed = check_ok and not tampered
    # Claude's three input parts, each summed once, where every call gave all three as counts.
    parts = [r.get("counts") for r in door.receipts if r.get("slot") is not None and r.get("api") == "messages"]
    split = None
    if counted and parts and all(_message_totals(c)[0] is not None for c in parts):
        split = {k: sum(c.get(k, 0) for c in parts) for k in ("uncached", "cacheCreate", "cacheRead")}
    if door.capped:
        stop += f"; step limit reached ({door.capped} further call(s) answered with a stop)"
    cut_last = ended_cut(door.receipts)
    if cut_last:
        stop += "; the last reply was cut at the output cap"
    if passed and not a.keep:
        shutil.rmtree(ws, ignore_errors=True)
        shutil.rmtree(state, ignore_errors=True)
    return {"id": task["id"], "name": task.get("name", task["id"]), "pass": passed, "checkExit": check_ok, "tampered": tampered,
            "rounds": len(usage), "budget": budget, "stop": stop, "harnessExit": rc, "starts": starts,
            "startMs": int((door.first - t0) * 1000) if door.first else None, "promptTokens": toks, "cases": case_counts(full),
            # A call Ollama gave no count for leaves the totals unknown, never a smaller number.
            "promptTotal": sum(toks) if counted else None, "outputTokens": outs, "outputTotal": sum(outs) if counted else None,
            "peakPrompt": max(toks or [0]) if counted else None,
            "peakContext": max([p + o for p, o in usage] or [0]) if counted else None,
            "usageComplete": counted, "inputParts": split, "partialCalls": door.partial,
            "measurementComplete": measured_complete(rc, stopped, door),
            "budgetCapped": door.capped,
            # Whether the harness ended by itself, apart from whether the grader passed what it left.
            # A run whose last model reply ended at the output cap stopped on an unfinished reply.
            "nativeCompleted": rc == 0 and not door.capped and not door.errors and not door.partial and bool(usage) and not cut_last,
            "cutCalls": door.cut, "endedCut": cut_last, **({"titleCalls": door.titles} if door.skip_titles else {}),
            "numCtx": a.num_ctx, "loadedWindow": window, "loadedWindows": windows, "taskDigests": task_digests(task), "provenance": getattr(a, "provenance", None),
            "receipts": door.receipts, "byRole": role_summary(door.receipts, usage),
            "refused": door.refused[:20], "modelErrors": door.errors[:20], "addedFiles": None if (passed and not a.keep) else added,
            "ms": int((time.time() - t0) * 1000), "agentMs": agent_ms,
            "workspace": None if (passed and not a.keep) else str(ws), "state": None if (passed and not a.keep) else str(state), "output": tail}


def counted_row(r):
    """A row whose every call was counted; an older row without the flag counts when its totals do."""
    return r.get("usageComplete") is not False and _count(r.get("promptTotal")) is not None and _count(r.get("outputTotal")) is not None


def report(results, a, t_all):
    windows = sorted({r.get("loadedWindow") for r in results if r.get("loadedWindow")})
    plugins = [str(d) for d in (getattr(a, "claude_plugin_dir", None) or [])] if a.harness == "claude" else []
    kind = f"with {len(plugins)} plugin folder(s)" if plugins else "stock"
    # Run totals and peaks exist only when every task was counted: one uncounted call anywhere
    # leaves them unknown, never smaller. The window matches only when every task's was read and
    # equals the one asked for; a task whose window could not be read does not match.
    complete = bool(results) and all(counted_row(r) for r in results)
    peaks = [r.get("peakContext") for r in results]
    return {"results": results, "passed": sum(1 for r in results if r["pass"]), "total": len(results),
            "ms": int((time.time() - t_all) * 1000), "engine": f"{a.harness} ({kind}, metered door, offline)", "harness": a.harness, "pluginDirs": plugins,
            "model": a.model, "numCtx": a.num_ctx, "numPredict": a.num_predict, "loadedWindows": windows,
            "windowMatched": all(r.get("loadedWindow") == a.num_ctx for r in results) if results else None,
            "usageComplete": complete, "promptTotal": sum(r["promptTotal"] for r in results) if complete else None,
            "outputTotal": sum(r["outputTotal"] for r in results) if complete else None,
            "peakPrompt": max(r["peakPrompt"] for r in results) if complete and all(_count(r.get("peakPrompt")) is not None for r in results) else None,
            "peakContext": max(peaks) if complete and all(_count(x) is not None for x in peaks) else None,
            "nativeCompleted": sum(1 for r in results if r.get("nativeCompleted") is True),
            # Every row's role figures added up; a row written before roles existed leaves the whole table unknown.
            "byRole": sum_role_summaries([r["byRole"] for r in results]) if results and all("byRole" in r for r in results) else None,
            "provenance": getattr(a, "provenance", None), "provenanceUniform": len({_digest(r.get("provenance")) for r in results}) <= 1,
            "corpus": {"tasks": a.tasks, "ids": a.ids_from or None}}


def resumed(out):
    """Every row of an earlier report: unknown, failed and unfavourable attempts stay, and a task
    already in it is never run again in its place."""
    return list(json.loads(pathlib.Path(out).read_text(encoding="utf-8")).get("results", []))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--harness", required=True, choices=sorted(HARNESS))
    ap.add_argument("--tasks", required=True, nargs="+", help="one or more task directories")
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", default="")
    ap.add_argument("--ids-from", default="", help="run exactly the task ids of this saved report")
    ap.add_argument("--budget", type=int, default=0)
    ap.add_argument("--resume", action="store_true", help="keep the tasks already in --out and run only the rest")
    ap.add_argument("--keep", action="store_true", help="keep the workspace of a passing task too")
    ap.add_argument("--check-memory-mib", type=int, default=0, help="most memory the grading check's process tree may commit (0 = no limit)")
    ap.add_argument("--harness-process-memory-mib", type=int, default=0, help="most memory any one process in the harness tree may commit, the code it runs included (0 = no limit)")
    ap.add_argument("--model", required=True, help="the Ollama model name, for example qwen3.5:9b")
    ap.add_argument("--api-base", default="http://127.0.0.1:11435")
    ap.add_argument("--work", default=os.path.join(tempfile.gettempdir(), "base-h2h"))
    ap.add_argument("--num-ctx", type=int, default=16384)
    ap.add_argument("--num-predict", type=int, default=2048)
    ap.add_argument("--task-timeout", type=int, default=1200, help="seconds a harness may work on one task, from its first model call")
    ap.add_argument("--start-timeout", type=int, default=600, help="seconds a harness may take to make its first model call")
    ap.add_argument("--nanobot", default="D:/harness-work/venvs/nanobot/Scripts/nanobot.exe")
    ap.add_argument("--bun", default="D:/harness-work/atlias-opencode-1009/runtime/bun-windows-x64/bun.exe")
    ap.add_argument("--opencode-source", default="D:/harness-work/atlias-opencode-1009/upstream",
                    help="OpenCode source tree the run is made from (its bun is --bun); example for OpenCode v2.0.28: --opencode-source D:/harness-work/opencode-v2.0.28")
    ap.add_argument("--ripgrep", default="D:/harness-work/atlias-opencode-1009/runtime/rg/rg.exe")
    ap.add_argument("--tiktoken-cache", default="D:/harness-work/tiktoken-cache", help="where nanobot's token-counter file is kept (filled once, with the network)")
    ap.add_argument("--claude", default="C:/Users/OWNER/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe", help="the Claude Code program itself, not the npm launcher script")
    ap.add_argument("--claude-plugin-dir", action="append", default=[], help="a plugin folder base Claude Code also loads (repeatable): atlias as a sub-harness, a mod")
    ap.add_argument("--codex", default="C:/Users/OWNER/AppData/Local/OpenAI/Codex/bin/2e5e00daee91c61d/codex.exe", help="the exact bundled Codex CLI")
    ap.add_argument("--codex-home-from", default="", help="a prepared CODEX_HOME copied into each task's own (atlias installed into it): the second arm")
    ap.add_argument("--codex-disabled-skills", default="", help="frozen JSON list of personal SKILL.md paths disabled identically in both arms; native/project skills remain")
    ap.add_argument("--codex-bypass-hook-trust", action="store_true", help="run pre-vetted isolated automation hooks; never implied by a model choice")
    a = ap.parse_args()
    need = ([a.nanobot] if a.harness == "nanobot" else [a.claude, *a.claude_plugin_dir] if a.harness == "claude"
            else [a.codex, *([a.codex_home_from] if a.codex_home_from else [])] if a.harness == "codex"
            else [shutil.which("node") or "node", str(pathlib.Path(__file__).resolve().parent / "atlias_task.mjs")] if a.harness == "atlias"
            else [a.bun, str(pathlib.Path(a.opencode_source) / "packages" / "cli" / "src" / "index.ts")])
    # Without its token-counter file nanobot falls back to counting bytes, takes its own first prompt
    # for twice the window and refuses to start (seen 2026-10-11); that is a broken setup, not a result.
    if a.harness == "nanobot" and not any(pathlib.Path(a.tiktoken_cache).glob("*")):
        need.append(str(pathlib.Path(a.tiktoken_cache) / "<the cl100k_base file>"))
    missing = [x for x in need if not pathlib.Path(x).exists()]
    if missing:
        print(f"Gev: {a.harness} cannot run, missing {', '.join(missing)}", flush=True)
        sys.exit(3)
    watch_parent()
    for sig in ("SIGTERM", "SIGHUP", "SIGBREAK"):
        if hasattr(signal, sig):
            signal.signal(getattr(signal, sig), lambda *_: (end_all(), os._exit(4)))
    pathlib.Path(a.work).mkdir(parents=True, exist_ok=True)
    shims = make_shims(pathlib.Path(a.work) / "_shims")
    # The plain arm's shims refuse PowerShell because its agent works in bash. These harnesses run
    # their own shell tool, and on Windows that is PowerShell: on 2026-10-11 nanobot could run no
    # command at all until these two were taken out. Editors, pagers and installers stay refused.
    for name in ("powershell", "pwsh"):
        for shim in (pathlib.Path(shims) / name, pathlib.Path(shims) / f"{name}.cmd"):
            shim.unlink(missing_ok=True)
    files = sorted(f for d in a.tasks for f in pathlib.Path(d).glob("*.json"))
    if a.only:
        want = [s for s in a.only.split(",") if s]
        files = [f for f in files if any(w in f.stem for w in want)]
    if a.ids_from:
        ids = {r["id"] for r in json.loads(pathlib.Path(a.ids_from).read_text(encoding="utf-8")).get("results", [])}
        files = [f for f in files if json.loads(f.read_text(encoding="utf-8")).get("id") in ids]
    results, t_all = [], time.time()
    out = pathlib.Path(a.out)
    if a.resume and out.exists():
        # Preserve unknown, failed and unfavorable attempts. A repeat is a new report,
        # never a replacement that erases the original spend or grade.
        results = resumed(out)
    done = {r["id"] for r in results}
    a.provenance = provenance(a)
    try:
        for f in files:
            task = json.loads(f.read_text(encoding="utf-8"))
            if task["id"] in done:
                continue
            res = run_one(task, a, shims)
            results.append(res)
            # Written after every task, so a run that dies at hour five keeps what it did.
            out.write_text(json.dumps(report(results, a, t_all), indent=2), encoding="utf-8")
            print(f"{'PASS' if res['pass'] else 'FAIL'}  {res['name']}  ({res['rounds']}/{res['budget']} calls, {res['ms'] / 1000:.1f}s, {res['stop']})", flush=True)
    finally:
        end_all()
    rep = report(results, a, t_all)
    out.write_text(json.dumps(rep, indent=2), encoding="utf-8")
    print(f"{a.harness}: {rep['passed']}/{rep['total']} in {rep['ms'] / 1000:.0f}s", flush=True)


if __name__ == "__main__":
    main()
