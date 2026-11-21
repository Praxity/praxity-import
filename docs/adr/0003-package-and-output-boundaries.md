# 0003 Package and output boundaries

Status: accepted, 2026-11-20

## Context

Imports read untrusted archives, paths and JavaScript data. Output replacement
must also protect files from earlier imports. Removing the checks below can
turn a malformed course into a filesystem write outside the intended folder.

## Decision

- In `src/input.ts`, `extractZip` uses a 4 GiB expanded-byte cap, 20,000-entry
  cap and compression ratio of 100 above 1 MiB. Video courses can exceed
  512 MiB, while tiny files can legitimately compress at high ratios. Declared
  sizes provide an early refusal; streamed bytes enforce the actual cap.
  `Limits` injects smaller limits so bomb tests need no multi-gigabyte fixture.
- In `src/input.ts`, `asUnsafe` classifies yauzl's unsafe-name and size errors
  as unsafe archives. Keep the importer guards for symlinks, entry count,
  compression ratio and real expanded bytes: yauzl does not cover them all.
- In `src/input.ts`, `safeEntryPath` rejects unsafe paths before extraction.
  `insidePackage` requires a regular file whose real path stays inside the
  package. A search for `..` alone misses absolute paths and symlink escapes.
  Keep security fixes in sync with Praxity Check's corresponding module.
- In `src/cli.ts`, `canonical` resolves the deepest existing ancestor before
  checking input/output overlap. An absent leaf must not hide a symlink alias.
  The top-level replacement path requires both `--force` and an existing
  import report before replacing a nonempty folder. It builds beside the
  destination before removing the previous output, so extraction failures
  leave that previous output intact.
- In `src/jslit.ts`, `parseLiteral` reads data without executing package code.
  It accepts literal objects, arrays, strings and their concatenation, numeric
  and boolean values, null, undefined, NaN and Infinity. Unsupported expressions
  become undefined after skipping to the next delimiter at the same depth.
  A VM is not the boundary for untrusted course code.
- In `src/media.ts`, `uris` and `hlsSource` validate every playlist reference,
  including keys, init sections, variants and audio renditions, before ffmpeg
  runs. `convertHls` allows local files only, copies streams and requests
  bitexact output. Determinism holds for one ffmpeg version. Highest bandwidth
  wins; ties retain playlist order.
- In `src/write.ts`, `embeddedAsset` requires plain relative POSIX paths because
  embedded bytes have no on-disk path for `insidePackage` to validate.
  `writeProject` applies the ordinary asset rules to logos too. Conversion
  precedes lesson writing so a failed video conversion can remove its block.

Sources: the comments and implementations of these symbols at
[`b47d3a416c2512e48b77877c7798ecfb1d6400ae`](https://github.com/Praxity/praxity-import/tree/b47d3a416c2512e48b77877c7798ecfb1d6400ae);
`AGENTS.md`; `test/input.test.ts`, `test/import.test.ts`, `test/jslit.test.ts`,
`test/media.test.ts` and the embedded-asset tests in `test/import.test.ts`.

## Consequences

Archive limits and path checks remain mandatory even when a dependency adds
similar validation. Media conversion remains opt-in and version-dependent.
