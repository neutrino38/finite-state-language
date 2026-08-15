# Contributing to FSL

Thanks for stopping by — the API is still soft, which means your use
case can still shape it. Issues that challenge the spec are as welcome
as pull requests.

## The one rule

**The spec is the arbiter.** [`spec/fsl-js-ts.md`](spec/fsl-js-ts.md)
defines the language; the TypeScript implementation under
[`typescript/`](typescript/) follows it, and the Elixir implementation
will too. If the implementation and the spec disagree, one of them has
a bug — say so in the issue. Deliberate divergences are documented in
the spec, and implementation-driven findings are recorded in
[`typescript/docs/design.md`](typescript/docs/design.md) §11.

## Working on the TypeScript implementation

```sh
cd typescript
npm ci
npm run build && npm test && npm run lint
```

Everything must stay green: build, tests (runtime **and** type-level),
eslint, prettier, and `npm run check:js-consumer` (the plain-JS
consumer fixture, which needs a `npm run build` first).

House rules, enforced by CI:

- **Zero runtime dependencies in the core.** `npm run check:zero-deps`
  fails the build otherwise. Dev dependencies must be mainstream,
  maintained and security-clean.
- **Every runtime rule cites its spec section.** Tests are named after
  the section they verify (`§4.2 replay order`, `§8.3 teardown
  ordering`). If you fix a behaviour, point the test at the paragraph
  that mandates it.
- **Compile-time behaviour is tested, not assumed** — deliberate misuse
  belongs in `test/types.test-d.ts` under `@ts-expect-error`.
- The core must keep running in browsers, Node ≥ 18 and workers alike:
  no DOM, no Node-only APIs.

## Style

Prettier formats, eslint lints (`npm run format` / `npm run lint`).
Readability outranks cleverness — a machine you can print is a machine
you can review, and the same goes for the runtime.

## License

By contributing you agree that your contributions are licensed under
the [Apache License 2.0](LICENSE).
