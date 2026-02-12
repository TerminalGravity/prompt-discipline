import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run, getDiffFiles } from "../lib/git.js";
import { PROJECT_DIR } from "../lib/files.js";
import { getConfig, type RelatedProject } from "../lib/config.js";
import { existsSync, readFileSync } from "fs";
import { execFileSync } from "child_process";
import { join, basename } from "path";
import { createHash } from "crypto";

/** Sanitize user input for safe use in shell commands */
function shellEscape(s: string): string {
  return s.replace(/[^a-zA-Z0-9_\-./]/g, "");
}

/** Detect package manager from lockfiles */
function detectPackageManager(): string {
  if (existsSync(join(PROJECT_DIR, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(PROJECT_DIR, "yarn.lock"))) return "yarn";
  if (existsSync(join(PROJECT_DIR, "bun.lockb"))) return "bun";
  return "npm";
}

/** Find files in a target area using git-tracked files (project-agnostic) */
function findAreaFiles(area: string): string {
  if (!area) return getDiffFiles("HEAD~3");

  const safeArea = shellEscape(area);

  // If area looks like a path, search directly
  if (area.includes("/")) {
    return run(`git ls-files -- '${safeArea}*' 2>/dev/null | head -20`);
  }

  // Search for area keyword in git-tracked file paths
  const files = run(`git ls-files 2>/dev/null | grep -i '${safeArea}' | head -20`);
  if (files && !files.startsWith("[command failed")) return files;

  // Fallback to recently changed files
  return getDiffFiles("HEAD~3");
}

/** Find related test files for an area */
function findRelatedTests(area: string): string {
  if (!area) return run("git ls-files 2>/dev/null | grep -E '\\.(spec|test)\\.(ts|tsx|js|jsx)$' | head -10");

  const safeArea = shellEscape(area.split(/\s+/)[0]);
  const tests = run(`git ls-files 2>/dev/null | grep -E '\\.(spec|test)\\.(ts|tsx|js|jsx)$' | grep -i '${safeArea}' | head -10`);
  return tests || run("git ls-files 2>/dev/null | grep -E '\\.(spec|test)\\.(ts|tsx|js|jsx)$' | head -10");
}

/** Get an example pattern from the first matching file */
function getExamplePattern(files: string): string {
  const firstFile = files.split("\n").filter(Boolean)[0];
  if (!firstFile) return "no pattern available";
  return run(`head -30 '${shellEscape(firstFile)}' 2>/dev/null || echo 'could not read file'`);
}

// ---------------------------------------------------------------------------
// Cross-service awareness helpers
// ---------------------------------------------------------------------------

interface ContractEntry {
  name: string;
  kind: string;       // e.g. "interface", "enum", "function", "type"
  file: string;
  summary?: string;
}

interface ContractFile {
  entries?: ContractEntry[];
}

/** Extract meaningful keywords from a task description */
function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "must", "to", "of",
    "in", "for", "on", "with", "at", "by", "from", "as", "into", "about",
    "that", "this", "it", "and", "or", "but", "not", "if", "then", "else",
    "when", "up", "out", "so", "no", "all", "any", "each", "every",
    "add", "create", "update", "delete", "remove", "fix", "implement",
    "make", "change", "modify", "file", "files", "code", "test", "tests",
  ]);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
}

/** Hash a project path the same way preflight indexes projects */
function projectHash(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, 12);
}

/** Load contracts for a project if they exist */
function loadContracts(projectPath: string): ContractEntry[] {
  const hash = projectHash(projectPath);
  const homedir = process.env.HOME || process.env.USERPROFILE || "";
  const contractsPath = join(homedir, ".preflight", "projects", hash, "contracts.json");
  if (!existsSync(contractsPath)) return [];
  try {
    const data = JSON.parse(readFileSync(contractsPath, "utf-8")) as ContractFile;
    return data.entries ?? [];
  } catch {
    return [];
  }
}

/** Search git-tracked files in a related project for keyword matches */
function searchRelatedProjectFiles(projectPath: string, keywords: string[]): string[] {
  if (!existsSync(projectPath)) return [];
  try {
    const allFiles = execFileSync("git", ["ls-files"], {
      cwd: projectPath,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!allFiles) return [];
    const fileList = allFiles.split("\n");
    const matches: string[] = [];
    for (const f of fileList) {
      const lower = f.toLowerCase();
      if (keywords.some(kw => lower.includes(kw))) {
        matches.push(f);
        if (matches.length >= 10) break;
      }
    }
    return matches;
  } catch {
    return [];
  }
}

/** Build cross-service context string for related projects */
function buildCrossServiceContext(taskDescription: string): string {
  let relatedProjects: RelatedProject[];
  try {
    relatedProjects = getConfig().related_projects;
  } catch {
    relatedProjects = [];
  }

  // Fallback to env var if no config-based projects
  if (relatedProjects.length === 0) {
    const envRelated = process.env.PREFLIGHT_RELATED;
    if (envRelated) {
      relatedProjects = envRelated
        .split(",")
        .map(p => p.trim())
        .filter(Boolean)
        .map(p => ({ path: p, alias: basename(p) }));
    }
  }

  if (relatedProjects.length === 0) return "";

  const keywords = extractKeywords(taskDescription);
  if (keywords.length === 0) return "";

  const sections: string[] = [];

  for (const project of relatedProjects) {
    const items: string[] = [];

    // Search contracts
    const contracts = loadContracts(project.path);
    for (const entry of contracts) {
      const nameLower = entry.name.toLowerCase();
      const fileLower = (entry.file || "").toLowerCase();
      const summaryLower = (entry.summary || "").toLowerCase();
      if (keywords.some(kw => nameLower.includes(kw) || fileLower.includes(kw) || summaryLower.includes(kw))) {
        const label = entry.kind ? `${entry.kind} ${entry.name}` : entry.name;
        items.push(`  - ${label}${entry.file ? ` (${entry.file})` : ""}`);
        if (items.length >= 8) break;
      }
    }

    // Search files
    const matchedFiles = searchRelatedProjectFiles(project.path, keywords);
    for (const f of matchedFiles) {
      const already = items.some(i => i.includes(f));
      if (!already) {
        items.push(`  - file: ${f}`);
        if (items.length >= 12) break;
      }
    }

    if (items.length > 0) {
      sections.push(`From ${project.alias}:\n${items.join("\n")}`);
    }
  }

  if (sections.length === 0) return "";
  return `\n\n📡 Cross-service context:\n${sections.join("\n\n")}`;
}

export function registerEnrichAgentTask(server: McpServer): void {
  server.tool(
    "enrich_agent_task",
    `Enrich a vague sub-agent task with project context. Call before spawning a Task/sub-agent to add file paths, patterns, scope boundaries, and done conditions.`,
    {
      task_description: z.string().describe("The raw task for the sub-agent"),
      target_area: z.string().optional().describe("Codebase area: directory path, keyword, or description like 'auth tests', 'api routes'"),
    },
    async ({ task_description, target_area }) => {
      const area = target_area || "";
      const pm = detectPackageManager();
      const fileList = findAreaFiles(area);
      const testFiles = findRelatedTests(area);
      const pattern = getExamplePattern(area.includes("test") ? testFiles : fileList);

      const crossServiceContext = buildCrossServiceContext(task_description);

      const fileSummary = fileList
        ? fileList.split("\n").filter(Boolean).slice(0, 5).join(", ")
        : "Specify exact files";
      const testSummary = testFiles
        ? testFiles.split("\n").filter(Boolean).slice(0, 3).join(", ")
        : "Run relevant tests";

      return {
        content: [{
          type: "text" as const,
          text: `## Files in Target Area
\`\`\`
${fileList || "none found — specify a more precise area"}
\`\`\`

## Related Tests
\`\`\`
${testFiles || "none"}
\`\`\`

## Existing Pattern
\`\`\`typescript
${pattern}
\`\`\`

## Enriched Task
Original: "${task_description}"

- **Files**: ${fileSummary}
- **Pattern**: Follow existing pattern above
- **Tests**: ${testSummary}
- **Scope**: Do NOT modify files outside target area
- **Done when**: All relevant tests pass + \`${pm} tsc --noEmit\` clean${crossServiceContext}`,
        }],
      };
    }
  );
}
