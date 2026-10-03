import { posix } from "node:path";
import { parseFragment, serialize } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import type { Block, Inline, Src } from "./model.ts";

type Node = DefaultTreeAdapterMap["childNode"] | DefaultTreeAdapterMap["documentFragment"];
type Element = DefaultTreeAdapterMap["element"];

export type HtmlContext = {
	/** Directory of the HTML source, relative to the package root, for resolving `src`. */
	base: string;
	/** Record a construct the conversion drops; optional so plain text callers can ignore it. */
	lose?: (source: string, detail: string) => void;
};

const SKIP = new Set(["script", "nav", "style", "noscript", "template", "svg", "canvas", "button", "input", "select", "textarea", "form", "object", "embed", "map", "head", "title", "meta", "link"]);
const BLOCK = new Set(["p", "div", "section", "article", "main", "aside", "header", "footer", "figure", "figcaption", "ul", "ol", "li", "dl", "dt", "dd", "table", "blockquote", "pre", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "img", "video", "audio", "iframe", "center", "body", "html", "details", "summary", "fieldset", "picture"]);

const isElement = (n: Node): n is Element => "tagName" in n;
const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value;

export function parse(html: string): DefaultTreeAdapterMap["documentFragment"] {
	return parseFragment(html);
}

/**
 * Plain text as `.prax` inline source. A backslash makes reserved punctuation
 * literal (Studio grammar v3 escaping); only characters that would otherwise
 * start markup are escaped, so ordinary text such as snake_case, [1] or a@b.c
 * stays readable.
 */
/** A string that is only a file name (authoring tools default alt text and titles to it); not a text alternative. */
export const isFileName = (s: string) => /^[^\r\n]+\.(?:png|jpe?g|gif|svg|webp|bmp|tiff?|mp4|m4v|mov|webm|mp3|wav|m4a)$/i.test(s.trim());

export function neutralize(text: string): string {
	return text
		.replace(/\\/g, "\\\\")
		.replace(/[*`]/g, "\\$&")
		.replace(/\{\{/g, "\\{{")
		.replace(/\[(?=[^\]]*\][({])/g, "\\[")
		.replace(/@(?=[\w.-]+\{)/g, "\\@")
		.replace(/==/g, "\\=\\=")
		.replace(/~~/g, "\\~\\~")
		.replace(/(^|[\s(])_(?=\S)|(?<=\S)_(?=$|[\s).,;:!?])/g, (m) => m.replace("_", "\\_"));
}

/** Undo `neutralize` for literal fields such as alt text, which Studio does not unescape. */
export const unescape = (inline: string) => inline.replace(/\\([\\*~=`[\]{}@|:;_#>!()+\/$.?-])/g, "$1");

const hasBlock = (el: Element): boolean =>
	el.childNodes.some((c) => isElement(c) && !SKIP.has(c.tagName) && (BLOCK.has(c.tagName) || hasBlock(c)));

/** Wrap `inner` in a marker, keeping edge spaces outside so the markdown stays valid. */
function wrap(inner: string, mark: string): string {
	const trimmed = inner.trim();
	if (!trimmed) return inner;
	const lead = inner.startsWith(" ") ? " " : "";
	const tail = inner.endsWith(" ") ? " " : "";
	return `${lead}${mark}${trimmed}${mark}${tail}`;
}

function inlineOf(node: Node): string {
	if (!isElement(node)) {
		if (node.nodeName === "#text") return neutralize((node as DefaultTreeAdapterMap["textNode"]).value.replace(/[\s ]+/g, " "));
		if (node.nodeName === "#document-fragment") return (node as DefaultTreeAdapterMap["documentFragment"]).childNodes.map(inlineOf).join("");
		return "";
	}
	const tag = node.tagName;
	if (SKIP.has(tag) || tag === "img") return "";
	if (tag === "br") return "\n";
	const inner = node.childNodes.map(inlineOf).join("");
	switch (tag) {
		case "strong":
		case "b":
			return wrap(inner, "**");
		case "em":
		case "i":
			return wrap(inner, "*");
		case "s":
		case "del":
		case "strike":
			return wrap(inner, "~~");
		case "a": {
			const href = attr(node, "href") ?? "";
			const text = inner.trim();
			if (!text || !/^(https?:|mailto:)/i.test(href)) return inner;
			return `[${text.replace(/[[\]]/g, "")}](${href.replace(/[()\s]/g, encodeURIComponent)})`;
		}
		default:
			// A block element reached through inline flow (a <p> in a question stem) keeps its own line.
			return BLOCK.has(tag) ? `\n${inner}\n` : inner;
	}
}

/** Collapse to a single paragraph's worth of inline text; `\n` survives as a hard break. */
export function tidy(text: string): Inline {
	return text
		.split("\n")
		.map((line) => line.replace(/ {2,}/g, " ").trim())
		.filter(Boolean)
		.join("\n")
		.replace(/\*\*\*\*/g, "")
		.replace(/(^|\s)\*\*(\s|$)/g, "$1$2");
}

/** Inline markdown for an HTML fragment, flattening any block structure into one run. */
export function inline(html: string | undefined): Inline {
	if (!html) return "";
	return tidy(inlineOf(parse(html)));
}

/** Single-line inline text, for headings, labels, options and cells. */
export function line(html: string | undefined): Inline {
	return inline(html).replace(/\n+/g, " ");
}

/** Plain text of an HTML fragment, for alt text, titles and source-text inventories. */
export function text(html: string | undefined): string {
	if (!html) return "";
	const walk = (n: Node): string => {
		if (!isElement(n)) {
			if (n.nodeName === "#text") return (n as DefaultTreeAdapterMap["textNode"]).value;
			return n.nodeName === "#document-fragment" ? (n as DefaultTreeAdapterMap["documentFragment"]).childNodes.map(walk).join("") : "";
		}
		if (SKIP.has(n.tagName)) return "";
		if (n.tagName === "img") return ` ${attr(n, "alt") ?? ""} `;
		const inner = n.childNodes.map(walk).join("");
		return BLOCK.has(n.tagName) || n.tagName === "br" ? ` ${inner} ` : inner;
	};
	return walk(parse(html)).replace(/[\s ]+/g, " ").trim();
}

export function resolveSrc(ctx: HtmlContext, src: string | undefined): Src | undefined {
	if (!src || src.startsWith("data:")) return undefined;
	if (/^https?:\/\//i.test(src)) return src;
	if (src.startsWith("//")) return `https:${src}`;
	const clean = decodeURIComponent(src.split(/[?#]/)[0] ?? "");
	const joined = posix.normalize(posix.join(ctx.base, clean));
	return joined.startsWith("..") ? undefined : joined;
}

const VIDEO_HOST = /(youtube\.com|youtu\.be|vimeo\.com|loom\.com|wistia\.)/i;

/** Convert an HTML fragment to blocks, preserving document order. */
export function blocks(html: string | undefined, ctx: HtmlContext): Block[] {
	if (!html) return [];
	return flow(parse(html).childNodes, ctx);
}

export function flow(nodes: Node[], ctx: HtmlContext): Block[] {
	const out: Block[] = [];
	let run: Node[] = [];
	const flush = () => {
		const t = tidy(run.map(inlineOf).join(""));
		if (t) out.push({ kind: "paragraph", text: t });
		run = [];
	};
	for (const node of nodes) {
		if (!isElement(node)) {
			run.push(node);
			continue;
		}
		if (SKIP.has(node.tagName)) continue;
		if (!BLOCK.has(node.tagName) && !hasBlock(node)) {
			run.push(node);
			continue;
		}
		flush();
		out.push(...element(node, ctx));
	}
	flush();
	return out;
}

function element(el: Element, ctx: HtmlContext): Block[] {
	const tag = el.tagName;
	const heading = /^h([1-6])$/.exec(tag);
	if (heading) {
		const t = tidy(inlineOf(el)).replace(/\n+/g, " ");
		const level = Math.min(Number(heading[1]), 4) as 1 | 2 | 3 | 4;
		return [...images(el, ctx), ...(t ? [{ kind: "heading", level, text: t } as const] : [])];
	}
	switch (tag) {
		case "p": {
			const t = tidy(inlineOf(el));
			return [...images(el, ctx), ...(t ? [{ kind: "paragraph", text: t } as const] : [])];
		}
		case "ul":
		case "ol": {
			const items = listItems(el);
			return items.length ? [...images(el, ctx), { kind: "list", ordered: tag === "ol", items }] : images(el, ctx);
		}
		case "img": {
			const src = resolveSrc(ctx, attr(el, "src"));
			if (!src) return [];
			return [{ kind: "image", src, alt: (attr(el, "alt") ?? "").trim() }];
		}
		case "figure": {
			const caption = el.childNodes.find((c): c is Element => isElement(c) && c.tagName === "figcaption");
			const inner = flow(el.childNodes.filter((c) => c !== caption), ctx);
			const img = inner.find((b) => b.kind === "image");
			if (img && caption) {
				// A nested figure's image already has its own caption; keep the outer one as text.
				const value = line(serialize(caption));
				if (img.caption) inner.push({ kind: "paragraph", text: value });
				else img.caption = value;
			}
			return inner;
		}
		case "table":
			return table(el);
		case "blockquote": {
			const t = tidy(inlineOf(el));
			return t ? [{ kind: "quote", text: t }] : [];
		}
		case "pre": {
			const t = text(serialize(el));
			return t ? [{ kind: "code", text: collectRaw(el) }] : [];
		}
		case "hr":
			return [{ kind: "divider" }];
		case "video":
		case "audio": {
			const src = resolveSrc(ctx, attr(el, "src") ?? sourceOf(el));
			if (!src) return [];
			const title = attr(el, "title") ?? attr(el, "aria-label");
			return [tag === "video" ? { kind: "video", src, ...(title ? { title } : {}) } : { kind: "audio", src, ...(title ? { title } : {}) }];
		}
		case "iframe": {
			const src = attr(el, "src");
			if (!src || !/^(https?:)?\/\//.test(src)) {
				ctx.lose?.("html:iframe", `local iframe ${src ?? "(no src)"} not imported`);
				return [];
			}
			const url = src.startsWith("//") ? `https:${src}` : src;
			if (VIDEO_HOST.test(url)) return [{ kind: "video", src: url }];
			const height = Number(attr(el, "height"));
			return [{ kind: "embed", url, ...(height > 0 ? { height } : {}) }];
		}
		default:
			return flow(el.childNodes, ctx);
	}
}

function sourceOf(el: Element): string | undefined {
	for (const c of el.childNodes) if (isElement(c) && c.tagName === "source") return attr(c, "src");
	return undefined;
}

function images(el: Element, ctx: HtmlContext): Block[] {
	const found: Block[] = [];
	const walk = (n: Node) => {
		if (!isElement(n)) return;
		if (n.tagName === "img") found.push(...element(n, ctx));
		else n.childNodes.forEach(walk);
	};
	el.childNodes.forEach(walk);
	return found;
}

/** Nested lists flatten into the parent: `.prax` list items are single inline runs here. */
function listItems(list: Element): Inline[] {
	const items: Inline[] = [];
	for (const li of list.childNodes) {
		if (!isElement(li) || li.tagName !== "li") continue;
		const own = li.childNodes.filter((c) => !(isElement(c) && (c.tagName === "ul" || c.tagName === "ol")));
		const t = tidy(own.map(inlineOf).join("")).replace(/\n+/g, " ");
		if (t) items.push(t);
		for (const c of li.childNodes) if (isElement(c) && (c.tagName === "ul" || c.tagName === "ol")) items.push(...listItems(c));
	}
	return items;
}

function table(el: Element): Block[] {
	const rows: Inline[][] = [];
	const walk = (n: Node) => {
		if (!isElement(n)) return;
		if (n.tagName === "tr") {
			const cells = n.childNodes.filter((c): c is Element => isElement(c) && (c.tagName === "td" || c.tagName === "th"));
			const row = cells.map((c) => tidy(inlineOf(c)).replace(/\n+/g, " "));
			if (row.some(Boolean)) rows.push(row);
		} else n.childNodes.forEach(walk);
	};
	walk(el);
	return rows.length ? [{ kind: "table", rows }] : [];
}

function collectRaw(el: Node): string {
	if (!isElement(el)) return el.nodeName === "#text" ? (el as DefaultTreeAdapterMap["textNode"]).value : "";
	return el.tagName === "br" ? "\n" : el.childNodes.map(collectRaw).join("");
}
