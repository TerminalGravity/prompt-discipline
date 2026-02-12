// =============================================================================
// Cross-Service Contract Registry
// =============================================================================
// Extracts, stores, and searches API contracts, types, and schemas
// across projects for fast cross-service context lookups.
// =============================================================================

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, resolve, relative, basename, extname } from "path";
import { createHash } from "crypto";
import { homedir } from "os";
import { load as yamlLoad } from "js-yaml";

// --- Types ---

export interface Contract {
  name: string;
  kind: "interface" | "type" | "enum" | "route" | "schema" | "event" | "model";
  file: string;
  definition: string;
  project: string;
  extractedAt: string;
}

interface ManualContractField {
  name: string;
  type: string;
  required?: boolean;
}

interface ManualContractEntry {
  name: string;
  kind: string;
  fields?: ManualContractField[];
  description?: string;
}

// --- Helpers ---

const PREFLIGHT_DIR = join(homedir(), ".preflight");
const PROJECTS_DIR = join(PREFLIGHT_DIR, "projects");

function hashProjectDir(projectDir: string): string {
  return createHash("sha256").update(resolve(projectDir)).digest("hex").slice(0, 12);
}

function contractsPath(projectHash: string): string {
  return join(PROJECTS_DIR, projectHash, "contracts.json");
}

// --- File Discovery ---

/** Recursively find files matching patterns, skipping node_modules/.git/dist */
function findFiles(dir: string, patterns: RegExp[], maxDepth = 8, depth = 0): string[] {
  if (depth > maxDepth) return [];
  const results: string[] = [];
  
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === ".next" || entry === "build") continue;
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    
    if (st.isDirectory()) {
      results.push(...findFiles(full, patterns, maxDepth, depth + 1));
    } else if (patterns.some(p => p.test(full))) {
      results.push(full);
    }
  }
  return results;
}

// --- Extraction ---

const TS_CONTRACT_PATTERNS: RegExp[] = [
  // types.ts, types/*.ts, interfaces.ts, *.d.ts
  /\/types\.ts$/, /\/types\/[^/]+\.ts$/, /\/interfaces\.ts$/, /\.d\.ts$/,
  // API routes
  /\/api\/.*\.ts$/, /\/routes\/.*\.ts$/,
  // Event schemas
  /\/events\/.*\.ts$/, /\/schemas\/.*\.ts$/,
];

const PRISMA_PATTERN = /prisma\/schema\.prisma$/;
const OPENAPI_PATTERN = /\/(openapi\.ya?ml|swagger\.json)$/;

/** Extract TypeScript interfaces, types, and enums from source */
function extractTsContracts(content: string, filePath: string, projectDir: string): Contract[] {
  const contracts: Contract[] = [];
  const relPath = relative(projectDir, filePath);
  const now = new Date().toISOString();

  // Match: export interface Foo { ... }
  const interfaceRe = /export\s+interface\s+(\w+)(?:\s+extends\s+[^{]+)?\s*\{[^}]*(?:\{[^}]*\}[^}]*)*\}/g;
  for (const m of content.matchAll(interfaceRe)) {
    contracts.push({ name: m[1], kind: "interface", file: relPath, definition: m[0].slice(0, 500), project: projectDir, extractedAt: now });
  }

  // Match: export type Foo = ...
  const typeRe = /export\s+type\s+(\w+)\s*(?:<[^>]*>)?\s*=[^;]+;/g;
  for (const m of content.matchAll(typeRe)) {
    contracts.push({ name: m[1], kind: "type", file: relPath, definition: m[0].slice(0, 500), project: projectDir, extractedAt: now });
  }

  // Match: export enum Foo { ... }
  const enumRe = /export\s+enum\s+(\w+)\s*\{[^}]*\}/g;
  for (const m of content.matchAll(enumRe)) {
    contracts.push({ name: m[1], kind: "enum", file: relPath, definition: m[0].slice(0, 500), project: projectDir, extractedAt: now });
  }

  // Detect route definitions (Next.js/Express patterns)
  const isRouteFile = /\/(api|routes)\//.test(filePath);
  if (isRouteFile) {
    // export async function GET/POST/PUT/DELETE/PATCH
    const routeRe = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|handler)\b[^{]*\{/g;
    for (const m of content.matchAll(routeRe)) {
      const routeName = `${m[1]} ${relPath.replace(/\.(ts|js)$/, "")}`;
      const defStart = m.index!;
      contracts.push({ name: routeName, kind: "route", file: relPath, definition: content.slice(defStart, defStart + 500), project: projectDir, extractedAt: now });
    }
    // router.get/post/put/delete
    const expressRe = /router\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g;
    for (const m of content.matchAll(expressRe)) {
      contracts.push({ name: `${m[1].toUpperCase()} ${m[2]}`, kind: "route", file: relPath, definition: m[0].slice(0, 500), project: projectDir, extractedAt: now });
    }
  }

  return contracts;
}

/** Extract Prisma models */
function extractPrismaContracts(content: string, filePath: string, projectDir: string): Contract[] {
  const contracts: Contract[] = [];
  const relPath = relative(projectDir, filePath);
  const now = new Date().toISOString();

  const modelRe = /model\s+(\w+)\s*\{[^}]*\}/g;
  for (const m of content.matchAll(modelRe)) {
    contracts.push({ name: m[1], kind: "model", file: relPath, definition: m[0].slice(0, 500), project: projectDir, extractedAt: now });
  }

  const enumRe = /enum\s+(\w+)\s*\{[^}]*\}/g;
  for (const m of content.matchAll(enumRe)) {
    contracts.push({ name: m[1], kind: "enum", file: relPath, definition: m[0].slice(0, 500), project: projectDir, extractedAt: now });
  }

  return contracts;
}

/** Extract from OpenAPI/Swagger specs */
function extractOpenApiContracts(content: string, filePath: string, projectDir: string): Contract[] {
  const contracts: Contract[] = [];
  const relPath = relative(projectDir, filePath);
  const now = new Date().toISOString();

  try {
    const spec = filePath.endsWith(".json") ? JSON.parse(content) : yamlLoad(content) as any;
    if (spec?.paths) {
      for (const [path, methods] of Object.entries(spec.paths as Record<string, any>)) {
        for (const method of Object.keys(methods)) {
          if (["get", "post", "put", "delete", "patch"].includes(method)) {
            const op = methods[method];
            const name = `${method.toUpperCase()} ${path}`;
            const def = JSON.stringify({ summary: op.summary, parameters: op.parameters, requestBody: op.requestBody }, null, 2);
            contracts.push({ name, kind: "route", file: relPath, definition: def.slice(0, 500), project: projectDir, extractedAt: now });
          }
        }
      }
    }
    if (spec?.components?.schemas) {
      for (const [name, schema] of Object.entries(spec.components.schemas)) {
        contracts.push({ name, kind: "schema", file: relPath, definition: JSON.stringify(schema, null, 2).slice(0, 500), project: projectDir, extractedAt: now });
      }
    }
  } catch {
    // Invalid spec, skip
  }

  return contracts;
}

// --- Public API ---

/** Scan a project directory and extract all contracts */
export function extractContracts(projectDir: string): Contract[] {
  const absDir = resolve(projectDir);
  const contracts: Contract[] = [];

  // TypeScript files
  const tsFiles = findFiles(absDir, TS_CONTRACT_PATTERNS);
  for (const file of tsFiles) {
    try {
      const content = readFileSync(file, "utf-8");
      contracts.push(...extractTsContracts(content, file, absDir));
    } catch { /* skip unreadable */ }
  }

  // Prisma
  const prismaFiles = findFiles(absDir, [PRISMA_PATTERN], 3);
  for (const file of prismaFiles) {
    try {
      const content = readFileSync(file, "utf-8");
      contracts.push(...extractPrismaContracts(content, file, absDir));
    } catch { /* skip */ }
  }

  // OpenAPI
  const openApiFiles = findFiles(absDir, [OPENAPI_PATTERN], 5);
  for (const file of openApiFiles) {
    try {
      const content = readFileSync(file, "utf-8");
      contracts.push(...extractOpenApiContracts(content, file, absDir));
    } catch { /* skip */ }
  }

  return contracts;
}

/** Load manual contract definitions from .preflight/contracts/ */
export function loadManualContracts(projectDir: string): Contract[] {
  const contractsDir = join(projectDir, ".preflight", "contracts");
  if (!existsSync(contractsDir)) return [];

  const contracts: Contract[] = [];
  const now = new Date().toISOString();

  let entries: string[];
  try { entries = readdirSync(contractsDir); } catch { return []; }

  for (const entry of entries) {
    if (![".yml", ".yaml"].includes(extname(entry))) continue;
    const filePath = join(contractsDir, entry);
    try {
      const content = readFileSync(filePath, "utf-8");
      const items = yamlLoad(content) as ManualContractEntry[];
      if (!Array.isArray(items)) continue;

      for (const item of items) {
        if (!item.name || !item.kind) continue;
        const def = item.fields
          ? `${item.description || ""}\nFields: ${item.fields.map(f => `${f.name}: ${f.type}${f.required ? " (required)" : ""}`).join(", ")}`
          : item.description || "";
        contracts.push({
          name: item.name,
          kind: item.kind as Contract["kind"],
          file: `.preflight/contracts/${entry}`,
          definition: def.trim().slice(0, 500),
          project: resolve(projectDir),
          extractedAt: now,
        });
      }
    } catch { /* skip invalid */ }
  }

  return contracts;
}

/** Load stored contracts for a project */
export function loadContracts(projectHash: string): Contract[] {
  const p = contractsPath(projectHash);
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return [];
  }
}

/** Save contracts to storage */
export function saveContracts(projectHash: string, contracts: Contract[]): void {
  const dir = join(PROJECTS_DIR, projectHash);
  mkdirSync(dir, { recursive: true });
  writeFileSync(contractsPath(projectHash), JSON.stringify(contracts, null, 2));
}

/** Search contracts by query string (simple relevance scoring) */
export function searchContracts(query: string, contracts: Contract[]): Contract[] {
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  if (terms.length === 0) return contracts;

  const scored = contracts.map(c => {
    const nameL = c.name.toLowerCase();
    const defL = c.definition.toLowerCase();
    const fileL = c.file.toLowerCase();
    let score = 0;

    for (const term of terms) {
      // Exact name match is highest
      if (nameL === term) score += 10;
      // Name contains term
      else if (nameL.includes(term)) score += 5;
      // File contains term
      if (fileL.includes(term)) score += 2;
      // Definition contains term
      if (defL.includes(term)) score += 1;
    }

    return { contract: c, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(s => s.contract);
}

/** Extract and save contracts for a project, merging with manual definitions */
export function extractAndSaveContracts(projectDir: string): { count: number; hash: string } {
  const absDir = resolve(projectDir);
  const hash = hashProjectDir(absDir);
  
  const autoContracts = extractContracts(absDir);
  const manualContracts = loadManualContracts(absDir);

  // Manual contracts take precedence (same name = manual wins)
  const manualNames = new Set(manualContracts.map(c => c.name));
  const merged = [
    ...manualContracts,
    ...autoContracts.filter(c => !manualNames.has(c.name)),
  ];

  saveContracts(hash, merged);
  return { count: merged.length, hash };
}

/** Load all contracts for a list of project directories */
export function loadAllContracts(projectDirs: string[]): Contract[] {
  const all: Contract[] = [];
  for (const dir of projectDirs) {
    const hash = hashProjectDir(resolve(dir));
    all.push(...loadContracts(hash));
  }
  return all;
}

/** Format contracts for display in tool output */
export function formatContracts(contracts: Contract[], limit = 10): string {
  if (contracts.length === 0) return "";
  
  const lines = contracts.slice(0, limit).map(c => {
    const proj = basename(c.project);
    const defPreview = c.definition.split("\n")[0].slice(0, 120);
    return `From ${proj}: ${c.kind} ${c.name} — ${defPreview} (${c.file})`;
  });

  return lines.join("\n");
}
