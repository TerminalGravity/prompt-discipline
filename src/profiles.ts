// =============================================================================
// Profile system — controls which tools are registered
// =============================================================================
// minimal:  No vectors. Pure JSONL parsing + git state. ~5MB install.
// standard: Local embeddings (Xenova) + LanceDB. Auto-downloads model on
//           first use. Zero config. ~200MB after model download. DEFAULT.
// full:     Everything in standard + OpenAI option for higher quality embeddings.
// =============================================================================

export type Profile = "minimal" | "standard" | "full";

const MINIMAL_TOOLS = new Set([
  "clarify_intent",
  "check_session_health",
  "session_stats",
  "prompt_score",
]);

// Standard IS the default — includes embeddings + timeline.
// LanceDB is embedded (no server), Xenova downloads model silently on first use.
const STANDARD_TOOLS = new Set([
  // All 14 prompt discipline tools
  "scope_work",
  "clarify_intent",
  "enrich_agent_task",
  "sharpen_followup",
  "token_audit",
  "sequence_tasks",
  "checkpoint",
  "check_session_health",
  "log_correction",
  "audit_workspace",
  "session_handoff",
  "what_changed",
  "verify_completion",
  // Lightweight tools
  "session_stats",
  "prompt_score",
  "generate_scorecard",
  // Timeline tools — local embeddings, zero config
  "onboard_project",
  "search_history",
  "timeline_view",
  "scan_sessions",
]);

// Full = standard + OpenAI embedding option (needs API key)
// Identical tool set — the difference is config, not features.
const FULL_TOOLS = new Set([
  ...STANDARD_TOOLS,
]);

export function getProfile(): Profile {
  const env = process.env.PROMPT_DISCIPLINE_PROFILE?.toLowerCase();
  if (env === "minimal") return "minimal";
  if (env === "full") return "full";
  return "standard"; // default — includes everything with local embeddings
}

export function isToolEnabled(toolName: string): boolean {
  const profile = getProfile();
  switch (profile) {
    case "minimal":
      return MINIMAL_TOOLS.has(toolName);
    case "standard":
      return STANDARD_TOOLS.has(toolName);
    case "full":
      return FULL_TOOLS.has(toolName);
  }
}
