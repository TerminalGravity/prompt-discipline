<div align="center">

# ✈️ preflight

**Preflight checks for your AI coding prompts.**

A 24-tool MCP server for Claude Code that catches ambiguous instructions before they cost you 2-3x in wrong→fix cycles — plus semantic search across your entire session history.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-Compatible-blueviolet)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

</div>

---

## The Problem

We built this after analyzing **9 months of real Claude Code usage** — 512 sessions, 32,000+ events, 3,200+ prompts, 1,642 commits, and 258 sub-agent spawns across a production Next.js/Prisma/Supabase app. The findings were brutal:

- **41% of prompts were under 50 characters** — things like `fix the tests`, `commit this`, `remove them`
- Each vague prompt triggers a **wrong→fix cycle costing 2-3x tokens**
- **~33K characters/day** duplicated from repeated context pastes
- **124 corrections logged** — places where Claude went the wrong direction and had to be steered back
- **94 context compactions** from unbounded session scope blowing past the context window
- Estimated **30-40% of tokens wasted** on avoidable back-and-forth

The pattern is always the same: vague prompt → Claude guesses → wrong output → you correct → repeat. That's your money evaporating.

## The Solution

24 tools in 4 categories that run as an MCP server inside Claude Code:

| Category | What it does |
|----------|-------------|
| ✈️ **Preflight Core** (1 tool) | Unified entry point — triages every prompt, chains the right checks automatically |
| 🎯 **Prompt Discipline** (12 tools) | Catches vague prompts, enforces structure, prevents waste |
| 🔍 **Timeline Intelligence** (4 tools) | LanceDB vector search across months of session history |
| 📊 **Analysis & Reporting** (4 tools) | Scorecards, cost estimation, session stats, pattern detection |
| ✅ **Verification & Hygiene** (3 tools) | Type-check, test, audit, and contract search |

## Before / After

```
❌  "fix the auth bug"
     → Claude guesses which auth bug, edits wrong file
     → You correct it, 3 more rounds
     → 12,000 tokens burned

✅  preflight intercepts → clarify_intent fires
     → "Which auth bug? I see 3 open issues:
        1. JWT expiry not refreshing (src/auth/jwt.ts)
        2. OAuth callback 404 (src/auth/oauth.ts)  
        3. Session cookie SameSite (src/middleware/session.ts)
        Pick one and I'll scope the fix."
     → 4,000 tokens, done right the first time
```

## Quick Start

### Option A: Claude Code CLI (fastest)

```bash
claude mcp add preflight -- npx tsx /path/to/preflight/src/index.ts
```

Or with environment variables:

```bash
claude mcp add preflight -e CLAUDE_PROJECT_DIR=/path/to/your/project -- npx tsx /path/to/preflight/src/index.ts
```

### Option B: Clone & configure manually

**1. Clone & install:**
```bash
git clone https://github.com/TerminalGravity/preflight.git
cd preflight && npm install
```

**2. Add to your project's `.mcp.json`:**
```json
{
  "mcpServers": {
    "preflight": {
      "command": "npx",
      "args": ["tsx", "/path/to/preflight/src/index.ts"],
      "env": {
        "CLAUDE_PROJECT_DIR": "/path/to/your/project"
      }
    }
  }
}
```

**3. Restart Claude Code.** The tools activate automatically.

## Tool Reference

### ✈️ Preflight Core

| Tool | What it does |
|------|-------------|
| `preflight_check` | **The main entry point.** Triages your prompt (trivial → multi-step), then chains the right checks automatically. One tool to rule them all. |

### 🎯 Prompt Discipline

| Tool | What it does |
|------|-------------|
| `scope_work` | Creates structured execution plans before coding starts |
| `clarify_intent` | Gathers project context to disambiguate vague prompts |
| `enrich_agent_task` | Enriches sub-agent tasks with file paths, patterns, and cross-service context |
| `sharpen_followup` | Resolves "fix it" / "do the others" to actual file targets |
| `token_audit` | Detects waste patterns, grades your session A–F |
| `sequence_tasks` | Orders tasks by dependency, locality, and risk |
| `checkpoint` | Save game before compaction — commits + resumption notes |
| `check_session_health` | Monitors uncommitted files, time since commit, turn count |
| `log_correction` | Tracks corrections and identifies recurring error patterns |
| `check_patterns` | Checks prompts against learned correction patterns — warns about known pitfalls |
| `session_handoff` | Generates handoff briefs for new sessions |
| `what_changed` | Summarizes diffs since last checkpoint |

### 🔍 Timeline Intelligence

| Tool | What it does |
|------|-------------|
| `onboard_project` | Indexes a project's session history + contracts into per-project LanceDB |
| `search_history` | Semantic search with scope: current project, related, or all |
| `timeline` | Chronological view of events across sessions |
| `scan_sessions` | Live scanning of active session data |

### 📊 Analysis & Reporting

| Tool | What it does |
|------|-------------|
| `generate_scorecard` | 12-category report card — session, trend (week/month), or cross-project comparative. PDF or markdown. |
| `estimate_cost` | Token usage, dollar cost, waste from corrections, preflight savings |
| `session_stats` | Lightweight session analysis — no embeddings needed |
| `prompt_score` | Gamified A–F grading on specificity, scope, actionability, done-condition |

### ✅ Verification & Hygiene

| Tool | What it does |
|------|-------------|
| `verify_completion` | Runs type check + tests + build before declaring done |
| `audit_workspace` | Finds stale/missing workspace docs vs git activity |
| `search_contracts` | Search API contracts, types, and schemas across current and related projects |

## Timeline Intelligence

This is the feature that makes preflight more than a linter.

When you run `onboard_project` for a specific project, the server finds that project's session history (JSONL files in `~/.claude/projects/<encoded-path>/`) and indexes its events into a local [LanceDB](https://lancedb.github.io/lancedb/) database with vector embeddings. Run it once per project you want to search — each project's data stays tagged so you can query across them or filter to one.

**What that gives you:**
- 🔎 **Semantic search** — "How did I set up the auth middleware last month?" actually works
- 📊 **32K+ events** indexed across 9 months of real production sessions
- 🧭 **Timeline view** — see what happened across sessions chronologically
- 🔄 **Live scanning** — index new sessions as they happen

No data leaves your machine. Embeddings run locally by default (Xenova/transformers.js) or via OpenAI if configured.

## Architecture

```
Claude Code ←→ MCP Protocol ←→ preflight server
                                      │
              ┌───────────┬───────────┼───────────┬──────────┐
              │           │           │           │          │
         Preflight    Discipline   Timeline   Analysis   Verify
         Core (1)    Tools (12)   Tools (4)   Tools (4)  (3)
              │           │           │
         Smart Triage  Patterns    LanceDB        .preflight/
         Classification Learning   (per-project)  (project config)
                                      │
                              ~/.claude/projects/
                            (session JSONL files)
```

## Configuration

### Project Config (`.preflight/`)

Drop a `.preflight/` directory in your project root for team-shared config:

```yaml
# .preflight/config.yml
profile: standard
related_projects:
  - path: /path/to/auth-service
    alias: auth-service
  - path: /path/to/notifications
    alias: notifications
thresholds:
  session_stale_minutes: 30
  max_tool_calls_before_checkpoint: 100
```

```yaml
# .preflight/triage.yml
rules:
  always_check: [rewards, permissions, migration]
  skip: [commit, format, lint]
  cross_service_keywords: [auth, notification, event]
strictness: standard
```

No config? No problem — everything works with zero configuration. Config just lets teams customize.

### Embedding Providers

| Provider | Setup | Speed | Quality |
|----------|-------|-------|---------|
| **Local (Xenova)** | Zero config, default | ~50 events/sec | Good |
| **OpenAI** | Set `OPENAI_API_KEY` env var | ~200 events/sec | Excellent |

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CLAUDE_PROJECT_DIR` | Project root to monitor | Required |
| `OPENAI_API_KEY` | OpenAI key for embeddings | (uses local Xenova) |
| `PREFLIGHT_RELATED` | Comma-separated related project paths | (none) |

## Contributing

This project is young and there's plenty to do. Check the [issues](https://github.com/TerminalGravity/preflight/issues) — several are tagged `good first issue`.

PRs welcome. No CLA, no bureaucracy. If it makes the tool better, it gets merged.

## License

MIT — do whatever you want with it.
