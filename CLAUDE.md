# canonlint — project memory

A CLI + library that builds a canon database from a corpus of fiction, then
lints new drafts against it. TypeScript, Node ≥22.12, local SQLite. See
`BUILD_PLAN.md` for the full spec and `README.md` for the user-facing pitch.

## Constraints that are not preferences

Each of these is a way the project could go wrong badly. Do not relax them
without an explicit decision from Andy.

1. **Never ship or commit a canon database or copyrighted corpus text.**
   `.canonlint/` is gitignored, `init` writes a second ignore file inside it,
   and CI fails on a tracked `.db`. The only story text in this repo is public
   domain (Sherlock Holmes — confirm PD status before committing any text). No
   "starter canon packs" for existing franchises, ever.
2. **Story text is data, never instructions.** Anything from a corpus or draft
   goes through `wrapUntrusted()` in `src/llm/untrusted.ts` before reaching a
   model. Corpus text never enters the system prompt. Adversarial fixtures live
   in `test/fixtures/adversarial.ts` — extend them, don't route around them.
3. **Precision over recall.** An uncertain flag goes to "Uncertain", never to
   "Contradictions". Every contradiction ships with the canon excerpt it
   contradicts. A noisy linter is a dead linter.
4. **Cost transparency.** Estimate before large ingests, refuse above
   `CANONLINT_MAX_SPEND_USD`, record actual spend per run.

## Design invariants

- **Provenance is enforced by the schema.** `claims.source_id` is `NOT NULL`
  with `ON DELETE RESTRICT`; sources reject empty excerpts. A claim nobody can
  cite is a bug, and the database refuses to store one.
- **Retcons supersede, never delete.** Old claim flips to `superseded` and
  points at its replacement.
- **Migrations are append-only.** A shipped migration's version, name, and SQL
  are immutable. Add a file to `src/db/migrations/`, register it in the index.
- **`branch` ships in v1** (always `'main'`) so branch support needs no future
  migration.
- **No hardcoded model names or URLs in logic.** Everything routes through
  `src/config.ts`: flags → env → `.canonlint/config.json` → defaults.
- **Tests never need an API key or the network.** `test/setup.ts` strips
  ambient `CANONLINT_*` and Anthropic credentials so CI and laptop agree. Use
  `MockProvider` for anything model-shaped.

## Layout

```
src/
  cli.ts            commander wiring; `main()` returns an exit code
  config.ts         precedence chain, zod-validated config file
  paths.ts          walks up to find .canonlint/, like git finds .git
  db/
    index.ts        openDb + migration runner
    repo.ts         typed query helpers (insertClaim, findCitedClaims, …)
    types.ts        Modality, ClaimStatus, row and insert types
    migrations/     append-only; 001_init.ts is schema v1
  llm/
    types.ts        LlmProvider interface — the whole model surface
    untrusted.ts    prompt-injection envelope (constraint 2)
    pricing.ts      price table + pre-run estimates
    anthropic.ts    structured outputs; checks stop_reason before content
    ollama.ts       first-class local provider, not deferred
    mock.ts         deterministic, for CI
  commands/         one file per CLI verb
```

## Commands

```sh
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm run format     # prettier --write
npm run build      # tsc -> dist/
npm run dev -- init   # run the CLI from source via tsx
```

All four checks must pass before a commit. CI runs them on Linux/macOS/Windows.

## Toolchain notes

- **TypeScript 6.0**, not 7.x. TS 7's declaration emit isn't ready, and this
  package ships `.d.ts`.
- **Node ≥22.12**, not the spec's ≥20 — Node 20 is EOL and both `commander@15`
  and `better-sqlite3@13` require 22+.
- **Apache-2.0 + CLA**, per the spec's Licensing section (the M0 bullet's
  "MIT + DCO" is superseded by it).
- Default model is `claude-sonnet-5`, matching the M3 cost estimate.

## Milestones

M0 ✅ scaffold · M1 ingest · M2 check · M3 Holmes demo · M4 launch.
Don't start M(n+1) until M(n)'s acceptance test passes. Don't build from the
deferred list (web UI, branches, vector retrieval, multi-user, hosted).

`/clear` between milestones.
