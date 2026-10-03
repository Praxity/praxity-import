import { insidePackage } from "../input.ts";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { inflateSync } from "node:zlib";
import type { DefaultTreeAdapterMap } from "parse5";
import { inline, line, neutralize, parse, resolveSrc, text } from "../html.ts";
import { parseLiteral } from "../jslit.ts";
import { readManifest } from "../manifest.ts";
import { slideLayout, type Box, type HeroItem } from "./hero.ts";
import type { Blank, Block, Course, Inline, Lesson, Loss, Option, Page, Theme } from "../model.ts";

/*
 * iSpring Suite HTML5 output (8 to 10): index.html embeds `presInfo`, a
 * base64 zlib-deflated JSON with the slide list (`s`: title `t`, data file `s`,
 * plain text `x`, notes `n`/`N`, outline level `l`, media `S`/`V`/`wo`/`y`,
 * quiz slides `st:"q"`). Each data/slideN.js calls a load handler with the
 * slide's HTML: text shapes are `<div style="width:0px">` line boxes whose
 * spans wrap mid-word, so `x` (paragraphs `\r`, shapes `\r\n`, in DOM order)
 * is the readable text and the HTML only places images between text shapes.
 * data/quizN.js holds `quizInfo`, base64 JSON of the quiz: groups `d.sl.g[].S`
 * of typed questions whose rich text is `{h: styled html, a: plain html}`.
 * Key names come from the players' own schema tables.
 */
type J = Record<string, unknown>;
type Node = DefaultTreeAdapterMap["childNode"];
type Element = DefaultTreeAdapterMap["element"];
const obj = (v: unknown): J => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : {});
const arr = (v: unknown): J[] => (Array.isArray(v) ? v.map(obj) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const num = (v: unknown): number => (typeof v === "number" ? v : Number.NaN);
const isElement = (n: Node): n is Element => "tagName" in n;
const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value ?? "";

/** A base64 payload that may be zlib-deflated (presInfo) or plain (quizInfo). */
function decodePayload(b64: string): J {
	const raw = Buffer.from(b64, "base64");
	let json: string;
	try {
		json = inflateSync(raw).toString("utf8");
	} catch {
		json = raw.toString("utf8");
	}
	return obj(JSON.parse(json));
}

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };

/** The slide HTML passed to the load handler, unescaped from its single-quoted JS literal. */
function slideHtml(file: string): string {
	const src = readFileSync(file, "utf8");
	const m = /loadHandler\s*\(\s*\d+\s*,\s*'((?:[^'\\]|\\[\s\S])*)'/.exec(src);
	if (!m) throw new Error(`${file} does not call the slide load handler`);
	return (m[1] ?? "").replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, e: string) =>
		e[0] === "u" || e[0] === "x" ? String.fromCharCode(parseInt(e.slice(1), 16)) : (ESCAPES[e] ?? e),
	);
}

/** Rich text objects carry a plain `a` HTML beside the styled `h`; strings are already plain. The editor pads runs with zero-width spaces. */
const rich = (v: unknown): string => (typeof v === "string" ? v : str(obj(v).a) || str(obj(v).h)).replace(/\u200b/g, "");

type Unit = Omit<HeroItem, "blocks"> & ({ kind: "text" } | { kind: "image"; src: string; alt: string; layout?: "full" });

/**
 * The slide's own layer is the last `.kern.slide` child; earlier ones are the
 * master and layout. Text shapes and images are listed in document order.
 */
function units(html: string, base: string, styles: Map<string, string>, ctx: Ctx): Unit[] {
	const out: Unit[] = [];
	const isLine = (n: Node) => isElement(n) && n.tagName === "div" && /^width:\s*0px;?$/.test(attr(n, "style").trim());
	const style = (el: Element) => `${styles.get(attr(el, "id")) ?? ""};${attr(el, "style")}`;
	const property = (el: Element, name: string) => {
		const values = [...style(el).matchAll(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "gi"))].map((m) => m[1]!.trim());
		return (values.filter((v) => /!important\s*$/i.test(v)).at(-1) ?? values.at(-1))?.replace(/\s*!important\s*$/i, "").trim();
	};
	const fixed = (value: string | undefined, fallback = Number.NaN) => value === undefined ? fallback : /^-?\d+(?:\.\d+)?(?:px)?$/.test(value) ? Number.parseFloat(value) : Number.NaN;
	let unsupportedStacking = false;
	const offset = (el: Element, axis: "left" | "top") => {
		const z = property(el, "z-index");
		if (z && z !== "auto" && el !== root && el !== own && (el.parentNode !== own || !/^-?\d+$/.test(z))) unsupportedStacking = true;
		const transform = property(el, "(?:-webkit-)?transform");
		return (transform && transform !== "none") || ["left", "top", "width", "height"].some((key) => !Number.isFinite(fixed(property(el, key), 0))) ? Number.NaN : fixed(property(el, axis), 0);
	};
	const textGeometry = (el: Element, x: number, y: number) => {
		const boxes: Box[] = [];
		let fontSize: number | undefined, color: string | undefined;
		const visit = (node: Element, left: number, top: number, font?: number, ink?: string, height?: number) => {
			font = property(node, "font-size") === undefined ? font : fixed(property(node, "font-size"));
			ink = property(node, "color") ?? ink;
			height = property(node, "line-height") === undefined ? height : fixed(property(node, "line-height"));
			if (node.childNodes.some((c) => c.nodeName === "#text" && (c as DefaultTreeAdapterMap["textNode"]).value.trim())) {
				boxes.push({ x: left, y: top, w: fixed(property(node, "width") ?? (attr(node, "data-width") || undefined)), h: height ?? font ?? Number.NaN });
				if (fontSize === undefined || (font !== undefined && font > fontSize)) { fontSize = font; color = ink; }
			}
			for (const child of node.childNodes) if (isElement(child)) visit(child, left + offset(child, "left"), top + offset(child, "top"), font, ink, height);
		};
		const inherited = (name: string): string | undefined => {
			let parent = el.parentNode;
			while (parent && "tagName" in parent) {
				const value = property(parent, name);
				if (value !== undefined) return value;
				parent = parent.parentNode;
			}
		};
		const font = inherited("font-size"), height = inherited("line-height");
		visit(el, x, y, font === undefined ? undefined : fixed(font), inherited("color"), height === undefined ? undefined : fixed(height));
		const left = Math.min(...boxes.map((b) => b.x)), top = Math.min(...boxes.map((b) => b.y));
		const w = fixed(property(el, "width")), h = fixed(property(el, "height"));
		const box = w > 0 && h > 0 ? { x, y, w, h } : { x: left, y: top, w: Math.max(...boxes.map((b) => b.x + b.w)) - left, h: Math.max(...boxes.map((b) => b.y + b.h)) - top };
		if (boxes.some((b) => !Number.isFinite(b.x) || !Number.isFinite(b.y))) box.x = Number.NaN;
		return { box, fontSize, color, singleLine: el.childNodes.filter(isLine).length === 1 };
	};
	const walk = (el: Element, left: number, top: number, z = 0) => {
		if (el.childNodes.some(isLine)) out.push({ kind: "text", order: z, ...textGeometry(el, left, top) });
		for (const c of el.childNodes) {
			if (!isElement(c) || isLine(c) || c.tagName === "svg") continue;
			const x = left + offset(c, "left"), y = top + offset(c, "top");
			const childZ = c.parentNode === own ? Number(property(c, "z-index")?.replace(/^auto$/, "0") ?? 0) : z;
			if (c.tagName === "img") {
				const src = resolveSrc({ base }, attr(c, "src"));
				const w = fixed(property(c, "width") || attr(c, "width")), h = fixed(property(c, "height") || attr(c, "height"));
				const full = ctx.slideWidth > 0 && w === ctx.slideWidth && x === 0;
				if (src) out.push({ kind: "image", src, alt: attr(c, "alt").trim(), order: childZ, box: { x, y, w, h }, ...(full ? { layout: "full" } : {}) });
			} else walk(c, x, y, childZ);
		}
	};
	const root = parse(html).childNodes.find(isElement);
	const countFonts = (node: Node, inherited = "") => {
		if (node.nodeName === "#text" && inherited) {
			const count = [...(node as DefaultTreeAdapterMap["textNode"]).value].length;
			if (count) ctx.fontCounts.set(inherited, (ctx.fontCounts.get(inherited) ?? 0) + count);
		}
		if (!isElement(node) || ["svg", "script", "style"].includes(node.tagName)) return;
		const family = property(node, "font-family");
		const alias = family?.split(",")[0]?.trim().replace(/^["']|["']$/g, "");
		const font = alias ? ctx.fontNames.get(alias) || alias : inherited;
		for (const child of node.childNodes) countFonts(child, font);
	};
	if (root) countFonts(root);
	const layers = root ? root.childNodes.filter((c): c is Element => isElement(c) && /\bslide\b/.test(attr(c, "class"))) : [];
	const own = layers.at(-1) ?? root;
	let background: string | undefined;
	for (const layer of [root, ...layers]) {
		if (!layer) continue;
		const value = property(layer, "background(?:-color)?");
		if (value && !/^(?:transparent|none)$/i.test(value)) background = undefined;
		if (value && /^#[\da-f]{6}$/i.test(value)) background = value.toLowerCase();
		else if (value && /^#[\da-f]{3}$/i.test(value)) background = `#${[...value.slice(1)].map((c) => c + c).join("")}`.toLowerCase();
	}
	if (background) ctx.backgroundCounts.set(background, (ctx.backgroundCounts.get(background) ?? 0) + 1);
	if (own) walk(own, offset(own, "left") + (own === root ? 0 : offset(root!, "left")), offset(own, "top") + (own === root ? 0 : offset(root!, "top")));
	// ponytail: flat sibling z-indices only; resolve nested stacking contexts if a publish needs them.
	if (unsupportedStacking) for (const unit of out) unit.box = undefined;
	else [...out].sort((a, b) => a.order - b.order).forEach((unit, i) => { unit.order = i; });
	return out;
}

type Ctx = {
	root: string;
	dir: string;
	index: string;
	sourceText: string[];
	losses: Loss[];
	/** Source pointer for losses: "slide 3", "slide 3/question 2". */
	at: string;
	fontNames: Map<string, string>;
	fontCounts: Map<string, number>;
	backgroundCounts: Map<string, number>;
	slideWidth: number;
	slideHeight: number;
};
const lose = (ctx: Ctx, source: string, effect: Loss["effect"], detail: string) => ctx.losses.push({ at: ctx.at, source, effect, detail });

/** Paragraph blocks for one text shape; the shape that repeats the slide title is its heading. */
function shapeBlocks(shape: string, title: string): Block[] {
	return shape
		.split(/\r\n?|\n/)
		.map((p) => p.replace(/\s+/g, " ").trim())
		.filter(Boolean)
		.map((p) => (p === title ? { kind: "heading", level: 2, text: neutralize(p) } : { kind: "paragraph", text: neutralize(p) }));
}

/** `src` of the index.html media element the presentation refers to by id. */
function mediaSrc(ctx: Ctx, id: string): string | undefined {
	if (!id) return undefined;
	if (/\.\w{2,4}$/.test(id) && !/\s/.test(id)) return resolveSrc({ base: ctx.dir }, id);
	const tag = new RegExp(`<(?:audio|video)\\b[^>]*\\bid="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>(?:\\s*<source\\b[^>]*>)?`, "i").exec(ctx.index)?.[0];
	const src = tag ? /\bsrc="([^"]+)"/.exec(tag)?.[1] : undefined;
	return src ? resolveSrc({ base: ctx.dir }, src) : undefined;
}

function slidePage(slide: J, ctx: Ctx): Page {
	const title = str(slide.t).trim();
	const shapes = str(slide.x)
		.split("\r\n")
		.map((s) => s.replace(/[\r\n]+$/, ""))
		.filter((s) => s.trim());
	if (title) ctx.sourceText.push(title);
	for (const s of shapes) ctx.sourceText.push(...s.split(/\r\n?|\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean));

	const file = str(slide.s) ? insidePackage(ctx.root, posix.join(ctx.dir, str(slide.s))) : undefined;
	const cssFile = str(slide.c) ? insidePackage(ctx.root, posix.join(ctx.dir, str(slide.c))) : undefined;
	const styles = new Map<string, string>();
	// Published slide styles use flat #id rules. Ignore other selectors.
	if (cssFile) {
		const css = readFileSync(cssFile, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
		let depth = 0, start = 0, body = 0, nested = false;
		for (const brace of css.matchAll(/\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{};]/g)) {
			if (brace[0] === "{") {
				if (depth++ === 0) { body = brace.index + 1; nested = false; }
				else nested = true;
			} else if (brace[0] === "}" && --depth === 0) {
				if (!nested) for (const selector of css.slice(start, body - 1).split(",")) {
					const id = /^\s*#([\w-]+)\s*$/.exec(selector)?.[1];
					if (id) styles.set(id, `${styles.get(id) ?? ""};${css.slice(body, brace.index)}`);
				}
				start = brace.index + 1;
			} else if (brace[0] === ";" && depth === 0) start = brace.index + 1;
		}
	}
	const placed = file ? units(slideHtml(file), ctx.dir, styles, ctx) : [];
	if (str(slide.s) && !file) lose(ctx, "ispring:slide", "dropped", `slide data file ${str(slide.s)} is missing or outside the package`);
	for (const u of placed) if (u.kind === "image" && u.alt) ctx.sourceText.push(u.alt);

	const blocks: Block[] = [];
	const items: HeroItem[] = [];
	const images = placed.filter((u) => u.kind === "image");
	if (placed.filter((u) => u.kind === "text").length === shapes.length) {
		let i = 0;
		for (const u of placed) {
			const emitted: Block[] = u.kind === "text" ? shapeBlocks(shapes[i++] ?? "", title) : [{ kind: "image", src: u.src, alt: u.alt, ...(u.layout ? { layout: u.layout } : {}) }];
			blocks.push(...emitted);
			items.push({ ...u, blocks: emitted });
		}
	} else {
		// Text drawn as glyph paths or SVG has no line boxes to align with; keep the text, then the pictures.
		for (const s of shapes) blocks.push(...shapeBlocks(s, title));
		for (const u of images) if (u.kind === "image") {
			const image: Block = { kind: "image", src: u.src, alt: u.alt, ...(u.layout ? { layout: u.layout } : {}) };
			blocks.push(image);
			items.push({ ...u, blocks: [image] });
		}
		if (images.length && shapes.length) lose(ctx, "ispring:reading-order", "approximated", "text shapes could not be matched to the slide markup; images placed after the text");
	}
	slideLayout(blocks, items, ctx.slideWidth, ctx.slideHeight);

	for (const a of arr(slide.S)) {
		const src = mediaSrc(ctx, str(a.a));
		if (src) blocks.push({ kind: "audio", src });
		else lose(ctx, "ispring:audio", "dropped", `audio narration ${str(a.a) || str(a.i) || "(unnamed)"} has no file in the package`);
	}
	for (const v of arr(slide.V)) {
		const src = mediaSrc(ctx, str(v.a));
		if (src) blocks.push({ kind: "video", src });
		else lose(ctx, "ispring:video", "dropped", `video narration ${str(v.a) || str(v.i) || "(unnamed)"} has no file in the package`);
	}
	for (const y of arr(slide.y)) if (str(y.v)) blocks.push({ kind: "video", src: `https://www.youtube.com/watch?v=${encodeURIComponent(str(y.v))}` });
	for (const w of arr(slide.wo)) {
		const url = str(w.u);
		if (/^https?:\/\//i.test(url)) blocks.push({ kind: "embed", url });
		else lose(ctx, "ispring:webobject", "dropped", `local web object ${url || "(no url)"} not imported`);
	}
	for (const [key, what] of [["yk", "embedded video"], ["f", "Flash movie"], ["z", "zoom region"], ["b", "branching action"], ["m", "media"]] as const) {
		const count = arr(slide[key]).length;
		if (count) lose(ctx, `ispring:${what.replace(/\s+/g, "-")}`, "dropped", `${count} ${what}(s) not imported`);
	}
	const steps = arr(slide.e).length;
	const actions = arr(obj(slide.i).a).length;
	if (steps > 1 || actions) lose(ctx, "ispring:animation", "dropped", `${Math.max(steps - 1, 0)} animation step(s), ${actions} action(s) not imported`);

	const notesHtml = str(slide.N);
	const notes = notesHtml ? inline(notesHtml) : neutralize(str(slide.n).trim()).replace(/\r\n?/g, "\n");
	if (notes) {
		ctx.sourceText.push(text(notesHtml) || str(slide.n).replace(/\s+/g, " ").trim());
		blocks.push({ kind: "note", text: notes });
	}
	return { ...(title ? { title } : {}), blocks };
}

/** Keep literal prose separate from answer data; only the writer emits blank syntax. */
function blankParts(rt: J, pick: (run: J) => Blank): Array<string | Blank> {
	const runs = new Map(arr(rt.r).map((r) => [str(r.id), r]));
	const parts: Array<string | Blank> = [];
	let prose = "";
	const flush = () => {
		const value = prose.replace(/[\s ]+/g, " ");
		if (value) parts.push(value);
		prose = "";
	};
	const walk = (node: Node) => {
		if (node.nodeName === "#text") prose += (node as DefaultTreeAdapterMap["textNode"]).value;
		if (!isElement(node)) return;
		if (["script", "style"].includes(node.tagName)) return;
		const id = attr(node, "id");
		if (node.tagName === "span" && /^qm/.test(id)) {
			flush();
			parts.push(runs.has(id) ? pick(runs.get(id)!) : { answers: [] });
			return;
		}
		const block = /^(?:p|div|br|li|ul|ol|h[1-6])$/.test(node.tagName);
		if (block) prose += " ";
		if (node.tagName === "img") prose += ` ${attr(node, "alt")} `;
		for (const child of node.childNodes) walk(child);
		if (block) prose += " ";
	};
	for (const node of parse(rich(rt)).childNodes) walk(node);
	flush();
	if (typeof parts[0] === "string") parts[0] = parts[0].trimStart();
	const last = parts.length - 1;
	if (typeof parts[last] === "string") parts[last] = (parts[last] as string).trimEnd();
	return parts.filter((p) => p !== "");
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : [str(v)]).filter(Boolean);
const layoutAlt = (o: J): string => str(obj(obj(o.S).a).t).trim() || str(o.n).trim();

/** Images and free text from a quiz slide's layout, excluding the question placeholders. */
function layoutBlocks(slide: J, quizDir: string, ctx: Ctx, withText: boolean, used = new Set<string>()): Block[] {
	const out: Block[] = [];
	for (const o of arr(obj(slide.a).o)) {
		const tp = str(o.tp);
		const alt = layoutAlt(o);
		const plain = text(rich(o.rt));
		if (tp === "image" || used.has(str(o.I))) {
			if (alt) ctx.sourceText.push(alt);
			if (plain) ctx.sourceText.push(plain);
		}
		if (used.has(str(o.I))) continue;
		if (tp === "image") {
			const src = str(o.i).replace(/^storage:\/\//, "");
			if (!src) continue;
			out.push({ kind: "image", src: posix.join(quizDir, src), alt });
			continue;
		}
		if (!withText || ["direction", "content", "additionalContent"].includes(str(o.I))) continue;
		const t = inline(rich(o.rt));
		if (!t) continue;
		ctx.sourceText.push(plain);
		out.push({ kind: "paragraph", text: t });
	}
	return out;
}

function question(q: J, n: number, quizDir: string, outer: Ctx): Block[] {
	const tp = str(q.tp);
	const ctx: Ctx = { ...outer, at: `${outer.at}/question ${n}` };
	const lose = (effect: Loss["effect"], detail: string) => ctx.losses.push({ at: ctx.at, source: `ispring:question/${tp}`, effect, detail });
	const C = obj(q.C);
	const F = obj(obj(q.s).F);
	const promptText = text(rich(q.D));
	if (promptText) ctx.sourceText.push(promptText);
	const prompt = line(rich(q.D)) || `Question ${n}`;
	const graded = obj(q.s).ee !== false;
	const fbText = (key: string) => {
		const v = obj(F[key]).v;
		const plain = text(rich(v));
		if (plain) ctx.sourceText.push(plain);
		return inline(rich(v));
	};
	const correct = graded ? fbText("c") : "";
	const incorrect = graded ? fbText("i") : "";
	const answered = graded ? "" : fbText("a");
	const fb = { ...(correct ? { correct } : {}), ...(incorrect ? { incorrect } : {}) };
	/** Blocks whose kind cannot carry feedback in the model report it once. */
	const withFeedback = (blocks: Block[]): Block[] => {
		const last = blocks.at(-1);
		if (last && ["choice", "match", "order", "categorize", "hotspot", "fillBlank"].includes(last.kind)) {
			// quizplayer settings.yf maps to s.a; -1 means unlimited.
			const attempts = num(obj(q.s).a);
			if (attempts === -1) Object.assign(last, { attempts: 0 });
			else if (Number.isSafeInteger(attempts) && attempts > 0) Object.assign(last, { attempts });
			const retry = graded && ((Number.isSafeInteger(attempts) && attempts > 1) || attempts === -1) ? fbText("at") : "";
			if (retry && retry !== incorrect) lose("approximated", "distinct retry feedback cannot be represented; only final incorrect feedback is kept");
		}
		const kept = last && ["choice", "match", "order", "categorize", "fillBlank"].includes(last.kind);
		const dropped = (kept ? [answered] : [correct, incorrect, answered]).filter(Boolean);
		if (last && dropped.length) lose("approximated", `feedback not kept: ${dropped.map((f) => `"${f}"`).join(", ")}`);
		return blocks;
	};
	const choices = arr(C.chs);
	for (const c of choices) {
		const t = text(rich(c.t));
		if (t) ctx.sourceText.push(t);
	}
	// Inventory source fields before deciding whether the question can be mapped.
	if (tp === "LikertScale") {
		for (const s of arr(C.s)) ctx.sourceText.push(text(rich(s)));
		for (const l of strs(C.l)) ctx.sourceText.push(l);
	}
	const layout = arr(obj(q.a).o);
	const hotspotImage = tp === "Hotspot" ? layout.find((o) => o.i === C.i) ?? layout.find((o) => o.I === "content") : undefined;
	const hotspotAlt = hotspotImage ? layoutAlt(hotspotImage) : "";
	if (tp === "Hotspot") {
		for (const a of arr(C.a)) if (str(a.l)) ctx.sourceText.push(str(a.l));
		if (hotspotAlt && hotspotImage?.tp !== "image") ctx.sourceText.push(hotspotAlt);
	}
	if (tp === "WordBank") ctx.sourceText.push(text(rich(C.rt)), ...arr(obj(C.rt).r).flatMap((run) => strs(obj(run.data).v)), ...strs(C.ew));
	const chains = tp === "DND" ? arr(C.d) : [];
	const used = new Set(chains.flatMap((c) => [str(obj(c.o).s), str(obj(c.d).s)]).filter(Boolean));
	const before = layoutBlocks(q, quizDir, ctx, true, used);
	switch (tp) {
		case "LikertScale": {
			const statements = arr(C.s).map((s) => line(rich(s))).filter(Boolean);
			const scale = strs(C.l).map(neutralize);
			if (!statements.length || scale.length < 2) {
				lose("dropped", "Likert scale has no statements or fewer than two scale labels");
				return before;
			}
			const labels = new Set([prompt, ...scale, ...statements, ...scale.map((_, i) => String(i + 1)), "Likert", "Likert Scale"]);
			const content = before.filter((b) => b.kind !== "paragraph" || !labels.has(b.text.trim()));
			return withFeedback([...content, statements.length === 1
				? { kind: "rating", prompt: `${prompt}\n${statements[0]}`, scale }
				: { kind: "matrix", prompt, scale, statements }]);
		}
		case "Hotspot": {
			const src = str(C.i).replace(/^storage:\/\//, "");
			const areas = arr(C.a);
			// quizplayer scales every area's bounding rect by image size / 1E4, including freeforms.
			if (!src || !areas.length || areas.some((a) => {
				const r = obj(a.r);
				return !["rectangle", "oval", "freeform"].includes(str(a.t)) || typeof a.c !== "boolean"
					|| ![r.x, r.y, r.w, r.h].every((v) => Number.isFinite(num(v)))
					|| num(r.w) <= 0 || num(r.h) <= 0 || num(r.x) < 0 || num(r.y) < 0
					|| num(r.x) + num(r.w) > 10000.001 || num(r.y) + num(r.h) > 10000.001;
			})) {
				lose("dropped", "hotspot has no image or areas, or an area has unsupported geometry or no correct flag");
				return before;
			}
			const spots = areas.map((a, i) => {
				const r = obj(a.r);
				return { label: neutralize(str(a.l)) || `Spot ${i + 1}`, x: (num(r.x) + num(r.w) / 2) / 100, y: (num(r.y) + num(r.h) / 2) / 100, correct: a.c === true };
			});
			lose("approximated", "hotspot regions became points at their bounding-box centres; region shapes and sizes are not kept");
			return withFeedback([...before, { kind: "hotspot", prompt, src: posix.join(quizDir, src), alt: hotspotAlt, spots }]);
		}
		case "DND": {
			const labels = new Map(layout.map((o) => [str(o.I), line(rich(o.rt)) || neutralize(layoutAlt(o))]));
			const categories = new Map<string, { name: Inline; items: Inline[] }>();
			const assigned = new Set<string>();
			for (const c of chains) {
				const [o, d] = [str(obj(c.o).s), str(obj(c.d).s)];
				const [item, name] = [labels.get(o), labels.get(d)];
				if (!item || !name || assigned.has(o)) {
					lose("dropped", "drag-and-drop answer key has a missing object, destination or text/alt label, or assigns an object more than once");
					return before;
				}
				assigned.add(o);
				if (!categories.has(d)) categories.set(d, { name, items: [] });
				categories.get(d)?.items.push(item);
			}
			if (!categories.size) {
				lose("dropped", "drag-and-drop question has no answer key");
				return before;
			}
			const pictures = layout.filter((o) => used.has(str(o.I)) && o.tp === "image");
			if (pictures.length) lose("approximated", `${pictures.length} drag-and-drop picture(s) replaced by text or alt labels; spatial layout not kept`);
			const groups = [...categories.values()];
			return withFeedback([...before, groups.some((g) => g.items.length > 1)
				? { kind: "categorize", prompt, categories: groups, ...fb }
				: { kind: "match", prompt, pairs: groups.map((g): [Inline, Inline] => [g.items[0]!, g.name]), ...fb }]);
		}
		case "MultipleChoice":
		case "TrueFalse":
		case "MultipleResponse": {
			const options: Option[] = choices.map((c) => {
				const feedback = inline(rich(obj(c.f).v));
				if (feedback) ctx.sourceText.push(text(rich(obj(c.f).v)));
				if (str(obj(c.ia).i)) lose("approximated", `picture on answer "${text(rich(c.t))}" not imported`);
				return { text: line(rich(c.t)), correct: c.c === true, ...(feedback ? { feedback } : {}) };
			});
			if (!options.length) {
				lose("dropped", "question has no answer choices");
				return before;
			}
			return withFeedback([...before, { kind: "choice", prompt, multiple: tp === "MultipleResponse", options, ...fb }]);
		}
		case "TypeIn": {
			const accepted = choices.map((c) => str(c.t)).filter(Boolean);
			if (!accepted.length) return withFeedback([...before, { kind: "freeResponse", prompt }]);
			return withFeedback([...before, { kind: "fillBlank", prompt, parts: [{ answers: accepted }], ...fb }]);
		}
		case "Numeric": {
			const conditions = arr(C.na);
			const first = conditions[0];
			if (conditions.length === 1 && first && str(first.co) === "equal" && Number.isFinite(num(first.op))) return withFeedback([...before, { kind: "fillBlank", prompt, parts: [{ answers: [String(num(first.op))] }], ...fb }]);
			lose("approximated", `numeric answer rule "${conditions.map((c) => str(c.co)).join(", ") || "none"}" kept as a free response`);
			return withFeedback([...before, { kind: "freeResponse", prompt }]);
		}
		case "Sequence": {
			const items = choices.map((c) => line(rich(c.t))).filter(Boolean);
			if (items.length < 2) {
				lose("dropped", "sequence has fewer than two items");
				return before;
			}
			return withFeedback([...before, { kind: "order", prompt, items, ...fb }]);
		}
		case "Matching": {
			const pairs: Array<[Inline, Inline]> = [];
			for (const m of arr(C.m)) {
				const [p, r] = [line(rich(obj(m.p).t)), line(rich(obj(m.r).t))];
				ctx.sourceText.push(text(rich(obj(m.p).t)), text(rich(obj(m.r).t)));
				if (p && r) pairs.push([p, r]);
			}
			const extra = arr(obj(C.d).chs);
			for (const d of extra) ctx.sourceText.push(text(rich(d.t)));
			if (extra.length) lose("approximated", `${extra.length} distractor(s) not kept: ${extra.map((d) => `"${text(rich(d.t))}"`).join(", ")}`);
			if (!pairs.length) {
				lose("dropped", "matching question has no pairs");
				return before;
			}
			return withFeedback([...before, { kind: "match", prompt, pairs, ...fb }]);
		}
		case "FillInTheBlank":
		case "WordBank":
		case "MultipleChoiceText": {
			const rt = obj(C.rt);
			if (tp !== "WordBank") ctx.sourceText.push(text(rich(rt)).replace(/\s+/g, " ").trim());
			for (const run of arr(rt.r)) if (tp !== "WordBank") ctx.sourceText.push(...strs(obj(run.data).v));
			const parts = blankParts(rt, (run) => {
				const v = obj(run.data).v;
				if (tp !== "MultipleChoiceText") return { answers: strs(v) };
				const values = Array.isArray(v) ? v.map(str) : [];
				const i = num(obj(run.data).i);
				return { answers: Number.isInteger(i) && values[i] !== undefined ? [values[i]!] : [], choices: values };
			});
			if (parts.some((p) => typeof p !== "string" && !p.answers.length)) lose("approximated", "blank(s) with no answer key kept as unanswered blanks");
			if (!parts.some((p) => typeof p !== "string")) {
				lose("dropped", "fill-in-the-blank has no answer key");
				return before;
			}
			// quizplayer constructs the bank from extra words, then rt.r values, before shuffling.
			const selection = tp === "MultipleChoiceText" ? { style: "dropdown" as const }
				: tp === "WordBank" ? { style: "word-bank" as const, bank: [...strs(C.ew), ...arr(rt.r).flatMap((run) => strs(obj(run.data).v))] } : {};
			return withFeedback([...before, { kind: "fillBlank", prompt, parts, ...selection, ...fb }]);
		}
		case "Essay":
			return withFeedback([...before, { kind: "freeResponse", prompt }]);
		default:
			lose("dropped", `unrecognised question type "${tp}"`);
			return before;
	}
}

/** An intro, instructions or info slide: its text and layout objects as plain blocks. */
function infoBlocks(slide: J, quizDir: string, ctx: Ctx): Block[] {
	const plain = text(rich(slide.D));
	if (plain) ctx.sourceText.push(plain);
	const t = inline(rich(slide.D));
	return [...(t ? [{ kind: "paragraph", text: t } as const] : []), ...layoutBlocks(slide, quizDir, ctx, true)];
}

function quizBlocks(slide: J, ctx: Ctx): Block[] {
	const rel = str(slide.s);
	const file = rel ? insidePackage(ctx.root, posix.join(ctx.dir, rel)) : undefined;
	if (!file) {
		lose(ctx, "ispring:quiz", "dropped", `quiz data file ${rel || "(none)"} is missing`);
		return [];
	}
	const m = /quizInfo\s*=\s*"([A-Za-z0-9+/=]+)"/.exec(readFileSync(file, "utf8"));
	if (!m) {
		lose(ctx, "ispring:quiz", "dropped", `${rel} has no quizInfo payload`);
		return [];
	}
	let payload: J;
	try {
		payload = decodePayload(m[1] ?? "");
	} catch {
		lose(ctx, "ispring:quiz", "dropped", `${rel} has an unreadable quizInfo payload`);
		return [];
	}
	const d = obj(payload.d);
	const sl = obj(d.sl);
	if (!Object.keys(sl).length) {
		// iSpring 8/9 quizzes use a different schema (`q[]` with coded types); their text is counted but not mapped.
		for (const q of arr(payload.q)) ctx.sourceText.push(...[text(str(q.d)), text(str(q.D))].filter(Boolean));
		lose(ctx, "ispring:quiz", "dropped", `${rel} uses an older quiz format (${str(payload.T) || "untitled"}, ${arr(payload.q).length} slides) that is not supported`);
		return [];
	}
	const quizDir = posix.join(ctx.dir, rel.replace(/\.js$/, ""));
	const title = str(d.T).trim() || str(slide.t).trim() || "Quiz";
	ctx.sourceText.push(title);
	const graded = str(obj(obj(d.s).q).pst) !== "survey";

	const before: Block[] = [];
	for (const key of ["i", "in"]) if (sl[key]) before.push(...infoBlocks(obj(sl[key]), quizDir, ctx));
	if (sl.au) lose(ctx, "ispring:quiz/authorization", "dropped", "learner sign-in form not imported");

	const groups = arr(sl.g);
	const questions: Block[] = [];
	let qn = 0;
	for (const g of groups) {
		for (const q of arr(g.S)) {
			const tp = str(q.tp);
			if (q.v === false) continue;
			if (["InfoSlide", "InstructionsSlide", "IntroSlide"].includes(tp)) {
				questions.push(...infoBlocks(q, quizDir, ctx));
				continue;
			}
			questions.push(...question(q, ++qn, quizDir, ctx));
		}
	}
	const ps = obj(obj(groups[0]?.s).ps);
	let passingScore: number | undefined;
	if (graded && groups.length) {
		if (str(ps.u) === "percents" && Number.isFinite(num(ps.v))) passingScore = num(ps.v);
		else lose(ctx, "ispring:quiz/passing-score", "approximated", `passing score of ${str(ps.v)} ${str(ps.u) || "(no unit)"} is not a percentage; none set`);
		if (groups.length > 1) lose(ctx, "ispring:quiz/groups", "approximated", `${groups.length} question groups flattened into one assessment; only the first group's passing score is kept`);
	}
	const results = [...arr(obj(sl.r).g), ...arr(obj(sl.r).s)].map((r) => text(rich(r.D))).filter(Boolean);
	if (results.length) {
		ctx.sourceText.push(...results);
		lose(ctx, "ispring:quiz/result", "dropped", `result messages not imported: ${results.map((r) => `"${r}"`).join(", ")}`);
	}
	return [...before, { kind: "group", title: neutralize(title), ...(passingScore !== undefined ? { passingScore } : {}), blocks: questions }];
}

/** Universal player schema from data/player.js; null/custom skins may ignore k.s entirely. */
function presentationTheme(pres: J, ctx: Ctx): Theme {
	const skin = obj(pres.k);
	const palette = obj(skin.l);
	const theme: Theme = {};
	for (const [source, target] of [
		["button.face.normal", "accent"], ["button.face.normal", "buttonBackground"],
		["button.content.normal", "buttonText"], ["text", "text"],
	] as const) {
		const value = str(palette[source]);
		if (/^#[0-9a-f]{6}$/i.test(value)) theme[target] = value.toLowerCase();
	}
	const playerFile = insidePackage(ctx.root, posix.join(ctx.dir, "data/player.js"));
	const player = playerFile ? readFileSync(playerFile, "utf8") : "";
	const schemaStart = /\{colors:\{A:["']l["']\},controlPanel:/.exec(player)?.index;
	let universal = false;
	if (schemaStart !== undefined) {
		try {
			const schema = obj(parseLiteral(player, schemaStart));
			universal = obj(schema.controlPanel).A === "c" && obj(obj(schema.controlPanel).showOutline).A === "o";
		} catch { /* Unknown player syntax: keep the palette, report its layout below. */ }
	}
	const side = obj(skin.s), title = obj(skin.t), controls = obj(skin.c);
	if (Object.keys(skin).length) theme.navigation = universal && (
		(side.v === true && side.o === true) || (controls.v === true && controls.o === true)
		|| (title.v === true && Array.isArray(title.b) && title.b.includes("outline"))
	) ? "sidebar" : "slides";
	let missingLogo = false;
	if (universal && ((side.v === true && side.l === true) || (title.v === true && title.l === true))) {
		const src = str(obj(obj(pres.C).l).i);
		const logo = src ? posix.join(ctx.dir, src) : "";
		if (logo && insidePackage(ctx.root, logo)) theme.logo = logo;
		else if (src) missingLogo = true;
	}
	if (Object.keys(skin).length || pres.C) ctx.losses.push({ at: "theme", source: "ispring:theme", effect: "approximated", detail: "player palette mapped; custom panel layout, hover states and slide-specific styling are not reproduced" + (!universal ? "; unknown or null player layout uses slide navigation" : "") + (missingLogo ? "; shown logo is missing or outside the package" : "") });
	return theme;
}

export function extractIspring(root: string, dir: string): Course {
	const indexFile = insidePackage(root, posix.join(dir, "index.html"));
	const index = indexFile ? readFileSync(indexFile, "utf8") : "";
	const m = /presInfo\s*=\s*["']([A-Za-z0-9+/=]+)["']/.exec(index);
	if (!m) throw new Error(`iSpring package found, but ${posix.join(dir, "index.html")} has no presInfo payload (Flash-era output is not supported)`);
	const pres = decodePayload(m[1] ?? "");
	const losses: Loss[] = [];
	const sourceText: string[] = [];
	const ctx: Ctx = { root, dir, index, sourceText, losses, at: "presentation", fontNames: new Map(arr(pres.f).map((f) => [str(f.n), str(f.l)])), fontCounts: new Map(), backgroundCounts: new Map(), slideWidth: num(pres.w), slideHeight: num(pres.h) };
	const theme = presentationTheme(pres, ctx);
	theme.density = theme.blockSpacing = "compact";
	if (ctx.slideWidth > 0 && Number.isFinite(ctx.slideWidth)) theme.contentWidth = ctx.slideWidth;

	const manifest = readManifest(root);
	const title = manifest?.title || str(pres.t).trim() || "Untitled course";
	const lang = str(obj(pres.b).l) || (/<html[^>]*\slang=["']([^"']+)/i.exec(index)?.[1] ?? "");
	const locale = lang.split(/[-_]/)[0] ?? "";
	const version = /<!--\s*version\s+([\d.]+)/.exec(index)?.[1] || (/^is\w+?_([\d.]+)_(\d+)/.exec(str(pres.ui))?.slice(1).join(".") ?? "");
	sourceText.push(title);

	const slides = arr(pres.s);
	const nested = slides.some((s) => num(s.l) > 0);
	const lessons: Lesson[] = [];
	slides.forEach((slide, i) => {
		const n = i + 1;
		if (slide.v === false) {
			losses.push({ at: `slide ${n}`, source: "ispring:hidden-slide", effect: "dropped", detail: `hidden slide "${str(slide.t)}" not imported` });
			return;
		}
		const slideCtx: Ctx = { ...ctx, at: `slide ${n}` };
		const type = str(slide.st) || "s";
		let page: Page;
		if (type === "s") page = slidePage(slide, slideCtx);
		else if (type === "q") {
			const t = str(slide.t).trim();
			if (t) sourceText.push(t);
			page = { ...(t ? { title: t } : {}), blocks: quizBlocks(slide, slideCtx) };
		} else {
			const what = type === "i" ? "interaction" : type === "S" ? "simulation" : `"${type}" slide`;
			lose(slideCtx, `ispring:${type === "i" ? "interaction" : type === "S" ? "scenario" : "slide"}`, "dropped", `${what} "${str(slide.t)}" (${str(slide.s) || "no data file"}) not imported`);
			const t = str(slide.t).trim();
			if (t) sourceText.push(t);
			page = { ...(t ? { title: t } : {}), blocks: [] };
		}
		const startsLesson = !lessons.length || (nested && !(num(slide.l) > 0));
		if (startsLesson) lessons.push({ sourceId: nested ? str(slide.I) || `slide-${n}` : str(pres.i) || "presentation", title: nested ? page.title || `Slide ${n}` : title, pages: [] });
		lessons.at(-1)?.pages.push(page);
	});

	// Most characters wins, with UTF-16 code-unit order breaking ties. No player-font substitution.
	const font = [...ctx.fontCounts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]?.[0];
	if (font) {
		theme.bodyFont = theme.headingFont = font;
		const detail = "most-used slide font applied to headings and body";
		const loss = losses.find((l) => l.source === "ispring:theme");
		if (loss) loss.detail += `; ${detail}`;
		else losses.push({ at: "theme", source: "ispring:theme", effect: "approximated", detail });
	}
	const background = [...ctx.backgroundCounts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]?.[0];
	if (background) theme.background = background;
	if (slides.length) {
		const detail = "recorded slide colours are reduced to the most-used background; player page colour is excluded. Master artwork, raster backgrounds, overlays and fixed slide layouts are not reproduced. Sources: slide HTML and CSS";
		const loss = losses.find((l) => l.source === "ispring:theme");
		if (loss) loss.detail += `; ${detail}`;
		else losses.push({ at: "theme", source: "ispring:theme", effect: "approximated", detail });
	}
	return {
		tool: "ispring",
		...(Object.keys(theme).length ? { theme } : {}),
		...(version ? { toolVersion: version } : {}),
		sourceId: str(pres.i) || manifest?.identifier || title,
		title,
		...(locale ? { locale } : {}),
		lessons: lessons.length ? lessons : [{ sourceId: str(pres.i) || "presentation", title, pages: [{ blocks: [] }] }],
		losses,
		sourceText,
	};
}
