// @ts-check
/**
 * Plain-JavaScript consumer fixture (plan M2), type-checked against the
 * BUILT package (dist/index.d.ts) with checkJs: validates that a JS
 * project gets completion, inference and state-name checking without
 * writing TypeScript (spec §1.1 "zero cost for JS users").
 *
 * Run with: npm run check:js-consumer (requires npm run build first).
 */
import { defineMachine, goto, success } from "finite-state-language";

/** @typedef {{ attempts: number, last?: string }} Ctx */
/** @typedef {{ type: "go", label: string } | { type: "quit" }} Ev */

// ---- typed tier: bind Ctx/Ev through a JSDoc cast -------------------------

const defineTyped = /** @type {typeof defineMachine<Ctx, Ev>} */ (
  defineMachine
);

const Typed = defineTyped()({
  name: "JsConsumer",
  context: () => ({ attempts: 0 }),
  states: {
    initial_state: {
      on: {
        go: (ev, ctx) => {
          ctx.attempts += 1;
          ctx.last = ev.label; // payload narrowed from the Ev union
          return goto("armed");
        },
      },
    },
    armed: {
      on: {
        quit: () => success("done"),
        // @ts-expect-error — state-name checking works from JS too
        go: () => goto("armd"),
      },
    },
  },
});

const typed = Typed.start();
typed.send({ type: "go", label: "first" });
// @ts-expect-error — wrong payload field type
typed.send({ type: "go", label: 42 });
// @ts-expect-error — unknown event type
typed.send({ type: "frob" });

/** @type {"initial_state" | "armed" | import("finite-state-language").TerminalStateName} */
const state = typed.state;
void state;

// ---- zero-effort tier: no type annotations at all ---------------------------

const Loose = defineMachine()({
  name: "Loose",
  context: () => ({ hits: 0 }),
  states: {
    initial_state: {
      on: {
        "*": (ev, ctx) => {
          ctx.hits += 1;
          void ev.type;
          return goto("end");
        },
      },
    },
    end: {
      // @ts-expect-error — even untyped, state names are still checked
      enter: () => goto("dne"),
    },
  },
});

const loose = Loose.start();
loose.send({ type: "anything-goes" });
void loose.matches("end");
