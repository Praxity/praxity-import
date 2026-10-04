---
name: praxity-import
description: Import a SCORM package or web export from Articulate Rise or Storyline, Adobe Captivate, iSpring Suite, Lectora, Adapt Learning, LiaScript, Xerte or plain HTML into a Praxity Studio course folder, and review what did not carry over.
---

# Praxity Import

Praxity Import converts a course package from another authoring tool into a
Studio course folder you can open, edit and re-export. The import is deterministic: the same
package always gives byte-identical output, so a re-import diffs cleanly.

## Run it

```sh
praxity-import <package.zip|unzipped-dir> --output <new-course-dir> --verify
```

- `--output` must be new or empty. `--force` replaces a folder that holds a
  previous import (it must contain `import-report.json`); it never replaces
  anything else.
- `--convert-media` converts HLS video (`.m3u8` playlists with `.ts`
  segments, as Storyline publishes streamed video) to MP4 with ffmpeg, which
  must be on PATH. It takes the highest-bandwidth variant and its default
  audio and copies the streams without re-encoding. The report records each
  conversion (`media:converted`) and the ffmpeg version (`mediaConverter`).
  A given ffmpeg version always produces byte-identical files. The importer
  refuses playlists that name remote addresses or files outside the package.
  Off by default.
- `--verify` parses the result with Studio and tries an HTML export. It looks
  for Studio's CLI in `PRAXITY_CLI` (the `praxity` launcher or `praxity.mjs`),
  then `praxity` on PATH, then the macOS app. The Studio 0.3.0 release
  (<https://github.com/Praxity/desktop/releases/tag/v0.3.0>) has the CLI as
  `praxity-cli-0.3.0-macos-arm64.tar.gz` and `-x64.tar.gz`; unpack one and set
  `PRAXITY_CLI` to `studio-cli/praxity.mjs`. It ships for macOS only, so
  `--verify` does not support Windows yet. If it finds no CLI, the import
  fails with `import_failed`, exits 1 and writes nothing. With a Studio older
  than 0.3.0, the importer writes the course but reports `"ok": false` and
  exits 1. Leave `--verify` off to import without the check.
- Output uses Studio's backslash escapes and fill-blank `dropdown` and
  `word-bank` styles, which need Studio 0.3.0. Studio 0.2.0 shows the
  backslashes literally and treats those blanks as typed answers.

stdout is one JSON object:

```json
{"ok": true, "outputPath": "/abs/course", "tool": "rise", "title": "…",
 "lessons": 7, "pages": 7, "assets": 15, "losses": 4,
 "verification": {"parse": true, "coverage": 0.989, "export": true, "accessibility": "passed"},
 "report": "/abs/course/import-report.json"}
```

Failures: `{"ok": false, "error": {"code": "…", "message": "…"}}` with exit 2
for `invalid_arguments`, otherwise exit 1:

- `input_not_found`, `output_exists`: fix the command.
- `unsupported_tool`: the importer recognised the tool (the message names it
  and the evidence) but has no extractor for it yet.
- `not_self_contained`: the package loads its course from a remote server
  (the message names the host), so the zip holds nothing to import.
- `no_readable_content`: the package uses a custom or unknown player, and the
  importer found nothing readable.
- `import_failed`: anything else, such as a corrupt zip.

A failed import leaves any previous import in place. With `--verify`, when
Studio cannot parse or export the result, `ok` is false and the exit status
is 1. The importer still writes the course folder for inspection.

## Output

```
course-dir/
  course.yaml          title, stable id, lesson order
  01-<lesson>.prax     one file per source lesson (Rise lesson, Storyline scene …)
  assets/              only the files the lessons reference
  praxity.json         only when the source has a pass mark: Studio's default
                       project settings plus export.passingScore
  import-report.json   what was detected, imported and lost
```

## Review an import

1. Check `verification.coverage`: the share of the source's visible words that
   Studio parsed back. Above 0.95 is typical for Rise and HTML. A low value
   means the import dropped content. `verification.coverage.missing` in the
   report lists the most frequent missing words, which usually point to the
   block that lost them.
2. Read `losses` in `import-report.json`. Each has `at` (source location),
   `source` (the construct), `effect` and `detail`:
   - `dropped`: nothing was imported (an embedded Storyline block in Rise, a
     script-generated quiz, a missing file).
   - `approximated`: content kept, behaviour changed (a branching scenario
     became a sequence; an image without alt text was marked decorative).
3. Make fixes in the `.prax` files. A re-import with `--force` overwrites
   edits.
4. Images marked decorative because the source had no alt text need a human
   decision. Search the report for "no alternative text".
5. `media:video` and `media:audio` losses are files Studio cannot play (HLS
   `.m3u8` streams, Flash, AVI…). The importer does not copy them, and the
   CLI prints a warning with their count. For HLS, re-run with
   `--convert-media` (see "Run it"). For anything else, convert the named file
   to MP4 (video) or MP3 (audio) and add it back to its lesson.

## What it recognises

| Tool | Detected by | Imports |
|---|---|---|
| Articulate Rise 360 (web or SCORM) | `lib/rise` or `lib/main.bundle.js`, course JSON in `locales/*.js`, `runtime-data.js` or `index.html` | Cover page (hero over the cover image), lessons, text, images with their layouts, image-and-text and multi-column blocks as columns, galleries, video with captions, audio, attachments, quotes, accordions, tabs, process (slide cards), timeline, flashcards (slide cards), sorting, labeled graphics, charts (as bar/line chart tables), scenarios (flattened), knowledge checks, quizzes as assessment groups with their passing score, embedded Storyline blocks |
| Articulate Storyline 360 / 3 | `html5/data/js/data.js`, `story_content/`, `story.html` | Scenes as lessons, slides as pages, text in focus order, images, media, layers (after base content), quiz slides with the slide's answer text, final feedback and attempts, Likert surveys as matrices; result slides and pictures repeated on 3+ slides are skipped |
| Adobe Captivate (9 to 2019, and 12/13) | `assets/js/CPM.js`, or `project.txt` generated by Captivate | Slides as pages, captions and shapes in reading order, images, narration, question slides and pools |
| Adapt Learning | `course/config.json` and `course/<lang>/components.json` | Pages as lessons, articles as pages, text, graphics, accordions, narratives, hot graphics, flip cards, MCQ, matching, text input, media |
| iSpring Suite (10) | `data/player.js` and `data/slide1.js`, possibly under `res/` | Slides as pages from the player's own slide text, images, notes, quizzes as assessment groups with choice, type-in, numeric, sequence, matching and essay questions |
| Lectora (HTML5 publish) | `trivantis.js` | Pages in title order, chapters as lessons, text in tab order, images, tests as assessment groups with choice, fill-in and essay questions |
| LiaScript | LiaScript player metadata in `index.html` and a Markdown source selected by SCORM item parameters | Headings as lessons/pages, text, lists, images, tables, code, quotes, unambiguous choice and typed-answer quizzes; macros, scripts and unsupported interactions are losses |
| Xerte | `template.xml` with a `learningObject` root and `common_html5/js/xenith.js` | XML page order, text and bullet pages with HTML media, single/multiple-answer quizzes with answer keys and feedback; other page types are losses |
| eXeLearning | Static HTML fallback | Published HTML pages in manifest navigation order; the corpus packages' serialized content is already present in their HTML |
| Static HTML | `imsmanifest.xml` item tree, then in-package links and frames | Manifest top-level items as lessons; script-rendered pages are reported, not imported |

## Design and layout

The import carries the source's look where the source records it:

- Theme colours, fonts, corners and background go into `course.yaml`
  `design:` on top of Studio's neutral `clean` palette.
- Slide tools (Storyline, Captivate, iSpring, Lectora) become guided slides:
  one slide per page, slide counter, the outline open beside the slide when
  the source player had a sidebar menu (closed otherwise), a 960px column,
  compact spacing. Next opens after a correct answer or the
  last attempt, as in the source players.
- On slides, a title over a full-slide photo becomes a hero heading, a
  picture beside text becomes columns, larger text becomes headings, and
  pictures keep their relative size. The rules are in
  [ADR 0002](../docs/adr/0002-layout-from-recorded-geometry.md).
- Rise keeps image layouts, coloured block backgrounds (as section bands),
  quote styles and comfortable spacing.

The report lists what `.prax` cannot express as `approximated`: fixed slide
positions, animations, drag-and-drop presentation, pop-up feedback,
one-question-at-a-time quizzes, pie charts, quote avatars, and hotspot region
shapes (each region becomes a point at its centre).

Other JavaScript players fall back to static HTML, which often yields only a
loader page. A very small page count with high coverage then means the
importer saw almost nothing, not that it kept everything. The report adds
`html:shallow` when the HTML fallback imports exactly one page with fewer
than 50 visible words and finds a script or data file of at least 100 KiB.
The check covers files ending in `.js`, `.mjs`, `.cjs`, `.json`, `.xml`,
`.md`, `.txt` and `.dat`, except `imsmanifest.xml`. This warning counts
toward the CLI's loss count, but it flags likely missing content, not a
measured loss.
