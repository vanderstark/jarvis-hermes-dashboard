"""
The command matrix — the six buttons, made real.

Each one mutates a small persistent state file and/or changes how the next run
behaves. Profile, goal and personality are injected into the system prompt on
every run, so they genuinely persist and shape the assistant.

  /new          start a fresh thread
  /profile X    remember a fact about the user, forever
  /goal X       set the standing objective
  /personality X  overlay a tone on the persona
  /kanban [X]   show the work queue, or add to it
  /background X run a mission asynchronously and report when it lands
"""
import json
import os
import pathlib
import re
import threading
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parent
STATE_FILE = pathlib.Path(os.environ.get("JARVIS_STATE", ROOT / "state.json"))

_LOCK = threading.Lock()
_DEFAULT = {"profile": [], "goal": "", "personality": "", "tasks": []}


# ─────────────────────────── state ───────────────────────────
def load():
    try:
        d = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        return {**_DEFAULT, **d}
    except (OSError, json.JSONDecodeError):
        return dict(_DEFAULT)


def save(d):
    with _LOCK:
        STATE_FILE.write_text(json.dumps(d, indent=2) + "\n", encoding="utf-8")


def context_block():
    """What gets appended to the persona on every run."""
    d = load()
    out = []
    if d["profile"]:
        out.append("## What you know about the user\n"
                   + "\n".join(f"- {x}" for x in d["profile"][-40:]))
    if d["goal"]:
        out.append(f"## Their standing objective\n{d['goal']}\n"
                   "Keep it in mind; mention it only when it's actually relevant.")
    if d["personality"]:
        out.append(f"## Tone overlay\n{d['personality']}\n"
                   "This adjusts your delivery. The brevity rules still apply.")
    open_tasks = [t for t in d["tasks"] if not t.get("done")]
    if open_tasks:
        out.append("## Their work queue\n"
                   + "\n".join(f"- {t['text']}" for t in open_tasks[:20]))
    return "\n\n".join(out)


# ─────────────────────────── background jobs ───────────────────────────
JOBS = {}          # id -> {status, mission, result, started, finished}
_JOB_LOCK = threading.Lock()


def start_background(mission, runner):
    """runner(message) -> yields runtime events. Runs detached; result stored."""
    jid = uuid.uuid4().hex[:8]
    with _JOB_LOCK:
        JOBS[jid] = {"id": jid, "status": "running", "mission": mission,
                     "result": "", "started": time.time(), "finished": None}

    def _work():
        text = ""
        try:
            for ev in runner(mission):
                if ev.get("t") == "delta":
                    text += ev["text"]
                elif ev.get("t") == "error":
                    text = text or ("failed: " + str(ev.get("message", ""))[:200])
        except Exception as e:                       # noqa: BLE001
            text = f"failed: {e}"[:200]
        with _JOB_LOCK:
            JOBS[jid].update(status="done", result=text.strip(), finished=time.time())

    threading.Thread(target=_work, daemon=True).start()
    return jid


def jobs_snapshot():
    with _JOB_LOCK:
        return [dict(j) for j in JOBS.values()]


def take_finished():
    """Return finished jobs once, then forget them (so the UI reports each once)."""
    with _JOB_LOCK:
        done = [dict(j) for j in JOBS.values() if j["status"] == "done"]
        for j in done:
            JOBS.pop(j["id"], None)
        return done


# ─────────────────────────── dispatch ───────────────────────────
_CMD = re.compile(r"^\s*/(new|profile|goal|personality|kanban|background)\b\s*(.*)$",
                  re.I | re.S)


def handle(message, runner=None):
    """Returns None if this isn't a command.

    Otherwise a dict:
      fresh   — reset the claude session
      message — what to actually send to claude (None = don't call claude)
      reply   — a direct answer, when no model call is needed
      note    — a line for the action log
    """
    m = _CMD.match(message or "")
    if not m:
        return None
    cmd, arg = m.group(1).lower(), m.group(2).strip()
    d = load()

    if cmd == "new":
        return dict(fresh=True,
                    message=arg or "Start fresh. Greet me in one short line.",
                    note="thread reset")

    if cmd == "profile":
        if not arg:
            facts = d["profile"]
            return dict(message=None,
                        reply=("I know " + str(len(facts)) + " things about you."
                               if facts else "I don't know anything about you yet."),
                        note="profile read")
        d["profile"].append(arg)
        save(d)
        return dict(message=f'The user just told you this about themselves: "{arg}". '
                            "You've saved it permanently. Acknowledge in one short line.",
                    note=f"profile += {arg[:50]}")

    if cmd == "goal":
        if not arg:
            return dict(message=None,
                        reply=d["goal"] or "No standing objective set.",
                        note="goal read")
        d["goal"] = arg
        save(d)
        return dict(message=f'The user set their standing objective: "{arg}". '
                            "Acknowledge in one short line.",
                    note=f"goal set: {arg[:50]}")

    if cmd == "personality":
        if not arg:
            return dict(message=None,
                        reply=d["personality"] or "Running default persona.",
                        note="persona read")
        d["personality"] = arg
        save(d)
        return dict(message=f'The user just changed your tone to: "{arg}". '
                            "Reply in one short line, already in that new tone.",
                    note=f"persona: {arg[:50]}")

    if cmd == "kanban":
        if arg:
            d["tasks"].append({"text": arg, "done": False, "at": time.time()})
            save(d)
            return dict(message=f'Added to the user\'s work queue: "{arg}". '
                                "Confirm in one short line.",
                        note=f"task += {arg[:50]}")
        open_t = [t["text"] for t in d["tasks"] if not t.get("done")]
        if not open_t:
            return dict(message=None, reply="Your queue is empty.", note="queue read")
        return dict(message="Read the user their work queue, briefly, in your own "
                            "voice. Do not add commentary:\n"
                            + "\n".join(f"- {t}" for t in open_t),
                    note=f"queue read ({len(open_t)})")

    if cmd == "background":
        if not arg:
            return dict(message=None, reply="Give me a mission.", note="background: empty")
        if runner is None:
            return dict(message=None, reply="Background missions aren't available.",
                        note="background unavailable")
        jid = start_background(arg, runner)
        return dict(message=None,
                    reply=f"On it in the background, sir. I'll report back.",
                    note=f"mission {jid} started: {arg[:50]}")

    return None
