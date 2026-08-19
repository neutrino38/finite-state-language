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
 * validation, same `initial_state` rule — and differs in three ways:
 * `data` replaces `context` (the host's context is shared, the block
 * only owns a sandbox), `timeout` bounds the whole block rather than
 * one state, and there is no `start()`: a block has no context to make,
 * so nothing can run it alone.
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
  Ret extends AnyEvent = AnyEvent,
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
    const timeout = def.timeout;
    if (timeout !== undefined) {
      if (typeof timeout.delay !== "number" || timeout.delay < 0) {
        throw new TypeError(`block '${def.name}': invalid timeout.delay`);
      }
      if (typeof timeout.then !== "function") {
        throw new TypeError(
          `block '${def.name}': timeout.then must be a function`,
        );
      }
    }

    // Declaration order defines next(), as in a machine (spec §3.1).
    const successor: Record<string, string | undefined> = {};
    for (let i = 0; i < names.length - 1; i++) {
      successor[names[i] as string] = names[i + 1];
    }

    const internal = def as unknown as InternalSbbDef;
    const block = {
      name: def.name,
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
