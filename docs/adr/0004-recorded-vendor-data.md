# 0004 Read recorded vendor data without running players

Status: accepted, 2026-11-20

## Context

Published formats contain authoring labels, player chrome, duplicate states and
learner text in different fields. Reading the wrong field can silently change
the course. The following format observations govern extraction; they are not
promises that arbitrary player code can be interpreted.

## Decision

### Adapt

In `src/extract/adapt.ts`, `extractAdapt` joins `course/<lang>/` JSON records
through `_parentId` and retains array display order. Text is HTML and asset
paths are build-relative. The source identity includes the title because
unrelated builds often share `_id: "course"`. Its visible-string inventory
uses `displayTitle`, not the authoring `title`; unsupported retry and
partly-correct feedback do not become invented Studio feedback.

`themeFromCss` reads the published stylesheet because the theme is not in
course JSON. Strings and comments consume their braces; conditional rules
cannot become unconditional defaults. Background shorthand resets the colour,
even when it only declares an image. Content-container backgrounds cover the
outer page texture. `extractAdapt` assigns each palette on first use in display
order; a class name alone supplies no colour.

### Captivate

In `src/extract/captivate.ts`, `loadModel` reads object literals after
`cp.D = cp.model.data` in `assets/js/CPM.js` or `assets/js/project.js`, plus
`cp.model['<id>Data']` question pools. `extractCaptivate` can proceed without
optional `project.txt`. Slide `si` entries reference timing and display records
through `mdi`. State variants share an object's position and are not separate
content. Classic captions retain words in `accstr` and authored type in `vt`
even when their display is a PNG; modern text uses Draft.js with per-character
bold/italic flags. `imageCache` reads literals, including assignments sometimes
present in `imgmd.json`, and excludes the vendor's terminal sentinel.

Within `extractCaptivate`, `question` resolves timing/display answer references,
including hotspot, fib and sha suffixes. Matching wording is `aAnsTxtlms`;
`atxtlms` can be only a letter. The slide caption retains quotation marks that
`qt` strips. Classic and modern formats have different unlimited-attempt
sentinels. Each `ao` names a fill blank, but its caption has no reliable text
offset; `FIBAnswer.sac` identifies combo boxes and `allAnswers` their options.
`dragDrop` follows `DD.Interaction`: `ma` constrains matching only when positive.

`QUIZ_TYPES` and `QUIZ_CHROME` separate prompt/answer/header content already
carried by questions from submit, progress, review and other player controls.
`page` reads zero-based `anyScoreSlide` and result type 111, and flags `is`,
`ikc` and `ipq` for surveys, knowledge checks and pretests. Narration comes from
`project_main.slideAudios` whose frame range starts in the slide. The `mdi`
canvas can have a zero box in classic output; image-less shapes use bare `dr/`.
Hidden reveal/feedback objects follow visible content. `readingOrder` anchors
each row to its first object's vertical centre within 10 px, preventing nearby
rows from merging through a chain of offsets.

### iSpring

In `src/extract/ispring.ts`, `extractIspring` reads `presInfo` as base64,
zlib-deflated JSON, and `quizInfo` as base64 JSON. Slide `x` retains readable
paragraphs (`\r`) and shapes (`\r\n`); HTML spans can wrap mid-word.
`units` chooses the last `.kern.slide` child as the slide's own layer rather
than a master/layout. `slidePage` uses flat `#id` styles; glyph/SVG text without
line boxes precedes pictures because interleaving cannot be recovered.
Rich text uses plain `a` HTML beside styled `h` and drops editor padding spaces.
`blankParts` keeps literal prose separate from answer data for the writer.

`question` inventories source text before mapping. Player settings `yf` maps
to `s.a`, with -1 for unlimited attempts. Hotspot bounds use image size / 1E4,
including freeforms; word banks start with extra words then `rt.r` values before
shuffling. `quizBlocks` inventories the older `q[]` coded schema without
mapping its questions. `presentationTheme` reads the universal `data/player.js`
schema; custom/null skins may ignore `k.s`. Unknown syntax keeps the palette
and records a layout loss. Dominant fonts use character counts and UTF-16
code-unit ties rather than a player-font substitution.

### Lectora

In `src/extract/lectora.ts`, `readPage` combines page HTML declarations and
`device_Desktop/pageNNN.js` recorded literals. `arWnds` supplies tab/DOM order;
`arChld` and `arChoices` identify question members. `pageIdx` gives title order,
while `_tobj<id>.txt` contains base64 test XML. Chapter names are not published.
Only linked local stylesheets are read, in document order; remote fonts are
not fetched. Answer-key readers decode Unicode escapes inside already escaped
strings; `unescapeJs` owns that decoding. `NAV_ACTION` classifies page moves
and question submission as player chrome. Title readers resolve values
spliced into HTML/JS literals.

`actionTokens`, `resolveActions` and `questionFeedback` read recorded actions
without evaluation. Strings and comments stay opaque. Unsupported statements
remain losses. Completion callbacks carry no feedback; disabled actions may
contain literal true. `textRules` discards nested at-rules rather than choosing
a viewport. `lectoraTheme` honours authored Background_Color shapes covering
the page, weights text/fonts by non-whitespace Unicode characters and
background/template colours by pages, with code-unit ties.

`questionFeedback` preserves hidden objects referenced outside feedback chains.
`branchingChoice` treats single-use scenes or mutually hiding panels as
exclusive choices, folds nested groups into their outer panel, retains
unresolved sibling buttons and attaches group text only for single-option
groups. Answer markers use authored object-name metadata, never feedback prose.
Practice choices stay outside assessment groups because those score every
member. Questions parse comma-delimited whole answers, normalising entities;
ordinal questions use `arChoices[].val`, `arrAns[0]` and `btnnm`, as in
`trivantis-questions.js`.

`extractLectora` excludes repeated template objects seen on at least three
pages. A background pattern also needs explicit designation, full-page coverage
and no readable label or actions; a filename or large photograph is insufficient.
The independent inventory counts image alt text, not chrome identity paths,
and each state-duplicated button label once per page. Assessment headings
become bold text; hero pictures/subtitles survive that demotion. Publisher
group names can exist only in declaration comments, which remain readable as
package data.

### Rise, Storyline and LiaScript

In `src/extract/rise.ts`, `loadCourse` tries the next literal when one is not
the payload. `interactive` displays default card images only on image faces.

In `src/extract/storyline.ts`, `provided` decodes
`globalProvideData('<name>', '<JSON string>')` files. The tree lives in
`html5/data/js/data.js`; scenes get names from player-menu `frame.js`.
`placed` uses author focus order (`tabIndex`), then source order for unindexed
objects, deduplicates identical state-group labels and excludes objects hidden
from assistive technology. `plainText` falls back to accessible text for
glyph-only content. `textBlocks` does not turn a plain shape's name into prose.
Literal `^%^` becomes `%`, while unresolved variable references remain visible.

`choiceText` distinguishes answer captions from letter buttons and uses a
same-id state child as the initial object rather than feedback artwork.
`bounds` does not infer transforms for rotated objects. `comparisons` reads
only conjunctions of literal comparisons; `attemptComparison` and
`attemptLimit` use the current interaction's recorded counter.
`countFonts` skips embedded Charset subsets to recover the original family.
Font and background ties use code-unit order, never locale.

Within `extractStoryline`, one slide-jump button is navigation rather than a
menu. Generic prompts are not learner text. Glyph-only feedback can have a
short top-line title above a longer message; other layers may intentionally
repeat question words. An accordion item needs a nonempty heading for Studio
to recognise it.

In `src/extract/liascript.ts`, `liaSources` follows manifest item parameters
to select Markdown. `extractLiaScript` strips runtime constructs only outside
code examples, preserves source line numbers and inventories visible strings
independently, including unsupported constructs.

Sources: the comments and implementations of the named symbols at
[`b47d3a416c2512e48b77877c7798ecfb1d6400ae`](https://github.com/Praxity/praxity-import/tree/b47d3a416c2512e48b77877c7798ecfb1d6400ae);
the corresponding synthetic extractor tests in `test/`, including the
Lectora ordinal/runtime fixtures in `test/lectora.test.ts`. These record the
publisher/player observations without distributing real course packages.

## Consequences

Format changes require source evidence and synthetic fixtures. Unsupported
runtime behaviour remains a reported loss; running package scripts is not a
fallback. Geometry and theme presentation continue to follow ADR 0002.
