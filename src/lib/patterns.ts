/**
 * Correction pattern learning system.
 * Analyzes correction logs and extracts recurring patterns so preflight
 * can warn about known pitfalls before they happen again.
 */

import { readLog, saveState, loadState } from "./state.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface CorrectionPattern {
  id: string;
  pattern: string;
  keywords: string[];
  frequency: number;
  lastSeen: string;
  context: string;
  examples: string[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Extract meaningful keywords (3+ chars, lowercased, deduplicated). */
function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    "the", "and", "that", "this", "with", "for", "not", "but", "was", "are",
    "you", "your", "have", "has", "had", "been", "were", "will", "would",
    "could", "should", "can", "did", "does", "don", "isn", "isn't", "don't",
    "use", "used", "using", "from", "into", "about", "just", "wrong", "again",
    "said", "instead", "meant", "want", "wanted", "need", "like",
  ]);
  const words = text
    .replace(/[^a-zA-Z0-9_\-/.]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .map((w) => w.toLowerCase())
    .filter((w) => !stopWords.has(w));
  return [...new Set(words)];
}

/** Compute overlap ratio between two keyword sets. */
function keywordOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  const shared = a.filter((w) => setB.has(w)).length;
  return shared / Math.min(a.length, b.length);
}

// ── Core Functions ─────────────────────────────────────────────────────────

/**
 * Read correction log and extract recurring patterns.
 * Groups corrections by keyword similarity. If 2+ corrections share
 * enough keywords, creates a pattern.
 */
export function extractPatterns(): CorrectionPattern[] {
  const corrections = readLog("corrections.jsonl");
  if (corrections.length === 0) return [];

  // Build keyword index per correction
  const entries = corrections.map((c) => ({
    text: `${c.user_said || ""} ${c.wrong_action || ""} ${c.root_cause || ""}`,
    keywords: extractKeywords(
      `${c.user_said || ""} ${c.wrong_action || ""} ${c.root_cause || ""}`,
    ),
    timestamp: c.timestamp as string,
    userSaid: (c.user_said || "") as string,
  }));

  // Group by similarity (greedy clustering)
  const used = new Set<number>();
  const groups: number[][] = [];

  for (let i = 0; i < entries.length; i++) {
    if (used.has(i)) continue;
    const group = [i];
    used.add(i);
    for (let j = i + 1; j < entries.length; j++) {
      if (used.has(j)) continue;
      if (keywordOverlap(entries[i].keywords, entries[j].keywords) >= 0.3) {
        group.push(j);
        used.add(j);
      }
    }
    if (group.length >= 2) {
      groups.push(group);
    }
  }

  // Convert groups to patterns
  const patterns: CorrectionPattern[] = groups.map((group, idx) => {
    const groupEntries = group.map((i) => entries[i]);

    // Merge keywords, ranked by frequency
    const kwFreq: Record<string, number> = {};
    for (const e of groupEntries) {
      for (const kw of e.keywords) {
        kwFreq[kw] = (kwFreq[kw] || 0) + 1;
      }
    }
    const topKeywords = Object.entries(kwFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k]) => k);

    // Most recent timestamp
    const lastSeen = groupEntries
      .map((e) => e.timestamp)
      .filter(Boolean)
      .sort()
      .pop() || new Date().toISOString();

    // Examples (up to 3 user_said messages)
    const examples = groupEntries
      .map((e) => e.userSaid)
      .filter((s) => s.length > 0)
      .slice(0, 3);

    // Build human-readable pattern from top keywords
    const patternDesc = `Recurring correction: ${topKeywords.slice(0, 4).join(", ")}`;

    // Context from the most detailed correction
    const longestEntry = groupEntries.sort((a, b) => b.text.length - a.text.length)[0];
    const context = longestEntry.text.trim().slice(0, 300);

    return {
      id: `p${idx + 1}`,
      pattern: patternDesc,
      keywords: topKeywords,
      frequency: group.length,
      lastSeen,
      context,
      examples,
    };
  });

  return patterns.sort((a, b) => b.frequency - a.frequency);
}

/**
 * Check if a prompt matches any known patterns.
 * Returns patterns whose keywords overlap with the prompt.
 */
export function matchPatterns(
  prompt: string,
  patterns: CorrectionPattern[],
): CorrectionPattern[] {
  if (patterns.length === 0) return [];
  const promptKeywords = extractKeywords(prompt);
  const promptLower = prompt.toLowerCase();

  return patterns.filter((p) => {
    // Direct keyword match: at least 2 keywords present in prompt
    const hits = p.keywords.filter(
      (kw) => promptLower.includes(kw.toLowerCase()),
    );
    return hits.length >= 2;
  });
}

/** Save patterns to state. */
export function savePatterns(patterns: CorrectionPattern[]): void {
  saveState("patterns", { patterns, updated: new Date().toISOString() });
}

/** Load patterns from state. */
export function loadPatterns(): CorrectionPattern[] {
  const state = loadState("patterns");
  return (state.patterns as CorrectionPattern[]) || [];
}

/**
 * Re-extract patterns from corrections log and save them.
 * Returns the updated patterns.
 */
export function refreshPatterns(): CorrectionPattern[] {
  const patterns = extractPatterns();
  savePatterns(patterns);
  return patterns;
}

/**
 * Format matched patterns for display.
 */
export function formatPatternMatches(matches: CorrectionPattern[]): string {
  if (matches.length === 0) return "";

  const lines = ["⚠️ Known patterns matched:", ""];
  for (let i = 0; i < matches.length; i++) {
    const p = matches[i];
    const ago = formatTimeAgo(p.lastSeen);
    lines.push(`${i + 1}. "${p.pattern}" (corrected ${p.frequency}x)`);
    lines.push(`   Context: ${p.context.slice(0, 150)}`);
    lines.push(`   Last triggered: ${ago}`);
    lines.push("");
  }
  return lines.join("\n");
}

function formatTimeAgo(isoDate: string): string {
  try {
    const diff = Date.now() - new Date(isoDate).getTime();
    const days = Math.floor(diff / 86400000);
    if (days === 0) return "today";
    if (days === 1) return "yesterday";
    return `${days} days ago`;
  } catch {
    return "unknown";
  }
}
