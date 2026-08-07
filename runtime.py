"""
The runtime — this is where Path A lives.

It drives Claude Code as a subprocess (`claude -p … --output-format stream-json`)
and turns its event stream into the small set of events the HUD renders. Because
Claude Code is the thing actually doing the work, every MCP connector and skill
you've set up for it is live here too — you didn't re-wire anything, you're just
putting a face on the same runtime.

If `claude` isn't reachable (not installed, or not logged in), it says so
plainly — there are no canned answers anywhere in this project.
"""
import collections
import json
import os
import re
import shutil
import subprocess
import time

# claude session ids are UUIDs — anything else (like "demo"/"mock") must never
# reach --resume, or the CLI refuses to start.
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def valid_session(sid):
    return bool(sid) and bool(_UUID.match(str(sid)))

MODEL = os.environ.get("JARVIS_MODEL", "").strip()
WORKDIR = os.path.expanduser(os.environ.get("JARVIS_WORKDIR", "~"))
# default|bypass|accept|plan — bypass lets the assistant use tools without a
# prompt, which is what makes connectors work headlessly. Loud in the banner.
PERMISSION = os.environ.get("JARVIS_PERMISSION", "bypass").strip().lower()
RUNTIME = os.environ.get("JARVIS_RUNTIME", "auto").strip().lower()  # auto|claude|mock


def _mono_ms():
    return int(time.monotonic() * 1000)


def runtime_kind():
    if RUNTIME == "mock":
        return "mock"
    if RUNTIME == "claude":
        return "claude"
    return "claude" if shutil.which("claude") else "mock"


# JARVIS_MCP controls which connectors load:
#   all   (default) — your normal Claude Code MCP servers
#   none            — no MCP servers (use this if a server that needs OAuth,
#                     e.g. supabase/vercel, is hanging the headless run)
#   /path/to.json   — only the servers in that config file
MCP_MODE = os.environ.get("JARVIS_MCP", "all").strip()
_NOMCP = os.path.join(os.path.dirname(__file__), ".no-mcp.json")


def _mcp_flags():
    if MCP_MODE in ("all", ""):
        return []
    path = _NOMCP if MCP_MODE == "none" else MCP_MODE
    if MCP_MODE == "none" and not os.path.exists(_NOMCP):
        with open(_NOMCP, "w") as f:
            f.write('{"mcpServers":{}}')
    return ["--strict-mcp-config", "--mcp-config", path]


def build_command(message, session_id=None, system=None):
    cmd = ["claude", "-p", message,
           "--output-format", "stream-json",
           "--include-partial-messages",
           "--verbose"]
    cmd += _mcp_flags()
    if MODEL:
        cmd += ["--model", MODEL]
    if valid_session(session_id):              # never pass "demo"/"mock"/garbage
        cmd += ["--resume", session_id]
    if system:
        cmd += ["--append-system-prompt", system]
    if PERMISSION == "bypass":
        cmd += ["--dangerously-skip-permissions"]
    elif PERMISSION in ("accept", "plan", "default"):
        if PERMISSION != "default":
            cmd += ["--permission-mode",
                    {"accept": "acceptEdits", "plan": "plan"}[PERMISSION]]
    return cmd


# idle watchdog: if claude produces no output for this long, it's stuck (almost
# always an MCP server waiting on auth). Kill it and say so, instead of hanging.
IDLE_TIMEOUT = int(os.environ.get("JARVIS_TIMEOUT", "45"))
# raw transcript of the last claude run — for diagnosing "no response"
RAW_LOG = os.environ.get("JARVIS_RAW_LOG", "/tmp/jarvis-claude-raw.log")


# ─────────────────────────── real: Claude Code ───────────────────────────
def run_claude(message, session_id=None, system=None):
    """Yields event dicts. Raises only if the process can't be launched."""
    import queue as _queue
    import threading as _threading

    cmd = build_command(message, session_id, system)
    started = _mono_ms()
    first_text_at = None

    # Strip API-key auth so claude uses your claude.ai login — that's the auth
    # source that loads your connectors. With ANTHROPIC_API_KEY set, the CLI
    # bills the API and disables claude.ai connectors (Path A's whole point).
    child_env = {k: v for k, v in os.environ.items()
                 if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
                              "CLAUDE_CODE_ENTRYPOINT", "CLAUDECODE",
                              "CLAUDE_CODE_SESSION_ID")}
    try:
        proc = subprocess.Popen(
            cmd, cwd=WORKDIR, text=True, bufsize=1,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=child_env,
        )
    except FileNotFoundError:
        raise RuntimeError("claude CLI not found")

    # Read stdout on a thread so the main loop can enforce an idle timeout —
    # a blocking `for line in proc.stdout` can't be interrupted when claude hangs.
    q = _queue.Queue()

    # Raw transcript of exactly what claude said, so a failure can be diagnosed
    # instead of guessed at. Small, overwritten each run.
    raw = open(RAW_LOG, "w", encoding="utf-8", errors="replace")
    raw.write("$ " + " ".join(cmd) + "\n\n")
    raw.flush()

    def _pump():
        try:
            for ln in proc.stdout:
                raw.write("OUT " + ln); raw.flush()
                q.put(ln)
        finally:
            q.put(None)                          # EOF sentinel
    _threading.Thread(target=_pump, daemon=True).start()

    # CRITICAL: drain stderr on its own thread too. A pipe holds only ~64KB;
    # if nobody reads it, claude blocks forever on its next stderr write and
    # never produces an answer. That deadlock looks exactly like a hang.
    errbuf = collections.deque(maxlen=200)

    def _pump_err():
        try:
            for ln in proc.stderr:
                raw.write("ERR " + ln); raw.flush()
                errbuf.append(ln.rstrip())
        except Exception:                        # noqa: BLE001
            pass
    _threading.Thread(target=_pump_err, daemon=True).start()

    sid = session_id
    got_text = False
    debug = os.environ.get("JARVIS_DEBUG") == "1"
    try:
        while True:
            try:
                line = q.get(timeout=IDLE_TIMEOUT)
            except _queue.Empty:
                proc.kill()
                err = " | ".join(list(errbuf)[-3:])
                yield dict(t="error",
                           message=(f"core went quiet for {IDLE_TIMEOUT}s and was stopped. "
                                    + (f"stderr: {err[:220]}" if err
                                       else "No output on stderr either.")))
                return
            if line is None:
                break
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue

            kind = ev.get("type")
            if debug and kind not in ("system", "assistant", "user", "result", "stream_event"):
                yield dict(t="note", message=f"claude event: {kind}")

            if kind == "system" and ev.get("subtype") == "init":
                sid = ev.get("session_id", sid)
                yield dict(t="status",
                           model=ev.get("model", ""),
                           tools=len(ev.get("tools", []) or []),
                           mcp=[m.get("name") for m in ev.get("mcp_servers", []) or []],
                           permission=ev.get("permissionMode", PERMISSION),
                           session_id=sid)

            elif kind == "stream_event":
                sub = ev.get("event", {})
                if sub.get("type") == "content_block_delta":
                    delta = sub.get("delta", {})
                    if delta.get("type") == "text_delta" and delta.get("text"):
                        if first_text_at is None:
                            first_text_at = _mono_ms()
                            yield dict(t="latency", ms=first_text_at - started)
                        got_text = True
                        yield dict(t="delta", text=delta["text"])

            elif kind == "assistant":
                for block in ev.get("message", {}).get("content", []) or []:
                    if block.get("type") == "tool_use":
                        yield dict(t="tool", phase="use", name=block.get("name", "tool"),
                                   input=_short(block.get("input")))
                    elif block.get("type") == "text" and not got_text and block.get("text"):
                        # no partial deltas arrived — emit the whole thing at once
                        if first_text_at is None:
                            first_text_at = _mono_ms()
                            yield dict(t="latency", ms=first_text_at - started)
                        got_text = True
                        yield dict(t="delta", text=block["text"])

            elif kind == "user":
                for block in ev.get("message", {}).get("content", []) or []:
                    if block.get("type") == "tool_result":
                        yield dict(t="tool", phase="result",
                                   ok=not block.get("is_error", False))

            elif kind == "result":
                usage = ev.get("usage", {}) or {}
                yield dict(t="usage",
                           input_tokens=usage.get("input_tokens", 0),
                           output_tokens=usage.get("output_tokens", 0),
                           total_tokens=(usage.get("input_tokens", 0)
                                         + usage.get("output_tokens", 0)))
                if ev.get("is_error"):
                    yield dict(t="error",
                               message=str(ev.get("result", "run failed"))[:400])
                else:
                    # if nothing streamed, deliver the final text now
                    if not got_text and ev.get("result"):
                        yield dict(t="delta", text=ev["result"])
                    yield dict(t="complete", session_id=sid,
                               ms=ev.get("duration_ms"))

        proc.wait(timeout=5)
        if not got_text:
            # process ended but never produced an answer — surface why
            err = " | ".join(list(errbuf)[-3:])
            yield dict(t="error",
                       message=(err or f"core produced no response "
                                       f"(exit {proc.returncode}).")[:400])
    finally:
        try: raw.close()
        except Exception: pass
        if proc.poll() is None:
            proc.terminate()


def _short(obj, limit=120):
    try:
        s = json.dumps(obj) if not isinstance(obj, str) else obj
    except (TypeError, ValueError):
        s = str(obj)
    return s[:limit] + ("…" if len(s) > limit else "")


# ─────────────────────────── public entry ───────────────────────────
def run(message, session_id=None, system=None):
    """Yields events. The three hot demo questions get a fixed scripted answer;
    everything else goes to the real Claude Code brain (mock if unreachable)."""
    if not shutil.which("claude"):
        yield dict(t="error",
                   message="Claude Code isn't installed or isn't on PATH. "
                           "Install it, run `claude` once to log in, then restart.")
        return
    try:
        produced = False
        for ev in run_claude(message, session_id, system):
            produced = True
            yield ev
        if not produced:                       # launched but said nothing
            yield dict(t="error", message="claude produced no output")
    except Exception as e:                      # noqa: BLE001 - never leave the HUD hung
        yield dict(t="error", message=f"could not start the core: {e}")
