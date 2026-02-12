#!/usr/bin/env node
// =============================================================================
// Prompt Coach MCP Server — v2.0
// =============================================================================
// 12-category prompt discipline system. Covers:
//   1-6:  Prompt quality (clarify_intent, enrich_agent_task)
//   7:    Compaction management (checkpoint)
//   8:    Session lifecycle (check_session_health)
//   9:    Error recovery (log_correction)
//   10:   Workspace hygiene (audit_workspace)
//   11:   Cross-session continuity (what_changed, session_handoff)
//   12:   Result verification (verify_completion)
// =============================================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync } from "child_process";
import {
  readFileSync, writeFileSync, existsSync,
  readdirSync, statSync, mkdirSync, appendFileSync,
} from "fs";
import { join, basename, relative } from "path";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = join(PROJECT_DIR, ".claude", "prompt-coach-state");

// Ensure state directory exists
if (!existsSync(STATE_DIR)) {
  mkdirSync(STATE_DIR, { recursive: true });
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      cwd: PROJECT_DIR,
      encoding: "utf-8",
      timeout: opts.timeout || 10000,
      maxBuffer: 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    return e.stdout?.trim() || e.stderr?.trim() || `[command failed: ${cmd}]`;
  }
}

function readIfExists(relPath, maxLines = 50) {
  const full = join(PROJECT_DIR, relPath);
  if (!existsSync(full)) return null;
  try {
    const lines = readFileSync(full, "utf-8").split("\n");
    return lines.slice(0, maxLines).join("\n");
  } catch {
    return null;
  }
}

function findWorkspaceDocs() {
  const docs = {};
  const claudeDir = join(PROJECT_DIR, ".claude");
  if (!existsSync(claudeDir)) return docs;
  const scanDir = (dir, prefix = "") => {
    try {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const rel = prefix ? `${prefix}/${entry}` : entry;
        const stat = statSync(full);
        if (stat.isDirectory() && !entry.startsWith(".") && !entry.includes("node_modules") && entry !== "prompt-coach-state") {
          scanDir(full, rel);
        } else if (entry.endsWith(".md") && stat.size < 50000) {
          docs[rel] = {
            content: readFileSync(full, "utf-8").split("\n").slice(0, 40).join("\n"),
            mtime: stat.mtime,
            size: stat.size,
          };
        }
      }
    } catch {}
  };
  scanDir(claudeDir);
  return docs;
}

function loadState(name) {
  const p = join(STATE_DIR, `${name}.json`);
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return {}; }
}

function saveState(name, data) {
  writeFileSync(join(STATE_DIR, `${name}.json`), JSON.stringify(data, null, 2));
}

function now() { return new Date().toISOString(); }

// -----------------------------------------------------------------------------
// MCP Server
// -----------------------------------------------------------------------------

const server = new McpServer({
  name: "prompt-coach",
  version: "2.0.0",
});

// =============================================================================
// CATEGORY 4: clarify_intent — Follow-up Specificity
// =============================================================================

server.tool(
  "clarify_intent",
  `Clarify a vague user instruction by gathering project context. Call BEFORE executing when the user's prompt is missing specific files, actions, scope, or done conditions. Returns git state, test failures, recent changes, and workspace priorities.`,
  {
    user_message: z.string().describe("The user's raw message/instruction to clarify"),
    suspected_area: z.string().optional().describe("Best guess area: 'tests', 'git', 'ui', 'api', 'schema'"),
  },
  async ({ user_message, suspected_area }) => {
    const sections = [];
    const branch = run("git branch --show-current");
    const status = run("git status --short");
    const recentCommits = run("git log --oneline -5");
    const recentFiles = run("git diff --name-only HEAD~3 2>/dev/null || git diff --name-only HEAD~1 2>/dev/null || echo 'no commits'");
    const staged = run("git diff --staged --name-only");
    const dirty = status ? status.split("\n").length : 0;

    sections.push(`## Git State\nBranch: ${branch}\nDirty files: ${dirty}\n${status ? `\`\`\`\n${status}\n\`\`\`` : "Working tree clean"}\nStaged: ${staged || "nothing"}\n\nRecent commits:\n\`\`\`\n${recentCommits}\n\`\`\`\n\nRecently changed files:\n\`\`\`\n${recentFiles}\n\`\`\``);

    const area = (suspected_area || "").toLowerCase();
    if (!area || area.includes("test") || area.includes("fix")) {
      const typeErrors = run("pnpm tsc --noEmit 2>&1 | grep -c 'error TS' || echo '0'");
      const testFiles = run("find tests -name '*.spec.ts' -maxdepth 4 2>/dev/null | head -20");
      let failingTests = "unknown";
      if (existsSync(join(PROJECT_DIR, "playwright-report"))) {
        failingTests = run(`cat playwright-report/results.json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const r=JSON.parse(d);const f=r.suites?.flatMap(s=>s.specs?.filter(sp=>sp.ok===false).map(sp=>sp.title)||[])||[];console.log(f.length?f.join('\\n'):'all passing')}catch{console.log('could not parse')}})" 2>/dev/null || echo "no report"`, { timeout: 5000 });
      }
      sections.push(`## Test State\nType errors: ${typeErrors}\nFailing tests: ${failingTests}\nTest files:\n\`\`\`\n${testFiles}\n\`\`\``);
    }

    const workspaceDocs = findWorkspaceDocs();
    const priorityDocs = Object.entries(workspaceDocs)
      .filter(([n]) => /gap|roadmap|current|todo|changelog/i.test(n))
      .slice(0, 3);
    if (priorityDocs.length > 0) {
      sections.push(`## Workspace Priorities\n${priorityDocs.map(([n, d]) => `### .claude/${n}\n\`\`\`\n${d.content}\n\`\`\``).join("\n\n")}`);
    }

    const msg = user_message.toLowerCase();
    const signals = [];
    if (msg.match(/fix|repair|broken|failing|error/)) signals.push("FIX: Check test output and type errors for specific failures.");
    if (msg.match(/test|spec|suite|playwright/)) signals.push("TESTS: Check failing tests and test files above.");
    if (msg.match(/commit|push|pr|merge/)) signals.push("GIT: Check dirty files and branch above.");
    if (msg.match(/add|create|new|build/)) signals.push("CREATE: Check workspace priorities for what's planned.");
    if (msg.match(/remove|delete|clean|strip/)) signals.push("REMOVE: Check conversation for what 'them/it' refers to.");
    if (msg.match(/check|verify|confirm|status/)) signals.push("VERIFY: Use git/test state above to answer.");
    if (msg.match(/everything|all|entire|whole/)) signals.push("⚠️ UNBOUNDED: Narrow down using workspace priorities.");
    if (!signals.length) signals.push("UNCLEAR: Ask ONE clarifying question.");

    sections.push(`## Intent Signals\n${signals.map(s => `- ${s}`).join("\n")}`);
    sections.push(`## Recommendation\n1. **Proceed with specifics** — state what you'll do and why\n2. **Ask ONE question** — if context doesn't disambiguate`);

    return { content: [{ type: "text", text: sections.join("\n\n") }] };
  }
);

// =============================================================================
// CATEGORY 3: enrich_agent_task — Agent Delegation
// =============================================================================

server.tool(
  "enrich_agent_task",
  `Enrich a vague sub-agent task with project context. Call before spawning a Task/sub-agent to add file paths, patterns, scope boundaries, and done conditions.`,
  {
    task_description: z.string().describe("The raw task for the sub-agent"),
    target_area: z.string().optional().describe("Codebase area: 'admin tests', 'participant pages', 'api routes'"),
  },
  async ({ task_description, target_area }) => {
    const area = target_area || "";
    let fileList = "";
    if (area.includes("admin")) fileList = run("find app/w -path '*/admin/*' -name '*.tsx' 2>/dev/null | head -20");
    else if (area.includes("participant")) fileList = run("find app/w -path '*/participant/*' -name '*.tsx' 2>/dev/null | head -20");
    else if (area.includes("manager")) fileList = run("find app/w -path '*/manager/*' -name '*.tsx' 2>/dev/null | head -20");
    else if (area.includes("test")) fileList = run("find tests -name '*.spec.ts' 2>/dev/null | head -20");
    else if (area.includes("api")) fileList = run("find app/api -name 'route.ts' 2>/dev/null | head -20");
    else fileList = run("git diff --name-only HEAD~3 2>/dev/null | head -15");

    const testFiles = run(`find tests -name '*.spec.ts' 2>/dev/null | grep -i '${area.split(" ")[0] || ""}' | head -10`);
    const pattern = area.includes("test")
      ? run("head -30 $(find tests -name '*.spec.ts' -maxdepth 4 2>/dev/null | head -1) 2>/dev/null || echo 'no pattern'")
      : run("head -30 $(find app/w -name 'page.tsx' -maxdepth 6 2>/dev/null | head -1) 2>/dev/null || echo 'no pattern'");

    return {
      content: [{ type: "text", text: `## Files in Target Area\n\`\`\`\n${fileList || "none found"}\n\`\`\`\n\n## Related Tests\n\`\`\`\n${testFiles || "none"}\n\`\`\`\n\n## Existing Pattern\n\`\`\`typescript\n${pattern}\n\`\`\`\n\n## Enriched Task\nOriginal: "${task_description}"\n\n- **Files**: ${fileList ? fileList.split("\n").slice(0, 5).join(", ") : "Specify exact files"}\n- **Pattern**: Follow existing pattern above\n- **Tests**: ${testFiles ? testFiles.split("\n").slice(0, 3).join(", ") : "Run relevant tests"}\n- **Scope**: Do NOT modify files outside target area\n- **Done when**: All relevant tests pass + \`pnpm tsc --noEmit\` clean` }],
    };
  }
);

// =============================================================================
// CATEGORY 7: checkpoint — Compaction Management
// =============================================================================

server.tool(
  "checkpoint",
  `Save a session checkpoint before context compaction hits. Commits current work, writes session state to workspace docs, and creates a resumption note. Call this proactively when session is getting long, or when the session-health hook warns about turn count. This is your "save game" before compaction wipes context.`,
  {
    summary: z.string().describe("What was accomplished so far in this session"),
    next_steps: z.string().describe("What still needs to be done"),
    current_blockers: z.string().optional().describe("Any issues or blockers encountered"),
  },
  async ({ summary, next_steps, current_blockers }) => {
    const branch = run("git branch --show-current");
    const dirty = run("git status --short");
    const lastCommit = run("git log --oneline -1");
    const timestamp = now();

    // Write checkpoint to persistent file
    const checkpointFile = join(PROJECT_DIR, ".claude", "last-checkpoint.md");
    const checkpointContent = `# Session Checkpoint
**Time**: ${timestamp}
**Branch**: ${branch}
**Last Commit**: ${lastCommit}

## Accomplished
${summary}

## Next Steps
${next_steps}

${current_blockers ? `## Blockers\n${current_blockers}\n` : ""}
## Uncommitted Work
\`\`\`
${dirty || "clean"}
\`\`\`
`;
    writeFileSync(checkpointFile, checkpointContent);

    // Also append to a running checkpoint log
    const logFile = join(STATE_DIR, "checkpoint-log.jsonl");
    appendFileSync(logFile, JSON.stringify({
      timestamp,
      branch,
      summary,
      next_steps,
      blockers: current_blockers || null,
      dirty_files: dirty ? dirty.split("\n").length : 0,
    }) + "\n");

    // Auto-commit if there are dirty files
    let commitResult = "no uncommitted changes";
    if (dirty) {
      commitResult = run('git add -A && git commit -m "checkpoint: session save before compaction" 2>&1 || echo "commit failed"');
    }

    return {
      content: [{
        type: "text",
        text: `## Checkpoint Saved ✅
**File**: .claude/last-checkpoint.md
**Branch**: ${branch}
**Commit**: ${commitResult}

### What's saved:
- Summary of work done
- Next steps for continuation
- Uncommitted files committed with checkpoint message

### To resume after compaction:
Tell the next session/continuation: "Read .claude/last-checkpoint.md for where I left off"

### Next: either continue working or start a fresh session.`,
      }],
    };
  }
);

// =============================================================================
// CATEGORY 8: check_session_health — Session Lifecycle
// =============================================================================

server.tool(
  "check_session_health",
  `Check session health and recommend whether to continue, checkpoint, or start fresh. Tracks session depth, uncommitted work, workspace staleness, and time since last commit. Call periodically during long sessions.`,
  {},
  async () => {
    const branch = run("git branch --show-current");
    const dirty = run("git status --short");
    const dirtyCount = dirty ? dirty.split("\n").length : 0;
    const lastCommit = run("git log --oneline -1");
    const lastCommitTime = run("git log -1 --format='%ci'");
    const uncommittedDiff = run("git diff --stat | tail -1");

    // Time since last commit
    const commitDate = new Date(lastCommitTime);
    const minutesSinceCommit = Math.round((Date.now() - commitDate.getTime()) / 60000);

    // Check for checkpoint
    const lastCheckpoint = readIfExists(".claude/last-checkpoint.md", 20);

    // Count workspace docs and their freshness
    const docs = findWorkspaceDocs();
    const staleThreshold = 2 * 60 * 60 * 1000; // 2 hours
    const staleDocs = Object.entries(docs)
      .filter(([, d]) => (Date.now() - d.mtime.getTime()) > staleThreshold)
      .map(([n]) => n);

    // Health score
    const issues = [];
    let severity = "healthy";

    if (dirtyCount > 15) { issues.push(`🚨 ${dirtyCount} uncommitted files — commit now`); severity = "critical"; }
    else if (dirtyCount > 5) { issues.push(`⚠️ ${dirtyCount} uncommitted files — consider committing`); severity = "warning"; }

    if (minutesSinceCommit > 120) { issues.push(`🚨 ${minutesSinceCommit}min since last commit — checkpoint immediately`); severity = "critical"; }
    else if (minutesSinceCommit > 60) { issues.push(`⚠️ ${minutesSinceCommit}min since last commit — commit soon`); if (severity !== "critical") severity = "warning"; }

    if (staleDocs.length > 3) { issues.push(`📝 ${staleDocs.length} workspace docs are >2h stale: ${staleDocs.slice(0, 3).join(", ")}`); }

    const recommendation = severity === "critical"
      ? "🚨 **STOP and checkpoint.** Run `checkpoint` tool now. Commit all work, save state, consider starting fresh."
      : severity === "warning"
        ? "⚠️ **Checkpoint soon.** Commit current batch, update workspace docs if needed."
        : "✅ **Session is healthy.** Continue working.";

    return {
      content: [{
        type: "text",
        text: `## Session Health Report

**Branch**: ${branch}
**Uncommitted**: ${dirtyCount} files
**Last commit**: ${lastCommit} (${minutesSinceCommit}min ago)
**Changes**: ${uncommittedDiff || "none"}
**Stale docs**: ${staleDocs.length > 0 ? staleDocs.join(", ") : "none"}
**Last checkpoint**: ${lastCheckpoint ? "exists" : "none"}

### Issues
${issues.length ? issues.join("\n") : "None — session is healthy"}

### Recommendation
${recommendation}`,
      }],
    };
  }
);

// =============================================================================
// CATEGORY 9: log_correction — Error Recovery
// =============================================================================

server.tool(
  "log_correction",
  `Log when the user corrected your action. Tracks error patterns over time to identify what kinds of prompts lead to wrong outputs. Call this whenever the user says "no", "wrong", "not that", "I meant", or otherwise corrects your work.`,
  {
    what_user_said: z.string().describe("The user's correction message"),
    what_you_did_wrong: z.string().describe("What you did that was incorrect"),
    root_cause: z.string().describe("Why — was it a vague prompt, stale context, wrong assumption, or something else?"),
    category: z.enum(["vague_prompt", "stale_context", "wrong_assumption", "wrong_file", "wrong_scope", "other"]).describe("Error category"),
  },
  async ({ what_user_said, what_you_did_wrong, root_cause, category }) => {
    const logFile = join(STATE_DIR, "corrections.jsonl");
    const entry = {
      timestamp: now(),
      branch: run("git branch --show-current"),
      user_said: what_user_said,
      wrong_action: what_you_did_wrong,
      root_cause,
      category,
    };
    appendFileSync(logFile, JSON.stringify(entry) + "\n");

    // Read recent corrections for pattern analysis
    let corrections = [];
    try {
      corrections = readFileSync(logFile, "utf-8").trim().split("\n").map(l => JSON.parse(l));
    } catch {}

    const categoryCounts = {};
    for (const c of corrections) {
      categoryCounts[c.category] = (categoryCounts[c.category] || 0) + 1;
    }

    const total = corrections.length;
    const topCategory = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0];

    return {
      content: [{
        type: "text",
        text: `## Correction Logged ✅

**Category**: ${category}
**Root cause**: ${root_cause}

### Error Pattern Summary (${total} total corrections)
${Object.entries(categoryCounts).map(([k, v]) => `- ${k}: ${v} (${Math.round(v / total * 100)}%)`).join("\n")}

### Most Common: ${topCategory ? `${topCategory[0]} (${topCategory[1]}x)` : "first correction"}

${topCategory?.[0] === "vague_prompt" ? "💡 Most errors come from vague prompts. The `clarify_intent` tool should be called more aggressively." : ""}
${topCategory?.[0] === "stale_context" ? "💡 Most errors from stale context. Call `checkpoint` more often and read workspace docs at session start." : ""}
${topCategory?.[0] === "wrong_file" ? "💡 Most errors from wrong files. Always verify file paths with `find` or `ls` before editing." : ""}`,
      }],
    };
  }
);

// =============================================================================
// CATEGORY 10: audit_workspace — Workspace Hygiene
// =============================================================================

server.tool(
  "audit_workspace",
  `Audit workspace documentation freshness vs actual project state. Compares .claude/ workspace docs against recent git commits to find stale or missing documentation. Call after completing a batch of work or at session end.`,
  {},
  async () => {
    const docs = findWorkspaceDocs();
    const recentFiles = run("git diff --name-only HEAD~10 2>/dev/null || echo ''").split("\n").filter(Boolean);
    const recentCommitMsgs = run("git log --oneline -10 2>/dev/null").split("\n");
    const branch = run("git branch --show-current");

    const sections = [];

    // Check each doc's freshness
    const docStatus = [];
    const now = Date.now();
    for (const [name, info] of Object.entries(docs)) {
      const ageHours = Math.round((now - info.mtime.getTime()) / 3600000);
      const stale = ageHours > 4;
      docStatus.push({
        name,
        ageHours,
        stale,
        size: info.size,
      });
    }

    sections.push(`## Workspace Doc Freshness\n| Doc | Age | Status |\n|-----|-----|--------|\n${docStatus.map(d =>
      `| .claude/${d.name} | ${d.ageHours}h | ${d.stale ? "🔴 STALE" : "🟢 Fresh"} |`
    ).join("\n")}`);

    // Check for recent work areas that lack docs
    const workAreas = new Set();
    for (const f of recentFiles) {
      if (f.startsWith("tests/")) workAreas.add("tests");
      if (f.startsWith("app/w/") && f.includes("admin")) workAreas.add("admin");
      if (f.startsWith("app/w/") && f.includes("manager")) workAreas.add("manager");
      if (f.startsWith("app/w/") && f.includes("participant")) workAreas.add("participant");
      if (f.startsWith("app/api/")) workAreas.add("api");
      if (f.includes("prisma")) workAreas.add("schema");
    }

    const docNames = Object.keys(docs).join(" ").toLowerCase();
    const undocumented = [...workAreas].filter(area => !docNames.includes(area));

    if (undocumented.length > 0) {
      sections.push(`## Undocumented Work Areas\nRecent commits touched these areas but no workspace docs cover them:\n${undocumented.map(a => `- ❌ **${a}** — no .claude/ doc found`).join("\n")}`);
    }

    // Check if gap trackers match reality
    const gapTracker = readIfExists(".claude/playwright-test-suite/GAP-TRACKER.md", 100);
    if (gapTracker) {
      const testFilesCount = parseInt(run("find tests -name '*.spec.ts' 2>/dev/null | wc -l").trim()) || 0;
      sections.push(`## Gap Tracker Check\nTest files on disk: ${testFilesCount}\nGap tracker last updated: ${docStatus.find(d => d.name.includes("GAP"))?.ageHours || "?"}h ago`);
    }

    const staleCount = docStatus.filter(d => d.stale).length;
    sections.push(`## Recommendation\n${staleCount > 0
      ? `⚠️ ${staleCount} docs are stale. Update them to reflect current state before ending this session.`
      : "✅ Workspace docs are fresh."
    }${undocumented.length > 0
      ? `\n⚠️ ${undocumented.length} work areas have no docs. Consider creating workspace docs for: ${undocumented.join(", ")}`
      : ""
    }`);

    return { content: [{ type: "text", text: sections.join("\n\n") }] };
  }
);

// =============================================================================
// CATEGORY 11: session_handoff — Cross-Session Continuity
// =============================================================================

server.tool(
  "session_handoff",
  `Generate a handoff brief for the next session. Reads last checkpoint, recent commits, open PRs, workspace state, and correction patterns to create a "here's where we are" document. Call at session end or when starting a new session to catch up on what happened.`,
  {
    direction: z.enum(["outgoing", "incoming"]).describe("'outgoing' = ending this session, 'incoming' = starting a new one"),
  },
  async ({ direction }) => {
    const branch = run("git branch --show-current");
    const sections = [];

    if (direction === "incoming") {
      // Starting new session — gather everything we need to know
      const lastCheckpoint = readIfExists(".claude/last-checkpoint.md", 50);
      const recentLog = run("git log --oneline -10");
      const dirty = run("git status --short");
      const openPRs = run("gh pr list --state open --json number,title,headRefName 2>/dev/null || echo '[]'");
      const corrections = loadState("corrections");

      sections.push(`## Session Handoff — INCOMING\n**Branch**: ${branch}\n**Time**: ${now()}`);

      if (lastCheckpoint) {
        sections.push(`## Last Checkpoint\n${lastCheckpoint}`);
      } else {
        sections.push(`## Last Checkpoint\nNone found. This may be the first session or checkpoints weren't saved.`);
      }

      sections.push(`## Recent Commits\n\`\`\`\n${recentLog}\n\`\`\``);

      if (dirty) {
        sections.push(`## Uncommitted Work\n\`\`\`\n${dirty}\n\`\`\``);
      }

      if (openPRs && openPRs !== "[]") {
        sections.push(`## Open PRs\n\`\`\`json\n${openPRs}\n\`\`\``);
      }

      // Workspace doc summary
      const docs = findWorkspaceDocs();
      const freshDocs = Object.entries(docs)
        .sort((a, b) => b[1].mtime.getTime() - a[1].mtime.getTime())
        .slice(0, 5);
      if (freshDocs.length > 0) {
        sections.push(`## Most Recently Updated Workspace Docs\n${freshDocs.map(([n, d]) =>
          `- .claude/${n} (updated ${Math.round((Date.now() - d.mtime.getTime()) / 3600000)}h ago)`
        ).join("\n")}`);
      }

      // Correction patterns from previous sessions
      const correctionFile = join(STATE_DIR, "corrections.jsonl");
      if (existsSync(correctionFile)) {
        try {
          const corr = readFileSync(correctionFile, "utf-8").trim().split("\n").map(l => JSON.parse(l));
          if (corr.length > 0) {
            const cats = {};
            for (const c of corr) cats[c.category] = (cats[c.category] || 0) + 1;
            sections.push(`## Known Error Patterns\n${Object.entries(cats).map(([k, v]) => `- ${k}: ${v}x`).join("\n")}\n\n**Watch out for these patterns.**`);
          }
        } catch {}
      }

      sections.push(`## Recommendation\n1. Read the last checkpoint to understand where previous session left off\n2. Check git status for uncommitted work\n3. Read the most recently updated workspace docs\n4. Start with a specific task — don't try to "continue where we left off" without reading state first`);

    } else {
      // Ending session — create handoff note
      const dirty = run("git status --short");
      const dirtyCount = dirty ? dirty.split("\n").length : 0;
      const recentLog = run("git log --oneline -5");

      sections.push(`## Session Handoff — OUTGOING\n**Branch**: ${branch}\n**Time**: ${now()}`);

      if (dirtyCount > 0) {
        sections.push(`## ⚠️ Uncommitted Work (${dirtyCount} files)\n\`\`\`\n${dirty}\n\`\`\`\n\n**Action**: Commit this work or it will be lost to the next session.`);
      }

      sections.push(`## Recent Commits This Session\n\`\`\`\n${recentLog}\n\`\`\``);

      // Prompt to checkpoint if not done
      const lastCheckpoint = readIfExists(".claude/last-checkpoint.md", 5);
      if (!lastCheckpoint || !lastCheckpoint.includes(new Date().toISOString().slice(0, 10))) {
        sections.push(`## ⚠️ No checkpoint today\nRun the \`checkpoint\` tool to save session state for the next session.`);
      }

      sections.push(`## Before ending:\n1. Commit all work\n2. Run \`checkpoint\` with summary + next steps\n3. Update any stale workspace docs (run \`audit_workspace\`)\n4. Push to remote`);
    }

    return { content: [{ type: "text", text: sections.join("\n\n") }] };
  }
);

// =============================================================================
// CATEGORY 11 (also): what_changed — Cross-Session Continuity
// =============================================================================

server.tool(
  "what_changed",
  `Summarize what changed recently. Useful after sub-agents finish, after a break, when context was compacted, or at the start of a new session. Returns diff summary with commit messages.`,
  {
    since: z.string().optional().describe("Git ref: 'HEAD~5', 'HEAD~3', etc. Default: HEAD~5"),
  },
  async ({ since }) => {
    const ref = since || "HEAD~5";
    const diffStat = run(`git diff ${ref} --stat 2>/dev/null || git diff HEAD~3 --stat`);
    const diffFiles = run(`git diff ${ref} --name-only 2>/dev/null || git diff HEAD~3 --name-only`);
    const log = run(`git log ${ref}..HEAD --oneline 2>/dev/null || git log -5 --oneline`);
    const branch = run("git branch --show-current");

    return {
      content: [{ type: "text", text: `## What Changed (since ${ref})\nBranch: ${branch}\n\n### Commits\n\`\`\`\n${log}\n\`\`\`\n\n### Files Changed\n\`\`\`\n${diffFiles}\n\`\`\`\n\n### Stats\n\`\`\`\n${diffStat}\n\`\`\`` }],
    };
  }
);

// =============================================================================
// CATEGORY 12: verify_completion — Result Verification
// =============================================================================

server.tool(
  "verify_completion",
  `Verify that work is actually complete before declaring done. Runs type check, relevant tests, checks for uncommitted files, and validates against the original task criteria. Call this BEFORE saying "done" or committing final work. Prevents the "ship it without testing" pattern.`,
  {
    task_description: z.string().describe("What was the task? Used to check if success criteria are met."),
    test_scope: z.string().optional().describe("Which tests to run: 'all', 'admin', 'participant', 'manager', specific spec file path. Default: relevant tests based on changed files."),
    skip_tests: z.boolean().optional().describe("Skip running tests (only check types + git state). Default: false."),
  },
  async ({ task_description, test_scope, skip_tests }) => {
    const sections = [];
    const checks = [];

    // 1. Type check
    const typeResult = run("pnpm tsc --noEmit 2>&1 | tail -5");
    const typeErrors = run("pnpm tsc --noEmit 2>&1 | grep -c 'error TS' || echo '0'");
    const typePassed = typeErrors === "0";
    checks.push({ name: "Type Check", passed: typePassed, detail: typePassed ? "✅ Clean" : `❌ ${typeErrors} errors\n${typeResult}` });

    // 2. Git state
    const dirty = run("git status --short");
    const dirtyCount = dirty ? dirty.split("\n").length : 0;
    checks.push({ name: "Git State", passed: true, detail: dirtyCount > 0 ? `${dirtyCount} uncommitted files:\n\`\`\`\n${dirty}\n\`\`\`` : "✅ Clean working tree" });

    // 3. Tests (unless skipped)
    if (!skip_tests) {
      const changedFiles = run("git diff --name-only HEAD~1 2>/dev/null").split("\n");
      let testCmd = "";

      if (test_scope && test_scope !== "all") {
        if (test_scope.endsWith(".spec.ts")) {
          testCmd = `npx playwright test ${test_scope} --reporter=line 2>&1 | tail -20`;
        } else {
          testCmd = `npx playwright test tests/functional/ui/**/${test_scope}/ --reporter=line 2>&1 | tail -20`;
        }
      } else if (changedFiles.some(f => f.includes("tests/"))) {
        // Run only changed test files
        const changedTests = changedFiles.filter(f => f.endsWith(".spec.ts")).slice(0, 5);
        if (changedTests.length > 0) {
          testCmd = `npx playwright test ${changedTests.join(" ")} --reporter=line 2>&1 | tail -20`;
        }
      }

      if (testCmd) {
        const testResult = run(testCmd, { timeout: 60000 });
        const testPassed = testResult.includes("passed") && !testResult.includes("failed");
        checks.push({ name: "Tests", passed: testPassed, detail: testPassed ? `✅ Tests passed\n${testResult}` : `❌ Tests failed\n${testResult}` });
      } else {
        checks.push({ name: "Tests", passed: true, detail: "⚠️ No relevant tests identified. Consider running full suite." });
      }
    }

    // 4. Build check (quick)
    const buildCheck = run("pnpm build 2>&1 | tail -5", { timeout: 30000 });
    const buildPassed = !buildCheck.includes("Error") && !buildCheck.includes("error");
    checks.push({ name: "Build", passed: buildPassed, detail: buildPassed ? "✅ Build succeeds" : `❌ Build failed\n${buildCheck}` });

    // Summary
    const allPassed = checks.every(c => c.passed);
    sections.push(`## Verification Report\n**Task**: ${task_description}\n\n${checks.map(c => `### ${c.name}\n${c.detail}`).join("\n\n")}`);

    sections.push(`## Verdict\n${allPassed
      ? "✅ **ALL CHECKS PASSED.** Safe to commit and declare done."
      : "❌ **CHECKS FAILED.** Fix the issues above before committing."
    }`);

    if (!allPassed) {
      sections.push(`## Do NOT:\n- Commit with failing checks\n- Say "done" without green tests\n- Push broken code to remote\n\n## DO:\n- Fix each failing check\n- Re-run \`verify_completion\` after fixes\n- Then commit`);
    }

    return { content: [{ type: "text", text: sections.join("\n\n") }] };
  }
);

// =============================================================================
// Start
// =============================================================================

const transport = new StdioServerTransport();
await server.connect(transport);
