// =============================================================================
// estimate_cost — Estimate token usage and cost for a Claude Code session
// =============================================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { findSessionDirs, findSessionFiles } from "../lib/session-parser.js";

// ── Pricing (per 1M tokens) ────────────────────────────────────────────────

const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4": { input: 3.0, output: 15.0 },
  "claude-opus-4": { input: 15.0, output: 75.0 },
  "claude-haiku-3.5": { input: 0.8, output: 4.0 },
};

const DEFAULT_MODEL = "claude-sonnet-4";

const CORRECTION_SIGNALS = /\b(no[,.\s]|wrong|not that|i meant|actually|try again|revert|undo|that's not|not what i)\b/i;

const PREFLIGHT_TOOLS = new Set([
  "preflight_check",
  "clarify_intent",
  "scope_work",
  "sharpen_followup",
  "token_audit",
  "prompt_score",
]);

// ── Helpers ─────────────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n");
  }
  return "";
}

function extractToolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b: any) => b.type === "tool_use" && b.name)
    .map((b: any) => b.name as string);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCost(dollars: number): string {
  if (dollars < 0.01) return `<$0.01`;
  return `$${dollars.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hours}h ${rem}m`;
}

interface SessionAnalysis {
  inputTokens: number;
  outputTokens: number;
  promptCount: number;
  toolCallCount: number;
  corrections: number;
  wastedOutputTokens: number;
  preflightCalls: number;
  preflightTokens: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
}

function analyzeSessionFile(filePath: string): SessionAnalysis {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);

  const result: SessionAnalysis = {
    inputTokens: 0,
    outputTokens: 0,
    promptCount: 0,
    toolCallCount: 0,
    corrections: 0,
    wastedOutputTokens: 0,
    preflightCalls: 0,
    preflightTokens: 0,
    firstTimestamp: null,
    lastTimestamp: null,
  };

  let lastType = "";
  let lastAssistantTokens = 0;

  for (const line of lines) {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    // Track timestamps
    const ts = obj.timestamp;
    if (ts) {
      const tsStr = typeof ts === "string" ? ts : new Date(ts < 1e12 ? ts * 1000 : ts).toISOString();
      if (!result.firstTimestamp) result.firstTimestamp = tsStr;
      result.lastTimestamp = tsStr;
    }

    if (obj.type === "user") {
      const text = extractText(obj.message?.content);
      const tokens = estimateTokens(text);
      result.inputTokens += tokens;
      result.promptCount++;

      // Correction detection
      if (lastType === "assistant" && CORRECTION_SIGNALS.test(text)) {
        result.corrections++;
        result.wastedOutputTokens += lastAssistantTokens;
      }
      lastType = "user";
    } else if (obj.type === "assistant") {
      const msgContent = obj.message?.content;
      const text = extractText(msgContent);
      const tokens = estimateTokens(text);
      result.outputTokens += tokens;
      lastAssistantTokens = tokens;

      // Tool calls
      const toolNames = extractToolNames(msgContent);
      result.toolCallCount += toolNames.length;

      for (const name of toolNames) {
        if (PREFLIGHT_TOOLS.has(name)) {
          result.preflightCalls++;
          // Estimate tool call tokens (name + args)
          const toolBlocks = (msgContent as any[]).filter(
            (b: any) => b.type === "tool_use" && b.name === name,
          );
          for (const tb of toolBlocks) {
            result.preflightTokens += estimateTokens(
              JSON.stringify(tb.input ?? {}),
            );
          }
        }
      }
      lastType = "assistant";
    } else if (obj.type === "tool_result") {
      const text = extractText(obj.content);
      const tokens = estimateTokens(text);
      result.inputTokens += tokens;

      // Check if this is a preflight tool result
      if (obj.tool_use_id) {
        // We can't perfectly match tool_use_id to name, so count tokens as preflight
        // if they're small (typical preflight responses)
      }
    }
  }

  return result;
}

// ── Registration ────────────────────────────────────────────────────────────

export function registerEstimateCost(server: McpServer): void {
  server.tool(
    "estimate_cost",
    "Estimate token usage and cost for the current session. Shows waste from vague prompts and savings from preflight checks.",
    {
      session_dir: z
        .string()
        .optional()
        .describe("Path to session JSONL file (optional, uses latest if omitted)"),
      model: z
        .string()
        .optional()
        .describe(
          "Pricing model to use (claude-sonnet-4, claude-opus-4, claude-haiku-3.5). Default: claude-sonnet-4",
        ),
    },
    async ({ session_dir, model }) => {
      const pricingModel = model && PRICING[model] ? model : DEFAULT_MODEL;
      const pricing = PRICING[pricingModel]!;

      // Find session file
      let filePath: string;
      if (session_dir) {
        filePath = session_dir;
      } else {
        // Find latest session file
        const dirs = findSessionDirs();
        let latest: { path: string; mtime: Date } | null = null;
        for (const dir of dirs) {
          const files = findSessionFiles(dir.sessionDir);
          for (const f of files) {
            if (!latest || f.mtime > latest.mtime) {
              latest = f;
            }
          }
        }
        if (!latest) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No session files found in ~/.claude/projects/",
              },
            ],
          };
        }
        filePath = latest.path;
      }

      // Verify file exists
      try {
        statSync(filePath);
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: `Session file not found: ${filePath}`,
            },
          ],
        };
      }

      const analysis = analyzeSessionFile(filePath);
      const totalTokens = analysis.inputTokens + analysis.outputTokens;
      const inputCost = (analysis.inputTokens / 1_000_000) * pricing.input;
      const outputCost = (analysis.outputTokens / 1_000_000) * pricing.output;
      const totalCost = inputCost + outputCost;
      const wasteCost =
        (analysis.wastedOutputTokens / 1_000_000) * pricing.output;
      const wastePercent =
        totalCost > 0 ? ((wasteCost / totalCost) * 100).toFixed(1) : "0";

      // Duration
      let durationStr = "unknown";
      if (analysis.firstTimestamp && analysis.lastTimestamp) {
        const ms =
          new Date(analysis.lastTimestamp).getTime() -
          new Date(analysis.firstTimestamp).getTime();
        if (ms > 0) durationStr = formatDuration(ms);
      }

      // Preflight impact
      const preflightCost =
        (analysis.preflightTokens / 1_000_000) * pricing.input;
      // Estimate: each preflight check prevents ~0.5 corrections on average
      const estimatedPrevented = Math.round(analysis.preflightCalls * 0.5);
      // Average wasted tokens per correction
      const avgWastePerCorrection =
        analysis.corrections > 0
          ? analysis.wastedOutputTokens / analysis.corrections
          : 500;
      const estimatedSavingsTokens = estimatedPrevented * avgWastePerCorrection;
      const estimatedSavingsCost =
        (estimatedSavingsTokens / 1_000_000) * pricing.output;

      // Build report
      const lines: string[] = [
        `📊 Session Cost Estimate`,
        `━━━━━━━━━━━━━━━━━━━━━━`,
        `Duration: ${durationStr} | ${analysis.promptCount} prompts | ${analysis.toolCallCount} tool calls`,
        `File: ${basename(filePath)}`,
        ``,
        `Token Usage (estimated):`,
        `  Input:   ~${formatTokens(analysis.inputTokens)} tokens`,
        `  Output:  ~${formatTokens(analysis.outputTokens)} tokens`,
        `  Total:   ~${formatTokens(totalTokens)} tokens`,
        ``,
        `Estimated Cost: ~${formatCost(totalCost)} (${pricingModel.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())})`,
      ];

      if (analysis.corrections > 0) {
        lines.push(
          ``,
          `Waste Analysis:`,
          `  Corrections detected: ${analysis.corrections}`,
          `  Wasted output tokens: ~${formatTokens(analysis.wastedOutputTokens)}`,
          `  Estimated waste: ~${formatCost(wasteCost)} (${wastePercent}% of total)`,
        );
      } else {
        lines.push(``, `Waste Analysis:`, `  No corrections detected 🎯`);
      }

      if (analysis.preflightCalls > 0) {
        lines.push(
          ``,
          `Preflight Impact:`,
          `  Preflight checks: ${analysis.preflightCalls} calls (~${formatTokens(analysis.preflightTokens)} tokens)`,
          `  Preflight cost: ~${formatCost(preflightCost)}`,
        );
        if (estimatedPrevented > 0) {
          lines.push(
            `  Estimated corrections prevented: ${estimatedPrevented}`,
            `  Estimated savings: ~${formatCost(estimatedSavingsCost)}`,
            ``,
            `💡 Net benefit: preflight saved ~${formatCost(estimatedSavingsCost - preflightCost)} this session`,
          );
        }
      } else {
        lines.push(
          ``,
          `Preflight Impact:`,
          `  No preflight checks used this session`,
          `  💡 Tip: Use preflight_check to catch issues before they cost tokens`,
        );
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  );
}
