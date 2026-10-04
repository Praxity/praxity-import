# Praxity Import

Import SCORM packages and web exports from other authoring tools into
[Praxity Studio](https://praxity.io) course folders: `course.yaml`, `.prax`
lessons and `assets/`, plus a report of anything that did not carry over.
Content, questions (answer keys, feedback, attempts, pass marks) and as much of
the source's design as it records (theme, slide or page format, heroes,
columns, spacing) carry over; the same package always gives the same output.

```sh
pnpm install
node src/cli.ts path/to/course.zip --output my-course --verify
```

`--verify` needs the Studio 0.3.0 CLI or later. Download
`praxity-cli-0.3.0-macos-arm64.tar.gz` (Apple Silicon) or
`praxity-cli-0.3.0-macos-x64.tar.gz` (Intel) from the
[Studio 0.3.0 release](https://github.com/Praxity/desktop/releases/tag/v0.3.0),
unpack it and set `PRAXITY_CLI` to `studio-cli/praxity.mjs`:

```sh
tar -xzf praxity-cli-0.3.0-macos-arm64.tar.gz
export PRAXITY_CLI="$PWD/studio-cli/praxity.mjs"
```

Studio publishes the CLI for macOS only, so `--verify` does not support
Windows yet. Importing without `--verify` works on any platform.

- Agents and scripts: [skill/SKILL.md](skill/SKILL.md) documents the CLI
  contract and how to review an import.
- Design: [docs/adr/](docs/adr/). ADR 0001 covers the pipeline and loss
  reporting; ADR 0002 covers how layout and theme are mapped from what the
  source records.
- Testing against real packages: the corpus folder is `$PRAXITY_IMPORT_CORPUS`,
  or `corpus/local/` by default, and never leaves the machine. `pnpm corpus`
  fetches the public packages listed in `corpus/sources.json`; private ones are
  listed in the folder's own `sources.local.json`. `pnpm bench` imports
  everything listed, twice, and writes `out/bench/scoreboard.tsv`; a missing
  input fails it, and `pnpm bench --release` also requires the private list.
  `pnpm corpus --lock` records every file's SHA-256 in the folder's
  `manifest.json`, and `pnpm corpus --check` compares against it.

Requires Node 24.18+.

## Related work

Other projects read parts of the same published formats.
[Rise Course Text Extractor](https://github.com/kirbyc/articulate-rise-to-markdown)
extracts Rise text to Markdown and records what it skips;
[course-builder](https://github.com/rspellen23/SCORM-Testing) imports Rise into
its own course model and reports dropped content;
[risefix](https://github.com/frumbert/risefix) adapts Rise packages;
[SCORMToIMSCC](https://github.com/kc0bfv/SCORMToIMSCC) and
[SCORM-to-PDF-Transformer](https://github.com/nathanpitman/SCORM-to-PDF-Transformer)
extract Storyline text; and the
[Captivate superWrapper](https://github.com/xapicohort/team-captivate-jslibrary)
reads Captivate's runtime model. Praxity Import was written independently and
uses no code from them. It brings Rise, Storyline, Captivate, iSpring, Lectora,
Adapt, LiaScript, Xerte and static HTML packages into one deterministic import with explicit
loss reporting. Commercial conversion services also exist.

## Licence

Praxity Import by Ariel Harlap. Source-available under the PolyForm Perimeter License 1.0.1: free at home and at work, including paid client work. See [LICENSING.md](LICENSING.md). [NOTICE.md](NOTICE.md) has the trademark and non-affiliation statement for the authoring tools it reads.
