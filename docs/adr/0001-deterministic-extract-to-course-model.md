# 0001 Deterministic extraction into one course model

Status: accepted, 2026-09-26

## Context

Courses arrive as SCORM zips from tools that store content very differently:
Rise ships its whole course as base64 JSON; Storyline ships slide JSON for its
own player; Captivate ships a JavaScript model; older packages are plain HTML
pages. We want imports that an LLM or a person can run in one command, that
give the same result every time, and that say plainly what did not survive.

Options considered:

1. **Render and scrape** (run the player in a browser, read the DOM). Works for
   any tool, but output depends on timing, fonts and viewport, needs a
   browser, and loses structure the player hides (answer keys, other states).
2. **LLM conversion** of HTML or JSON into `.prax`. Flexible, but not
   deterministic, hard to audit, and it invents text.
3. **Read each tool's data files** and map them through a shared model.
   Needs one extractor per tool, but the data files carry the author's
   structure: lessons, block types, correct answers, alt text, feedback.

## Decision

Option 3. Each extractor reads its tool's published data and returns a
`Course` (src/model.ts). One writer serialises that model to `.prax`. The model
only has blocks `.prax` can express; everything else becomes a `Loss` with a
source pointer and an effect (`dropped` or `approximated`).

Detection uses files a tool's player needs to run, in a fixed order, and
reports the evidence it matched. Static HTML is the fallback, so an unknown
tool degrades to "whatever is readable as HTML" plus a clear loss, rather
than a failure.

Studio validates the result through its CLI (`praxity inspect`, `praxity
export`), not a copy of its parser. Coverage is measured as the share of
source words (from each extractor's own inventory of visible strings) that
Studio parses back.

## Consequences

- Adding a tool means one extractor file and a detector rule.
- Script-built content (JavaScript quizzes, canvas games) is reported as lost,
  not approximated by screenshots.
- A later, optional LLM pass could improve structure (for example, choosing
  headings on a slide), but only as a separate step whose output is diffable
  against the deterministic import.
