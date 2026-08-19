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
  /**
   * Whether this came from `defineMachine` or `defineSbb`. A block is
   * drawn like a machine, and its `[*]` edges are its `fx.sbbReturn`
   * calls rather than its terminals (spec §8.4).
   */
  kind: "machine" | "block";
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
  /**
   * Blocks each state enters with `fx.sbb`, in call order. A state whose
   * `enter` is one `fx.sbb` has no outgoing edge of its own — it waits
   * for the block — so without this the graph would show it as a dead
   * end and lose the whole sequence hanging off it.
   */
  blocks: StateEvents[];
}

/** What a handler can reach. `desc` is the transition description, when it is a literal. */
type Outcome =
  | { kind: "goto"; to: string; desc?: string }
  | { kind: "self"; desc?: string }
  | { kind: "next"; desc?: string }
  | { kind: "final"; outcome: "success" | "failure" | "aborted" }
  | { kind: "return"; event?: string };

interface Reachable {
  outcomes: Outcome[];
  forwards: boolean;
  /** Blocks entered with `fx.sbb`, in call order. */
  blocks: string[];
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
  const blocks: string[] = [];
  let forwards = false;

  const descend = (name: string): void => {
    const fn = helpers.get(name);
    if (fn?.body === undefined || seen.has(name)) return;
    seen.add(name);
    const inner = collect(fn.body, helpers, seen);
    outcomes.push(...inner.outcomes);
    blocks.push(...inner.blocks);
    forwards = forwards || inner.forwards;
  };

  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && helpers.has(n.text)) {
      descend(n.text);
    } else if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression)
    ) {
      const effect = n.expression.name.text;
      const [arg] = n.arguments;
      if (effect === "notify") {
        forwards = true;
      } else if (
        effect === "sbb" &&
        arg !== undefined &&
        ts.isIdentifier(arg)
      ) {
        // `fx.sbb(Establish)` — the block is named by an identifier, the
        // one thing about a subroutine call the source always states.
        if (!blocks.includes(arg.text)) blocks.push(arg.text);
      } else if (effect === "sbbReturn") {
        outcomes.push({ kind: "return", event: eventType(arg) });
      }
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
  return { outcomes, forwards, blocks };
}

/** `fx.sbbReturn({ type: "call:connected", … })` → `"call:connected"`. */
function eventType(arg: ts.Expression | undefined): string | undefined {
  if (arg === undefined || !ts.isObjectLiteralExpression(arg)) return undefined;
  const typeProp = property(arg, "type");
  return typeProp !== undefined && ts.isPropertyAssignment(typeProp)
    ? literal(typeProp.initializer)
    : undefined;
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

interface Definition {
  def: ts.ObjectLiteralExpression;
  kind: "machine" | "block";
}

/**
 * Every `defineMachine<…>()({…})` and `defineSbb<…>()({…})` argument in
 * the file, in source order. A file usually holds a machine and the
 * blocks it calls, and both belong in the diagram.
 */
function definitions(source: ts.SourceFile): Definition[] {
  const found: Definition[] = [];

  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isCallExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      (n.expression.expression.text === "defineMachine" ||
        n.expression.expression.text === "defineSbb") &&
      n.arguments.length === 1
    ) {
      const [def] = n.arguments;
      if (def !== undefined && ts.isObjectLiteralExpression(def)) {
        found.push({
          def,
          kind:
            n.expression.expression.text === "defineSbb" ? "block" : "machine",
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(source);

  return found;
}

function graphOf(
  def: ts.ObjectLiteralExpression,
  kind: "machine" | "block",
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
  const blocks: StateEvents[] = [];

  // A block-level `timeout` bounds every state of the block, so it is a
  // trigger of each of them (spec §8.4).
  const blockTimeout = kind === "block" ? timeoutTrigger(def) : undefined;

  members.forEach(({ name: state, body }, index) => {
    const forwardedHere: string[] = [];
    const consumedHere: string[] = [];
    const blocksHere: string[] = [];

    const triggers = triggersOf(body);
    if (blockTimeout !== undefined) triggers.push(blockTimeout);

    for (const trigger of triggers) {
      const {
        outcomes,
        forwards,
        blocks: entered,
      } = collect(trigger.node, helpers, new Set());
      for (const b of entered) if (!blocksHere.includes(b)) blocksHere.push(b);
      if (outcomes.length === 0) {
        if (trigger.isEvent && entered.length === 0)
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
            break;
          case "return":
            // Leaving a block is leaving the diagram it is drawn in.
            to = END;
            desc = outcome.event ?? "sbbReturn";
        }
        addEdge(state, to, desc ? `${trigger.label} (${desc})` : trigger.label);
      }
    }

    if (forwardedHere.length > 0)
      forwarded.push({ state, events: forwardedHere });
    if (consumedHere.length > 0) consumed.push({ state, events: consumedHere });
    if (blocksHere.length > 0) blocks.push({ state, events: blocksHere });
  });

  return {
    name,
    kind,
    states,
    edges: [...edges.values()],
    forwarded,
    consumed,
    blocks,
  };
}

/** A block's own deadline, as a trigger shared by all of its states. */
function timeoutTrigger(def: ts.ObjectLiteralExpression): Trigger | undefined {
  const timeout = objectProperty(def, "timeout");
  if (timeout === undefined) return undefined;
  const delay = property(timeout, "delay");
  const then = property(timeout, "then");
  const thenBody = then && value(then);
  if (!delay || !ts.isPropertyAssignment(delay) || !thenBody) return undefined;
  return {
    label: delayLabel(delay.initializer),
    node: thenBody,
    isEvent: false,
  };
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

  return definitions(source).map(({ def, kind }) =>
    graphOf(def, kind, helpers),
  );
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
 *
 * `blocks` are the exception, and they earn it: a state that enters one
 * has no outgoing edge until it returns, so leaving it out draws a dead
 * end where the whole sequence is. One block name per line keeps the
 * box narrow.
 */
export function renderMermaid(graph: MachineGraph): string {
  const entered = new Map(graph.blocks.map((b) => [b.state, b.events]));
  const decls: string[] = [];
  const descs: string[] = [];
  for (const name of graph.states) {
    const id = mermaidId(name);
    const blocks = entered.get(name) ?? [];
    const bare = id === name && blocks.length === 0;
    decls.push(bare ? `  state ${name}` : `  state "${name}" as ${id}`);
    for (const block of blocks) descs.push(`  ${id} : sbb ${block}`);
  }
  const arrows = graph.edges.map(
    (e) =>
      `  ${mermaidId(e.from)} --> ${mermaidId(e.to)}: ${e.labels.join(", ")}`,
  );
  return [
    "stateDiagram-v2",
    ...decls,
    `  [*] --> initial_state`,
    ...arrows,
    ...descs,
  ].join("\n");
}
