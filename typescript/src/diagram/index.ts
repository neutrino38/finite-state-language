/**
 * finite-state-language/diagram — the transition graph of a machine,
 * extracted from its TypeScript source (spec §6.1, design §9).
 *
 * `Machine.toMermaid()` runs against the live definition, where handlers
 * are opaque closures: the only edge it can see is the string shorthand
 * `on: { evt: "target" }`. A machine whose handlers all return `goto(…)`
 * therefore prints as a list of states with no arrows at all.
 *
 * The source does not hide anything. `goto("ready")` names its target in
 * plain text, so a build-time pass over the AST recovers the real graph.
 * This module is that pass. It is a build tool, not part of the runtime:
 * it needs `typescript` (an optional peer dependency), so the core keeps
 * its zero-dependency promise.
 *
 * The extraction is a deliberate over-approximation: every transition
 * constructor reachable from a handler becomes an edge, guard conditions
 * ignored. A branch that cannot fire at runtime is still drawn. Only
 * string-literal descriptions become labels — a template literal has no
 * static value.
 */

import ts from "typescript";

/** One arrow of the graph. Parallel edges are merged, so `labels` may hold several events. */
export interface Edge {
  from: string;
  /** A state name, or `"[*]"` for the end of the machine. */
  to: string;
  labels: string[];
}

/** Events a state handles without moving, grouped per state. */
export interface StateEvents {
  state: string;
  events: string[];
}

export interface MachineGraph {
  /** The machine's `name`, as declared in its definition. */
  name: string;
  /** Every state, in declaration order — the order that gives `next()` its meaning. */
  states: string[];
  edges: Edge[];
  /**
   * Events handed to a child machine (`fx.notify`). They drive the child,
   * not this machine; calling them merely consumed would read as
   * "does nothing". `fx.send` does not count — it re-injects into this
   * machine's own queue.
   */
  forwarded: StateEvents[];
  /** Events this state handles with no transition and no forwarding. */
  consumed: StateEvents[];
}

/** What a handler can reach. `desc` is the transition description, when it is a literal. */
type Outcome =
  | { kind: "goto"; to: string; desc?: string }
  | { kind: "self"; desc?: string }
  | { kind: "next"; desc?: string }
  | { kind: "final"; outcome: "success" | "failure" | "aborted" };

interface Reachable {
  outcomes: Outcome[];
  forwards: boolean;
}

/** A state's outgoing triggers, in declaration order. */
interface Trigger {
  label: string;
  node: ts.Node;
  /** `enter` and `after` are not events: they never end up in the consumed list. */
  isEvent: boolean;
}

const FINAL_DESC = {
  success: "success",
  failure: "failure",
  aborted: "aborted",
} as const;

const END = "[*]";

/** Property names are written both bare (`enter`) and quoted (`"ui:call"`). */
function key(node: ts.PropertyName): string {
  return node.getText().replace(/"/g, "");
}

function literal(arg: ts.Expression | undefined): string | undefined {
  return arg !== undefined && ts.isStringLiteralLike(arg)
    ? arg.text
    : undefined;
}

/**
 * Walks an expression and every module-level function it names,
 * collecting the transition constructors it can reach. A shared helper
 * (`function fail(ctx) { return goto("reg_failed") }`) holds real
 * targets, so a handler that calls one inherits its outcomes. `seen`
 * stops the walk from looping on mutual recursion.
 */
function collect(
  node: ts.Node,
  helpers: Map<string, ts.FunctionDeclaration>,
  seen: Set<string>,
): Reachable {
  const outcomes: Outcome[] = [];
  let forwards = false;

  const descend = (name: string): void => {
    const fn = helpers.get(name);
    if (fn?.body === undefined || seen.has(name)) return;
    seen.add(name);
    const inner = collect(fn.body, helpers, seen);
    outcomes.push(...inner.outcomes);
    forwards = forwards || inner.forwards;
  };

  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && helpers.has(n.text)) {
      descend(n.text);
    } else if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression)
    ) {
      if (n.expression.name.text === "notify") forwards = true;
    } else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const [first, second] = n.arguments;
      switch (n.expression.text) {
        case "goto": {
          const to = literal(first);
          if (to !== undefined)
            outcomes.push({ kind: "goto", to, desc: literal(second) });
          break;
        }
        case "stay":
        case "loop":
          outcomes.push({ kind: "self", desc: literal(first) });
          break;
        case "next":
          outcomes.push({ kind: "next", desc: literal(first) });
          break;
        case "success":
        case "failure":
        case "aborted":
          outcomes.push({ kind: "final", outcome: n.expression.text });
          break;
      }
    }
    ts.forEachChild(n, visit);
  };

  visit(node);
  return { outcomes, forwards };
}

/** `90_000` → `after 90 s`, `3500` → `after 3500 ms`. */
function delayLabel(expr: ts.Expression): string {
  const ms = Number(expr.getText().replace(/_/g, ""));
  return Number.isInteger(ms / 1000)
    ? `after ${ms / 1000} s`
    : `after ${ms} ms`;
}

function property(
  obj: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralElementLike | undefined {
  return obj.properties.find(
    (p) => p.name !== undefined && key(p.name) === name,
  );
}

/** The value of a member, whether written `on: {…}` or `enter() {…}`. */
function value(member: ts.ObjectLiteralElementLike): ts.Node | undefined {
  if (ts.isPropertyAssignment(member)) return member.initializer;
  if (ts.isMethodDeclaration(member)) return member.body;
  return undefined;
}

function objectProperty(
  obj: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralExpression | undefined {
  const member = property(obj, name);
  const node = member && value(member);
  return node !== undefined && ts.isObjectLiteralExpression(node)
    ? node
    : undefined;
}

function triggersOf(state: ts.ObjectLiteralExpression): Trigger[] {
  const triggers: Trigger[] = [];

  const enterDef = property(state, "enter");
  const enterBody = enterDef && value(enterDef);
  if (enterBody)
    triggers.push({ label: "enter", node: enterBody, isEvent: false });

  const on = objectProperty(state, "on");
  if (on !== undefined) {
    for (const clause of on.properties) {
      const handler = value(clause);
      if (clause.name === undefined || handler === undefined) continue;
      triggers.push({ label: key(clause.name), node: handler, isEvent: true });
    }
  }

  const after = objectProperty(state, "after");
  if (after !== undefined) {
    const delay = property(after, "delay");
    const then = property(after, "then");
    const thenBody = then && value(then);
    if (delay && ts.isPropertyAssignment(delay) && thenBody) {
      triggers.push({
        label: delayLabel(delay.initializer),
        node: thenBody,
        isEvent: false,
      });
    }
  }

  return triggers;
}

/** Every `defineMachine<…>()({…})` argument in the file, in source order. */
function definitions(source: ts.SourceFile): ts.ObjectLiteralExpression[] {
  const found: ts.ObjectLiteralExpression[] = [];

  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isCallExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === "defineMachine" &&
      n.arguments.length === 1
    ) {
      const [def] = n.arguments;
      if (def !== undefined && ts.isObjectLiteralExpression(def))
        found.push(def);
    }
    ts.forEachChild(n, visit);
  };
  visit(source);

  return found;
}

function graphOf(
  def: ts.ObjectLiteralExpression,
  helpers: Map<string, ts.FunctionDeclaration>,
): MachineGraph {
  const nameDef = property(def, "name");
  const name =
    nameDef !== undefined && ts.isPropertyAssignment(nameDef)
      ? (literal(nameDef.initializer) ?? "")
      : "";

  const statesObj = objectProperty(def, "states");
  if (statesObj === undefined) {
    throw new Error(`machine '${name}': 'states' is not an object literal`);
  }

  const members = statesObj.properties.flatMap((member) => {
    const body = value(member);
    if (
      member.name === undefined ||
      body === undefined ||
      !ts.isObjectLiteralExpression(body)
    ) {
      return [];
    }
    return [{ name: key(member.name), body }];
  });
  const states = members.map((m) => m.name);

  const edges = new Map<string, Edge>();
  const addEdge = (from: string, to: string, label: string): void => {
    const id = `${from} ${to}`;
    const edge = edges.get(id) ?? { from, to, labels: [] };
    if (!edge.labels.includes(label)) edge.labels.push(label);
    edges.set(id, edge);
  };

  const forwarded: StateEvents[] = [];
  const consumed: StateEvents[] = [];

  members.forEach(({ name: state, body }, index) => {
    const forwardedHere: string[] = [];
    const consumedHere: string[] = [];

    for (const trigger of triggersOf(body)) {
      const { outcomes, forwards } = collect(trigger.node, helpers, new Set());
      if (outcomes.length === 0) {
        if (trigger.isEvent)
          (forwards ? forwardedHere : consumedHere).push(trigger.label);
        continue;
      }
      for (const outcome of outcomes) {
        // `next()` is the state declared after this one; from the last
        // state the runtime settles with a failure instead (design §11.7).
        const successor = states[index + 1];
        let to: string;
        let desc: string | undefined;
        switch (outcome.kind) {
          case "goto":
            to = outcome.to;
            desc = outcome.desc;
            break;
          case "self":
            to = state;
            desc = outcome.desc;
            break;
          case "next":
            to = successor ?? END;
            desc = successor === undefined ? FINAL_DESC.failure : outcome.desc;
            break;
          case "final":
            to = END;
            desc = FINAL_DESC[outcome.outcome];
        }
        addEdge(state, to, desc ? `${trigger.label} (${desc})` : trigger.label);
      }
    }

    if (forwardedHere.length > 0)
      forwarded.push({ state, events: forwardedHere });
    if (consumedHere.length > 0) consumed.push({ state, events: consumedHere });
  });

  return { name, states, edges: [...edges.values()], forwarded, consumed };
}

/**
 * Extracts the graph of every machine defined in a TypeScript source.
 *
 * Takes the code, not a path: the caller owns file access, and this
 * module stays usable wherever a string is available.
 *
 * ```ts
 * const [graph] = machineGraphs(readFileSync("phone.ts", "utf8"), "phone.ts");
 * writeFileSync("phone.mmd", renderMermaid(graph));
 * ```
 */
export function machineGraphs(
  code: string,
  fileName = "machine.ts",
): MachineGraph[] {
  const source = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.ESNext,
    true,
  );

  const helpers = new Map<string, ts.FunctionDeclaration>();
  for (const st of source.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) helpers.set(st.name.text, st);
  }

  return definitions(source).map((def) => graphOf(def, helpers));
}

/** Mermaid node ids must be identifier-like; alias anything else. */
function mermaidId(name: string): string {
  return name === END ? END : name.replace(/\W/g, "_");
}

/**
 * Renders a graph as a mermaid `stateDiagram-v2`.
 *
 * `forwarded` and `consumed` are left out on purpose: as state
 * descriptions they stretch the boxes to the width of their longest
 * event list, which wrecks the layout of any real machine. Print them
 * beside the diagram instead.
 */
export function renderMermaid(graph: MachineGraph): string {
  const decls = graph.states.map((name) => {
    const id = mermaidId(name);
    return id === name ? `  state ${name}` : `  state "${name}" as ${id}`;
  });
  const arrows = graph.edges.map(
    (e) =>
      `  ${mermaidId(e.from)} --> ${mermaidId(e.to)}: ${e.labels.join(", ")}`,
  );
  return [
    "stateDiagram-v2",
    ...decls,
    `  [*] --> initial_state`,
    ...arrows,
  ].join("\n");
}
