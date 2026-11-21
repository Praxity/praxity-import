# 0006 Corpus checks and portable packaging

Status: accepted, 2026-11-20

## Context

Bench runs need to expose missing coverage. Portable releases must carry only
audited runtime files, while the installed agent skill has its own file boundary.

## Decision

- In `scripts/corpus.ts`, `loadSources` reads public sources and the local private
  list when present. Private course material stays outside version control.
  In `scripts/fetch-corpus.ts`, `fetchPublic` uses pinned commits or SHA-256
  downloads and retains only the named course member from a bundle archive.
- In `scripts/bench.ts`, `bench` imports twice, strips verification from each
  report and compares the rest: only the first import runs verification.
  The top-level release mode requires the private source list so missing local
  coverage cannot look like a successful release bench. Missing inputs,
  failed parsing/verification of recognised inputs and nondeterminism are
  regressions; refusing an unsupported format is expected.
- In `scripts/package.mjs`, `runtimePackages` is the audited runtime inventory
  tied to third-party notices. A dependency update requires review of its runtime
  files and licence. `collect` validates text payload bytes as well as file
  extensions, rejecting disguised native binaries. `build` rechecks after
  reading and validates before creating output.
- In `scripts/test.ts`, the top-level runner uses Node so the command works
  under Windows cmd as well as POSIX shells. It sets TMPDIR and TEMP/TMP to
  the test output directory because os.tmpdir reads different variables on
  the two platforms.
- The installation checks "skill links resolve inside the installed skill
  folder" (`test/skill.test.ts`) and "package follows skill reference links and
  refuses links to private or external files" (`test/package.test.ts`) treat
  `skill/` as the whole Rubato-installed unit. Relative links must resolve
  inside it; references to external project documentation use public URLs.

Sources: `AGENTS.md`; the corresponding comments and implementations at
[`b47d3a416c2512e48b77877c7798ecfb1d6400ae`](https://github.com/Praxity/praxity-import/tree/b47d3a416c2512e48b77877c7798ecfb1d6400ae);
`test/corpus.test.ts`, `test/package.test.ts` and `test/skill.test.ts`.

## Consequences

A passing public-only bench is insufficient for a release. Development
packages, local corpora and checkout-only documentation do not become portable
runtime payloads merely because they are installed in the checkout.
