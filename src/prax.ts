import { neutralize } from "./html.ts";
import type { Blank, Block, Course, Inline, Lesson } from "./model.ts";

/** YAML scalar. JSON strings are valid YAML and quote everything that needs it. */
const y = (value: string) => JSON.stringify(value);

/**
 * Literal parameter values (alt, speaker, paths) are single lines: a newline
 * would start another key, and `| key: value` inside a value is Studio's inline
 * parameter separator. Studio does not unescape these fields, so a look-alike
 * bar is the only way to keep such text from splitting.
 */
const one = (value: string) =>
	value
		.replace(/\s*\n\s*/g, " ")
		.replace(/\|(?=\s*[A-Za-z][\w-]*:)/g, "\u2223")
		.trim();

/** Inline parameter values (caption, title, feedback, description) decode escapes, so `\|` keeps a bar literal. */
const param = (value: Inline) =>
	value
		.replace(/\s*\n\s*/g, " ")
		.replace(/(?<!\\)\|(?=\s*[A-Za-z][\w-]*:)/g, "\\|")
		.trim();

/** A field split on `delim` (table cells on `|`, match sides on `::`, hotspot fields on `;`). */
const field = (value: Inline, delim: string) => param(value).split(delim).join(`\\${delim}`);

/** A blank answer or word-bank entry: plain text, with its delimiters and marker characters escaped. */
const answer = (value: string) => value.replace(/[\\|{}]/g, "\\$&").replace(/^[~*]/, "\\$&").trim();

/** Fill-blank sentence text: inline escapes plus braces and runs of underscores, which would make blanks. */
const sentence = (text: string) =>
	text
		.split(/(_{3,})/)
		.map((seg, i) => (i % 2 ? `\\${seg}` : neutralize(seg).replace(/(?<!\\)[{}]/g, "\\$&")))
		.join("");

function blank(b: Blank, style: "dropdown" | "word-bank" | undefined): string {
	if (style === "dropdown") return `{${(b.choices ?? b.answers).map((c) => `${b.answers.includes(c) ? "*" : ""}${answer(c)}`).join("|")}}`;
	return b.answers.length ? `{${b.answers.map(answer).join("|")}}` : "____";
}

/**
 * A line of body text that Studio would read as syntax. Probed against Studio
 * 0.2.0: a leading backslash is removed and the line kept as text. Inline
 * markup has no such escape; see `neutralize` in html.ts.
 */
const RESERVED = [
	/^#/, /^>/, /^[-+*]\s/, /^-{2,}/, /^\d+[.)]\s/, /^\|/, /^\$\$/, /^```/, /^~~~/,
	/^[A-Za-z][\w-]*:(\s|$)/, // parameter or keyword (as:, close:, var:, if:, feedback: …)
	/^[([]\s?[xX ]?\s?[)\]]\s/, // choice markers
	/^!?\[[^\]]*\]\([^)]*\)$/, // a whole-line link becomes a link/button block
	/^(https?:\/\/|\/)\S+$/, // a bare URL or path becomes a media block
];

export function escapeLines(text: Inline): string {
	return text
		.split("\n")
		.map((l) => (RESERVED.some((r) => r.test(l)) ? `\\${l}` : l))
		.join("\n");
}

export type AssetMap = Map<string, string>;

function media(src: string, assets: AssetMap): string {
	return /^https?:/i.test(src) ? src : `/${assets.get(src) ?? src}`;
}

type Ctx = { assets: AssetMap; /** Heading level for container items and questions on this page. */ item: number; shuffle?: boolean; /** Inside a graded quiz group. */ graded?: boolean; /** A guided-slides deck, where graded questions gate Next. */ deck?: boolean };

/** Studio accepts retries on all six scored question kinds, including practice checks. */
const questionParams = (b: { scored?: boolean; attempts?: number }, ctx: Ctx) => [
	...(b.scored || ctx.graded ? ["scored: true"] : []),
	// Studio's deck gate opens on a correct answer or once attempts run out, as slide players do; with
	// unlimited attempts it would demand a correct answer, so those questions open on submission.
	...(ctx.deck && (b.scored || ctx.graded) && b.attempts === 0 ? ["deckGate: attempt"] : []),
	// Zero is Studio's unlimited-attempt sentinel, including on scored questions.
	...(Number.isInteger(b.attempts) && (b.attempts === 0 || b.attempts! > 1) ? [`attempts: ${b.attempts}`, "feedbackMode: retry"] : []),
];

function stem(prompt: Inline): { heading: string; description?: string } {
	const parts = prompt.split("\n").map((p) => p.trim()).filter(Boolean);
	if (parts.length <= 1) return { heading: param(prompt) || "Question" };
	return { heading: parts.at(-1) ?? "Question", description: parts.slice(0, -1).join(" ") };
}

function question(q: Inline, as: string, level: number, extra: string[] = []): string[] {
	const { heading, description } = stem(q);
	return [`${"#".repeat(level)} ${escapeHeading(heading)}`, `as: ${as}`, ...(description ? ["display: scenario", `description: ${param(description)}`] : []), ...extra, ""];
}

/** A heading's text follows `#`, so only leading `#` or trailing markers can misparse. */
const escapeHeading = (t: string) =>
	param(t)
		.replace(/^(\*{1,3})([^*].*?)\1$/, "$2") // headings are already strong; drop whole-heading emphasis
		.replace(/^#+/, (m) => m.replace(/#/g, "＃")) || "Untitled";

function feedback(b: { correct?: Inline; incorrect?: Inline }): string[] {
	return [...(b.correct ? [`correct: ${param(b.correct)}`] : []), ...(b.incorrect ? [`incorrect: ${param(b.incorrect)}`] : [])];
}

export function block(b: Block, ctx: Ctx): string {
	switch (b.kind) {
		case "heading":
			if (!b.background) return [`${"#".repeat(b.level)} ${escapeHeading(b.text)}`, ...(b.subtitle ? ["", escapeLines(b.subtitle)] : [])].join("\n");
			return [
				`${"#".repeat(b.level)} ${escapeHeading(b.text)}`,
				`background: ${media(b.background.src, ctx.assets)}`,
				"width: full",
				...(b.background.alt ? [`backgroundAlt: ${one(b.background.alt)}`] : []),
				...(b.background.overlay ? [`overlay: ${b.background.overlay}`] : []),
				...(b.subtitle ? [`subtitle: ${param(b.subtitle)}`] : []),
			].join("\n");
		case "paragraph":
			return escapeLines(b.text);
		case "list":
			return b.items.map((t, i) => `${b.ordered ? `${i + 1}.` : "-"} ${param(t)}`).join("\n");
		case "image":
			return [media(b.src, ctx.assets), b.alt ? `alt: ${one(b.alt)}` : "decorative: true", ...(b.caption ? [`caption: ${param(b.caption)}`] : []), ...(b.layout === "full" ? ["width: full"] : b.layout ? [`size: ${b.layout}`] : []), ...(b.ratio ? [`ratio: ${b.ratio}`] : []), ...(b.fit ? [`fit: ${b.fit}`] : [])].join("\n");
		case "video":
			return [media(b.src, ctx.assets), ...(b.title ? [`title: ${param(b.title)}`] : []), ...(b.caption ? [`caption: ${param(b.caption)}`] : []), ...(b.captions ? [`captions: ${media(b.captions, ctx.assets)}`] : [])].join("\n");
		case "file":
			return [`[${param(b.label).replace(/(?<!\\)[[\]]/g, "")}](${media(b.src, ctx.assets).replace(/[()\s]/g, encodeURIComponent)})`, "as: button"].join("\n");
		case "audio":
			return [media(b.src, ctx.assets), ...(b.title ? [`title: ${param(b.title)}`] : [])].join("\n");
		case "embed":
			return [b.url, "as: embed", ...(b.height ? [`height: ${b.height}`] : [])].join("\n");
		case "quote":
			return [...b.text.split("\n").map((l) => `> ${l}`), ...(b.speaker ? [`speaker: ${one(b.speaker)}`] : []), ...(b.style ? [`style: ${b.style}`] : [])].join("\n");
		case "note":
			return [...b.text.split("\n").map((l) => `> ${l}`), "as: note", ...(b.title ? [`title: ${param(b.title)}`] : [])].join("\n");
		case "table":
			return [...b.rows.map((r) => `| ${r.map((c) => field(c, "|") || " ").join(" | ")} |`), ...(b.chart ? [`chart: ${b.chart}`] : [])].join("\n");
		case "code": {
			const fence = b.text.includes("```") ? "~~~~" : "```";
			return `${fence}${b.lang ?? ""}\n${b.text.replace(/\n+$/, "")}\n${fence}`;
		}
		case "divider":
			return b.tone ? `--\npalette: ${b.tone}` : "--";
		case "columns": {
			const cols = b.columns.filter((c) => c.length);
			if (cols.length < 2) return cols.flat().map((x) => block(x, ctx)).filter(Boolean).join("\n\n");
			return [...cols.map((c) => ["as: col", "", c.map((x) => block(x, ctx)).filter(Boolean).join("\n\n"), ""].join("\n")), "close: col"].join("\n");
		}
		case "container": {
			const out: string[] = [];
			b.items.forEach((item, i) => {
				out.push(`${"#".repeat(ctx.item)} ${escapeHeading(item.title)}`);
				if (i === 0) out.push(`as: ${b.as}`);
				out.push("", inner(item.blocks, ctx), "");
			});
			out.push(`close: ${b.as}`);
			return out.join("\n");
		}
		case "cards": {
			// A card set opens with a bare `as: card` line; each card is a sub-heading inside it.
			// (A heading carrying `as: card` makes a one-card set, so cards must not repeat that form.)
			const level = Math.min(ctx.item + 1, 4);
			const out: string[] = ["as: card", "layout: slides", ""];
			b.items.forEach((card) => {
				out.push(`${"#".repeat(level)} ${escapeHeading(card.title)}`);
				out.push("", inner(card.front, { ...ctx, item: Math.min(level + 1, 4) }), "");
				if (card.back.length) out.push("card: back", inner(card.back, { ...ctx, item: Math.min(level + 1, 4) }), "");
			});
			out.push("close: card");
			return out.join("\n");
		}
		// Feedback goes with the question's parameters: Studio drops trailing correct:/incorrect: on match and fill-blank.
		case "choice": {
			const opts = b.options.flatMap((o) => [`${b.multiple ? (o.correct ? "[x]" : "[ ]") : o.correct ? "(x)" : "( )"} ${param(o.text)}`, ...(o.feedback ? [`feedback: ${param(o.feedback)}`] : [])]);
			return [...question(b.prompt, "choice", ctx.item, [...questionParams(b, ctx), ...(ctx.shuffle ? ["shuffle: true"] : []), ...feedback(b)]), ...opts].join("\n");
		}
		case "match":
			return [...question(b.prompt, "match", ctx.item, [...questionParams(b, ctx), "shuffle: true", ...feedback(b)]), ...b.pairs.map(([l, r]) => `${field(l, "::")} :: ${field(r, "::")}`)].join("\n");
		case "order":
			return [...question(b.prompt, "order", ctx.item, [...questionParams(b, ctx), ...feedback(b)]), ...b.items.map((t, i) => `${i + 1}. ${param(t)}`)].join("\n");
		case "categorize":
			return [...question(b.prompt, "categorize", ctx.item, [...questionParams(b, ctx), "shuffle: true", ...feedback(b)]), ...b.categories.flatMap((c) => [`${param(c.name).replace(/:$/, "")}:`, ...c.items.map((t) => `- ${param(t)}`), ""])].join("\n").trimEnd();
		case "fillBlank": {
			const style = b.style ? [`style: ${b.style}`, ...(b.style === "word-bank" && b.bank ? [`bank: ${b.bank.map(answer).join(" | ")}`] : [])] : [];
			const body = b.parts.map((part) => (typeof part === "string" ? sentence(part) : blank(part, b.style))).join("");
			return [...question(b.prompt, "fill-blank", ctx.item, [...questionParams(b, ctx), ...style, ...feedback(b)]), escapeLines(body.trim())].join("\n");
		}
		case "matrix":
			return [...question(b.prompt, "matrix", ctx.item, ["width: wide"]), ...b.scale.map((t, i) => `${i + 1}: ${param(t)}`), "", ...b.statements.map((t) => `- ${param(t)}`)].join("\n");
		case "rating":
			return [...question(b.prompt, "rating", ctx.item), ...b.scale.map((t, i) => `${i + 1}: ${param(t)}`)].join("\n");
		case "hotspot": {
			// Spot fields are `;`-separated, and every parameter line must be contiguous.
			const pct = (n: number) => `${Math.round(Math.min(100, Math.max(0, n)) * 10) / 10}%`;
			const spots = b.spots.map((sp, i) => `spot: ${field(sp.label, ";") || `Spot ${i + 1}`}; ${pct(sp.x)}; ${pct(sp.y)}${sp.correct ? "; correct" : ""}`);
			return [...question(b.prompt, "hotspot", ctx.item, questionParams(b, ctx)), media(b.src, ctx.assets), `alt: ${one(b.alt)}`, ...spots].join("\n");
		}
		case "group": {
			const members = b.blocks.map((m) => block(m, { ...ctx, item: Math.min(ctx.item + 1, 4), shuffle: b.shuffle ?? false, graded: true })).filter(Boolean);
			const settings = ["as: assessment-group", "showResultsSummary: true", ...(b.passingScore !== undefined ? [`passingScore: ${b.passingScore}`] : [])];
			return [`${"#".repeat(ctx.item)} ${escapeHeading(b.title)}`, ...settings, "", members.join("\n\n"), "", "close: assessment-group"].join("\n");
		}
		case "freeResponse":
			return [`${"#".repeat(ctx.item)} ${escapeHeading(b.prompt)}`, "as: free-response", ...(b.description ? [`description: ${param(b.description)}`] : [])].join("\n");
	}
}

/**
 * Content inside a container item must not contain headings at or above the
 * item level (they would start the next item) or other containers (nesting
 * rules differ per container). Headings become bold paragraphs, nested
 * containers and cards flatten into labelled runs, and questions use headings
 * one level below the item.
 */
function inner(blocks: Block[], ctx: Ctx): string {
	const deeper = { ...ctx, item: Math.min(ctx.item + 1, 4) };
	const run = (label: string, body: Block[]) => [`**${label}**`, inner(body, ctx)].filter(Boolean).join("\n\n");
	return blocks
		.map((b) => {
			if (b.kind === "heading") return block({ kind: "paragraph", text: `**${b.text}**` }, ctx);
			if (b.kind === "container") return b.items.map((it) => run(it.title, it.blocks)).join("\n\n");
			if (b.kind === "cards") return b.items.map((c) => run(c.title, [...c.front, ...c.back])).join("\n\n");
			if (b.kind === "group") return run(b.title, b.blocks);
			return block(b, deeper);
		})
		.filter(Boolean)
		.join("\n\n");
}

export function lesson(l: Lesson, id: string, lang: string | undefined, assets: AssetMap, deck = false): string {
	const front = ["---", `id: ${id}`, `title: ${y(l.title)}`, ...(lang ? [`lang: ${lang}`] : [])];
	const first = l.pages[0];
	if (first?.title) front.push("firstPage:", `  title: ${y(one(first.title))}`);
	front.push("---", "");
	const body = l.pages.map((p, i) => {
		// A page that is only a quiz uses the quiz title as its primary heading.
		const item = p.blocks.length && p.blocks.every((b) => b.kind === "group") ? 1 : pageItemLevel(p.blocks);
		const blocks = p.blocks.map((b) => block(b, { assets, item, deck })).filter(Boolean).join("\n\n");
		return i === 0 ? blocks : `--- ${one(p.title ?? "").replace(/^-+/, "")}`.trimEnd() + (blocks ? `\n\n${blocks}` : "");
	});
	return `${front.join("\n")}\n${body.join("\n\n")}\n`;
}

/**
 * Containers and questions use headings one level below the page's top heading
 * (level 2 on a page without headings), so the outline never skips a level.
 */
function pageItemLevel(blocks: Block[]): number {
	const top = Math.min(...blocks.flatMap((b) => (b.kind === "heading" ? [b.level] : [])));
	return top <= 1 || !Number.isFinite(top) ? 2 : 3;
}

export function courseYaml(c: Course, id: string, files: string[], design: string[] = []): string {
	return [
		`title: ${y(c.title)}`,
		`id: ${id}`,
		...(c.description ? [`description: ${y(one(c.description))}`] : []),
		...(c.locale ? [`locale: ${c.locale}`] : []),
		...(c.theme?.format === "slides" ? ["moduleDeck: true"] : []),
		"lessons:",
		...files.map((f) => `  - ${f}`),
		...design,
		"",
	].join("\n");
}
