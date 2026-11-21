# 0005 Studio output and verification contract

Status: accepted, 2026-11-20

## Context

Extractors describe content; Studio interprets the generated source. Escaping,
container boundaries and score units must agree with that interpretation.

## Decision

- In `src/model.ts`, `Inline` contains inline source produced by `src/html.ts`
  `inline`/`neutralize`. Fill-blank sentence parts instead contain plain text;
  `src/prax.ts` owns their escaping. Blank answer lists distinguish open blanks,
  ordered dropdown choices and shared word banks with repeats/distractors.
- In `src/prax.ts`, `one` keeps literal parameters on one line and substitutes
  U+2223 for a bar followed by a parameter name. Literal fields do not decode
  backslash escapes. `param` escapes that separator for inline fields;
  `field` additionally escapes table, match and hotspot delimiters. `answer`
  escapes braces/bars and leading answer markers; `sentence` escapes braces
  and underscore runs so authored prose cannot create blanks.
- In `src/prax.ts`, `RESERVED` and `escapeLines` protect body lines that would
  become headings, quotes, lists, fences, parameters, choices, links or media.
  `escapeHeading` treats heading text separately and removes whole-heading
  emphasis because headings already supply it. Inline escaping now exists;
  the older comment claiming otherwise no longer describes `neutralize`.
- In `src/prax.ts`, `questionParams` supports retries for all six scored
  question kinds, including practice checks. `block` keeps hotspot parameters
  contiguous with semicolon-delimited spots. `inner` flattens nested containers
  into labelled runs and demotes their headings to bold paragraphs because a
  heading at the item's level would begin another item, and nesting rules
  differ across container kinds.
- In `src/theme.ts`, `CATALOGUE`/`family` match Studio's bundled fonts, originally
  recorded from `grammar/src/font-catalog.ts` in Studio 0.2.x. Recheck that
  source when the supported Studio font set changes. `designYaml` starts from
  the clean palette and excludes near-grey accents: a player glow or off-white
  primary is not a useful brand accent. Section bands require manual rhythm
  mode for Studio to paint their palettes. Other layout choices follow ADR 0002.
- In `src/import.ts`, `importPackage` lets manifest mastery outrank quiz settings
  because the manifest tells the LMS the original course's pass mark.
  In `src/manifest.ts`, `readManifest` reads a SCORM 2004 minimum normalised
  measure only from a primary objective satisfied by measure.
  In `src/model.ts`, `Course.passingScore` is a percentage; in `src/write.ts`,
  `writeProject` converts it to the fraction in `export.passingScore`, retaining
  Studio's other project defaults and page-based completion threshold.
- In `src/write.ts`, `selectionProblem` rejects dropdowns without two distinct
  choices including a correct one, and banks without copies for every primary
  answer and alternative or with open blanks. `resolveAssets` keeps reports
  and emitted content consistent when a local asset is absent. Quoted empty
  alt values count as empty, not authored alternatives.
- In `src/model.ts`, `Course.embedded` uses package-relative POSIX paths and disk
  files take precedence. `Course.sourceText` is gathered before block mapping,
  independently of its success. Deriving it from emitted blocks would hide
  losses from coverage. `src/verify.ts` `coverage` excludes filename defaults
  that the writer also omits from learner text.
- In `src/verify.ts`, `verify` requires Studio 0.3.0 or later: older releases
  either lack inspect or show inline escapes and selection blanks literally.
  Export runs on a copy because it writes identity sidecars into its project.
  In `test/skill.test.ts`, the installation link remains pinned to Studio
  0.3.0 until a pilot requires a newer release (owner decision, 2026-10-19).

Sources: `AGENTS.md`; the named comments and implementations at
[`b47d3a416c2512e48b77877c7798ecfb1d6400ae`](https://github.com/Praxity/praxity-import/tree/b47d3a416c2512e48b77877c7798ecfb1d6400ae);
`test/import.test.ts`, `test/verify.test.ts`, `test/skill.test.ts` and
`test/studio-followups.test.ts`. These are retained implementation contracts;
this migration does not claim a new validation against a newer Studio release.

## Consequences

Keep literal fields, inline source and plain fill-blank data distinct. Studio
contract tests validate the generated format; independent inventories expose
content that mapping could not preserve. Compatibility changes require a
separate behaviour change and its tests.
