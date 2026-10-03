import { insidePackage } from "../input.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { blocks as htmlBlocks, neutralize, parse, text, tidy } from "../html.ts";
import type { DefaultTreeAdapterMap } from "parse5";
import { type Blank, type Block, type Course, type Inline, type Item, type Lesson, type Loss, markScored, type Page, type Theme } from "../model.ts";
import { find, kids, parseXml, textOf } from "../xml.ts";
import { type Box, type HeroItem, slideLayout } from "./hero.ts";

/*
 * Storyline HTML5 output: html5/data/js/data.js carries the scene/slide tree
 * and each slide's html5url points at its own data file. Every file is
 * `globalProvideData('<name>', '<JSON as a JS string literal>')`. Text lives in
 * object.textLib[].vartext (blocks of styled spans; an HTML string in older
 * versions; only glyph paths in 3.40-era output, where altText is the copy).
 * Quiz definitions are `interactions` on the slide entry in data.js.
 */
type J = Record<string, unknown>;
const obj = (v: unknown): J => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : {});
const arr = (v: unknown): J[] => (Array.isArray(v) ? v.map(obj) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const num = (v: unknown): number => (typeof v === "number" ? v : Number.NaN);

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };

/** Decode one `globalProvideData` file: unescape the JS string literal, then parse its JSON. */
export function provided(file: string): J {
	const src = readFileSync(file, "utf8");
	const m = /globalProvideData\('\w+',\s*'([\s\S]*)'\s*\)\s*;?\s*$/.exec(src);
	if (!m) throw new Error(`${file} does not call globalProvideData`);
	const json = (m[1] ?? "").replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, e: string) =>
		e[0] === "u" || e[0] === "x" ? String.fromCharCode(parseInt(e.slice(1), 16)) : (ESCAPES[e] ?? e),
	);
	return obj(JSON.parse(json));
}

const HAS_VAR = /%[\w.$-]+%/;
// Keep unresolved %name% references verbatim; Storyline encodes a literal percent as ^%^.
const literalText = (s: string) => s.replace(/\^%\^/g, "%");
/** Generic labels Storyline gives freeform interactions; the real question is on the slide. */
const GENERIC_PROMPT = new Set(["Pick One", "Pick Many", "Drag and Drop", "Text Entry Interaction", "Hotspot", "Word Bank", "Shortcut Key", "Sequence"]);
/** Objects that hold other objects without being content themselves. */
const CONTAINERS = new Set(["objgroup", "scrollarea", "shufflegroup", "stategroup"]);

/** A slide object in reading order, with the state group it belongs to (if any). */
type Placed = { o: J; tab: number; seq: number; inState: boolean };

/**
 * Flatten a layer's object tree in the author's focus order (tabIndex), which is
 * the accessibility order Storyline itself uses. Objects without one keep their
 * source order after the rest. State groups repeat their label once per
 * visual state, so identical text inside one group is kept once.
 */
function placed(objects: J[]): Placed[] {
	const out: Placed[] = [];
	const walk = (list: J[], inState: boolean, seen: Set<string> | undefined) => {
		for (const o of list) {
			if (CONTAINERS.has(str(o.kind))) {
				const acc = str(o.accType);
				if (acc === "radio" || acc === "checkbox") continue; // a grouped choice: the interaction block carries its text
				const button = str(o.kind) === "stategroup" || acc === "button";
				walk(arr(o.objects), inState || button, button ? new Set() : seen);
				continue;
			}
			if (/(Correct|Incorrect)Review$|_ReviewShape$/.test(str(o.id))) continue; // quiz review-mode markers, not content
			if (o.tabEnabled === false) continue; // hidden from assistive tech by the author: decorative or player chrome
			const key = plainText(o).join("\n");
			if (seen && key) {
				if (seen.has(key)) continue;
				seen.add(key);
			}
			const tab = num(o.tabIndex);
			out.push({ o, tab: tab >= 0 ? tab : Number.POSITIVE_INFINITY, seq: out.length, inState });
		}
	};
	walk(objects, false, undefined);
	return out.sort((a, b) => a.tab - b.tab || a.seq - b.seq);
}

const altOf = (o: J) => str(obj(obj(o.data).vectorData).altText) || str(obj(obj(o.data).textdata).altText) || str(obj(obj(o.data).imagedata).altText) || str(o.altText);
const firstText = (o: J): J => arr(o.textLib)[0] ?? obj(obj(o.data).textdata);

/** Visible strings of one object, before any mapping: text runs, or alt text for media. */
function plainText(o: J): string[] {
	const kind = str(o.kind);
	if (kind === "sequencectrl") return arr(obj(o.data).itemlist).flatMap((item) => plainText({ data: { textdata: item.textdata } }));
	if (kind === "textinput") return [str(o.placeholder)].filter(Boolean);
	if (kind === "video") return [str(obj(obj(o.data).videodata).altText)].filter(Boolean);
	if (kind === "svgimage") return [str(obj(obj(o.data).imagedata).altText)].filter(Boolean);
	if (str(o.accType) === "image") return [altOf(o)].filter(Boolean);
	const t = firstText(o);
	if (!Object.keys(t).length) return [];
	const vt = t.vartext;
	let s: string;
	if (typeof vt === "string") s = text(vt);
	else if (vt && typeof vt === "object") s = arr(obj(vt).blocks).map((b) => arr(b.spans).map((sp) => str(sp.text)).join("")).join("\n");
	else s = altOf(o); // glyph-only text: the accessible copy is all that survives
	s = literalText(s).replace(/[\s\r\v]+/g, " ").trim();
	return s ? [s] : [];
}

/** Styled spans of one vartext block as prax inline text. */
function spanInline(block: J, base: J): Inline {
	let out = "";
	for (const sp of arr(block.spans)) {
		const style = obj(sp.style);
		const raw = literalText(str(sp.text)).replace(/[\r\v]/g, "\n");
		const t = neutralize(raw);
		const bold = (style.fontIsBold ?? base.fontIsBold) === true;
		const italic = (style.fontIsItalic ?? base.fontIsItalic) === true;
		const trimmed = t.trim();
		if (!trimmed || (!bold && !italic)) {
			out += t;
			continue;
		}
		const mark = bold && italic ? "***" : bold ? "**" : "*";
		out += `${t.startsWith(" ") ? " " : ""}${mark}${trimmed}${mark}${t.endsWith(" ") ? " " : ""}`;
	}
	return tidy(out);
}

/** One text object's paragraphs, headings and lists, in the author's paragraph order. */
function textBlocks(o: J, ctx: SlideCtx): Block[] {
	const t = firstText(o);
	if (!Object.keys(t).length) return []; // a plain shape: its alt text is only its name
	const vt = t.vartext;
	if (typeof vt === "string") return htmlBlocks(literalText(vt), { base: "" });
	if (!vt || typeof vt !== "object") {
		const alt = neutralize(literalText(altOf(o))).replace(/[\r\v]/g, "\n");
		const p = tidy(alt);
		return p ? [{ kind: "paragraph", text: p }] : [];
	}
	const v = obj(vt);
	const base = obj(obj(v.defaultBlockStyle).baseSpanStyle);
	const out: Block[] = [];
	for (const b of arr(v.blocks)) {
		const style = obj(b.style);
		const inline = spanInline(b, base);
		if (!inline) continue;
		const listType = str(obj(style.listStyle ?? obj(v.defaultBlockStyle).listStyle).listType);
		const heading = /^H([1-6])$/.exec(str(style.tagType));
		if (listType && listType !== "none") {
			const ordered = listType !== "bullet";
			const last = out.at(-1);
			const item = inline.replace(/\n+/g, " ");
			if (last?.kind === "list" && last.ordered === ordered) last.items.push(item);
			else out.push({ kind: "list", ordered, items: [item] });
		} else if (heading) out.push({ kind: "heading", level: Math.min(Number(heading[1]) + 1, 4) as 2 | 3 | 4, text: inline.replace(/\n+/g, " ") });
		else out.push({ kind: "paragraph", text: inline });
	}
	return out;
}

type SlideCtx = {
	root: string;
	paths: J;
	asset: (id: unknown) => string;
	skipPicture: (o: J) => boolean;
	/** Strings the question block already carries, so the slide's copies are not repeated. */
	quizText: Set<string>;
	/** Blocks standing in for text-entry fields, keyed by object id. */
	entries: Map<string, Block>;
	questionBoxes: Map<Block, Box>;
	/** Only objects whose content or drag behaviour a mapped question accounts for. */
	accounted: Set<J>;
	buttons: string[];
	/** Labelled buttons that jump to a specific slide: a menu, imported as a list of its labels. */
	menu: number;
	vars: number;
	lose: (source: string, effect: Loss["effect"], detail: string) => void;
	events: number;
	animations: number;
	states: number;
	dragdrop: number;
};

/** Media file for an image object: the export's own file, or the mobile PNG when the original is Flash. */
function imageSrc(o: J, ctx: Pick<SlideCtx, "root" | "asset">): string | undefined {
	const lib = arr(o.imagelib)[0] ?? obj(obj(o.data).imagedata);
	const own = str(lib.url);
	const fallback = ctx.asset(lib.assetId);
	const usable = (p: string) => p && !p.endsWith(".swf");
	for (const p of [own, fallback]) if (usable(p) && insidePackage(ctx.root, p)) return p;
	return [own, fallback].find(usable);
}

/** Blocks for one slide layer, in reading order. */
function layerBlocks(layer: J, ctx: SlideCtx, slide?: J, questions: Block[] = []): Block[] {
	const out: Block[] = [];
	const candidates: HeroItem[] = [];
	const boxes = slide ? bounds(arr(layer.objects)) : new Map();
	for (const a of arr(layer.audiolib)) {
		const src = ctx.asset(a.assetId);
		if (src) out.push({ kind: "audio", src });
	}
	ctx.events += arr(layer.events).length;
	const tally = (list: J[]) => {
		for (const o of list) {
			ctx.events += arr(o.events).length;
			ctx.animations += arr(o.animations).length;
			ctx.states += arr(o.states).length;
			if (o.dragdrop && !ctx.accounted.has(o)) ctx.dragdrop++;
			tally(arr(o.objects));
		}
	};
	tally(arr(layer.objects));
	for (const { o, inState, seq } of placed(arr(layer.objects))) {
		const kind = str(o.kind);
		const acc = str(o.accType);
		const label = plainText(o).join(" ");
		if (HAS_VAR.test(JSON.stringify(firstText(o)) + altOf(o))) ctx.vars++;
		if (ctx.accounted.has(o) && (!o.dragdrop || kind === "dragitem" || kind === "droparea")) continue;
		if (ctx.skipPicture(o)) continue;
		const start = out.length;
		switch (kind) {
			case "expandinglabel": // marker pop-up text: content, even though it sits inside the marker's state group
				out.push(...textBlocks(o, ctx));
				break;
			case "vectorshape": {
				if (acc === "image") {
					const src = imageSrc(o, ctx);
					if (src) out.push({ kind: "image", src, alt: altOf(o) });
					break;
				}
				if (acc === "radio" || acc === "checkbox") break; // the interaction block carries the choices
				if (acc === "dial" || acc === "slider") {
					ctx.lose(`storyline:${acc}`, "dropped", `${acc} control "${label || altOf(o)}" has no Studio equivalent`);
					break;
				}
				if (acc === "button" || inState) {
					if (label && jumpsToSlide(o)) {
						// A menu is content (the topics), unlike Next/Submit chrome; consecutive entries share one list.
						const last = out.at(-1);
						if (last?.kind === "list" && menus.has(last)) last.items.push(neutralize(label));
						else {
							const list: Block = { kind: "list", ordered: false, items: [neutralize(label)] };
							menus.add(list);
							out.push(list);
						}
						ctx.menu++;
					} else if (label) ctx.buttons.push(label);
					break;
				}
				if (label && ctx.quizText.has(label)) break;
				out.push(...textBlocks(o, ctx));
				break;
			}
			case "svgimage": {
				const src = imageSrc(o, ctx);
				if (src) out.push({ kind: "image", src, alt: str(obj(obj(o.data).imagedata).altText) });
				break;
			}
			case "video": {
				const vd = obj(obj(o.data).videodata);
				const src = ctx.asset(vd.assetId);
				const title = str(vd.altText);
				if (src) out.push({ kind: "video", src, ...(title ? { title } : {}) });
				else ctx.lose("storyline:video", "dropped", "video has no file in the package");
				break;
			}
			case "webobject": {
				const url = str(o.url) || str(o.html5Url);
				if (/^https?:\/\//i.test(url)) out.push({ kind: "embed", url });
				else ctx.lose("storyline:webobject", "dropped", `local web object ${url || "(no url)"} not imported`);
				break;
			}
			case "textinput": {
				const entry = ctx.entries.get(str(o.id));
				if (entry) out.push(entry);
				else if (label) out.push({ kind: "freeResponse", prompt: neutralize(label) });
				else ctx.lose("storyline:textinput", "dropped", `text entry field bound to ${str(o.bindto) || "no variable"} has no prompt`);
				break;
			}
			default:
				ctx.lose(`storyline:${kind || "object"}`, "dropped", `unrecognised object kind "${kind}"`);
		}
		if (slide && out.length > start) candidates.push({ blocks: out.slice(start), box: boxes.get(o), order: seq, ...heroStyle(o, ctx.paths) });
	}
	// One jump button ("Start course", "Continue") is navigation, not a menu: it stays player chrome.
	for (const b of [...out]) {
		if (b.kind !== "list" || !menus.has(b) || b.items.length !== 1) continue;
		out.splice(out.indexOf(b), 1);
		candidates.splice(0, candidates.length, ...candidates.filter((c) => !c.blocks.includes(b)));
		ctx.menu--;
		ctx.buttons.push(b.items[0]!);
	}
	out.push(...questions);
	if (slide) {
		candidates.push(...questions.map((b, i) => ({ blocks: [b], box: ctx.questionBoxes.get(b), order: candidates.length + i })));
		// Apply the text beside-picture rule to questions before the shared text layout pass.
		for (const question of candidates.filter((item) => item.blocks.length === 1 && "prompt" in item.blocks[0]!)) {
			const q = question.box;
			if (!validBox(q)) continue;
			const picture = candidates.find((item) => {
				const p = item.box;
				return item.blocks.length === 1 && item.blocks[0]?.kind === "image" && out.includes(item.blocks[0]) && validBox(p)
					&& Math.max(p.x, q.x) >= Math.min(p.x + p.w, q.x + q.w)
					&& Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y) >= q.h * 0.5;
			});
			if (!picture) continue;
			const consumed = new Set([...picture.blocks, ...question.blocks]);
			const index = out.findIndex((b) => consumed.has(b));
			const columns = picture.box!.x <= q.x ? [picture.blocks, question.blocks] : [question.blocks, picture.blocks];
			const remaining = out.filter((b) => !consumed.has(b));
			remaining.splice(index, 0, { kind: "columns", columns });
			out.splice(0, out.length, ...remaining);
		}
		slideLayout(out, candidates, num(slide.width), num(slide.height));
	}
	return out;
}

/** Largest recorded text run, falling back to glyph height per recorded line. */
function heroStyle(o: J, paths: J): Pick<HeroItem, "fontSize" | "color" | "singleLine"> {
	const styles: J[] = [];
	const t = firstText(o);
	const vt = t.vartext;
	if (typeof vt === "string") {
		const visit = (n: DefaultTreeAdapterMap["node"], inherited: J): void => {
			let style = inherited;
			if ("attrs" in n) {
				const css = n.attrs.find((a) => a.name === "style")?.value ?? "";
				const size = /(?:^|;)\s*font-size\s*:\s*([\d.]+)(px|pt)\b/i.exec(css);
				const color = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(css)?.[1]?.trim();
				style = { ...inherited, ...(size ? { fontSize: Number(size[1]) * (size[2] === "px" ? 0.75 : 1) } : {}), ...(color ? { foregroundColor: color } : {}) };
			}
			if (n.nodeName === "#text" && "value" in n && n.value.trim()) styles.push(style);
			if ("childNodes" in n) for (const c of n.childNodes) visit(c, style);
		};
		visit(parse(vt), {});
	} else {
		const base = obj(obj(obj(vt).defaultBlockStyle).baseSpanStyle);
		for (const b of arr(obj(vt).blocks)) for (const s of arr(b.spans)) if (str(s.text).trim()) styles.push({ ...base, ...obj(obj(b.style).baseSpanStyle), ...obj(s.style) });
	}
	const glyph = obj(t.vectortext);
	const ref = obj(glyph.pr);
	const commands = nodes(obj(paths[str(ref.l)])[`commandset-${str(ref.i)}`]);
	for (const node of commands) {
		const size = /^([\d.]+)(px|pt)$/.exec(str(node["font-size"]));
		if (size) styles.push({ fontSize: Number(size[1]) * (size[2] === "px" ? 0.75 : 1), foregroundColor: node.fill });
	}
	const lines = Math.max(1, altOf(o).split(/\r\n|[\r\n\v]/).length, new Set(commands.filter((n) => n.nodeType === "tspan" && n.y !== undefined).map((n) => n.y)).size);
	const glyphSize = (num(glyph.bottom) - num(glyph.top)) * 0.75 / lines;
	const style = styles.sort((a, b) => (num(b.fontSize) || 0) - (num(a.fontSize) || 0))[0];
	const singleLine = !vt ? lines === 1 : typeof vt === "string" ? !/<br\b/i.test(vt) : arr(obj(vt).blocks).length <= 1 && !arr(obj(vt).blocks).some((b) => arr(b.spans).some((s) => /[\r\n\v]/.test(str(s.text))));
	return { fontSize: num(style?.fontSize) > 0 ? num(style?.fontSize) : glyphSize > 0 ? glyphSize : undefined, color: str(style?.foregroundColor), singleLine };
}

/** Raw objects, including hidden hit regions and the groups that own drag events. */
function objects(list: J[]): J[] {
	return list.flatMap((o) => [o, ...objects(arr(o.objects))]);
}

/** Menu lists built from slide-jump buttons, so later entries join the same list. */
const menus = new WeakSet<Block>();

/** A button whose trigger goes to one specific slide (`gotoplay` → `_player.<scene>.<slide>`), not Next/Previous. */
const jumpsToSlide = (o: J) => nodes(o.events).some((a) => a.kind === "gotoplay" && /^_player\.[^.]+\.[^.]+$/.test(str(obj(a.objRef).value)));

function nodes(node: unknown): J[] {
	if (Array.isArray(node)) return node.flatMap(nodes);
	if (!node || typeof node !== "object") return [];
	return [obj(node), ...Object.values(obj(node)).flatMap(nodes)];
}

const choiceId = (v: unknown) => str(v).replace(/^choices\./, "");
const statementId = (v: unknown) => str(v).replace(/^statements\./, "");
const objectId = (v: unknown) => str(v).replace(/^(choices|statements)\./, "").replace(/^(choice|statement)_/i, "");
const propertyObject = (v: unknown) => str(v).split(".").at(-2) ?? "";

/** Choice groups can contain both an answer caption and a separate letter button. */
function choiceText(c: J, all: J[]): string {
	const o = all.find((o) => str(o.id) === objectId(c.id) || choiceId(o.connectdata) === str(c.id));
	if (!o) return "";
	const own = str(o.accType) !== "image" && Object.keys(firstText(o)).length ? plainText(o) : [];
	if (own.length) return own.join(" ");
	// A state group's same-id child is the initial object; siblings can be feedback artwork.
	const initial = (list: J[]): J[] => list.flatMap((o) => o.kind === "stategroup"
		? initial(arr(o.objects).filter((child) => child.id === o.id))
		: CONTAINERS.has(str(o.kind)) ? initial(arr(o.objects)) : [o]);
	const texts = placed(initial([o])).filter(({ o }) => str(o.accType) !== "image" && Object.keys(firstText(o)).length);
	const captions = texts.filter(({ o, inState }) => !inState && str(o.accType) !== "button");
	return (captions.length ? captions : texts).flatMap(({ o }) => plainText(o)).join(" ");
}

/** Displayed bounds in slide coordinates; rotated objects need a transform we cannot safely infer. */
function bounds(list: J[], x = 0, y = 0, sx = 1, sy = 1, out = new Map<J, { x: number; y: number; w: number; h: number }>()): typeof out {
	for (const o of list) {
		const ox = x + num(o.xPos ?? 0) * sx;
		const oy = y + num(o.yPos ?? 0) * sy;
		const dx = sx * num(o.scaleX ?? 100) / 100 * (num(o.rotation ?? 0) === 0 ? 1 : Number.NaN);
		const dy = sy * num(o.scaleY ?? 100) / 100 * (num(o.rotation ?? 0) === 0 ? 1 : Number.NaN);
		const lib = arr(o.imagelib)[0] ?? obj(obj(o.data).imagedata);
		out.set(o, { x: ox, y: oy, w: num(o.width ?? lib.width) * dx, h: num(o.height ?? lib.height) * dy });
		bounds(arr(o.objects), ox, oy, dx, dy, out);
	}
	return out;
}

const validBox = (b: Box | undefined): b is Box => !!b && [b.x, b.y, b.w, b.h].every(Number.isFinite) && b.w > 0 && b.h > 0;

function hotspot(it: J, base: J, prompt: Inline, correctIds: Set<string>, ctx: SlideCtx): Block | undefined {
	const all = objects(arr(base.objects));
	const boxes = bounds(arr(base.objects));
	const regions = arr(it.choices).filter((c) => str(c.id) !== "choice_incorrect").map((c) => {
		const hit = nodes(obj(it.responseDefinition).actions).find((a) => str(obj(obj(a.condition).statement).kind) === "hittestpoint" && collect(a.thenActions, "value").includes(`choices.${str(c.id)}`));
		const id = str(obj(obj(obj(hit?.condition).statement).objRef).value).split(".").at(-1) || objectId(c.id);
		const o = all.find((o) => str(o.id) === id);
		return { c, o, box: o ? boxes.get(o) : undefined };
	});
	const valid = (b: ReturnType<typeof boxes.get>) => b && [b.x, b.y, b.w, b.h].every(Number.isFinite) && b.w > 0 && b.h > 0;
	if (!regions.length || regions.some((r) => !valid(r.box)) || correctIds.has("choice_incorrect") || !regions.some((r) => correctIds.has(str(r.c.id)))) {
		ctx.lose("storyline:question/hotspot", "dropped", `interaction ${str(it.id)} has missing or unsupported region geometry or no explicit correct region`);
		return;
	}
	const images = all.filter((o) => (str(o.accType) === "image" || str(o.kind) === "svgimage") && valid(boxes.get(o))).filter((o) => {
		const b = boxes.get(o)!;
		return regions.every(({ box: r }) => r!.x >= b.x && r!.y >= b.y && r!.x + r!.w <= b.x + b.w && r!.y + r!.h <= b.y + b.h);
	}).sort((a, b) => boxes.get(a)!.w * boxes.get(a)!.h - boxes.get(b)!.w * boxes.get(b)!.h);
	const image = images[0];
	const src = image && imageSrc(image, ctx);
	if (!image || !src || (images[1] && boxes.get(image)!.w * boxes.get(image)!.h === boxes.get(images[1])!.w * boxes.get(images[1])!.h)) {
		ctx.lose("storyline:question/hotspot", "dropped", `interaction ${str(it.id)} has no unambiguous image containing its regions`);
		return;
	}
	const b = boxes.get(image)!;
	ctx.accounted.add(image);
	// ponytail: use bounding-box centres; keep region geometry when Studio can express it.
	const spots = regions.map(({ c, o, box: r }, i) => {
		ctx.accounted.add(o!);
		return { label: neutralize(choiceText(c, all) || str(c.lmstext)) || `Spot ${i + 1}`, x: (r!.x + r!.w / 2 - b.x) / b.w * 100, y: (r!.y + r!.h / 2 - b.y) / b.h * 100, correct: correctIds.has(str(c.id)) };
	});
	ctx.lose("storyline:question/hotspot", "approximated", `interaction ${str(it.id)}: ${spots.length} hotspot region(s) became centre points on image ${str(image.id)}; region shapes and sizes are not kept`);
	return { kind: "hotspot", prompt, src, alt: altOf(image), spots };
}

/** Only conjunctions of literal comparisons, never execute or guess arbitrary trigger logic. */
function comparisons(s: J): J[] {
	if (s.kind === "compare" && s.operator === "eq") return [s];
	if (s.kind !== "and") return [];
	const children = arr(s.statements).map(comparisons);
	return children.every((c) => c.length) ? children.flat() : [];
}

/** Custom drag puzzles sometimes store the key in boolean flags used by completion triggers. */
function triggeredMatch(slide: J, prompt: Inline, ctx: SlideCtx): Block | undefined {
	const all = arr(slide.slideLayers).flatMap((l) => objects(arr(l.objects)));
	const drags = all.filter((o) => obj(o.dragdrop).dragenabled === true);
	const targets = all.filter((o) => obj(o.dragdrop).dropenabled === true).sort((a, b) => num(a.tabIndex) - num(b.tabIndex));
	if (!drags.length || !targets.length) return;
	const flag = (v: unknown) => str(v).replace(/#/g, "");
	const assignments = drags.flatMap((o) => arr(o.events).filter((e) => e.kind === "ondragconnect").flatMap((e) => arr(e.actions)).flatMap((a) => {
		const conditions = comparisons(obj(obj(a.condition).statement));
		const c = conditions[0];
		if (a.kind !== "if_action" || conditions.length !== 1 || c?.typea !== "property" || c.valuea !== "$DropTargetId" || c.typeb !== "string") return [];
		const target = targets.find((t) => t.id === c.valueb);
		return target ? arr(a.thenActions).filter((s) => s.kind === "adjustvar" && s.operator === "set" && obj(s.value).type === "boolean" && typeof obj(s.value).value === "boolean").map((s) => ({ o, target, flag: flag(s.variable), value: obj(s.value).value })) : [];
	}));
	const key = assignments.filter((p) => p.value === true);
	const flags = new Set(key.map((p) => p.flag));
	const used = new Set<string>();
	for (const a of nodes([slide.events, ...all.map((o) => o.events)])) {
		if (a.kind !== "if_action") continue;
		const cs = comparisons(obj(obj(a.condition).statement));
		if (cs.length < 2 || cs.some((c) => c.typea !== "var" || c.typeb !== "boolean" || c.valueb !== true || !flags.has(flag(c.valuea)))) continue;
		if (arr(a.thenActions).some((s) => s.kind === "adjustvar" && s.operator === "set" && obj(s.value).type === "boolean" && obj(s.value).value === true && !flags.has(flag(s.variable)))) cs.forEach((c) => used.add(flag(c.valuea)));
	}
	if (!key.length || key.some((p) => !used.has(p.flag)) || new Set(key.map((p) => p.o)).size !== key.length || new Set(key.map((p) => p.target)).size !== key.length || targets.some((t) => !key.some((p) => p.target === t))) return;
	const label = (o: J) => placed([o]).filter(({ o }) => str(o.accType) !== "image" && str(o.kind) !== "svgimage").flatMap(({ o }) => plainText(o)).join(" ");
	if (key.some((p) => !label(p.o))) return;
	const categories = targets.map((t, i) => ({ name: /^_*\s*$/.test(label(t)) ? `Target ${i + 1}` : neutralize(label(t)), items: key.filter((p) => p.target === t).map((p) => neutralize(label(p.o))) }));
	const decoys = drags.filter((o) => !key.some((p) => p.o === o) && targets.every((t) => assignments.some((p) => p.o === o && p.target === t && p.flag === key.find((p) => p.target === t)!.flag && p.value === false)));
	for (const o of [...key.map((p) => p.o), ...decoys, ...targets]) ctx.accounted.add(o);
	ctx.lose("storyline:dragdrop", "approximated", `slide ${str(slide.id)}: explicit drop-to-flag assignments used by completion triggers became text matching; ${decoys.length} distractor(s), spatial placement and variable-dependent completion are not kept; unnamed targets are numbered in focus order`);
	return { kind: "match", prompt, pairs: categories.map((c) => [c.items[0]!, c.name]) };
}

/** Every `key` value nested anywhere under `node`, in document order. */
function collect(node: unknown, key: string, out: string[] = []): string[] {
	if (Array.isArray(node)) node.forEach((n) => collect(n, key, out));
	else if (node && typeof node === "object") {
		for (const [k, v] of Object.entries(node as J)) {
			if (k === key && typeof v === "string") out.push(v);
			else collect(v, key, out);
		}
	}
	return out;
}

/** Only the interaction's recorded attempt counter, not other runtime variables. */
function attemptComparison(s: J, id: string): boolean {
	return s.kind === "compare" && s.typea === "property" && s.valuea === `${id}.$AttemptCount`
		&& s.typeb === "number" && Number.isSafeInteger(s.valueb) && num(s.valueb) > 0;
}

/** Storyline stores the final try as the cutoff in its answer action conditions. */
function attemptLimit(it: J): number | undefined {
	const limits = new Set(nodes(arr(it.answers).map((a) => a.actions))
		.filter((s) => attemptComparison(s, str(it.id)) && ["lt", "lte", "gte"].includes(str(s.operator))).map((s) => num(s.valueb)));
	return limits.size === 1 ? [...limits][0] : undefined;
}

/** Layer ids shown by an answer, optionally restricted to the final recorded try. */
function shownLayers(answer: J, id?: string, attempts?: number): string[] {
	const out: string[] = [];
	const walk = (node: unknown) => {
		if (Array.isArray(node)) return node.forEach(walk);
		if (!node || typeof node !== "object") return;
		const a = node as J;
		const s = obj(obj(a.condition).statement);
		if (a.kind === "if_action" && id && attempts !== undefined && attemptComparison(s, id)) {
			const limit = num(s.valueb);
			const take = s.operator === "lt" ? attempts < limit : s.operator === "lte" ? attempts <= limit : s.operator === "gte" ? attempts >= limit : undefined;
			if (take !== undefined) return walk(take ? a.thenActions : a.elseActions);
		}
		if (str(a.kind) === "show_slidelayer") {
			const id = str(obj(a.objRef).value).replace(/^_parent\./, "");
			if (id) out.push(id);
		}
		Object.values(a).forEach(walk);
	};
	walk(answer.actions);
	return out;
}

/** Whole-slide inventory for coverage: title, quiz strings and every object's text on every layer. */
function inventory(ref: J, slide: J | undefined, out: string[]): void {
	const title = text(str(ref.title));
	if (title) out.push(title);
	for (const it of arr(ref.interactions)) {
		const prompt = GENERIC_PROMPT.has(str(it.lmstext)) ? "" : str(it.lmstext); // generic labels are not learner-visible
		const base = arr(slide?.slideLayers).find((l) => l.isBaseLayer === true) ?? arr(slide?.slideLayers)[0];
		const all = objects(arr(base?.objects));
		for (const s of [prompt, ...arr(it.choices).map((c) => choiceText(c, all) || str(c.lmstext)), ...arr(it.statements).map((c) => choiceText(c, all) || str(c.lmstext))]) if (s) out.push(s);
	}
	if (!slide) return;
	for (const layer of arr(slide.slideLayers)) for (const { o } of placed(arr(layer.objects))) out.push(...plainText(o));
}

/** Storyline's embedded Charset subset precedes the original family in its CSS list. */
function countFonts(slide: J, counts: Map<string, number>): void {
	for (const node of nodes(slide)) {
		const vt = obj(node.vartext);
		const base = obj(obj(vt.defaultBlockStyle).baseSpanStyle);
		for (const block of arr(vt.blocks)) {
			for (const span of arr(block.spans)) {
				const css = str(obj(span.style).fontFamily) || str(obj(obj(block.style).baseSpanStyle).fontFamily) || str(base.fontFamily);
				const families = css.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
				const font = / Charset/.test(families[0] ?? "") ? families[1] || families[0] : families[0];
				const count = [...str(span.text)].length;
				if (font && count) counts.set(font, (counts.get(font) ?? 0) + count);
			}
		}
	}
}

function playerTheme(root: string, frame: J, losses: Loss[]): Theme {
	const theme: Theme = {};
	const accent = str(frame.themeAccentColor).replace(/^0x/i, "#");
	if (/^#[0-9a-f]{6}$/i.test(accent)) theme.accent = accent.toLowerCase();
	const sidebar = obj(obj(frame.controlOptions).sidebarOptions);
	if (typeof sidebar.sidebarEnabled === "boolean") theme.navigation = frame.chromeless !== true && sidebar.sidebarEnabled ? "sidebar" : "slides";
	const notes: string[] = [];
	if (frame.chromeless !== true && sidebar.logoEnabled === true) {
		const logo = str(sidebar.html5_logo_url);
		if (logo && insidePackage(root, logo)) theme.logo = logo;
		else notes.push("enabled player logo is missing or outside the package");
	}
	if (Object.keys(frame).length) notes.push("player chrome, control styling and slide-specific layout are not reproduced");
	if (notes.length) losses.push({ at: "theme", source: "storyline:theme", effect: "approximated", detail: notes.join("; ") });
	return theme;
}

export function extractStoryline(root: string): Course {
	const dataFile = insidePackage(root, "html5/data/js/data.js");
	if (!dataFile) throw new Error("Storyline package found, but html5/data/js/data.js is missing (Flash-only output is not supported)");
	const data = provided(dataFile);
	const pathsFile = insidePackage(root, "html5/data/js/paths.js");
	const paths = pathsFile ? provided(pathsFile) : {};
	const losses: Loss[] = [];
	const sourceText: string[] = [];

	const assets = new Map<number, string>();
	for (const a of arr(data.assetLib)) assets.set(num(a.id), str(a.url));
	const asset = (id: unknown) => assets.get(num(id)) ?? "";
	const slides = new Map<J, J>();
	const pictures = new Map<J, string>();
	const usage = new Map<string, Set<J>>();
	for (const scene of arr(data.scenes).filter((s) => s.isMessageScene !== true)) for (const ref of arr(scene.slides)) {
		const file = str(ref.html5url) ? insidePackage(root, str(ref.html5url)) : undefined;
		if (!file) continue;
		const slide = provided(file);
		slides.set(ref, slide);
		for (const layer of arr(slide.slideLayers)) {
			for (const { o } of placed(arr(layer.objects))) {
				if (o.kind !== "svgimage" && !(o.kind === "vectorshape" && o.accType === "image")) continue;
				const src = imageSrc(o, { root, asset });
				if (!src) continue;
				pictures.set(o, src);
				(usage.get(src) ?? usage.set(src, new Set()).get(src))!.add(ref);
			}
		}
	}
	const skippedPictures = new Set<string>();
	const skipPicture = (o: J) => {
		const src = pictures.get(o);
		// A unique full-slide picture is often the content (a screenshot slide); only repeats are template.
		if (!src || (usage.get(src)?.size ?? 0) < 3) return false;
		skippedPictures.add(src);
		return true;
	};
	const quizzes = new Set(arr(data.quizzes).map((q) => `_player.${str(q.id)}`));
	const resultSlides: string[] = [];

	// Scene names only exist in the player menu (frame.js); the data file keeps ids.
	const sceneTitles = new Map<string, string>();
	const frameFile = insidePackage(root, "html5/data/js/frame.js");
	const frame = frameFile ? provided(frameFile) : {};
	const theme = playerTheme(root, frame, losses);
	theme.density = theme.blockSpacing = "compact";
	const width = [...slides.values()].map((s) => num(s.width)).find((w) => w > 0 && Number.isFinite(w));
	if (width) theme.contentWidth = width;
	const fonts = new Map<string, number>();
	const backgrounds = new Map<string, number>();
	if (frameFile) {
		for (const link of arr(obj(obj(frame.navData).outline).links)) {
			const id = str(link.slideid).replace(/^_player\./, "");
			if (id && !id.includes(".")) sceneTitles.set(id, text(str(link.displaytext)));
		}
	}

	const meta = existsSync(join(root, "meta.xml")) ? parseXml(readFileSync(join(root, "meta.xml"), "utf8")) : undefined;
	const project = meta ? find(meta, "project")[0] : undefined;
	const application = meta ? find(meta, "application")[0] : undefined;
	const description = project ? textOf(kids(project, "description")[0]) : "";
	const manifest = existsSync(join(root, "imsmanifest.xml")) ? parseXml(readFileSync(join(root, "imsmanifest.xml"), "utf8")) : undefined;
	const org = manifest ? find(manifest, "organization")[0] : undefined;
	const title = str(project?.attrs.title) || (org ? textOf(kids(org, "title")[0]) : "") || "Untitled course";
	const html = ["story.html", "index.html"].map((f) => join(root, f)).find((f) => existsSync(f));
	const lang = html ? (/<html[^>]*\slang=["']([^"']+)/i.exec(readFileSync(html, "utf8"))?.[1] ?? "") : "";
	const locale = ([lang, str(data.tincanLanguage)].find((l) => l && l !== "und") ?? "").split("-")[0] ?? "";

	const lessons: Lesson[] = [];
	let sceneN = 0;
	for (const scene of arr(data.scenes)) {
		if (scene.isMessageScene === true) continue; // player prompts, not course content
		sceneN++;
		const sceneId = str(scene.id);
		const pages: Page[] = [];
		for (const ref of arr(scene.slides)) {
			const at = `scene ${sceneId}/slide ${str(ref.id)}`;
			const slide = slides.get(ref);
			inventory(ref, slide, sourceText);
			const pageTitle = text(str(ref.title));
			if (!slide) {
				losses.push({ at, source: "storyline:slide", effect: "dropped", detail: `slide data file ${str(ref.html5url) || "(none)"} is missing` });
				pages.push({ ...(pageTitle ? { title: pageTitle } : {}), blocks: [] });
				continue;
			}
			countFonts(slide, fonts);
			const background = obj(slide.background);
			const fill = obj(background.fill);
			const colours = arr(fill.colors);
			const colour = str(colours[0]?.rgb).replace(/^0x/i, "#").toLowerCase();
			// Only uniform, opaque fills count; gradients and artwork need compositing.
			if (background.type === "fill" && ["linear", "solid"].includes(str(fill.type)) && /^#[0-9a-f]{6}$/.test(colour) && colours.length && colours.every((c) => c.kind === "color" && c.alpha === 100 && str(c.rgb).replace(/^0x/i, "#").toLowerCase() === colour)) backgrounds.set(colour, (backgrounds.get(colour) ?? 0) + 1);
			// Results slides complete a recorded quiz automatically when the slide starts.
			if (arr(slide.events).filter((e) => e.kind === "onslidestart").some((e) => nodes(e.actions).some((a) => a.kind === "setquizcomplete" && quizzes.has(str(obj(a.objRef).value))))) {
				resultSlides.push(at);
				continue;
			}
			const ctx: SlideCtx = {
				root,
				paths,
				asset,
				skipPicture,
				quizText: new Set(),
				entries: new Map(),
				questionBoxes: new Map(),
				accounted: new Set(),
				buttons: [],
				menu: 0,
				vars: 0,
				lose: (source, effect, detail) => losses.push({ at, source, effect, detail }),
				events: 0,
				animations: 0,
				states: 0,
				dragdrop: 0,
			};
			const layers = arr(slide.slideLayers);
			const base = layers.find((l) => l.isBaseLayer === true) ?? layers[0];
			const all = objects(arr(base?.objects));
			const boxes = bounds(arr(base?.objects));
			const others = layers.filter((l) => l !== base);
			const consumed = new Set<J>();
			const layerById = new Map(others.map((l) => [str(l.id), l] as const));

			// Feedback lives on layers the answer actions reveal; those layers are folded into the question.
			const feedbackOf = (it: J, status: string, attempts: number | undefined): Inline | undefined => {
				// Prefer the catch-all outcome when choices have their own final messages.
				const answers = arr(it.answers).filter((a) => str(a.status) === status).sort((a, b) => Number(nodes(b.evaluate).some((s) => s.kind === "other")) - Number(nodes(a.evaluate).some((s) => s.kind === "other")));
				const found = [...new Set(answers.flatMap((a) => shownLayers(a)))].map((id) => layerById.get(id)).filter((l): l is J => !!l);
				const final = new Set(answers.flatMap((a) => shownLayers(a, str(it.id), attempts)));
				const messages: string[] = [];
				let media = 0;
				let retry = 0;
				let titles = 0;
				for (const layer of found) {
					consumed.add(layer);
					media += arr(layer.audiolib).length;
					const texts: Array<{ value: string; y: number }> = [];
					const marked: Array<{ value: string; y: number }> = [];
					for (const { o, inState } of placed(arr(layer.objects))) {
						const kind = str(o.kind);
						if (kind === "video" || kind === "svgimage" || kind === "webobject" || (kind === "vectorshape" && str(o.accType) === "image")) media++;
						else if (!inState && str(o.accType) !== "button") {
							const value = plainText(o).join(" ");
							const blocks = textBlocks(o, ctx);
							const title = ["heading", "title"].includes(str(o.accType)) || ["heading", "title"].includes(str(o.role))
								|| (blocks.length > 0 && blocks.every((b) => b.kind === "heading"))
								|| [str(layer.name), str(layer.title)].some((name) => name.trim() && name.trim() === value);
							if (value) (title ? marked : texts).push({ value, y: num(o.yPos) });
						}
					}
					// A marked title is only dropped beside a message; alone, it is the message.
					if (texts.length) titles += marked.length;
					else texts.push(...marked);
					// Glyph-only feedback records no roles: a layer's topmost text, when it is one
					// short line above a longer message, is its title ("Correct"). Studio shows its own.
					const top = texts.length > 1 ? texts.reduce((a, b) => (b.y < a.y ? b : a)) : undefined;
					if (top && top.value.split(/\s+/).length <= 3 && top.value.length <= 30 && texts.some((t) => t !== top && t.value.length > top.value.length)) {
						texts.splice(texts.indexOf(top), 1);
						titles++;
					}
					const strings = texts.map((t) => t.value);
					if (final.has(str(layer.id))) messages.push(strings.join(" "));
					else if (strings.length) retry++;
				}
				// Studio feedback is text only; say so rather than dropping a feedback video or narration unseen.
				if (media) ctx.lose("storyline:feedback", "dropped", `${media} picture, video or audio item(s) on ${status} feedback layers not imported`);
				const unique = [...new Set(messages.filter(Boolean))];
				if (titles) ctx.lose("storyline:feedback", "approximated", `interaction ${str(it.id)}: ${titles} ${status} feedback layer title(s) omitted; Studio labels the result itself`);
				if (retry || unique.length > 1) ctx.lose("storyline:feedback", "approximated", `interaction ${str(it.id)}: one final ${status} message kept; ${retry} retry layer(s) and ${Math.max(0, unique.length - 1)} alternative final message(s) cannot be represented separately`);
				const fb = neutralize(unique[0] ?? "").trim();
				return fb || undefined;
			};

			const questions: Block[] = [];
			const entryBlocks: Block[] = [];
			for (const it of arr(ref.interactions)) {
				const before = questions.length + entryBlocks.length;
				const type = str(it.type);
				const lmstext = str(it.lmstext);
				const choices = arr(it.choices);
				const answers = arr(it.answers);
				const statements = arr(it.statements);
				const attempts = attemptLimit(it);
				const key = answers.filter((a) => str(a.status) === "correct").flatMap((a) => arr(obj(a.evaluate).statements));
				const responses = nodes(obj(it.responseDefinition).actions);
				const labelOf = (c: J) => choiceText(c, all) || str(c.lmstext);
				const quizStrings = [lmstext, ...choices.map(labelOf), ...statements.map(labelOf)];
				const account = (mappedChoices: J[], mappedStatements: J[]) => {
					const ids = new Set([...mappedChoices, ...mappedStatements].map((c) => objectId(c.id)));
					for (const a of responses) {
						if (str(a.kind) === "addchoiceresponse" || mappedStatements.some((s) => str(s.id) === statementId(a.valuea))) ids.add(propertyObject(a.valueb ?? a.value));
					}
					for (const o of all) if (ids.has(str(o.id)) || mappedChoices.some((c) => str(c.id) === choiceId(o.connectdata))) ctx.accounted.add(o);
				};
				const correctIds = new Set(answers.filter((a) => str(a.status) === "correct").flatMap((a) => collect(a.evaluate, "choiceid")).map((id) => id.replace(/^choices\./, "")));
				const survey = it.issurvey === true || !answers.some((a) => str(a.status) === "correct");
				const prompt = neutralize(GENERIC_PROMPT.has(lmstext) ? pageTitle || lmstext : lmstext).replace(/\s+/g, " ").trim() || "Question";
				const feedback = () => {
					if (survey) return {};
					const correct = feedbackOf(it, "correct", attempts);
					const incorrect = feedbackOf(it, "incorrect", attempts);
					return { ...(correct ? { correct } : {}), ...(incorrect ? { incorrect } : {}) };
				};
				const marks = [questions.length, entryBlocks.length] as const;
				switch (type) {
					case "multiplechoice":
					case "truefalse":
					case "multipleresponse": {
						const options = choices.map((c) => ({ text: neutralize(labelOf(c)), correct: correctIds.has(str(c.id)) }));
						if (!options.some((o) => o.correct) && !survey) ctx.lose(`storyline:question/${type}`, "approximated", "correct answer is decided by triggers or variables, not choices; imported with none marked");
						if (str(it.lmsId).startsWith("FreeForm")) ctx.lose(`storyline:question/${type}`, "approximated", "freeform pick interaction: choices are named after their objects, which may be pictures");
						questions.push({ kind: "choice", prompt, multiple: type === "multipleresponse", options, ...feedback() });
						break;
					}
					case "matching": {
						const pairs = key.map((p) => ({ c: choices.find((c) => str(c.id) === choiceId(p.choiceid)), s: statements.find((s) => str(s.id) === statementId(p.statementid)), kind: p.kind }));
						if (!pairs.length || pairs.some((p) => p.kind !== "pair" || !p.c || !p.s || !labelOf(p.c) || !labelOf(p.s)) || new Set(pairs.map((p) => p.c)).size !== pairs.length) {
							ctx.lose("storyline:question/matching", "dropped", `interaction ${str(it.id)} has no complete, unambiguous labelled answer key`);
							break;
						}
						const categories = statements.map((s) => ({ name: neutralize(labelOf(s)), items: pairs.filter((p) => p.s === s).map((p) => neutralize(labelOf(p.c!))) })).filter((c) => c.items.length);
						if (categories.some((c) => c.items.length > 1)) questions.push({ kind: "categorize", prompt, categories, ...feedback() });
						else questions.push({ kind: "match", prompt, pairs: pairs.map((p) => [neutralize(labelOf(p.c!)), neutralize(labelOf(p.s!))]), ...feedback() });
						account(pairs.map((p) => p.c!), pairs.map((p) => p.s!));
						if (str(it.lmsId).startsWith("FreeForm")) ctx.lose("storyline:question/matching", "approximated", "freeform drag-and-drop imported as text pairs or categories; spatial layout and object artwork are not part of the answer key");
						if (pairs.length < choices.length) ctx.lose("storyline:question/matching", "dropped", `interaction ${str(it.id)}: ${choices.length - pairs.length} choice(s) outside the answer key are not offered as distractors`);
						const unused = statements.filter((s) => !pairs.some((p) => p.s === s)).length;
						if (unused) ctx.lose("storyline:question/matching", "dropped", `interaction ${str(it.id)}: ${unused} target(s) outside the answer key are not offered`);
						break;
					}
					case "likert": {
						const scale = choices.map((c) => neutralize(labelOf(c)));
						const rows = statements.map((s) => neutralize(labelOf(s)));
						if (scale.length < 2 || scale.some((s) => !s) || rows.some((s) => !s)) ctx.lose("storyline:question/likert", "dropped", `interaction ${str(it.id)} has incomplete scale or statement labels`);
						else {
							if (rows.length > 1) questions.push({ kind: "matrix", prompt, scale, statements: rows });
							else questions.push({ kind: "rating", prompt: rows[0] && rows[0] !== prompt ? `${prompt}\n${rows[0]}` : prompt, scale });
							quizStrings.push("Likert", "Likert Scale", ...scale.map((_, i) => String(i + 1)));
						}
						break;
					}
					case "hotspot": {
						const b = base && hotspot(it, base, prompt, new Set(key.filter((p) => p.kind === "equals").map((p) => choiceId(p.choiceid))), ctx);
						if (b) questions.push(b);
						break;
					}
					case "sequence": {
						const order = statements.map((s) => {
							const response = responses.find((a) => str(a.kind) === "addpairresponse" && statementId(a.valuea) === str(s.id));
							const pos = /\.#_pos(\d+)$/.exec(str(response?.valueb));
							const matches = key.filter((p) => p.kind === "pair" && statementId(p.statementid) === str(s.id));
							const c = matches.length === 1 ? choices.find((c) => str(c.id) === choiceId(matches[0]!.choiceid)) : undefined;
							return { pos: pos ? Number(pos[1]) : Number(str(s.lmstext)) - 1, c };
						}).sort((a, b) => a.pos - b.pos);
						if (!order.length || key.length !== order.length || order.length !== choices.length || new Set(order.map((o) => o.c)).size !== choices.length || order.some((o, i) => o.pos !== i || !o.c || !labelOf(o.c))) {
							ctx.lose("storyline:question/sequence", "dropped", `interaction ${str(it.id)} has no complete, unambiguous correct order`);
							break;
						}
						questions.push({ kind: "order", prompt, items: order.map((o) => neutralize(labelOf(o.c!))), ...feedback() });
						account(choices, statements);
						break;
					}
					case "wordbank": {
						const fields = placed(arr(base?.objects)).map(({ o }) => o);
						const fieldOf = (s: J) => {
							const a = responses.find((a) => a.kind === "addpairresponse" && statementId(a.valuea) === str(s.id));
							return fields.findIndex((o) => str(o.id) === (propertyObject(a?.valueb) || objectId(s.id)));
						};
						const slotCount = Math.max(1, responses.filter((a) => a.kind === "addchoiceresponse" && /\.\$DragConnectData$/.test(str(a.value))).length, lmstext.match(/_{2,}/g)?.length ?? 0);
						const slots = statements.length ? [...statements] : Array.from({ length: slotCount }, () => ({} as J));
						if (statements.length && slots.every((s) => fieldOf(s) >= 0)) slots.sort((a, b) => fieldOf(a) - fieldOf(b));
						const accepted = slots.map((s) => choices.filter((c) => key.some((p) => (statements.length ? p.kind === "pair" && statementId(p.statementid) === str(s.id) : slots.length === 1 && p.kind === "equals") && choiceId(p.choiceid) === str(c.id))));
						const blanks: Blank[] = accepted.map((cs) => ({ answers: cs.map(labelOf).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean) }));
						const templates = [lmstext, ...placed(arr(base?.objects)).flatMap(({ o }) => plainText(o))].filter((s) => /_{2,}/.test(s));
						const template = templates.find((s) => s.match(/_{2,}/g)?.length === blanks.length);
						let index = 0;
						const parts = template ? template.split(/(_{2,})/).map((s) => /^_{2,}$/.test(s) ? blanks[index++]! : s) : blanks.flatMap((b, i): Array<string | Blank> => i ? [" ", b] : [b]);
						questions.push({ kind: "fillBlank", prompt, parts, style: "word-bank", bank: choices.map(labelOf), ...feedback() });
						if (template) quizStrings.push(template);
						account(choices, statements);
						if (blanks.some((b) => !b.answers.length)) ctx.lose("storyline:question/wordbank", "dropped", `interaction ${str(it.id)}: ${blanks.filter((b) => !b.answers.length).length} blank(s) have no readable explicit answer; kept as ____`);
						if (slots.length > 1 && answers.filter((a) => a.status === "correct").length > 1) ctx.lose("storyline:question/wordbank", "approximated", `interaction ${str(it.id)}: accepted alternatives are checked per blank; dependencies between whole-answer combinations are not kept`);
						break;
					}
					case "fillin":
					case "numeric":
					case "essay":
					case "shortanswer": {
						const accepted = choices.map((c) => str(c.lmstext)).filter(Boolean);
						const block: Block =
							type === "essay" || type === "shortanswer" || !accepted.length
								? { kind: "freeResponse", prompt }
								: { kind: "fillBlank", prompt, parts: [{ answers: accepted }], ...feedback() };
						entryBlocks.push(block);
						break;
					}
					default:
						ctx.lose(`storyline:question/${type}`, "dropped", `unrecognised interaction type "${type}"`);
				}
				// Graded quiz slides report a score; surveys stay practice.
				const mapped = [...questions.slice(marks[0]), ...entryBlocks.slice(marks[1])];
				if (survey || mapped.some((b) => b.kind === "freeResponse" || b.kind === "rating" || b.kind === "matrix")) {
					for (const id of new Set(answers.flatMap((a) => shownLayers(a)))) {
						const layer = layerById.get(id);
						if (!layer || consumed.has(layer)) continue;
						consumed.add(layer);
						losses.push({ at: `${at}/interaction ${str(it.id)}/layer ${id}`, source: "storyline:feedback", effect: "approximated", detail: "response layer omitted; Studio has no feedback on survey, rating or free-response questions" });
					}
				}
				const ids = new Set([...choices, ...statements].map((c) => objectId(c.id)));
				for (const a of responses) if (["addchoiceresponse", "addpairresponse"].includes(str(a.kind))) ids.add(propertyObject(a.valueb ?? a.value));
				const answerBoxes = all.filter((o) => ids.has(str(o.id)) || choices.some((c) => str(c.id) === choiceId(o.connectdata))).map((o) => boxes.get(o));
				if (answerBoxes.length && answerBoxes.every(validBox)) {
					const x = Math.min(...answerBoxes.map((b) => b.x)), y = Math.min(...answerBoxes.map((b) => b.y));
					const box = { x, y, w: Math.max(...answerBoxes.map((b) => b.x + b.w)) - x, h: Math.max(...answerBoxes.map((b) => b.y + b.h)) - y };
					for (const b of mapped) ctx.questionBoxes.set(b, box);
				}
				if (!survey) markScored(mapped);
				if (attempts !== undefined) for (const b of mapped) {
					if (b.kind === "choice" || b.kind === "match" || b.kind === "order" || b.kind === "categorize" || b.kind === "hotspot" || b.kind === "fillBlank") b.attempts = attempts;
				}
				if (questions.length + entryBlocks.length > before) for (const s of quizStrings) if (s) ctx.quizText.add(s.replace(/\s+/g, " ").trim());
			}
			if (!arr(ref.interactions).length) {
				const puzzle = triggeredMatch(slide, neutralize(pageTitle) || "Question", ctx);
				if (puzzle) questions.push(puzzle);
			}
			// Text-entry blocks stand in for the slide's entry fields, in reading order.
			if (entryBlocks.length) {
				const fields = placed(arr(base?.objects)).filter(({ o }) => str(o.kind) === "textinput");
				entryBlocks.forEach((b, i) => {
					const f = fields[i];
					if (f) ctx.entries.set(str(f.o.id), b);
					else questions.push(b);
				});
			}

			const blocks: Block[] = base ? layerBlocks(base, ctx, slide, questions) : [...questions];
			ctx.quizText.clear(); // Other layers may intentionally repeat a question's words.
			const items: Item[] = [];
			for (const [i, layer] of others.entries()) {
				if (consumed.has(layer)) continue;
				const inner = layerBlocks(layer, ctx);
				if (!inner.length) continue;
				const first = inner.find((b) => b.kind === "paragraph" || b.kind === "heading");
				const title = first && (first.kind === "paragraph" || first.kind === "heading") && first.text.length < 120 && !/[\r\n\v]/.test(first.text) ? first.text : "";
				// Studio requires a nonempty heading to recognise an accordion item.
				items.push({ title: title || `Layer ${i + 2}`, blocks: title ? inner.filter((b) => b !== first) : inner });
			}
			if (items.length) {
				ctx.lose("storyline:layer", "approximated", `${items.length} slide layer(s) revealed by triggers imported as accordion items after the base layer`);
				blocks.push({ kind: "container", as: "accordion", items });
			}
			if (ctx.menu) ctx.lose("storyline:menu", "approximated", `${ctx.menu} menu button(s) that jump to a slide imported as a list of their labels; the jumps are not kept (Studio's outline navigates between pages)`);
			if (ctx.buttons.length) ctx.lose("storyline:button", "dropped", `button labels not imported: ${[...new Set(ctx.buttons)].map((b) => `"${b}"`).join(", ")}`);
			if (ctx.vars) ctx.lose("storyline:variable", "approximated", `variable references (%name%) kept as source text in ${ctx.vars} text object(s); runtime values are not evaluated`);
			if (ctx.dragdrop) ctx.lose("storyline:dragdrop", "dropped", `${ctx.dragdrop} drag-and-drop object(s) have no mapped answer key`);
			if (ctx.events || ctx.animations || ctx.states) ctx.lose("storyline:trigger", "dropped", `${ctx.events} trigger(s), ${ctx.animations} animation(s), ${ctx.states} object state(s) not imported`);
			pages.push({ ...(pageTitle ? { title: pageTitle } : {}), blocks });
		}
		const sceneTitle = sceneTitles.get(sceneId) || str(scene.lmsId) || `Scene ${sceneN}`;
		sourceText.push(sceneTitle);
		if (!pages.length && arr(scene.slides).length) continue;
		lessons.push({ sourceId: sceneId, title: sceneTitle, pages: pages.length ? pages : [{ blocks: [] }] });
	}

	if (skippedPictures.size) losses.push({ at: "course", source: "storyline:template", effect: "dropped", detail: `${skippedPictures.size} pictures repeated on 3+ slides are treated as slide template chrome and skipped: ${[...skippedPictures].sort().join(", ")}` });
	if (resultSlides.length) losses.push({ at: "course", source: "storyline:results", effect: "dropped", detail: `${resultSlides.length} result slide(s) skipped because Studio reports the score itself: ${resultSlides.sort().join(", ")}` });
	sourceText.unshift(...[title, description].filter(Boolean));
	// ponytail: one family for both roles; use explicit role metadata if a future format supplies it.
	// Highest character count wins; equal counts use UTF-16 code-unit order, never locale.
	const font = [...fonts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]?.[0];
	if (font) theme.bodyFont = theme.headingFont = font;
	// One vote per recorded slide; equal counts use colour code-unit order.
	const background = [...backgrounds].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]?.[0];
	if (background) theme.background = background;
	if (font || lessons.some((lesson) => lesson.pages.length)) {
		const detail = [
			...(font ? ["most-used text font applied to headings and body"] : []),
			...(background ? ["most frequent recorded opaque slide background applied course-wide; ties use colour code-unit order"] : []),
			"slide-specific typography, backgrounds, positioning, gradients and decorative shapes are not reproduced",
		].join("; ");
		const loss = losses.find((l) => l.source === "storyline:theme");
		if (loss) loss.detail += `; ${detail}`;
		else losses.push({ at: "theme", source: "storyline:theme", effect: "approximated", detail });
	}
	const version = str(data.version) || str(application?.attrs.version);
	return {
		tool: "storyline",
		...(Object.keys(theme).length ? { theme } : {}),
		...(version ? { toolVersion: version } : {}),
		sourceId: str(data.projectId) || str(project?.attrs.id) || title,
		title,
		...(description ? { description } : {}),
		...(locale ? { locale } : {}),
		lessons,
		losses,
		sourceText,
	};
}
