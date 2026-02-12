import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadPatterns, matchPatterns, formatPatternMatches } from "../lib/patterns.js";

export function registerCheckPatterns(server: McpServer): void {
  server.tool(
    "check_patterns",
    "Check if the current prompt matches any learned correction patterns from past mistakes. Use this to avoid repeating known pitfalls.",
    {
      prompt: z.string().describe("The prompt to check against known patterns"),
    },
    async ({ prompt }) => {
      const patterns = loadPatterns();

      if (patterns.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: "✅ No correction patterns learned yet. Patterns are extracted automatically as corrections are logged.",
          }],
        };
      }

      const matches = matchPatterns(prompt, patterns);

      if (matches.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `✅ No known pitfalls matched. (${patterns.length} patterns tracked)`,
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: formatPatternMatches(matches),
        }],
      };
    },
  );
}
