#!/usr/bin/env bash
# JARVIS — NORMAL mode.
# Real Claude Code brain, your connectors, no scripted answers. This is the
# honest assistant anyone building it should run.
#
# Run from a normal Terminal window (not inside a Claude Code session).
cd "$(dirname "$0")" || exit 1
unset CLAUDECODE CLAUDE_CODE_SESSION_ID CLAUDE_CODE_ENTRYPOINT ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY
lsof -ti tcp:"${JARVIS_PORT:-8730}" | xargs kill -9 2>/dev/null
exec python3 server.py
