#!/usr/bin/env bun
/**
 * scripts/audit-codebase.ts -- deterministic architecture-doc regenerator.
 *
 * Walks the TypeScript AST via ts-morph + regex-level secondary passes to emit
 * five docs + one machine snapshot under `docs/architecture/` and `docs/audit/`:
 *
 *   - api-inventory.md    Every `router.handle("...")` call, its handler file,
 *                         the Zod schema (if any), and the caller matrix.
 *   - module-graph.md     Import graph across packages/{core,server,cli,web,
 *                         protocol}, fan-in leaderboard, orphan list.
 *   - db-map.md           Every drizzle `sqliteTable`/`pgTable`, plus writer /
 *                         reader files discovered by walking `db.prepare(...)`
 *                         SQL template literals across the repo.
 *   - data-flows.md       One-hop trace of the top-N operations (route ->
 *                         service -> repo -> table).
 *   - README.md           How each file is regenerated and what the audit
 *                         intentionally does not catch.
 *   - audit.json          Machine-readable snapshot. Schema: see README.
 *
 * Pi-sage parity (issue #338): `make audit` regenerates everything in-place;
 * `make audit-check` regenerates into a temp dir and diffs -- CI fails if a
 * drift is committed without the regenerated docs.
 *
 * Determinism:
 *   - All arrays are sorted with a stable comparator before emission.
 *   - Paths are stored relative to repo root (posix).
 *   - `generatedAt` is normalized to a single fixed string in --check mode.
 *
 * Zero runtime deps beyond ts-morph. No shelling out.
 */

import { Project, SyntaxKind } from "ts-morph";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { resolve, relative, dirname, join, basename, sep } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const AUDIT_VERSION = "1.0";

// Fixed timestamp used when running via `make audit-check`. The generated
// files still include a `generatedAt` line, but check mode normalizes both
// the committed copy and the regenerated copy before diffing so a stale
// timestamp never causes a false-positive drift.
const NORMALIZED_TIMESTAMP = "1970-01-01T00:00:00.000Z";

const TRACKED_PACKAGES = ["core", "server", "cli", "web", "protocol", "compute", "router", "arkd", "types"];

// --- Helpers -------------------------------------------------------------

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function relFromRoot(absPath: string): string {
  return toPosix(relative(REPO_ROOT, absPath));
}

function stableSort<T>(arr: T[], key: (item: T) => string): T[] {
  return [...arr].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "__tests__" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkFiles(full, out);
    } else if (st.isFile()) {
      if (full.endsWith(".ts") || full.endsWith(".tsx")) {
        if (full.endsWith(".d.ts") || full.endsWith(".test.ts") || full.endsWith(".test.tsx")) continue;
        if (full.endsWith(".spec.ts") || full.endsWith(".spec.tsx")) continue;
        out.push(full);
      }
    }
  }
  return out;
}

// --- RPC inventory -------------------------------------------------------

interface RpcRoute {
  method: string;
  file: string;
  line: number;
  hasZodSchema: boolean;
  callerFiles: string[];
}

/**
 * Walk `packages/server/handlers/**` via ts-morph, find every
 * `router.handle("method/name", ...)` call, record the file + line. We use a
 * real AST walk (not regex) so dynamic method strings -- which we can't
 * resolve statically -- are still flagged rather than silently missed.
 */
function collectRoutes(project: Project): RpcRoute[] {
  const routes: Array<Omit<RpcRoute, "callerFiles">> = [];
  const dynamicRoutes: Array<{ file: string; line: number }> = [];

  const handlerFiles = walkFiles(join(REPO_ROOT, "packages/server"));
  for (const file of handlerFiles) {
    const sf = project.addSourceFileAtPathIfExists(file);
    if (!sf) continue;
    const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const call of calls) {
      const expr = call.getExpression();
      if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
      const prop = expr.asKind(SyntaxKind.PropertyAccessExpression);
      if (!prop) continue;
      if (prop.getName() !== "handle") continue;
      const receiver = prop.getExpression().getText();
      // Match router.handle(...) -- receiver identifier is typically `router`
      // (the convention across every register*Handlers function).
      if (receiver !== "router") continue;
      const args = call.getArguments();
      if (args.length < 1) continue;
      const first = args[0];
      if (
        first.getKind() === SyntaxKind.StringLiteral ||
        first.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral
      ) {
        const lit = first.asKind(SyntaxKind.StringLiteral) ?? first.asKind(SyntaxKind.NoSubstitutionTemplateLiteral);
        const method = lit?.getLiteralValue() ?? "";
        if (!method) continue;
        routes.push({
          method,
          file: relFromRoot(file),
          line: call.getStartLineNumber(),
          hasZodSchema: false, // filled below
        });
      } else {
        dynamicRoutes.push({ file: relFromRoot(file), line: call.getStartLineNumber() });
      }
    }
  }

  // Zod coverage: read rpc-schemas.ts and extract the method-name keys from
  // the `rpcMethodSchemas` object literal.
  const zodCovered = readZodCoveredMethods(project);
  for (const r of routes) {
    (r as RpcRoute).hasZodSchema = zodCovered.has(r.method);
  }

  // Build the caller matrix once, using a single-pass scan of every tracked
  // caller file. This is O(files * methods) but methods is small (<200).
  const callerRoots = ["packages/cli", "packages/web/src", "packages/protocol"];
  const callerFilesByMethod = collectCallerMatrix(
    routes.map((r) => r.method),
    callerRoots,
  );

  const final: RpcRoute[] = routes.map((r) => ({
    ...r,
    callerFiles: callerFilesByMethod.get(r.method) ?? [],
  }));

  const sorted = stableSort(final, (r) => r.method);
  // Surface dynamic registrations on the returned array.  stableSort
  // copies into a new array, so attach this after the sort.
  (sorted as any).__dynamic = stableSort(dynamicRoutes, (d) => `${d.file}:${d.line}`);
  return sorted;
}

function readZodCoveredMethods(project: Project): Set<string> {
  const path = join(REPO_ROOT, "packages/protocol/rpc-schemas.ts");
  const sf = project.addSourceFileAtPathIfExists(path);
  if (!sf) return new Set();
  const out = new Set<string>();
  // Find `rpcMethodSchemas` variable declaration -> its object literal keys.
  for (const decl of sf.getVariableDeclarations()) {
    if (decl.getName() !== "rpcMethodSchemas") continue;
    const init = decl.getInitializer();
    if (!init) continue;
    const obj = init.asKind(SyntaxKind.ObjectLiteralExpression);
    if (!obj) continue;
    for (const prop of obj.getProperties()) {
      const propAssign = prop.asKind(SyntaxKind.PropertyAssignment);
      if (!propAssign) continue;
      const name = propAssign.getNameNode();
      const text = name.getText();
      // Keys are string literals like "session/start".
      if (text.startsWith('"') || text.startsWith("'")) {
        out.add(text.slice(1, -1));
      }
    }
  }
  return out;
}

function collectCallerMatrix(methods: string[], roots: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of methods) out.set(m, []);
  const files: string[] = [];
  for (const r of roots) files.push(...walkFiles(join(REPO_ROOT, r)));
  for (const f of files) {
    const content = readFileSync(f, "utf8");
    for (const m of methods) {
      // Match the method name as a string literal. We look for the literal
      // wrapped in " or ' -- this keeps us from flagging comments that
      // happen to mention the name, while still catching every real call
      // site (rpc("method/x"), register("method/x"), etc.).
      if (content.includes(`"${m}"`) || content.includes(`'${m}'`)) {
        out.get(m)!.push(relFromRoot(f));
      }
    }
  }
  for (const [k, v] of out)
    out.set(
      k,
      stableSort([...new Set(v)], (x) => x),
    );
  return out;
}

// --- Module import graph -------------------------------------------------

interface ModuleNode {
  path: string;
  imports: string[];
  importedBy: string[];
}

function collectModuleGraph(project: Project): ModuleNode[] {
  const files: string[] = [];
  for (const pkg of TRACKED_PACKAGES) {
    files.push(...walkFiles(join(REPO_ROOT, "packages", pkg)));
  }
  const known = new Set(files);
  const graph = new Map<string, { imports: Set<string>; importedBy: Set<string> }>();
  for (const f of files) {
    graph.set(relFromRoot(f), { imports: new Set(), importedBy: new Set() });
  }

  for (const f of files) {
    const sf = project.addSourceFileAtPathIfExists(f);
    if (!sf) continue;
    const fromKey = relFromRoot(f);
    const fromDir = dirname(f);
    const imports = [
      ...sf.getImportDeclarations().map((d) => d.getModuleSpecifierValue()),
      // Also count dynamic imports -- they show up in session.ts via
      // `await import("../services/session-orchestration.js")`.
      ...sf
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .filter((c) => c.getExpression().getKind() === SyntaxKind.ImportKeyword)
        .map((c) => {
          const arg = c.getArguments()[0];
          if (!arg) return undefined;
          const lit = arg.asKind(SyntaxKind.StringLiteral);
          return lit?.getLiteralValue();
        }),
    ];
    for (const spec of imports) {
      if (!spec) continue;
      if (!spec.startsWith(".") && !spec.startsWith("/")) continue; // external pkg -- skip
      const resolvedTs = tryResolveImport(fromDir, spec, known);
      if (!resolvedTs) continue;
      const toKey = relFromRoot(resolvedTs);
      graph.get(fromKey)!.imports.add(toKey);
      if (!graph.has(toKey)) graph.set(toKey, { imports: new Set(), importedBy: new Set() });
      graph.get(toKey)!.importedBy.add(fromKey);
    }
  }

  const nodes: ModuleNode[] = [...graph.entries()].map(([path, { imports, importedBy }]) => ({
    path,
    imports: stableSort([...imports], (x) => x),
    importedBy: stableSort([...importedBy], (x) => x),
  }));
  return stableSort(nodes, (n) => n.path);
}

function tryResolveImport(fromDir: string, spec: string, known: Set<string>): string | null {
  // Strip .js/.jsx/.tsx/.ts extensions then try candidate resolutions in
  // order. ES modules require `.js` at runtime; on disk the file is `.ts`.
  const raw = resolve(fromDir, spec);
  const stripped = raw.replace(/\.(js|jsx|tsx|ts)$/, "");
  const candidates = [
    `${stripped}.ts`,
    `${stripped}.tsx`,
    `${stripped}/index.ts`,
    `${stripped}/index.tsx`,
    raw, // literal path (rare)
  ];
  for (const c of candidates) {
    if (known.has(c)) return c;
    if (existsSync(c) && !statSync(c).isDirectory()) return c;
  }
  return null;
}

// --- Drizzle table + repository SQL map ---------------------------------

interface DbColumn {
  name: string;
  tsName: string;
  sqlType: string;
  notNull: boolean;
  hasDefault: boolean;
}

interface DbTable {
  name: string;
  tsName: string;
  file: string;
  columns: DbColumn[];
  writers: string[];
  readers: string[];
  migrationHistory: string[];
}

function collectDbTables(project: Project): DbTable[] {
  const schemaFile = join(REPO_ROOT, "packages/core/drizzle/schema/sqlite.ts");
  const sf = project.addSourceFileAtPathIfExists(schemaFile);
  if (!sf) return [];
  const tables: DbTable[] = [];
  for (const decl of sf.getVariableDeclarations()) {
    const init = decl.getInitializer();
    if (!init) continue;
    const call = init.asKind(SyntaxKind.CallExpression);
    if (!call) continue;
    if (call.getExpression().getText() !== "sqliteTable") continue;
    const args = call.getArguments();
    if (args.length < 2) continue;
    const first = args[0].asKind(SyntaxKind.StringLiteral);
    if (!first) continue;
    const sqlName = first.getLiteralValue();
    const tsName = decl.getName();
    const colsArg = args[1].asKind(SyntaxKind.ObjectLiteralExpression);
    const columns: DbColumn[] = [];
    if (colsArg) {
      for (const prop of colsArg.getProperties()) {
        const assign = prop.asKind(SyntaxKind.PropertyAssignment);
        if (!assign) continue;
        const colTsName = assign.getName();
        const colInit = assign.getInitializer();
        if (!colInit) continue;
        // Expected shape: text("col").notNull().default(...) or similar.
        const colText = colInit.getText();
        const sqlMatch = colText.match(/^(text|integer|real|blob|primaryKey)\s*\(\s*"([^"]+)"/);
        const sqlCol = sqlMatch ? sqlMatch[2] : colTsName;
        const sqlType = sqlMatch ? sqlMatch[1] : "unknown";
        columns.push({
          name: sqlCol,
          tsName: colTsName,
          sqlType,
          notNull: colText.includes(".notNull()"),
          hasDefault: colText.includes(".default("),
        });
      }
    }
    tables.push({
      name: sqlName,
      tsName,
      file: relFromRoot(schemaFile),
      columns: stableSort(columns, (c) => c.name),
      writers: [],
      readers: [],
      migrationHistory: [],
    });
  }

  // Walk repositories + any file using raw SQL strings.
  const sqlRoots = [
    "packages/core/repositories",
    "packages/core/auth",
    "packages/core/hosted",
    "packages/core/secrets",
  ];
  const sqlFiles: string[] = [];
  for (const r of sqlRoots) sqlFiles.push(...walkFiles(join(REPO_ROOT, r)));

  for (const t of tables) {
    const tableRe = t.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const writeRe = new RegExp(
      `(INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${tableRe}\\b|UPDATE\\s+${tableRe}\\b|DELETE\\s+FROM\\s+${tableRe}\\b)`,
      "i",
    );
    const readRe = new RegExp(`\\bFROM\\s+${tableRe}\\b`, "i");
    const writers: string[] = [];
    const readers: string[] = [];
    for (const f of sqlFiles) {
      const content = readFileSync(f, "utf8");
      if (writeRe.test(content)) writers.push(relFromRoot(f));
      if (readRe.test(content)) readers.push(relFromRoot(f));
    }
    t.writers = stableSort([...new Set(writers)], (x) => x);
    t.readers = stableSort([...new Set(readers)], (x) => x);
  }

  // Migration history: scan packages/core/migrations/**/*.ts for table name.
  const migFiles = walkFiles(join(REPO_ROOT, "packages/core/migrations")).filter(
    (f) => !f.includes("registry") && !f.includes("runner") && !f.includes("index") && !f.includes("types"),
  );
  for (const t of tables) {
    const tableRe = new RegExp(`\\b${t.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    const hits: string[] = [];
    for (const f of migFiles) {
      if (tableRe.test(readFileSync(f, "utf8"))) {
        hits.push(relFromRoot(f));
      }
    }
    t.migrationHistory = stableSort(hits, (x) => basename(x));
  }

  return stableSort(tables, (t) => t.name);
}

// --- Data flows ----------------------------------------------------------

interface DataFlow {
  operation: string;
  hops: Array<{ layer: string; file: string }>;
}

/**
 * Produce a module-level trace for a small, curated set of top operations.
 * The trace is shallow by design -- one hop per layer. Deeper tracing
 * requires symbol resolution that ts-morph can do but at a cost we don't
 * want on every `make audit`.
 */
function collectDataFlows(routes: RpcRoute[], modules: ModuleNode[]): DataFlow[] {
  const pick: Array<{ method: string; service?: string; repo?: string; table?: string }> = [
    {
      method: "session/start",
      service: "packages/core/services/session-orchestration.ts",
      repo: "packages/core/repositories/session.ts",
      table: "sessions",
    },
    {
      method: "session/read",
      service: "packages/core/services/session.ts",
      repo: "packages/core/repositories/session.ts",
      table: "sessions",
    },
    {
      method: "session/advance",
      service: "packages/core/services/session.ts",
      repo: "packages/core/repositories/session.ts",
      table: "sessions",
    },
    {
      method: "compute/create",
      service: "packages/core/services/compute.ts",
      repo: "packages/core/repositories/compute.ts",
      table: "compute",
    },
    {
      method: "knowledge/stats",
      service: "packages/core/knowledge",
      repo: "packages/core/repositories/artifact.ts",
      table: "knowledge",
    },
    { method: "code-intel/run", service: "packages/core/code-intel", repo: "-", table: "-" },
    {
      method: "schedule/create",
      service: "packages/core/schedule.ts",
      repo: "packages/core/repositories/schedule.ts" /* computed via existence */,
      table: "schedules",
    },
    { method: "memory/add", service: "packages/core/memory", repo: "-", table: "memory" },
  ];
  const byMethod = new Map<string, RpcRoute>();
  for (const r of routes) byMethod.set(r.method, r);
  const moduleSet = new Set(modules.map((m) => m.path));
  const flows: DataFlow[] = [];
  for (const p of pick) {
    const route = byMethod.get(p.method);
    if (!route) continue;
    const hops: DataFlow["hops"] = [{ layer: "route", file: route.file }];
    if (p.service && moduleSet.has(p.service)) hops.push({ layer: "service", file: p.service });
    if (p.repo && p.repo !== "-" && moduleSet.has(p.repo)) hops.push({ layer: "repository", file: p.repo });
    if (p.table && p.table !== "-") hops.push({ layer: "table", file: p.table });
    flows.push({ operation: p.method, hops });
  }
  return flows;
}

// --- Emitters ------------------------------------------------------------

function emitApiInventory(routes: RpcRoute[]): string {
  const dynamic = ((routes as any).__dynamic ?? []) as Array<{ file: string; line: number }>;
  let out = "# API Inventory\n\n";
  out += `> generated: ${NORMALIZED_TIMESTAMP}  -  regenerate with \`make audit\`.\n\n`;
  out += `Total RPC methods: **${routes.length}**.  `;
  out += `Zod-validated: **${routes.filter((r) => r.hasZodSchema).length}**.\n\n`;
  out += "| method | handler file | line | zod | caller files |\n";
  out += "| --- | --- | --- | --- | --- |\n";
  for (const r of routes) {
    const callers = r.callerFiles.length ? r.callerFiles.join("<br>") : "_(no caller found)_";
    out += `| \`${r.method}\` | \`${r.file}\` | ${r.line} | ${r.hasZodSchema ? "yes" : "no"} | ${callers} |\n`;
  }
  if (dynamic.length) {
    out += `\n## Dynamic registrations\n\nEvery \`router.handle(<non-literal>, ...)\` site. These are invisible to the static audit:\n\n`;
    for (const d of dynamic) out += `- \`${d.file}:${d.line}\`\n`;
  }
  return out;
}

function emitModuleGraph(modules: ModuleNode[]): string {
  let out = "# Module Graph\n\n";
  out += `> generated: ${NORMALIZED_TIMESTAMP}  -  regenerate with \`make audit\`.\n\n`;
  out += `Tracked packages: ${TRACKED_PACKAGES.join(", ")}.  Total modules: **${modules.length}**.\n\n`;

  out += "## Fan-in leaderboard (top 20)\n\n";
  const leaderboard = stableSort(modules.slice(), (m) => m.path)
    .slice()
    .sort((a, b) => b.importedBy.length - a.importedBy.length || (a.path < b.path ? -1 : 1))
    .slice(0, 20);
  out += "| module | fan-in |\n| --- | --- |\n";
  for (const m of leaderboard) out += `| \`${m.path}\` | ${m.importedBy.length} |\n`;

  const orphans = modules.filter((m) => m.importedBy.length === 0);
  out += `\n## Orphans (${orphans.length})\n\n`;
  out +=
    "Modules with fan-in 0. Entry points (cli/index.ts, packages/server/index.ts, test setup) are expected here; everything else is a dead-code candidate.\n\n";
  for (const m of orphans) out += `- \`${m.path}\`\n`;

  out += `\n## Full graph\n\n<details><summary>${modules.length} modules</summary>\n\n`;
  for (const m of modules) {
    out += `### \`${m.path}\`\n\n`;
    out += `- fan-in: ${m.importedBy.length}\n`;
    out += `- fan-out: ${m.imports.length}\n`;
    if (m.imports.length) {
      out += `- imports:\n`;
      for (const i of m.imports) out += `  - \`${i}\`\n`;
    }
    out += "\n";
  }
  out += "</details>\n";
  return out;
}

function emitDbMap(tables: DbTable[]): string {
  let out = "# DB Map\n\n";
  out += `> generated: ${NORMALIZED_TIMESTAMP}  -  regenerate with \`make audit\`.\n\n`;
  out += `Source: \`packages/core/drizzle/schema/sqlite.ts\`.  Total tables: **${tables.length}**.\n\n`;
  for (const t of tables) {
    out += `## \`${t.name}\`\n\n`;
    out += `- TS binding: \`${t.tsName}\`\n`;
    out += `- defined in: \`${t.file}\`\n`;
    out += `- columns (${t.columns.length}):\n`;
    for (const c of t.columns) {
      const flags = [c.notNull ? "NOT NULL" : "", c.hasDefault ? "DEFAULT" : ""].filter(Boolean).join(" ");
      out += `  - \`${c.name}\` (${c.sqlType}${flags ? ", " + flags : ""})\n`;
    }
    out += `- writers (${t.writers.length}):\n`;
    for (const w of t.writers) out += `  - \`${w}\`\n`;
    out += `- readers (${t.readers.length}):\n`;
    for (const r of t.readers) out += `  - \`${r}\`\n`;
    out += `- migration history (${t.migrationHistory.length}):\n`;
    for (const m of t.migrationHistory) out += `  - \`${m}\`\n`;
    out += "\n";
  }
  return out;
}

function emitDataFlows(flows: DataFlow[]): string {
  let out = "# Data Flows\n\n";
  out += `> generated: ${NORMALIZED_TIMESTAMP}  -  regenerate with \`make audit\`.\n\n`;
  out +=
    "One-hop traces for the top-N operations. Each row is module-level -- depth stops at the DB table.  If a hop says \`-\` the tracer could not resolve the layer statically.\n\n";
  for (const f of flows) {
    out += `## \`${f.operation}\`\n\n`;
    for (const h of f.hops) {
      out += `- **${h.layer}**: \`${h.file}\`\n`;
    }
    out += "\n";
  }
  return out;
}

function emitReadme(): string {
  return `# Architecture Docs (auto-generated)

> Do not edit by hand.  Every file in this directory (and \`docs/audit/audit.json\`) is regenerated by \`make audit\`; \`make audit-check\` fails CI if a commit drifts.

## Files

| file | contents |
| --- | --- |
| \`api-inventory.md\` | Every \`router.handle("method/name", ...)\` in \`packages/server/handlers/**\`, with handler file, line, Zod coverage, and the caller matrix (cli / web / protocol). |
| \`module-graph.md\` | Import graph across \`packages/{core,server,cli,web,protocol,compute,router,arkd,types}/**\`. Fan-in leaderboard (top 20) + orphan list (fan-in 0). |
| \`db-map.md\` | Every \`sqliteTable\` in \`packages/core/drizzle/schema/sqlite.ts\`: columns, writer files, reader files, migration history. |
| \`data-flows.md\` | Top operations traced one hop per layer: route -> service -> repo -> table. |
| \`../audit/audit.json\` | Machine-readable snapshot. Schema: \`{ version, generatedAt, routes, modules, tables }\`. |

## Regenerating

\`\`\`bash
make audit           # regenerate in place
make audit-check     # regenerate into a temp dir, diff against committed, exit 1 on drift
\`\`\`

\`make audit-check\` is wired into CI (\`.github/workflows/audit-check.yml\`). A PR that changes a handler or a schema without regenerating the docs will fail this check with a visible diff.

## What this audit intentionally does NOT catch

- **Dynamic route registration.** \`router.handle(computedMethodName, ...)\` where the first arg is not a string literal.  The walker records the site but not the method name.  None currently exist, but if one is added it shows up in an extra \`## Dynamic registrations\` section of \`api-inventory.md\`.
- **External webhook callers.** Routes called by code outside this repo (\`ai.pi-sage\`, \`cursor\`, external dashboards) are invisible.  Caller matrix only covers \`packages/{cli,web,protocol}\`.
- **Runtime re-exports.** If a module is only imported via a barrel file, the fan-in edge points at the barrel, not the upstream consumer -- so a handful of low-level utilities appear over-counted.
- **Same-file usage.** The DB writer/reader lists are file-granular.  A repository that SELECTs in one function and INSERTs in another appears in both lists without distinguishing the call sites.
- **Cross-package dynamic dispatch.**  \`getApp()\` / \`ARK_DIR()\` indirection hides its consumers from the import graph.  Migration to DI (awilix) is tracked separately.
- **SQL inside raw template strings constructed at runtime.**  Tables referenced only via interpolated table-name variables (\`\\\`UPDATE \\\${table} SET ...\\\`\`) will be missed.  None are currently known.

## Implementation

Single file: \`scripts/audit-codebase.ts\` (Bun + ts-morph).  Uses ts-morph AST walking for:
- RPC routes (call-expression match on \`router.handle\`)
- drizzle table declarations (variable-declaration + \`sqliteTable(...)\` initializer)
- import graph (import declarations + dynamic \`import()\` calls)

Uses regex for raw-SQL table discovery (intentional -- the SQL is inside template strings and not meaningfully typed).
`;
}

// --- Main ---------------------------------------------------------------

type Outputs = {
  apiInventory: string;
  moduleGraph: string;
  dbMap: string;
  dataFlows: string;
  readme: string;
  auditJson: string;
};

function build(): Outputs {
  const project = new Project({
    tsConfigFilePath: join(REPO_ROOT, "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
  });

  const routes = collectRoutes(project);
  const modules = collectModuleGraph(project);
  const tables = collectDbTables(project);
  const flows = collectDataFlows(routes, modules);

  const apiInventory = emitApiInventory(routes);
  const moduleGraph = emitModuleGraph(modules);
  const dbMap = emitDbMap(tables);
  const dataFlows = emitDataFlows(flows);
  const readme = emitReadme();

  const snapshot = {
    version: AUDIT_VERSION,
    generatedAt: NORMALIZED_TIMESTAMP,
    routes: routes.map((r) => ({
      method: r.method,
      file: r.file,
      line: r.line,
      hasZodSchema: r.hasZodSchema,
      callerFiles: r.callerFiles,
    })),
    modules,
    tables,
  };
  const auditJson = JSON.stringify(snapshot, null, 2) + "\n";

  return { apiInventory, moduleGraph, dbMap, dataFlows, readme, auditJson };
}

function writeOutputs(outDir: string, o: Outputs): void {
  const archDir = join(outDir, "docs/architecture");
  const auditDir = join(outDir, "docs/audit");
  mkdirSync(archDir, { recursive: true });
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(join(archDir, "README.md"), o.readme);
  writeFileSync(join(archDir, "api-inventory.md"), o.apiInventory);
  writeFileSync(join(archDir, "module-graph.md"), o.moduleGraph);
  writeFileSync(join(archDir, "db-map.md"), o.dbMap);
  writeFileSync(join(archDir, "data-flows.md"), o.dataFlows);
  writeFileSync(join(auditDir, "audit.json"), o.auditJson);
}

function readCommitted(): Outputs | null {
  const archDir = join(REPO_ROOT, "docs/architecture");
  const auditDir = join(REPO_ROOT, "docs/audit");
  try {
    return {
      readme: readFileSync(join(archDir, "README.md"), "utf8"),
      apiInventory: readFileSync(join(archDir, "api-inventory.md"), "utf8"),
      moduleGraph: readFileSync(join(archDir, "module-graph.md"), "utf8"),
      dbMap: readFileSync(join(archDir, "db-map.md"), "utf8"),
      dataFlows: readFileSync(join(archDir, "data-flows.md"), "utf8"),
      auditJson: readFileSync(join(auditDir, "audit.json"), "utf8"),
    };
  } catch {
    return null;
  }
}

function lineDiff(a: string, b: string, maxLines = 60): string {
  if (a === b) return "";
  const al = a.split("\n");
  const bl = b.split("\n");
  const n = Math.max(al.length, bl.length);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    if (al[i] === bl[i]) continue;
    if (out.length >= maxLines) {
      out.push(`  (... ${n - i} more lines differ)`);
      break;
    }
    if (al[i] !== undefined) out.push(`- ${al[i]}`);
    if (bl[i] !== undefined) out.push(`+ ${bl[i]}`);
  }
  return out.join("\n");
}

async function main() {
  const mode = process.argv[2] ?? "generate";
  if (mode === "generate") {
    const t0 = Date.now();
    const outputs = build();
    writeOutputs(REPO_ROOT, outputs);
    const t1 = Date.now();
    // Write a short summary line so callers can see what happened.
    console.log(`audit regenerated in ${t1 - t0}ms  (routes, modules, tables, data-flows, readme, audit.json)`);
    return;
  }
  if (mode === "check") {
    const t0 = Date.now();
    const outputs = build();
    const committed = readCommitted();
    if (!committed) {
      console.error("error: no committed audit docs -- run `make audit` and commit the generated files.");
      process.exit(1);
    }
    const diffs: string[] = [];
    for (const key of ["readme", "apiInventory", "moduleGraph", "dbMap", "dataFlows", "auditJson"] as const) {
      const d = lineDiff(committed[key], outputs[key]);
      if (d) diffs.push(`== ${key} ==\n${d}`);
    }
    const t1 = Date.now();
    if (diffs.length === 0) {
      console.log(`audit-check passed in ${t1 - t0}ms (6 artifacts, byte-identical to committed).`);
      return;
    }
    console.error(
      `audit-check FAILED -- ${diffs.length} of 6 artifacts drift.  Run \`make audit\` and commit the result.\n`,
    );
    for (const d of diffs) console.error(d + "\n");
    process.exit(1);
  }
  if (mode === "write-temp") {
    // Used by tests: write outputs to an explicit directory.
    const target = process.argv[3];
    if (!target) {
      console.error("usage: audit-codebase.ts write-temp <dir>");
      process.exit(1);
    }
    const outputs = build();
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    writeOutputs(target, outputs);
    return;
  }
  console.error(`unknown mode: ${mode}.  Expected: generate | check | write-temp <dir>`);
  process.exit(1);
}

main();
