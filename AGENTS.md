# Praxity Import

If `AGENTS.local.md` exists, read it before starting. It holds maintainer context and is not part of the repository.

The backlog, plans, research notes and experiments live in the private orchestrator named in `AGENTS.local.md`, under `projects/import/`.

Import converts SCORM packages and web exports from other authoring tools
(Articulate Rise and Storyline, Adobe Captivate, iSpring Suite, Lectora, Adapt,
LiaScript, Xerte, static HTML) into Praxity Studio course folders: `course.yaml`,
`.prax` lessons and `assets/`. Its sibling tools are Check (accessibility) and
Trace (design diagnostics). The repository is private for now.

## Design rules

- **Deterministic.** Output is a pure function of the input bytes. The import
  path uses no clocks, randomness, network, environment-dependent paths or
  model calls. It walks directories and maps in sorted order. `pnpm bench`
  imports every package twice and fails any that differ.
- **Content as-is, losses recorded.** Carry content over unchanged (text,
  order, media, alt text, questions and answer keys). Record anything the
  `.prax` grammar cannot express as a `Loss` with a source pointer. Never drop
  content silently or invent it. Learner-facing text comes only from the
  source, apart from neutral structural labels such as "Card 3".
- **One pipeline.** `openInput` → `detect` → one extractor → `Course` model
  (`src/model.ts`) → `writeProject`. Only extractors contain tool-specific
  code. Only the writer emits `.prax` syntax.
- **Studio judges validity.** `--verify` runs `praxity inspect` and
  `praxity export` from Studio 0.2.0+ (`PRAXITY_CLI`), and measures word
  coverage against the extractor's independent `sourceText` inventory. Output
  targets Studio grammar v3, including inline escapes and the fill-blank
  `dropdown`/`word-bank` styles added after Studio 0.2.0. Verify with a Studio
  CLI that supports them. Keep Studio source out of this repository.
- **Packages are untrusted.** Never evaluate their JavaScript (`vm`, `eval`,
  `Function`). Parse it with `src/jslit.ts`. When a file path comes from
  package data or a directory listing, open the file through `insidePackage`
  (src/input.ts), which refuses `..`, absolute paths and symlinks out of the
  package. `src/input.ts` is copied from Praxity Check; port security fixes
  both ways.
- **The writer owns escaping.** Extractors pass plain text (`neutralize` in
  `src/html.ts` for inline runs) and structured blanks. `src/prax.ts` applies
  Studio's backslash escapes per field. Inline fields decode them; literal
  fields (`alt:`, paths) do not. Never substitute look-alike characters or
  zero-width spaces to dodge markup.
- **Layout comes from recorded geometry.** Slide extractors describe objects
  (box, drawing order, text size and colour). The shared rules in
  `src/extract/hero.ts` choose heroes, columns, headings and picture sizes
  ([ADR 0002](docs/adr/0002-layout-from-recorded-geometry.md)). Change a
  threshold there, not per tool, and check the bench diff.

## Code

- Node runs `.ts` directly by type stripping, so write only erasable
  TypeScript and end relative imports in `.ts`.
- `skill/SKILL.md` is the CLI guide for agents. Update it with any CLI change.
- `pnpm verify` is the integrated gate. Run it locally before handing off. For
  extractor changes, also run `pnpm bench`. In a delegated run, workers run
  the smallest relevant check and the root runs these once after integration.

## Private material

Packages under test are third-party and mostly unlicensed. They live only on
the machines that test with them, in the corpus folder: `$PRAXITY_IMPORT_CORPUS`
(outside any checkout), or the Git-ignored `corpus/local/`. Never upload copies
of packages, or the names of private ones, anywhere, including private
repositories. `corpus/sources.json` records where public packages came from,
pinned to a commit. List private packages only in the corpus folder's
`sources.local.json`, with paths relative to that folder. Run
`pnpm corpus --check` after copying a corpus between machines and
`pnpm bench --release` before a release. Keep course content out of commits,
test fixtures, docs and issue text. Fixtures are synthetic.
