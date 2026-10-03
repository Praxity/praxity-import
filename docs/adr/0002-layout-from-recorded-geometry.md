# 0002 Layout and design from recorded geometry

Status: accepted, 2026-09-28

## Context

ADR 0001 carries content. Side-by-side comparisons in SCORM Cloud showed that
content alone reads poorly: slide courses came through as a photo filling the
screen with the title pushed below it, text beside a picture became a long
stack, small portraits filled the column, and every course took Studio's
default spacing. Slide tools record where each object sits, how big it is and
what it is drawn over; page tools (Rise, Adapt) record block variants and
theme settings. That is enough to choose Studio layouts without guessing.

## Decision

Map layout with fixed geometric rules applied to what the source records.
Extractors describe objects (blocks, box, drawing order, text size and
colour); the shared helpers in `src/extract/hero.ts` decide, so every slide
tool follows the same rules. A rule applies only to fixed, unrotated geometry
the tool recorded; otherwise the content keeps its stacked reading order.

| Pattern | Rule | Studio output |
|---|---|---|
| Template chrome | Same picture on 3+ slides (Storyline, Captivate, Lectora) | Skipped, `dropped` loss listing the files |
| Hero | Picture covers ≥70% of the slide, text drawn above overlaps it | Heading with `background`: largest text is the title, next short line the subtitle; overlay from the text's own colour (light text → `dark`), omitted if unrecorded |
| Heading | Single line ≥1.3× the slide's median text size | Heading (largest tier level 2, next level 3) |
| Columns | Picture and text side by side: gap ≥0, vertical overlap ≥50% of the shorter box | `columns`, left object first; the text column takes every text object beside the picture |
| Picture size | Displayed width as a share of the slide: <0.35, <0.6; revealed panels too | `size: small`, `size: medium`; otherwise column width |
| Tall picture | A small/medium picture ≥1.5× taller than wide, or a picture beside text ≥1.25× taller than wide | `ratio: square`, `fit: contain`: whole picture, no taller than wide |
| Picture row | Consecutive pictures with vertical overlap ≥50% and centres at least half the narrower width apart | `columns`, one picture per column |
| Repeat | The same picture file twice on one page (Lectora) | Shown once |
| Text size | Recorded font size; for glyph-only text, glyph box height ÷ recorded line count | Input to hero and heading rules |

Design tokens come from the source's own theme where recorded (colours,
fonts, corners, background, section colours) and from its format otherwise:
slide tools become guided slides (`moduleDeck`, slide counter, the outline
open beside the slide when the source player had a sidebar menu and closed
otherwise) with `contentMaxWidth: 960` (players scale the stage
to the window, so the stored stage width undersizes the deck), compact
density and block spacing; Rise uses comfortable density and its recorded
content width. In decks, Studio's gate opens on a correct answer or once
attempts run out, as source players do; only questions with unlimited
attempts get `deckGate: attempt`, so they never demand a correct answer.

## Consequences

- Thresholds are constants in one place; changing one changes every tool,
  and the corpus bench shows the effect package by package.
- Rules can misfire on unusual slides (a decorative band that happens to
  cover 70% of a slide). They only restructure; they never drop or rewrite
  text, and the import report records what was skipped.
- Adjacent column rows rely on `close: col` ending a row (Studio #1211);
  older builds merge the two rows into one.
- Pictures layered over other pictures (figures standing in a scene photo)
  cannot be composed; they follow the photo as their own row.
- Layout that has no Studio equivalent stays approximated: fixed slide
  positions, animations, drag-and-drop presentation, pop-up feedback,
  one-question-at-a-time quizzes, pie charts (shown as bar charts), quote
  avatars, hotspot region shapes (points at each region's centre).
