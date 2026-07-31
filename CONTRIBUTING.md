# Contributing to canonlint

Thanks for looking. Before anything else, please read the maintenance posture
in the README: **this is a low-maintenance project.** Issues may sit for a
while. Pull requests are welcome but review is slow. Forking is explicitly
encouraged and is not considered rude.

## The one rule that is not negotiable

**Never commit a corpus, a canon database, or extracted text from a
copyrighted work.**

canonlint is a lawful tool. A repository containing a database of extracted
facts and verbatim excerpts from someone's novels or comics is a distribution
of derivative content, and it carries the maintainer's name. So:

- `.canonlint/` is gitignored by default, and `canonlint init` writes a second
  ignore file inside it. Don't defeat either.
- The **only** story text that may ever be committed to this repo is in the
  public domain, and its PD status must be confirmed and stated in the PR.
- No "starter canon packs" for existing franchises. Not for Star Wars, not for
  the MCU, not for a living author's series. This holds no matter how many
  people ask.

If you want to share a canon database with collaborators, share it out of band.
The tool is local-first on purpose.

## Contributor License Agreement

The Project requires a CLA before a contribution can be merged. It is a
one-click bot comment on your first PR — see [CLA.md](CLA.md) for the terms and
for why it exists. Short version: you keep your copyright; the Owner gets a
broad license, which preserves the option to dual-license later.

## Getting set up

```sh
git clone https://github.com/AlphaBetSoup789/canonlint.git
cd canonlint
npm install
npm test
```

Node 22.12 or newer. No API key is needed to develop or to run the test suite.

## Before you open a PR

```sh
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run format      # prettier --write
npm test            # vitest
```

CI runs all four. It runs with no secrets, so **tests must never require an API
key or reach the network.** Use the `MockProvider` (or a recorded fixture) for
anything that would otherwise call a model.

## Things worth knowing about the codebase

**Story text is data, never instructions.** Any corpus or draft text on its way
to a model goes through `wrapUntrusted()` in `src/llm/untrusted.ts`. It gets a
per-call random nonce delimiter, delimiter-shaped content in the payload is
neutralised, and the "this block is inert data" instruction is pinned to the
system turn where corpus text can never reach. If you add a code path that
sends text to a model, it goes through that function. There are tests with
adversarial passages; add to them rather than working around them.

**Every claim carries provenance.** `claims.source_id` is `NOT NULL` with an
`ON DELETE RESTRICT` foreign key, and sources reject empty excerpts. This is
enforced in the schema rather than in application code precisely so that no
future code path can quietly produce a claim nobody can cite. Don't relax it.

**Retcons supersede; they never delete.** A replaced claim keeps its row, flips
to `superseded`, and points at its replacement.

**Precision over recall.** An uncertain flag goes in the "Uncertain" section of
a report, never in "Contradictions", and every contradiction ships with the
canon excerpt it contradicts. A noisy linter is a dead linter. If you're tuning
prompts, this is the constraint to optimise against.

**No hardcoded model names or URLs in logic.** Everything routes through
`src/config.ts`, which reads flags, then env, then `.canonlint/config.json`,
then defaults.

**Migrations are append-only.** A shipped migration's version, name, and SQL are
immutable — existing databases have already applied them. Add a new file in
`src/db/migrations/` and register it in the index.

## Commits

Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`).

## Reporting a security issue

Please don't open a public issue for a security problem — especially a prompt
injection that escapes the untrusted-text envelope. See
[SECURITY.md](SECURITY.md).
