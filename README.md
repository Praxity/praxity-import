# Praxity Import

Import SCORM packages and web exports from other authoring tools into
[Praxity Studio](https://praxity.io) course folders: `course.yaml`, `.prax`
lessons and `assets/`, plus a report of anything that did not carry over.

Import writes the older grammar 3, which current Studio refuses. To use the
output with current Studio, convert it with [Studio's archived grammar 3 to 4
converter](https://github.com/Praxity/studio/blob/main/docs/context/converter-archive.md),
or wait for Import to write grammar 4. The converter documentation records its
publication status and the staging and review steps to follow.

Content, questions (answer keys, feedback, attempts, pass marks) and as much of
the source's design as it records (theme, slide or page format, heroes,
columns, spacing) carry over; the same package always gives the same output.

```sh
pnpm install
node src/cli.ts path/to/course.zip --output my-course
```

## Legacy verification

`--verify` needs the frozen Studio 0.3.0 CLI, which reads grammar 3. Current
Studio cannot verify Import's output. For legacy verification, download
`praxity-cli-0.3.0-macos-arm64.tar.gz` (Apple Silicon) or
`praxity-cli-0.3.0-macos-x64.tar.gz` (Intel) from the
[Studio 0.3.0 release](https://github.com/Praxity/desktop/releases/tag/v0.3.0),
unpack it and set `PRAXITY_CLI` to `studio-cli/praxity.mjs`:

```sh
tar -xzf praxity-cli-0.3.0-macos-arm64.tar.gz
export PRAXITY_CLI="$PWD/studio-cli/praxity.mjs"
```

The Studio 0.3.0 CLI archives are for macOS only, so `--verify` does not support
Windows yet. Importing without `--verify` works on any platform.

## Project guides

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

## Portable package

From a clean, committed checkout with dependencies installed:

```sh
pnpm package --output /path/to/new/praxity-import-0.1.0
node /path/to/new/praxity-import-0.1.0/src/cli.ts --help
node /path/to/new/praxity-import-0.1.0/src/cli.ts /path/to/course.zip --output my-course
```

The new directory contains runtime TypeScript, production dependencies,
licences and notices, the agent skill and its linked references, and a tiny
synthetic SCORM fixture at `fixtures/smoke/scorm`. It needs only Node 24.18+
to import, without a package manager or network. `--verify` and
`--convert-media` still need their external tools.

`inventory.json` records the committed revision, dependency versions and each
payload file's SHA-256, size and mode. It excludes itself from its hash list.
Packaging refuses dirty trees, existing outputs, unsafe references, unaudited
dependencies, binary files and machine paths. Text uses LF; launchers use mode
0755. Archive the directory under `praxity-import-0.1.0/` and extract with
`stripComponents: 1`. The same archive supports every platform with Node 24.

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

Praxity-authored code in Praxity Import by Ariel Harlap is available under the
[MIT licence](LICENSE). See [LICENSING.md](LICENSING.md).

Earlier versions of this repository published under PolyForm Perimeter 1.0.1 or earlier Praxity terms are also available under the MIT licence from 2026-11-21.

[NOTICE.md](NOTICE.md) has the trademark and non-affiliation statement for the
authoring tools it reads. Third-party components retain their own licences;
see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
