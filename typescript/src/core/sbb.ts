/**
 * defineSbb — Service Building Blocks (spec §8.4, design §12).
 *
 * A block is a reusable fragment of a state machine behind a callable
 * face: a sequence written once — establish a call, run a menu, collect
 * credentials — that a host machine enters and observes through a
 * handful of service-level events.
 *
 * It is a *subroutine call*, not a second actor. `fx.spawn` starts a
 * machine with state of its own; `fx.sbb` calls a block that works on
 * the state its host already holds.
 *
 * The shape mirrors `defineMachine` — same currying, same runtime
 * validation, same `initial_state` rule — and differs in four ways:
 * `data` replaces `context` (the host's context is shared, the block
 * only owns a sandbox), `namespace` + `returns` declare the vocabulary
 * the block talks back with, `timeout` bounds the whole block rather
 * than one state, and there is no `start()`: a block has no context to
 * make, so nothing can run it alone.
 */

import type { AnyEvent, Sbb, SbbDef, SbbFx, StateDef } from "./types.js";
import { TERMINAL_STATES } from "./types.js";
import { registerSbb, type InternalSbbDef } from "./instance.js";
import { renderMermaid } from "./mermaid.js";

const RESERVED = new Set<string>(Object.values(TERMINAL_STATES));

export function defineSbb<
  // Same defaults as defineMachine: a plain-JS consumer still gets
  // typed state names, while ctx/events/data stay loose.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Ctx = Record<string, any>,
  Ev extends AnyEvent = AnyEvent,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Data = Record<string, any>,
  // The default has to match the `namespace:outcome` shape, or a
  // plain-JS `defineSbb()` would derive `never` for its namespace and
  // its outcomes and could not be written at all.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Ret extends AnyEvent = { type: `${string}:${string}`; data: any },
>() {
  return <SN extends string>(
    // The intersection requires `initial_state` at compile time without
    // adding an inference site for SN, exactly as defineMachine does —
    // and it must name the real fx type, or every handler in
    // initial_state loses its contextual typing.
    def: SbbDef<Ctx, Ev, Data, Ret, SN> & {
      states: {
        initial_state: StateDef<
          Ctx,
          Ev,
          NoInfer<SN>,
          SbbFx<Ev, Ctx, Data, Ret>
        >;
      };
    },
  ): Sbb<Ctx, Ev, Data, Ret, SN> => {
    if (typeof def.name !== "string" || def.name.length === 0) {
      throw new TypeError("defineSbb: 'name' must be a non-empty string");
    }
    // The namespace leads every return, so it has to be one word: a ':'
    // inside it would make `namespace:outcome` ambiguous to split, and
    // to read.
    const namespace = def.namespace as unknown;
    if (
      typeof namespace !== "string" ||
      namespace.length === 0 ||
      namespace.includes(":")
    ) {
      throw new TypeError(
        `block '${def.name}': 'namespace' must be a non-empty string without ':'`,
      );
    }
    const returns = def.returns as unknown;
    if (returns === null || typeof returns !== "object") {
      throw new TypeError(
        `block '${def.name}': 'returns' must map each outcome to what it means`,
      );
    }
    const outcomes = Object.keys(returns as Record<string, unknown>);
    if (outcomes.length === 0) {
      throw new TypeError(
        `block '${def.name}': 'returns' declares no outcome — a block that ` +
          `cannot return leaves its host waiting for ever`,
      );
    }
    for (const o of outcomes) {
      if (o.includes(":")) {
        throw new TypeError(
          `block '${def.name}': outcome '${o}' must not contain ':'`,
        );
      }
    }
    if (typeof def.data !== "function") {
      throw new TypeError(`block '${def.name}': 'data' must be a factory`);
    }
    const states = def.states as Record<string, StateDef<Ctx, Ev, SN>>;
    if (states === null || typeof states !== "object") {
      throw new TypeError(`block '${def.name}': 'states' must be an object`);
    }
    const names = Object.keys(states);
    if (!names.includes("initial_state")) {
      throw new TypeError(
        `block '${def.name}': states must declare 'initial_state'`,
      );
    }
    for (const n of names) {
      if (RESERVED.has(n)) {
        throw new TypeError(
          `block '${def.name}': state name '${n}' is reserved`,
        );
      }
    }
    for (const [stateName, stateDef] of Object.entries(states)) {
      for (const [evType, clause] of Object.entries(stateDef.on ?? {})) {
        if (typeof clause === "string" && !names.includes(clause)) {
          throw new TypeError(
            `block '${def.name}': state '${stateName}' routes ` +
              `'${evType}' to unknown state '${clause}'`,
          );
        }
      }
      const after = stateDef.after;
      if (after !== undefined) {
        if (typeof after.delay !== "number" || after.delay < 0) {
          throw new TypeError(
            `block '${def.name}': state '${stateName}' has an invalid after.delay`,
          );
        }
        if (typeof after.then !== "function") {
          throw new TypeError(
            `block '${def.name}': state '${stateName}' after.then must be a function`,
          );
        }
      }
    }
    // The bound is mandatory, `"infinity"` being how a block says it has
    // none of its own. A block that runs unbounded by accident is the
    // silence this layer exists to prevent, so the author decides.
    const timeout = def.timeout;
    if (timeout === null || typeof timeout !== "object") {
      throw new TypeError(
        `block '${def.name}': 'timeout' is required — give it a delay, ` +
          `or { delay: "infinity" } if the block has no bound of its own`,
      );
    }
    if (
      timeout.delay !== "infinity" &&
      (typeof timeout.delay !== "number" || timeout.delay < 0)
    ) {
      throw new TypeError(
        `block '${def.name}': timeout.delay must be a positive number or "infinity"`,
      );
    }
    if (timeout.then !== undefined && typeof timeout.then !== "function") {
      throw new TypeError(
        `block '${def.name}': timeout.then must be a function`,
      );
    }
    // Without a `then` the deadline returns `<namespace>:timeout`, which
    // only works if the block declared that outcome — otherwise expiry
    // would post an event the host has no clause for.
    if (
      timeout.delay !== "infinity" &&
      timeout.then === undefined &&
      !outcomes.includes("timeout")
    ) {
      throw new TypeError(
        `block '${def.name}': a bounded block without timeout.then returns ` +
          `'${namespace}:timeout' — declare it in 'returns', or handle the ` +
          `deadline yourself with timeout.then`,
      );
    }

    // Declaration order defines next(), as in a machine (spec §3.1).
    const successor: Record<string, string | undefined> = {};
    for (let i = 0; i < names.length - 1; i++) {
      successor[names[i] as string] = names[i + 1];
    }

    const internal = def as unknown as InternalSbbDef;
    const block = {
      name: def.name,
      namespace,
      returns: Object.freeze({ ...(returns as Record<string, string>) }),
      toMermaid: () =>
        renderMermaid({
          name: def.name,
          context: () => ({}),
          states: internal.states,
        }),
    } as Sbb<Ctx, Ev, Data, Ret, SN>;
    registerSbb(block, { def: internal, successor });
    return block;
  };
}
