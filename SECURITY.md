# Security Policy

## Reporting a vulnerability

Please report privately via
[GitHub Security Advisories](https://github.com/AlphaBetSoup789/canonlint/security/advisories/new)
rather than opening a public issue.

This is a low-maintenance project (see the README). A response may take a
while. If you need a fix on a schedule, forking is encouraged.

## What counts as a vulnerability here

canonlint's threat model is unusual for a CLI tool, because **the input is
untrusted prose that gets handed to a language model.**

Especially interested in:

- **Prompt-injection escapes.** A passage of story text that breaks out of the
  `wrapUntrusted()` envelope in `src/llm/untrusted.ts` and gets treated as an
  instruction — e.g. forging a closing delimiter, or otherwise causing model
  output to be steered by corpus content rather than by the system prompt.
- **Provenance forgery.** Any path that produces a claim with no source, a
  fabricated excerpt, or an excerpt that does not appear in the cited work.
- **Path traversal or arbitrary write** via a crafted corpus filename, work
  title, or locator.
- **SQL injection** through entity names, attributes, or other extracted
  values.
- **Credential leakage** — an API key reaching a log, a report file, or the
  canon database.

Also in scope, though not a classic vulnerability: anything that causes a canon
database or corpus excerpt to be written somewhere it could be committed or
transmitted. Keeping extracted text local is a design constraint, not a
preference.

## Not vulnerabilities

- A model producing a wrong or low-quality extraction. That's a precision bug —
  open a normal issue.
- Cost overruns from a large ingest that you approved. Set
  `CANONLINT_MAX_SPEND_USD` lower.
- Anything requiring an attacker to already have write access to your
  `.canonlint/` directory.
