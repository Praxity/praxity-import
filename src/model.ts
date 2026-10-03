/**
 * The course model every extractor produces and the writer consumes. It names
 * only what `.prax` can express; anything an extractor cannot map is recorded
 * as a Loss instead of being squeezed into the nearest block.
 *
 * `Inline` strings are already prax inline markdown, produced by `inline()` in
 * html.ts, so they are safe to place in a paragraph without further escaping.
 */
export type Inline = string;

/** A package-relative file path (POSIX separators) or an absolute http(s) URL. */
export type Src = string;

export type Item = { title: Inline; blocks: Block[] };

/** Question blocks carry `scored` when the source grades them; members of a `group` are always scored. */
export function markScored(blocks: Block[]): void {
	for (const b of blocks) if (b.kind === "choice" || b.kind === "match" || b.kind === "order" || b.kind === "categorize" || b.kind === "fillBlank" || b.kind === "hotspot") b.scored = true;
}

export type Blank = { answers: string[]; choices?: string[] };

export type Option = { text: Inline; correct: boolean; feedback?: Inline };

export type Block =
	| {
			kind: "heading";
			level: 1 | 2 | 3 | 4;
			text: Inline;
			/** Picture the heading sits on (a title over a full-slide photo); Studio renders a hero cover. */
			background?: { src: Src; alt: string; overlay?: "dark" | "light" };
			/** Text under the title on the background; written as a paragraph when there is none. */
			subtitle?: Inline;
	  }
	| { kind: "paragraph"; text: Inline }
	| { kind: "list"; ordered: boolean; items: Inline[] }
	| { kind: "image"; src: Src; alt: string; caption?: Inline; /** Full-bleed, or a size within the text column. */ layout?: "full" | "small" | "medium" | "large"; ratio?: "square"; fit?: "contain" }
	| { kind: "video"; src: Src; title?: string; caption?: Inline; /** WebVTT file. */ captions?: Src }
	| { kind: "audio"; src: Src; title?: string }
	| { kind: "embed"; url: string; height?: number }
	/** A downloadable document (PDF, DOCX …), shown as a button. */
	| { kind: "file"; src: Src; label: Inline }
	| { kind: "quote"; text: Inline; speaker?: string; style?: "none" | "outline" | "shaded" | "primary" | "secondary" }
	| { kind: "note"; text: Inline; title?: string }
	| { kind: "table"; rows: Inline[][]; /** Drawn as a chart from the first column (labels) and the rest (values). */ chart?: "bar" | "line" }
	| { kind: "code"; text: string; lang?: string }
	/** A section break; with `tone`, the following content sits on a coloured band (Studio section palette). */
	| { kind: "divider"; tone?: "light" | "dark" | "accent" | "cool" }
	/** Side-by-side columns, left to right. */
	| { kind: "columns"; columns: Block[][] }
	| { kind: "container"; as: "accordion" | "tab" | "sequence"; items: Item[] }
	| { kind: "cards"; items: Array<{ title: Inline; front: Block[]; back: Block[] }> }
	| { kind: "choice"; prompt: Inline; scored?: boolean; attempts?: number; multiple: boolean; options: Option[]; correct?: Inline; incorrect?: Inline }
	| { kind: "match"; prompt: Inline; scored?: boolean; attempts?: number; pairs: Array<[Inline, Inline]>; correct?: Inline; incorrect?: Inline }
	| { kind: "order"; prompt: Inline; scored?: boolean; attempts?: number; items: Inline[]; correct?: Inline; incorrect?: Inline }
	| { kind: "categorize"; prompt: Inline; scored?: boolean; attempts?: number; categories: Array<{ name: Inline; items: Inline[] }>; correct?: Inline; incorrect?: Inline }
	/** Likert grid: every statement is rated on the same scale. Unscored. */
	| { kind: "matrix"; prompt: Inline; scale: Inline[]; statements: Inline[] }
	/** A single Likert-style rating. Unscored. */
	| { kind: "rating"; prompt: Inline; scale: Inline[] }
	/** Click the right place on an image. Spots are points in percent of the image; Studio draws a small ellipse around each. */
	| { kind: "hotspot"; prompt: Inline; scored?: boolean; attempts?: number; src: Src; alt: string; spots: Array<{ label: Inline; x: number; y: number; correct: boolean }> }
	/**
	 * Sentence text (plain, the writer escapes it) with blanks between. A blank
	 * with no answers is open. `dropdown` blanks list their `choices` in order;
	 * `word-bank` questions share one `bank` of entries, repeats and distractors included.
	 */
	| { kind: "fillBlank"; prompt: Inline; scored?: boolean; attempts?: number; parts: Array<string | Blank>; style?: "dropdown" | "word-bank"; bank?: string[]; correct?: Inline; incorrect?: Inline }
	| { kind: "freeResponse"; prompt: Inline; description?: string }
	/** A scored quiz: its questions submit together and pass at `passingScore` percent. */
	| { kind: "group"; title: Inline; passingScore?: number; shuffle?: boolean; blocks: Block[] };

export type Page = { title?: string; blocks: Block[] };

export type Lesson = {
	/** Stable source identifier, used to derive the lesson id and file name. */
	sourceId: string;
	title: string;
	pages: Page[];
};

/** Something in the source the import could not carry over faithfully. */
export type Loss = {
	/** Where in the source: a lesson/page/block path using source identifiers. */
	at: string;
	/** Source construct, e.g. "rise:interactive/scenario" or "storyline:trigger". */
	source: string;
	/** "dropped" lost entirely; "approximated" kept content, changed behaviour. */
	effect: "dropped" | "approximated";
	detail: string;
};

/**
 * The source's look, as far as Studio can express it. Colours are #rrggbb;
 * fonts are the source's family names (the writer maps them to Studio's
 * catalogue); a logo is a package path like any other asset.
 */
export type Theme = {
	contentWidth?: number;
	density?: "compact" | "comfortable" | "spacious";
	blockSpacing?: "compact" | "default" | "spacious";
	accent?: string;
	text?: string;
	background?: string;
	buttonBackground?: string;
	buttonText?: string;
	headingFont?: string;
	bodyFont?: string;
	/** Corner radius in px: 0 for square corners. */
	corners?: number;
	navigation?: "sidebar" | "slides";
	logo?: Src;
	/**
	 * Slide-based tools (one screen at a time with Next) import as Studio guided
	 * slides; page-based tools as scrolling pages.
	 */
	format?: "slides" | "pages";
	/** Band colours for `divider` tones "accent" and "dark". */
	sectionAccent?: string;
	sectionDark?: string;
};

export type Course = {
	/** Which extractor produced this, and what it recognised. */
	tool: string;
	toolVersion?: string;
	/** Stable source identity, used to derive the course id. */
	sourceId: string;
	title: string;
	description?: string;
	locale?: string;
	lessons: Lesson[];
	/**
	 * Percent the LMS should treat as passing, when the source states one for
	 * the whole course. The writer falls back to the course's assessment
	 * groups when they agree on a passing score.
	 */
	passingScore?: number;
	theme?: Theme;
	/** Package-relative file paths (POSIX separators) to decoded bytes; real package files take precedence. */
	embedded?: Map<string, Buffer>;
	losses: Loss[];
	/**
	 * Every learner-visible string the extractor found in the source, before
	 * mapping. Coverage compares these words with what Studio parsed back, so it
	 * must be gathered independently of the block mapping, not derived from it.
	 */
	sourceText: string[];
};

/** An import that cannot proceed, with a stable code for the CLI's JSON result. */
export class ImportError extends Error {
	code: "unsupported_tool" | "not_self_contained" | "no_readable_content";
	constructor(code: ImportError["code"], message: string) {
		super(message);
		this.code = code;
	}
}
