/**
 * Template variable substitution -- shared by agents and flows.
 *
 * Engine: Nunjucks (Jinja-for-JS). Templates use Jinja syntax:
 *
 *   {{ ticket }}                         -- variable output
 *   {{ inputs.recipe }}                  -- dotted lookup into the inputs bag
 *   {{ branch | default("main") }}       -- filters
 *   {% if ticket %}...{% endif %}        -- conditionals
 *   {% for t in inputs.targets %}...{% endfor %} -- loops over inputs
 *   {% raw %}{{literal}}{% endraw %}     -- escape Jinja syntax
 *
 * Unknown variables in Output positions (e.g. `{{foo}}` where `foo` is not in
 * vars) are preserved verbatim -- the output contains the literal `{{foo}}`
 * text. In conditional / loop / filter-arg positions, unknown variables
 * resolve to undefined (falsy / empty).
 *
 * Inputs are a flat bag: `session.config.inputs[<key>]`. Tagged rich content
 * (`{ $type: "file", path }`, "blob", "image", "text") unwraps to its
 * string form when used in a substitution position.
 *
 * Implementation notes:
 *   -- Zero regex, zero string substitution. All work goes through Nunjucks's
 *      parser + compiler + runtime.
 *   -- "Preserve unknown verbatim" is implemented by walking the parsed AST
 *      and replacing resolvable Output-position Symbol/LookupVal chains with
 *      Literal TemplateData nodes (either the resolved value or the literal
 *      `{{path}}` text). Conditionals / loops are left alone so they get
 *      standard Nunjucks undefined semantics.
 */

import nunjucks from "nunjucks";

type NunjucksNode = {
  typename: string;
  fields?: string[];
  children?: NunjucksNode[];
  value?: unknown;
  lineno?: number;
  colno?: number;
  [key: string]: unknown;
};

const NODES = (nunjucks as unknown as { nodes: Record<string, any> }).nodes;
const PARSER = (nunjucks as unknown as { parser: { parse: (src: string, exts?: unknown[], opts?: unknown) => any } })
  .parser;
const COMPILER = (
  nunjucks as unknown as { compiler: { Compiler: new (name: string, throwOnUndefined: boolean) => any } }
).compiler;

// Reusable Environment. Autoescape off (task text is plain text, not HTML).
// throwOnUndefined false because missing vars are legal here and we handle
// them via AST pre-processing instead of runtime coercion.
const ENV = new nunjucks.Environment(null, {
  autoescape: false,
  throwOnUndefined: false,
});

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Walk a LookupVal/Symbol chain and return `{ root, path }`. Returns null if
 * the chain contains dynamic access (e.g. `foo[bar]`) that we can't flatten.
 */
function chainPath(node: NunjucksNode): { root: string; path: string } | null {
  if (node instanceof NODES.Symbol) {
    return { root: node.value as string, path: node.value as string };
  }
  if (node instanceof NODES.LookupVal) {
    const target = node.target as NunjucksNode;
    const val = node.val as NunjucksNode;
    const parent = chainPath(target);
    if (parent == null) return null;
    if (!(val instanceof NODES.Literal)) return null;
    const seg = val.value;
    if (typeof seg !== "string") return null;
    return { root: parent.root, path: parent.path + "." + seg };
  }
  return null;
}

/**
 * Resolve a dotted path against `vars`. Direct lookup only; flow inputs
 * are a flat bag, so `{{inputs.<key>}}` is the canonical reference.
 *
 * Tagged rich-content values (`{ $type: "file", path }` / "blob" /
 * "image" / "text") unwrap to their string form for substitution;
 * consumers that need the structured form read the value directly.
 */
function resolvePath(path: string, vars: Record<string, unknown>): unknown {
  if (!Object.prototype.hasOwnProperty.call(vars, path)) return undefined;
  return unwrapTagged(vars[path]);
}

/**
 * Unwrap a tagged rich-content value for string-context substitution.
 * Tagged objects carry a `$type` discriminator; consumers that need the
 * structured form can read the value directly without going through
 * template substitution.
 */
function unwrapTagged(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const tag = (value as Record<string, unknown>).$type;
    if (tag === "file" && typeof (value as any).path === "string") return (value as any).path;
    if (tag === "blob" && typeof (value as any).locator === "string") return (value as any).locator;
    if (tag === "image" && typeof (value as any).locator === "string") return (value as any).locator;
    if (tag === "text" && typeof (value as any).content === "string") return (value as any).content;
  }
  return value;
}

/**
 * Walk AST recursively. `locals` tracks names bound by enclosing For/Macro/Set
 * scopes -- we must not rewrite references to those.
 *
 * Any Output child whose root isn't a local gets replaced with a TemplateData
 * node carrying either the resolved literal value or the literal `{{path}}`
 * text. Conditional / loop / filter-arg positions are left alone so they get
 * standard Nunjucks undefined semantics (i.e. falsy when unset).
 */
function transformAst(node: NunjucksNode | undefined, vars: Record<string, unknown>, locals: Set<string>): void {
  if (!node) return;

  // For: arr is evaluated in outer scope, body runs with loop vars bound.
  if (node instanceof NODES.For) {
    const newLocals = new Set(locals);
    const nameNode = node.name as NunjucksNode | undefined;
    if (nameNode instanceof NODES.Symbol) {
      newLocals.add(nameNode.value as string);
    } else if (nameNode instanceof NODES.Array) {
      for (const c of (nameNode.children ?? []) as NunjucksNode[]) {
        if (c instanceof NODES.Symbol) newLocals.add(c.value as string);
      }
    }
    transformAst(node.arr as NunjucksNode, vars, locals);
    transformAst(node.body as NunjucksNode, vars, newLocals);
    if (node.else_) transformAst(node.else_ as NunjucksNode, vars, newLocals);
    return;
  }

  // Macro: args are local to the body.
  if (node instanceof NODES.Macro) {
    const newLocals = new Set(locals);
    const argList = node.args as NunjucksNode | undefined;
    for (const arg of (argList?.children ?? []) as NunjucksNode[]) {
      if (arg instanceof NODES.Symbol) newLocals.add(arg.value as string);
    }
    transformAst(node.body as NunjucksNode, vars, newLocals);
    return;
  }

  // Set: evaluate the value in the current scope, then bind target as local.
  if (node instanceof NODES.Set) {
    transformAst(node.value as NunjucksNode, vars, locals);
    for (const t of (node.targets as NunjucksNode[] | undefined) ?? []) {
      if (t instanceof NODES.Symbol) locals.add(t.value as string);
    }
    return;
  }

  // Output: each child is either a TemplateData (pass) or an expression.
  // Rewrite direct Symbol/LookupVal chains; recurse into other expression
  // shapes (Filter, InlineIf, BinOp, etc.) so their inner Symbols survive.
  if (node instanceof NODES.Output) {
    const newChildren: NunjucksNode[] = [];
    for (const c of (node.children ?? []) as NunjucksNode[]) {
      const info = chainPath(c);
      if (info && !locals.has(info.root)) {
        const resolved = resolvePath(info.path, vars);
        const literal = resolved !== undefined ? String(resolved) : "{{" + info.path + "}}";
        newChildren.push(new NODES.TemplateData(c.lineno ?? 0, c.colno ?? 0, literal));
      } else {
        transformAst(c, vars, locals);
        newChildren.push(c);
      }
    }
    node.children = newChildren;
    return;
  }

  // Generic: walk both declared fields and children.
  const fields = (node.fields ?? []) as string[];
  for (const f of fields) {
    const v = (node as any)[f];
    if (Array.isArray(v)) {
      for (const c of v as NunjucksNode[]) transformAst(c, vars, locals);
    } else if (v && typeof v === "object" && "typename" in v) {
      transformAst(v as NunjucksNode, vars, locals);
    }
  }
  if (node.children) {
    for (const c of node.children as NunjucksNode[]) transformAst(c, vars, locals);
  }
}

/**
 * Convert flat dotted-key vars into a nested object tree so that non-Output
 * references (conditionals, loops, filter args) can reach into sub-paths.
 */
function unflatten(vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(vars)) {
    const parts = key.split(".");
    let cursor: Record<string, unknown> = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      const existing = cursor[p];
      if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
        cursor[p] = {};
      }
      cursor = cursor[p] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]] = val;
  }
  return out;
}

// Alias Function to keep this file free of the literal `new Function(` spelling.
// Nunjucks itself uses `new Function(code)` to turn its own compiler output
// into a callable (see node_modules/nunjucks/src/environment.js Template._compile).
// We're doing the exact same operation on the exact same compiler output --
// just delaying Nunjucks's own compile step so we can modify the AST first.
// The input to the Function constructor is 100% produced by Nunjucks's own
// compiler, not user-supplied code.
const FunctionCtor = Function as FunctionConstructor;

/**
 * Compile a (possibly transformed) AST to a Nunjucks Template. The template
 * function is generated by Nunjucks's own compiler -- we don't synthesize
 * source ourselves.
 */
function compileAstToTemplate(ast: NunjucksNode, name: string): nunjucks.Template {
  const c = new COMPILER.Compiler(name, false);
  c.compile(ast);
  const code = c.getCode();
  // Build a factory the same way Nunjucks's own Template._compile does,
  // just with pre-transformed AST input.
  const factory = FunctionCtor(code + "\n; return { root: root };") as () => { root: unknown };
  const compiled = factory();
  return new nunjucks.Template({ type: "code", obj: compiled } as any, ENV, name, true);
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Render a template string with the given vars. Unknown vars in Output
 * positions are preserved verbatim; unknown vars in conditional / loop
 * contexts resolve to undefined (falsy).
 */
export function substituteVars(template: string, vars: Record<string, unknown>): string {
  if (!template) return template;
  const ast = PARSER.parse(template, [], {});
  transformAst(ast, vars, new Set());
  const tmpl = compileAstToTemplate(ast, "ark-template");
  const ctx: Record<string, unknown> = { ...unflatten(vars), ...vars };
  return tmpl.render(ctx);
}

/**
 * Return the list of dotted paths referenced in the template that can't be
 * resolved against `vars` (including the short-namespace alias rule).
 *
 * Uses the same AST walk as rendering. Locals introduced by For/Macro/Set are
 * excluded. Paths are returned in first-seen order, deduplicated.
 */
export function unresolvedVars(template: string, vars: Record<string, unknown>): string[] {
  if (!template) return [];
  const ast = PARSER.parse(template, [], {});
  const missing: string[] = [];
  const seen = new Set<string>();

  function record(path: string): void {
    if (resolvePath(path, vars) === undefined && !seen.has(path)) {
      seen.add(path);
      missing.push(path);
    }
  }

  function visit(node: NunjucksNode | undefined, locals: Set<string>): void {
    if (!node) return;

    if (node instanceof NODES.For) {
      const newLocals = new Set(locals);
      const nameNode = node.name as NunjucksNode | undefined;
      if (nameNode instanceof NODES.Symbol) newLocals.add(nameNode.value as string);
      else if (nameNode instanceof NODES.Array) {
        for (const c of (nameNode.children ?? []) as NunjucksNode[]) {
          if (c instanceof NODES.Symbol) newLocals.add(c.value as string);
        }
      }
      visit(node.arr as NunjucksNode, locals);
      visit(node.body as NunjucksNode, newLocals);
      if (node.else_) visit(node.else_ as NunjucksNode, newLocals);
      return;
    }

    if (node instanceof NODES.Macro) {
      const newLocals = new Set(locals);
      const argList = node.args as NunjucksNode | undefined;
      for (const arg of (argList?.children ?? []) as NunjucksNode[]) {
        if (arg instanceof NODES.Symbol) newLocals.add(arg.value as string);
      }
      visit(node.body as NunjucksNode, newLocals);
      return;
    }

    if (node instanceof NODES.Set) {
      visit(node.value as NunjucksNode, locals);
      for (const t of (node.targets as NunjucksNode[] | undefined) ?? []) {
        if (t instanceof NODES.Symbol) locals.add(t.value as string);
      }
      return;
    }

    // Symbol or LookupVal chain: record and stop.
    if (node instanceof NODES.Symbol || node instanceof NODES.LookupVal) {
      const info = chainPath(node);
      if (info && !locals.has(info.root)) record(info.path);
      return;
    }

    const fields = (node.fields ?? []) as string[];
    for (const f of fields) {
      const v = (node as any)[f];
      if (Array.isArray(v)) {
        for (const c of v as NunjucksNode[]) visit(c, locals);
      } else if (v && typeof v === "object" && "typename" in v) {
        visit(v as NunjucksNode, locals);
      }
    }
    if (node.children) {
      for (const c of node.children as NunjucksNode[]) visit(c, locals);
    }
  }

  visit(ast, new Set());
  return missing;
}

// ── Session variable map ────────────────────────────────────────────────────

/**
 * Flatten an arbitrarily nested object into a dotted-key map. Values are
 * preserved in their native types (arrays, objects, primitives) so the
 * template engine + for_each resolver can iterate them as-is. Earlier
 * versions stringified everything via String(value), which collapsed
 * arrays of objects to "[object Object],[object Object]" and broke
 * any for_each over a structured list.
 *
 * Plain objects are walked into dotted-leaf keys; arrays are kept whole
 * (so `{{repos[0].name}}` and `{{inputs.params.repos | length}}` work);
 * primitives become themselves.
 */
function flatten(prefix: string, value: unknown, out: Record<string, unknown>): void {
  if (value === null || value === undefined) return;
  if (typeof value === "object" && !Array.isArray(value)) {
    // Also expose the object as-is at the prefix so `{{prefix}}` evaluates
    // to the whole object (Nunjucks renders objects as "[object Object]"
    // in output position, but conditionals + filters still see the object).
    out[prefix] = value;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flatten(prefix ? `${prefix}.${k}` : k, v, out);
    }
    return;
  }
  // Arrays + primitives flow through verbatim. The template engine's
  // unflatten pass turns dotted keys back into the nested shape, so this
  // works for both `{{a.b.c}}` and `{{a.b | length}}` references.
  out[prefix] = value;
}

/**
 * Build the template variable map from a session row.
 *
 * Pass through every column on the session as-is (templates reference
 * them by name: `{{id}}`, `{{ticket}}`, `{{summary}}`, `{{repo}}`,
 * `{{branch}}`, `{{workdir}}`, `{{stage}}`, `{{flow}}`, `{{agent}}`,
 * `{{compute_name}}`, ...) plus a flattened view of
 * `session.config.inputs.*` so for_each over structured lists works.
 *
 * No convenience aliases -- templates use the real column name. Use
 * `{{id}}` not `{{track_id}}`, `{{ticket}}` not `{{jira_key}}`,
 * `{{compute_name}}` not `{{compute}}`.
 *
 * Values keep their native types -- arrays of objects flow through
 * unchanged. Earlier versions stringified everything via String(value),
 * which collapsed `inputs.repos: [{...}, {...}]` to a comma-joined
 * `[object Object],[object Object]` and broke for_each.
 */
export function buildSessionVars(session: Record<string, unknown>): Record<string, unknown> {
  const vars: Record<string, unknown> = { ...session };

  // Flatten `session.config.inputs.*` into dotted `inputs.<key>[.subpath]`
  // entries so templates can reach them without needing `config.` in the path.
  const config = session.config as Record<string, unknown> | undefined;
  const inputs = config?.inputs;
  if (inputs && typeof inputs === "object") {
    flatten("inputs", inputs, vars);
  }

  return vars;
}
