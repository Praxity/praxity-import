export type Inline = string;

export type Src = string;

export type Item = { title: Inline; blocks: Block[] };

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
			background?: { src: Src; alt: string; overlay?: "dark" | "light" };
			subtitle?: Inline;
	  }
	| { kind: "paragraph"; text: Inline }
	| { kind: "list"; ordered: boolean; items: Inline[] }
	| { kind: "image"; src: Src; alt: string; caption?: Inline;  layout?: "full" | "small" | "medium" | "large"; ratio?: "square"; fit?: "contain" }
	| { kind: "video"; src: Src; title?: string; caption?: Inline;  captions?: Src }
	| { kind: "audio"; src: Src; title?: string }
	| { kind: "embed"; url: string; height?: number }
	| { kind: "file"; src: Src; label: Inline }
	| { kind: "quote"; text: Inline; speaker?: string; style?: "none" | "outline" | "shaded" | "primary" | "secondary" }
	| { kind: "note"; text: Inline; title?: string }
	| { kind: "table"; rows: Inline[][];  chart?: "bar" | "line" }
	| { kind: "code"; text: string; lang?: string }
	| { kind: "divider"; tone?: "light" | "dark" | "accent" | "cool" }
	| { kind: "columns"; columns: Block[][] }
	| { kind: "container"; as: "accordion" | "tab" | "sequence"; items: Item[] }
	| { kind: "cards"; items: Array<{ title: Inline; front: Block[]; back: Block[] }> }
	| { kind: "choice"; prompt: Inline; scored?: boolean; attempts?: number; multiple: boolean; options: Option[]; correct?: Inline; incorrect?: Inline }
	| { kind: "match"; prompt: Inline; scored?: boolean; attempts?: number; pairs: Array<[Inline, Inline]>; correct?: Inline; incorrect?: Inline }
	| { kind: "order"; prompt: Inline; scored?: boolean; attempts?: number; items: Inline[]; correct?: Inline; incorrect?: Inline }
	| { kind: "categorize"; prompt: Inline; scored?: boolean; attempts?: number; categories: Array<{ name: Inline; items: Inline[] }>; correct?: Inline; incorrect?: Inline }
	| { kind: "matrix"; prompt: Inline; scale: Inline[]; statements: Inline[] }
	| { kind: "rating"; prompt: Inline; scale: Inline[] }
	| { kind: "hotspot"; prompt: Inline; scored?: boolean; attempts?: number; src: Src; alt: string; spots: Array<{ label: Inline; x: number; y: number; correct: boolean }> }
	| { kind: "fillBlank"; prompt: Inline; scored?: boolean; attempts?: number; parts: Array<string | Blank>; style?: "dropdown" | "word-bank"; bank?: string[]; correct?: Inline; incorrect?: Inline }
	| { kind: "freeResponse"; prompt: Inline; description?: string }
	| { kind: "group"; title: Inline; passingScore?: number; shuffle?: boolean; blocks: Block[] };

export type Page = { title?: string; blocks: Block[] };

export type Lesson = {
	sourceId: string;
	title: string;
	pages: Page[];
};

export type Loss = {
	at: string;
	source: string;
	effect: "dropped" | "approximated";
	detail: string;
};

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
	corners?: number;
	navigation?: "sidebar" | "slides";
	logo?: Src;
	format?: "slides" | "pages";
	sectionAccent?: string;
	sectionDark?: string;
};

export type Course = {
	tool: string;
	toolVersion?: string;
	sourceId: string;
	title: string;
	description?: string;
	locale?: string;
	lessons: Lesson[];
	passingScore?: number;
	theme?: Theme;
	embedded?: Map<string, Buffer>;
	losses: Loss[];
	sourceText: string[];
};

export class ImportError extends Error {
	code: "unsupported_tool" | "not_self_contained" | "no_readable_content";
	constructor(code: ImportError["code"], message: string) {
		super(message);
		this.code = code;
	}
}
