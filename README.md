# Prompt Discipline Plugin

Stop burning tokens on vague prompts. This plugin catches ambiguous instructions before they cause wrong outputs, extra round-trips, and context bloat.

## The Problem

In real Claude Code sessions, 40%+ of prompts are under 50 characters — things like "fix the tests", "commit this", "remove them". These force Claude to guess, leading to:
- Wrong outputs that need correction (2-3x token cost)
- Extra round-trips asking for clarification
- Context bloat that triggers compaction sooner

## What This Plugin Does

### Hooks
- **Pre-tool ambiguity check**: Before Claude executes Write/Edit/Bash on a vague instruction, it pauses to verify it has the specific file, change, and done condition
- **Session health monitor**: Warns when turn count is high and suggests starting fresh

### Commands
- `/commit-all` — Atomic git commit workflow (replaces copy-pasting the same prompt 5x/day)
- `/execute-plan` — Load and execute a structured plan with batch checkpoints
- `/finish-branch` — Push, PR, review workflow
- `/agent-status` — Check all sub-agents in one prompt instead of polling 4-5 times
- `/scope-first` — Enumerate pages/routes/roles before starting open-ended work

### Skills
- **prompt-coach** — When Claude detects an ambiguous instruction, it gathers project context (git diff, test output, workspace docs) and either proceeds with full context or asks one sharp clarifying question

## Installation

```bash
# From the claude-plugins marketplace
claude plugin add prompt-discipline

# Or link locally
claude plugin link /path/to/claude-plugins/plugins/prompt-discipline
```

## Usage

Once installed, hooks activate automatically. Commands are available via slash:

```
/prompt-discipline:commit-all
/prompt-discipline:execute-plan
/prompt-discipline:finish-branch
/prompt-discipline:agent-status
/prompt-discipline:scope-first
```

## How the Ambiguity Hook Works

The hook scores the user's last message against 4 criteria:
1. **Target**: Is a specific file/component/test named?
2. **Action**: Is the verb unambiguous (fix what? add where? remove which?)
3. **Scope**: Are boundaries defined (which suite, which role, which branch)?
4. **Done condition**: Is there a way to verify completion?

If 2+ criteria are missing, Claude asks ONE clarifying question before proceeding.

## Measured Impact

Based on session analysis of 125 prompts across 9 sessions:
- 41% of prompts were under 50 chars (most missing 2+ criteria)
- ~33K chars of duplicate content per day from repeated skill pastes
- 6 context compactions from unbounded session scope
- Estimated 30-40% token savings from eliminating vague→wrong→fix cycles
