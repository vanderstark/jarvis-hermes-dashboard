# JARVIS — a voice HUD for Claude Code

Talk to your computer. It answers in a real voice, uses your own tools, and
shows you every step it takes.

This is a mission-control interface that **drives your own Claude Code**. It
isn't a separate AI — whatever connectors and skills you've already set up
(Gmail, Calendar, Drive, anything MCP) work here with no extra wiring, because
Claude Code is doing the work and this is a face on it.

```bash
git clone https://github.com/YOUR-USERNAME/jarvis-os.git
cd jarvis-os
cp .env.example .env      # add your ElevenLabs key
./start.sh
```

Opens on <http://localhost:8730>. Click **◉ VOICE**, allow the mic, and talk.

---

## What you need

| | |
|---|---|
| **Claude Code** | installed and logged in (`claude` → `/login`). This is the brain. |
| **Python 3** | standard library only — no `pip install`, no `npm`, no build step |
| **ElevenLabs** | free account, for the voice. Nothing else is paid. |

No API key for the model. It runs on your existing Claude Code login.

---

## How it works

```
you speak ─▶ ElevenLabs speech-to-text ─▶ text
                                            │
                                            ▼
  claude -p "<text>" --output-format stream-json --include-partial-messages
                     (your subscription · your connectors · your skills)
                                            │
             ┌──────────────────────────────┴──────────────────┐
             ▼                                                  ▼
   streamed telemetry                                     the answer
   (run id, tool calls, tokens, latency)                        │
             │                                                  ▼
             ▼                                     ElevenLabs text-to-speech
       the ACTION LOG                                           │
                                                                ▼
                                                        the RESPONSE panel
```

The server spawns `claude` and parses its `stream-json` output, forwarding
events to the browser over a streamed HTTP response. The Action Log isn't
decoration — it's Claude's real event stream.

---

## Talking to it

Press **◉ VOICE once**, then just talk. It listens, you stop, it answers and
speaks, then **listens again automatically** — no clicking between turns. Press
it again to end the conversation.

The mic goes deliberately deaf while it's speaking. Without that it transcribes
its own voice through your speakers and talks to itself forever.

You can also type in the uplink box (⌘↵ to send).

---

## The command matrix

The six buttons are real. Press one, then say or type the rest.

| Button | What it does |
|---|---|
| **/new** | Fresh thread — clears the conversation |
| **/profile** | Remembers a fact about you, permanently |
| **/goal** | Sets your standing objective |
| **/personality** | Overlays a tone on the persona |
| **/kanban** | Say something to add it to your queue; press alone to hear it |
| **/background** | Runs a mission asynchronously and reports back when it lands |

Profile, goal, personality and the queue live in `state.json` and are injected
into **every** run, so they persist across restarts and genuinely change how it
behaves. Press a button with nothing after it to read the current value.

Try: `/personality` → *"dry, sardonic, fewer words"* → then ask it anything.

---

## Making it yours

**`persona.md` is the personality.** Brevity, tone, banned phrases, and the rule
that it must never narrate its own tooling. Edit it, restart, done — no code
change. Everything it says is spoken aloud, so it's written for the ear.

**Connectors** come from Claude Code. Add one with `claude mcp add …` and it
appears here on the next run. Check the STATUS line in the Action Log to see
which ones loaded.

---

## The permission trade-off — read this

By default this runs Claude with `--dangerously-skip-permissions`
(`JARVIS_PERMISSION=bypass`).

It has to. In a headless run there's nobody to click "allow", so without it
every tool call — including your connectors — stalls forever.

**That means the assistant can use tools, including ones that send email, without
asking you first.** On your own machine, driving your own assistant, that's the
point. But know what you're turning on. The guardrails then live in `persona.md`
and in whatever skills you install — not in a per-action prompt.

Set `JARVIS_PERMISSION=default` to require approval, and accept that tool calls
won't complete headlessly.

---

## Troubleshooting

Every run writes exactly what Claude said — stdout and stderr — to
`/tmp/jarvis-claude-raw.log`. If something misbehaves, read that first; it is
the ground truth.

**It transcribes me but never answers.** Check the raw log for
`authentication_failed`. A stale `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`
in `~/.claude/settings.json` overrides your login and 401s on every request.
Remove them and Claude falls back to your subscription.

**A connector hangs the run.** Start with `JARVIS_MCP=none ./start.sh` to
confirm, then authorize the offending server with `claude` → `/mcp`.

**"core went quiet".** The watchdog stopped a run that produced nothing for
`JARVIS_TIMEOUT` seconds. The error includes Claude's stderr.

**The mic hears nothing.** The reactor shows a live `IN ▮▮▮▯▯` meter while
listening. If the bars don't move, it's mic permission, not the app.

---

## Files

```
jarvis-os/
├── server.py     HTTP + NDJSON run stream + voice proxy   (stdlib only)
├── runtime.py    spawns claude, parses stream-json
├── voice.py      ElevenLabs speech-to-text + text-to-speech
├── commands.py   the six command-matrix buttons + state
├── persona.md    how it talks — edit this
├── ui/           the HUD: index.html, styles.css, app.js
└── start.sh
```

There are no canned answers anywhere in this project. If Claude can't be
reached, it says so rather than faking a reply.

## License

MIT.
