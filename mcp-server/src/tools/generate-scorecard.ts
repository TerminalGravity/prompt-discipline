// =============================================================================
// generate_scorecard — 12-category prompt discipline report cards (PDF/Markdown)
// =============================================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  findSessionDirs,
  findSessionFiles,
  parseSession,
  type TimelineEvent,
} from "../lib/session-parser.js";

// ── Types ──────────────────────────────────────────────────────────────────

interface CategoryScore {
  name: string;
  score: number;
  grade: string;
  evidence: string;
  examples?: { good?: string[]; bad?: string[] };
}

interface Scorecard {
  project: string;
  period: string;
  date: string;
  overall: number;
  overallGrade: string;
  categories: CategoryScore[];
  highlights: { best: CategoryScore; worst: CategoryScore };
}

// ── Grading ────────────────────────────────────────────────────────────────

function letterGrade(score: number): string {
  if (score >= 95) return "A+";
  if (score >= 90) return "A";
  if (score >= 85) return "A-";
  if (score >= 80) return "B+";
  if (score >= 75) return "B";
  if (score >= 70) return "B-";
  if (score >= 65) return "C+";
  if (score >= 60) return "C";
  if (score >= 55) return "C-";
  if (score >= 50) return "D";
  return "F";
}

function clamp(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

// ── Helpers ────────────────────────────────────────────────────────────────

const PATH_RE = /(?:\/[\w./-]+\.\w{1,6}|\b\w+\.\w{2,6}\b)/;
const FILE_EXT_RE = /\.\b(?:ts|tsx|js|jsx|py|rs|go|rb|java|c|cpp|h|css|scss|html|json|yaml|yml|toml|md|sql|sh)\b/;
const CORRECTION_PATTERNS = [/\bno\b/i, /\bwrong\b/i, /\bnot that\b/i, /\bi meant\b/i, /\bactually\b/i, /\binstead\b/i, /\bundo\b/i, /\brevert\b/i];

interface ParsedSession {
  id: string;
  events: TimelineEvent[];
  userMessages: TimelineEvent[];
  assistantMessages: TimelineEvent[];
  toolCalls: TimelineEvent[];
  corrections: TimelineEvent[];
  compactions: TimelineEvent[];
  commits: TimelineEvent[];
  subAgentSpawns: TimelineEvent[];
  durationMinutes: number;
}

function classifyEvents(events: TimelineEvent[]): ParsedSession {
  const userMessages = events.filter((e) => e.type === "user_prompt");
  const assistantMessages = events.filter((e) => e.type === "assistant_response");
  const toolCalls = events.filter((e) => e.type === "tool_call");
  const corrections = events.filter((e) => e.type === "correction");
  const compactions = events.filter((e) => e.type === "compaction");
  const commits = events.filter((e) => e.type === "git_commit");
  const subAgentSpawns = events.filter((e) => e.type === "sub_agent_spawn");

  let durationMinutes = 0;
  if (events.length >= 2) {
    const first = new Date(events[0].timestamp).getTime();
    const last = new Date(events[events.length - 1].timestamp).getTime();
    if (!isNaN(first) && !isNaN(last)) {
      durationMinutes = (last - first) / 60000;
    }
  }

  return {
    id: events[0]?.session_id ?? "unknown",
    events,
    userMessages,
    assistantMessages,
    toolCalls,
    corrections,
    compactions,
    commits,
    subAgentSpawns,
    durationMinutes,
  };
}

function hasFileRef(text: string): boolean {
  return PATH_RE.test(text) || FILE_EXT_RE.test(text);
}

function pct(num: number, den: number): number {
  return den === 0 ? 100 : Math.round((num / den) * 100);
}

// ── Scoring Functions ──────────────────────────────────────────────────────

function scorePlans(sessions: ParsedSession[]): CategoryScore {
  if (sessions.length === 0) return { name: "Plans", score: 75, grade: "B", evidence: "No sessions to analyze" };

  let planned = 0;
  for (const s of sessions) {
    const first3 = s.userMessages.slice(0, 3);
    const hasPlanning = first3.some((m) => m.content.length > 100 && hasFileRef(m.content));
    if (hasPlanning) planned++;
  }
  const score = clamp(pct(planned, sessions.length));
  return {
    name: "Plans",
    score,
    grade: letterGrade(score),
    evidence: `${planned}/${sessions.length} sessions began with file-specific planning prompts (>100 chars with file references).`,
  };
}

function scoreClarification(sessions: ParsedSession[]): CategoryScore {
  let specific = 0, total = 0;
  for (const s of sessions) {
    for (const m of s.userMessages) {
      total++;
      if (hasFileRef(m.content)) specific++;
    }
  }
  const score = clamp(pct(specific, total));
  return {
    name: "Clarification",
    score,
    grade: letterGrade(score),
    evidence: `${specific}/${total} user prompts contained file paths or specific identifiers.`,
  };
}

function scoreDelegation(sessions: ParsedSession[]): CategoryScore {
  let total = 0, quality = 0;
  for (const s of sessions) {
    for (const e of s.subAgentSpawns) {
      total++;
      if (e.content.length > 200) quality++;
    }
  }
  if (total === 0) return { name: "Delegation", score: 75, grade: "B", evidence: "No sub-agent spawns detected. Default score." };
  const score = clamp(pct(quality, total));
  return {
    name: "Delegation",
    score,
    grade: letterGrade(score),
    evidence: `${quality}/${total} sub-agent tasks had detailed descriptions (>200 chars).`,
  };
}

function scoreFollowUpSpecificity(sessions: ParsedSession[]): CategoryScore {
  let followUps = 0, specific = 0;
  const badExamples: string[] = [];
  const goodExamples: string[] = [];

  for (const s of sessions) {
    for (let i = 0; i < s.events.length; i++) {
      const ev = s.events[i];
      if (ev.type !== "user_prompt") continue;
      // Check if preceded by assistant
      const prev = s.events.slice(0, i).reverse().find((e) => e.type === "assistant_response" || e.type === "user_prompt");
      if (prev?.type !== "assistant_response") continue;

      followUps++;
      if (hasFileRef(ev.content) || ev.content.length >= 50) {
        specific++;
        if (goodExamples.length < 3 && hasFileRef(ev.content)) goodExamples.push(ev.content.slice(0, 120));
      } else {
        if (badExamples.length < 3) badExamples.push(ev.content.slice(0, 80));
      }
    }
  }
  const score = clamp(pct(specific, followUps));
  return {
    name: "Follow-up Specificity",
    score,
    grade: letterGrade(score),
    evidence: `${specific}/${followUps} follow-up prompts had specific file references or sufficient detail.`,
    examples: { good: goodExamples.length ? goodExamples : undefined, bad: badExamples.length ? badExamples : undefined },
  };
}

function scoreTokenEfficiency(sessions: ParsedSession[]): CategoryScore {
  let totalCalls = 0, totalFiles = 0;
  for (const s of sessions) {
    totalCalls += s.toolCalls.length;
    const files = new Set<string>();
    for (const tc of s.toolCalls) {
      const match = tc.content.match(/(?:file_path|path)["']?\s*[:=]\s*["']([^"']+)/);
      if (match) files.add(match[1]);
    }
    totalFiles += files.size || 1;
  }
  // Ratio: lower tool_calls per file = better. Ideal ~5-10 calls per file.
  const ratio = totalCalls / totalFiles;
  let score: number;
  if (ratio <= 5) score = 100;
  else if (ratio <= 10) score = 90;
  else if (ratio <= 20) score = 75;
  else if (ratio <= 40) score = 60;
  else score = 40;

  // Deduct for sessions with >200 tool calls
  const bloated = sessions.filter((s) => s.toolCalls.length > 200).length;
  if (bloated > 0) score = clamp(score - bloated * 10);

  return {
    name: "Token Efficiency",
    score: clamp(score),
    grade: letterGrade(clamp(score)),
    evidence: `${totalCalls} tool calls across ${totalFiles} unique files (ratio: ${ratio.toFixed(1)}). ${bloated} session(s) exceeded 200 tool calls.`,
  };
}

function scoreSequencing(sessions: ParsedSession[]): CategoryScore {
  let totalSwitches = 0, totalPrompts = 0;
  for (const s of sessions) {
    let lastArea = "";
    for (const m of s.userMessages) {
      totalPrompts++;
      const pathMatch = m.content.match(/(?:\/[\w./-]+)/);
      const area = pathMatch ? pathMatch[0].split("/").slice(0, -1).join("/") : "";
      if (area && lastArea && area !== lastArea) totalSwitches++;
      if (area) lastArea = area;
    }
  }
  // Fewer switches = better. Target: <10% switch rate
  const switchRate = totalPrompts > 0 ? totalSwitches / totalPrompts : 0;
  let score: number;
  if (switchRate <= 0.05) score = 100;
  else if (switchRate <= 0.1) score = 90;
  else if (switchRate <= 0.2) score = 75;
  else if (switchRate <= 0.35) score = 60;
  else score = 45;

  return {
    name: "Sequencing",
    score: clamp(score),
    grade: letterGrade(clamp(score)),
    evidence: `${totalSwitches} topic switches across ${totalPrompts} prompts (${(switchRate * 100).toFixed(0)}% switch rate).`,
  };
}

function scoreCompactionManagement(sessions: ParsedSession[]): CategoryScore {
  let totalCompactions = 0, covered = 0;
  for (const s of sessions) {
    if (s.compactions.length === 0) continue;
    for (const c of s.compactions) {
      totalCompactions++;
      const cIdx = s.events.indexOf(c);
      const nearby = s.events.slice(Math.max(0, cIdx - 10), cIdx);
      if (nearby.some((e) => e.type === "git_commit")) covered++;
    }
  }
  if (totalCompactions === 0) return { name: "Compaction Management", score: 100, grade: "A+", evidence: "No compactions needed — sessions stayed manageable." };
  const score = clamp(pct(covered, totalCompactions));
  return {
    name: "Compaction Management",
    score,
    grade: letterGrade(score),
    evidence: `${covered}/${totalCompactions} compactions were preceded by a commit within 10 messages.`,
  };
}

function scoreSessionLifecycle(sessions: ParsedSession[]): CategoryScore {
  if (sessions.length === 0) return { name: "Session Lifecycle", score: 75, grade: "B", evidence: "No sessions." };
  let good = 0;
  for (const s of sessions) {
    if (s.durationMinutes <= 0) { good++; continue; }
    if (s.durationMinutes > 180 && s.commits.length === 0) continue; // bad
    const commitInterval = s.commits.length > 0 ? s.durationMinutes / s.commits.length : s.durationMinutes;
    if (commitInterval <= 30) good++;
    else if (commitInterval <= 60) good += 0.5;
  }
  const score = clamp(pct(Math.round(good), sessions.length));
  return {
    name: "Session Lifecycle",
    score,
    grade: letterGrade(score),
    evidence: `${Math.round(good)}/${sessions.length} sessions had healthy commit frequency (every 15-30 min).`,
  };
}

function scoreErrorRecovery(sessions: ParsedSession[]): CategoryScore {
  let totalCorrections = 0, fastRecoveries = 0, totalMessages = 0;
  for (const s of sessions) {
    totalMessages += s.events.length;
    for (const c of s.corrections) {
      totalCorrections++;
      const cIdx = s.events.indexOf(c);
      const after = s.events.slice(cIdx + 1, cIdx + 3);
      if (after.some((e) => e.type === "tool_call" || e.type === "assistant_response")) fastRecoveries++;
    }
  }
  if (totalCorrections === 0) return { name: "Error Recovery", score: 95, grade: "A", evidence: "No corrections needed." };
  const correctionRate = totalMessages > 0 ? totalCorrections / totalMessages : 0;
  let score = clamp(100 - correctionRate * 500);
  if (totalCorrections > 0) {
    const recoveryBonus = pct(fastRecoveries, totalCorrections) * 0.2;
    score = clamp(score + recoveryBonus);
  }
  return {
    name: "Error Recovery",
    score,
    grade: letterGrade(score),
    evidence: `${totalCorrections} corrections (${(correctionRate * 100).toFixed(1)}% of messages). ${fastRecoveries} recovered within 2 messages.`,
  };
}

function scoreWorkspaceHygiene(sessions: ParsedSession[]): CategoryScore {
  let bonus = 0;
  for (const s of sessions) {
    const allContent = s.events.map((e) => e.content).join(" ");
    if (/\.claude\//.test(allContent) || /CLAUDE\.md/.test(allContent)) bonus++;
  }
  const score = clamp(75 + (bonus > 0 ? Math.min(bonus * 5, 20) : 0));
  return {
    name: "Workspace Hygiene",
    score,
    grade: letterGrade(score),
    evidence: `Default baseline 75. ${bonus} session(s) referenced .claude/ workspace docs (+bonus).`,
  };
}

function scoreCrossSessionContinuity(sessions: ParsedSession[]): CategoryScore {
  if (sessions.length === 0) return { name: "Cross-Session Continuity", score: 75, grade: "B", evidence: "No sessions." };
  let good = 0;
  for (const s of sessions) {
    const first3Tools = s.toolCalls.slice(0, 3);
    const readsContext = first3Tools.some((tc) =>
      /CLAUDE\.md|\.claude\/|checkpoint|context|README/i.test(tc.content)
    );
    if (readsContext) good++;
  }
  const score = clamp(pct(good, sessions.length));
  return {
    name: "Cross-Session Continuity",
    score,
    grade: letterGrade(score),
    evidence: `${good}/${sessions.length} sessions started by reading project context docs.`,
  };
}

function scoreVerification(sessions: ParsedSession[]): CategoryScore {
  if (sessions.length === 0) return { name: "Verification", score: 75, grade: "B", evidence: "No sessions." };
  let verified = 0;
  for (const s of sessions) {
    const totalEvents = s.events.length;
    const tail = s.events.slice(Math.max(0, Math.floor(totalEvents * 0.9)));
    const hasVerification = tail.some((e) =>
      e.type === "tool_call" && /test|build|lint|check|verify|jest|vitest|pytest|cargo.test/i.test(e.content)
    );
    if (hasVerification) verified++;
  }
  const score = clamp(pct(verified, sessions.length));
  return {
    name: "Verification",
    score,
    grade: letterGrade(score),
    evidence: `${verified}/${sessions.length} sessions ran tests/builds in the final 10% of events.`,
  };
}

// ── Main Scoring ───────────────────────────────────────────────────────────

function computeScorecard(
  sessions: ParsedSession[],
  project: string,
  period: string,
): Scorecard {
  const categories: CategoryScore[] = [
    scorePlans(sessions),
    scoreClarification(sessions),
    scoreDelegation(sessions),
    scoreFollowUpSpecificity(sessions),
    scoreTokenEfficiency(sessions),
    scoreSequencing(sessions),
    scoreCompactionManagement(sessions),
    scoreSessionLifecycle(sessions),
    scoreErrorRecovery(sessions),
    scoreWorkspaceHygiene(sessions),
    scoreCrossSessionContinuity(sessions),
    scoreVerification(sessions),
  ];

  const overall = clamp(Math.round(categories.reduce((s, c) => s + c.score, 0) / categories.length));
  const sorted = [...categories].sort((a, b) => b.score - a.score);

  return {
    project,
    period,
    date: new Date().toISOString().slice(0, 10),
    overall,
    overallGrade: letterGrade(overall),
    categories,
    highlights: { best: sorted[0], worst: sorted[sorted.length - 1] },
  };
}

// ── Markdown Output ────────────────────────────────────────────────────────

function toMarkdown(sc: Scorecard): string {
  const lines: string[] = [];
  lines.push(`# 📊 Prompt Discipline Scorecard`);
  lines.push(`**Project:** ${sc.project} | **Period:** ${sc.period} (${sc.date}) | **Overall: ${sc.overallGrade} (${sc.overall}/100)**\n`);

  lines.push(`## Category Scores`);
  lines.push(`| # | Category | Score | Grade |`);
  lines.push(`|---|----------|-------|-------|`);
  sc.categories.forEach((c, i) => {
    lines.push(`| ${i + 1} | ${c.name} | ${c.score} | ${c.grade} |`);
  });

  lines.push(`\n## Highlights`);
  lines.push(`- 🏆 **Best:** ${sc.highlights.best.name} (${sc.highlights.best.grade}) — ${sc.highlights.best.evidence}`);
  lines.push(`- ⚠️ **Worst:** ${sc.highlights.worst.name} (${sc.highlights.worst.grade}) — ${sc.highlights.worst.evidence}`);

  lines.push(`\n## Detailed Breakdown`);
  sc.categories.forEach((c, i) => {
    lines.push(`\n### ${i + 1}. ${c.name} — ${c.grade} (${c.score}/100)`);
    lines.push(`Evidence: ${c.evidence}`);
    if (c.examples?.bad?.length) {
      lines.push(`\nExamples of vague follow-ups:`);
      c.examples.bad.forEach((e) => lines.push(`- ❌ "${e}"`));
    }
    if (c.examples?.good?.length) {
      lines.push(`\nExamples of specific follow-ups:`);
      c.examples.good.forEach((e) => lines.push(`- ✅ "${e}"`));
    }
  });

  return lines.join("\n");
}

// ── HTML / PDF Output ──────────────────────────────────────────────────────

function gradeColor(grade: string): string {
  if (grade.startsWith("A")) return "#22c55e";
  if (grade.startsWith("B")) return "#eab308";
  if (grade.startsWith("C")) return "#f97316";
  return "#ef4444";
}

function generateRadarSVG(categories: CategoryScore[]): string {
  const cx = 200, cy = 200, r = 150;
  const n = categories.length;
  const points = categories.map((c, i) => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    const dist = (c.score / 100) * r;
    return { x: cx + dist * Math.cos(angle), y: cy + dist * Math.sin(angle) };
  });
  const gridLines = [0.25, 0.5, 0.75, 1].map((f) => {
    const gr = r * f;
    const pts = Array.from({ length: n }, (_, i) => {
      const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
      return `${cx + gr * Math.cos(angle)},${cy + gr * Math.sin(angle)}`;
    }).join(" ");
    return `<polygon points="${pts}" fill="none" stroke="#e5e7eb" stroke-width="1"/>`;
  }).join("");

  const labels = categories.map((c, i) => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    const lx = cx + (r + 30) * Math.cos(angle);
    const ly = cy + (r + 30) * Math.sin(angle);
    const anchor = Math.abs(angle) < 0.1 || Math.abs(angle - Math.PI) < 0.1 ? "middle" : angle > -Math.PI / 2 && angle < Math.PI / 2 ? "start" : "end";
    return `<text x="${lx}" y="${ly}" text-anchor="${anchor}" font-size="10" fill="#6b7280">${c.name.slice(0, 12)}</text>`;
  }).join("");

  const polygon = points.map((p) => `${p.x},${p.y}`).join(" ");

  return `<svg viewBox="0 0 400 400" width="400" height="400" xmlns="http://www.w3.org/2000/svg">
    ${gridLines}
    <polygon points="${polygon}" fill="rgba(59,130,246,0.2)" stroke="#3b82f6" stroke-width="2"/>
    ${points.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="4" fill="#3b82f6"/>`).join("")}
    ${labels}
  </svg>`;
}

function toHTML(sc: Scorecard): string {
  const radar = generateRadarSVG(sc.categories);
  const rows = sc.categories.map((c, i) => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb">${i + 1}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;font-weight:600">${c.name}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:center">${c.score}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:center">
        <span style="background:${gradeColor(c.grade)};color:white;padding:2px 8px;border-radius:4px;font-weight:700">${c.grade}</span>
      </td>
    </tr>`).join("");

  const details = sc.categories.map((c, i) => {
    let html = `<div style="margin-bottom:16px"><h3 style="margin:0 0 4px">${i + 1}. ${c.name} — <span style="color:${gradeColor(c.grade)}">${c.grade}</span> (${c.score}/100)</h3><p style="color:#6b7280;margin:0">${c.evidence}</p>`;
    if (c.examples?.bad?.length) {
      html += `<div style="margin-top:6px">${c.examples.bad.map((e) => `<div style="color:#ef4444;font-size:13px">❌ "${e}"</div>`).join("")}</div>`;
    }
    if (c.examples?.good?.length) {
      html += `<div style="margin-top:4px">${c.examples.good.map((e) => `<div style="color:#22c55e;font-size:13px">✅ "${e}"</div>`).join("")}</div>`;
    }
    return html + `</div>`;
  }).join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;color:#1f2937">
  <div style="background:linear-gradient(135deg,#1e293b,#0f172a);color:white;padding:32px 40px;display:flex;align-items:center;justify-content:space-between">
    <div>
      <h1 style="margin:0;font-size:28px">📊 Prompt Discipline Scorecard</h1>
      <p style="margin:8px 0 0;opacity:0.8">Project: <strong>${sc.project}</strong> | Period: ${sc.period} | ${sc.date}</p>
    </div>
    <div style="width:100px;height:100px;border-radius:50%;background:${gradeColor(sc.overallGrade)};display:flex;align-items:center;justify-content:center;flex-direction:column">
      <div style="font-size:28px;font-weight:800;line-height:1">${sc.overallGrade}</div>
      <div style="font-size:14px;opacity:0.9">${sc.overall}/100</div>
    </div>
  </div>
  <div style="padding:32px 40px;display:flex;gap:40px;flex-wrap:wrap">
    <div style="flex:1;min-width:300px">
      <h2 style="margin:0 0 12px">Category Scores</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead><tr style="background:#f9fafb"><th style="padding:8px;text-align:left">#</th><th style="padding:8px;text-align:left">Category</th><th style="padding:8px;text-align:center">Score</th><th style="padding:8px;text-align:center">Grade</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="flex:0 0 auto">${radar}</div>
  </div>
  <div style="padding:0 40px 20px">
    <div style="background:#f0fdf4;border-left:4px solid #22c55e;padding:12px 16px;margin-bottom:8px;border-radius:4px">🏆 <strong>Best:</strong> ${sc.highlights.best.name} (${sc.highlights.best.grade}) — ${sc.highlights.best.evidence}</div>
    <div style="background:#fef2f2;border-left:4px solid #ef4444;padding:12px 16px;border-radius:4px">⚠️ <strong>Needs work:</strong> ${sc.highlights.worst.name} (${sc.highlights.worst.grade}) — ${sc.highlights.worst.evidence}</div>
  </div>
  <div style="padding:20px 40px 40px">
    <h2 style="margin:0 0 16px">Detailed Breakdown</h2>
    ${details}
  </div>
</body></html>`;
}

async function generatePDF(html: string, outputPath: string): Promise<void> {
  const { chromium } = await import("playwright" as string) as any;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.pdf({
    path: outputPath,
    format: "A4",
    margin: { top: "1cm", bottom: "1cm", left: "1cm", right: "1cm" },
  });
  await browser.close();
}

// ── Session Loading ────────────────────────────────────────────────────────

function loadSessions(opts: {
  project?: string;
  sessionId?: string;
  since?: string;
  period: string;
}): ParsedSession[] {
  const dirs = findSessionDirs();
  let targetDirs = dirs;

  if (opts.project) {
    targetDirs = dirs.filter((d) =>
      d.projectName.toLowerCase().includes(opts.project!.toLowerCase()) ||
      d.project.toLowerCase().includes(opts.project!.toLowerCase())
    );
  }

  // Determine time filter
  let sinceDate: Date | null = null;
  if (opts.since) {
    const relMatch = opts.since.match(/^(\d+)\s*days?$/i);
    if (relMatch) {
      sinceDate = new Date(Date.now() - parseInt(relMatch[1]) * 86400000);
    } else {
      sinceDate = new Date(opts.since);
    }
  } else {
    const now = new Date();
    switch (opts.period) {
      case "day": sinceDate = new Date(now.getTime() - 86400000); break;
      case "week": sinceDate = new Date(now.getTime() - 7 * 86400000); break;
      case "month": sinceDate = new Date(now.getTime() - 30 * 86400000); break;
    }
  }

  const sessions: ParsedSession[] = [];

  for (const dir of targetDirs) {
    const files = findSessionFiles(dir.sessionDir);
    for (const f of files) {
      if (opts.sessionId && f.sessionId !== opts.sessionId) continue;
      if (sinceDate && f.mtime < sinceDate) continue;

      try {
        const events = parseSession(f.path, dir.project, dir.projectName);
        if (events.length > 0) {
          sessions.push(classifyEvents(events));
        }
      } catch {
        // Skip unparseable files
      }
    }
  }

  return sessions;
}

// ── Tool Registration ──────────────────────────────────────────────────────

export function registerGenerateScorecard(server: McpServer): void {
  server.tool(
    "generate_scorecard",
    "Generate a prompt discipline scorecard analyzing sessions across 12 categories. Produces markdown or PDF report cards with per-category scores, letter grades, and evidence.",
    {
      project: z.string().optional().describe("Project name to score. If omitted, scores current project."),
      period: z.enum(["session", "day", "week", "month"]).default("day"),
      session_id: z.string().optional().describe("Score a specific session by ID"),
      since: z.string().optional().describe("Start date (ISO or relative like '7days')"),
      output: z.enum(["pdf", "markdown"]).default("markdown"),
      output_path: z.string().optional().describe("Where to save PDF. Default: /tmp/scorecard-{date}.pdf"),
    },
    async (params) => {
      const sessions = loadSessions({
        project: params.project,
        sessionId: params.session_id,
        since: params.since,
        period: params.period,
      });

      if (sessions.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No sessions found matching the criteria. Try broadening the time period or checking the project name." }],
        };
      }

      const projectName = params.project ?? sessions[0]?.events[0]?.project_name ?? "unknown";
      const scorecard = computeScorecard(sessions, projectName, params.period);

      if (params.output === "pdf") {
        const html = toHTML(scorecard);
        const outputPath = params.output_path ?? `/tmp/scorecard-${scorecard.date}.pdf`;
        try {
          await generatePDF(html, outputPath);
          return {
            content: [{ type: "text" as const, text: `✅ PDF scorecard saved to ${outputPath}\n\n${toMarkdown(scorecard)}` }],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `⚠️ PDF generation failed (${err}). Falling back to markdown:\n\n${toMarkdown(scorecard)}` }],
          };
        }
      }

      return {
        content: [{ type: "text" as const, text: toMarkdown(scorecard) }],
      };
    },
  );
}
