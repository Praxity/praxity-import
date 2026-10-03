import { insidePackage } from "../input.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { blocks as htmlBlocks, inline, line, neutralize, text } from "../html.ts";
import type { Block, Course, Item, Lesson, Loss, Page, Theme } from "../model.ts";

/*
 * Adapt Learning builds keep content as JSON in course/<lang>/: course.json,
 * contentObjects.json (menus and pages), articles.json, blocks.json and
 * components.json. Each record names its parent with `_parentId`; array order
 * is display order. Text fields are HTML. Asset paths are relative to the
 * build root (course/en/images/…).
 */
type J = Record<string, unknown>;
const obj = (v: unknown): J => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : {});
const arr = (v: unknown): J[] => (Array.isArray(v) ? v.map(obj) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** Published Adapt builds carry their theme in this stylesheet, not course JSON. */
function themeFromCss(root: string, losses: Loss[]) {
	const file = "adapt/css/adapt.css";
	const path = insidePackage(root, file);
	if (!path) return { theme: undefined, background: (_kind: string, _record: J) => undefined as string | undefined };
	const css = readFileSync(path, "utf8");
	const rules: Array<{ selector: string; declarations: Map<string, { value: string; important: boolean }> }> = [];
	let depth = 0;
	let start = 0;
	let opening = 0;
	// ponytail: unconditional compound class selectors only; use a CSS parser for descendant/conditional styling.
	// Quoted strings and comments consume their braces; conditional rules never become defaults.
	for (const token of css.matchAll(/\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{};]/g)) {
		const char = token[0];
		if (char === "{") {
			if (depth++ === 0) opening = token.index;
		} else if (char === "}") {
			if (--depth !== 0) continue;
			const selector = css.slice(start, opening).replace(/\/\*[\s\S]*?\*\//g, "").trim();
			if (!selector.startsWith("@")) for (const name of selector.split(",").map((s) => s.trim())) {
				if (!["body", "h1"].includes(name) && !/^(?:\.[\w-]+)+$/.test(name)) continue;
				const declarations = new Map<string, { value: string; important: boolean }>();
				for (const declaration of css.slice(opening + 1, token.index).replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
					const match = /^\s*([\w-]+)\s*:\s*(.*?)\s*$/s.exec(declaration);
					if (!match) continue;
					const property = match[1]!.toLowerCase();
					const important = /\s*!important\s*$/i.test(match[2]!);
					if (important || !declarations.get(property)?.important) declarations.set(property, { value: match[2]!.replace(/\s*!important\s*$/i, ""), important });
					// Background shorthand resets background-color, including image-only declarations.
					if (property === "background" && (important || !declarations.get("background-color")?.important)) declarations.set("background-color", { value: match[2]!.replace(/\s*!important\s*$/i, ""), important });
				}
				rules.push({ selector: name, declarations });
			}
			start = token.index + 1;
		} else if (char === ";" && depth === 0) start = token.index + 1;
	}
	const value = (selector: string, property: string, classes = [selector.slice(1)]) => {
		let best: { value: string; important: boolean; specificity: number } | undefined;
		for (const rule of rules) {
			const names = rule.selector.slice(1).split(".");
			if (rule.selector !== selector && !(selector.startsWith(".") && rule.selector.startsWith(".") && names.every((c) => classes.includes(c)))) continue;
			const declaration = rule.declarations.get(property);
			const specificity = names.length;
			if (declaration && (!best || Number(declaration.important) > Number(best.important) || (declaration.important === best.important && specificity >= best.specificity))) best = { ...declaration, specificity };
		}
		return best?.value ?? "";
	};
	const colour = (value: string) => {
		const hex = /^(#[\da-f]{6}|#[\da-f]{3})(?=\s|$)/i.exec(value)?.[1]?.toLowerCase();
		return hex?.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join("")}` : hex;
	};
	const font = (value: string) => value.split(",")[0]?.trim().replace(/^["']|["']$/g, "") || undefined;
	const bodyFont = font(value("body", "font-family"));
	const background = (kind: string, record: J) => colour(value(`.${kind}`, "background-color", [kind, str(record._id), ...str(record._classes).split(/\s+/)]));
	const radius = /^(\d+(?:\.\d+)?)(?:px)?$/.exec(value(".button", "border-radius"));
	const theme: Theme = {
		accent: colour(value(".navigation", "background-color")),
		text: colour(value("body", "color")),
		// Content containers cover the outer body/page texture in published Adapt themes.
		background: background("block", {}) ?? background("article", {}) ?? background("page", {}) ?? colour(value("body", "background-color")),
		buttonBackground: colour(value(".button", "background-color")),
		buttonText: colour(value(".button", "color")),
		bodyFont,
		headingFont: font(value("h1", "font-family")) ?? bodyFont,
		...(radius ? { corners: Number(radius[1]) } : {}),
	};
	if (css.trim()) losses.push({ at: file, source: "adapt:theme", effect: "approximated", detail: "base content, heading, navigation and button styling and article/block backgrounds mapped to Studio theme; the first coloured and first dark neutral section colours define the two band palettes, additional colours share those palettes; background images, layouts, conditional/descendant rules and other CSS details are not carried over" });
	return { theme: Object.values(theme).some((v) => v !== undefined) ? theme : undefined, background };
}

/** The build's content language: config `_defaultLanguage`, else the first language folder in name order. */
function language(root: string): string {
	const config = obj(JSON.parse(readFileSync(join(root, "course/config.json"), "utf8")));
	const preferred = str(config._defaultLanguage);
	if (preferred && insidePackage(root, `course/${preferred}/components.json`)) return preferred;
	const found = readdirSync(join(root, "course")).sort().find((d) => insidePackage(root, `course/${d}/components.json`));
	if (!found) throw new Error("Adapt build found, but course/<lang>/components.json is missing");
	return found;
}

/**
 * Adapt's displayed strings. `title` is an authoring label; `displayTitle` is
 * what learners see. Retry (`notFinal`) and partly-correct feedback are left
 * out: Studio has neither, and multi-select partly-correct text is reported
 * as a loss where it matters.
 */
const TEXT_KEYS = new Set(["displayTitle", "body", "instruction", "text", "alt", "attribution", "backTitle", "backBody", "frontTitle", "correct", "final", "prefix", "suffix", "strapline", "inlineTranscriptBody"]);
function inventory(node: unknown, out: string[]): void {
	if (Array.isArray(node)) return node.forEach((n) => inventory(n, out));
	if (!node || typeof node !== "object") return;
	for (const [k, v] of Object.entries(node as J)) {
		if (typeof v === "string" && TEXT_KEYS.has(k)) {
			const t = text(v);
			if (t) out.push(t);
		} else if (v && typeof v === "object" && !["_globals", "_buttons", "_accessibility", "_extensions", "_pageLevelProgress", "_trickle", "_partlyCorrect"].includes(k)) inventory(v, out);
	}
}

export function extractAdapt(root: string): Course {
	const lang = language(root);
	const read = (name: string): J[] => {
		const p = insidePackage(root, `course/${lang}/${name}.json`);
		return p ? arr(JSON.parse(readFileSync(p, "utf8"))) : [];
	};
	const courseFile = insidePackage(root, `course/${lang}/course.json`);
	const course = courseFile ? obj(JSON.parse(readFileSync(courseFile, "utf8"))) : {};
	const contentObjects = read("contentObjects");
	const articles = read("articles");
	const blocksJson = read("blocks");
	const components = read("components");
	const losses: Loss[] = [];
	const styling = themeFromCss(root, losses);
	let theme = styling.theme;
	// First use in display order wins each palette. Further source colours share
	// a palette; class names alone never imply a colour without a matching rule.
	const tone = (colour: string | undefined): "light" | "accent" | "dark" => {
		if (!colour || colour === theme?.background) return "light";
		const rgb = [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16));
		const neutral = Math.max(...rgb) - Math.min(...rgb) < 40;
		if (neutral && Math.min(...rgb) >= 200) return "light";
		theme ??= {};
		if (neutral) { theme.sectionDark ??= colour; return "dark"; }
		theme.sectionAccent ??= colour;
		return "accent";
	};
	const childrenOf = (id: string, list: J[]) => list.filter((x) => str(x._parentId) === id && x._isHidden !== true && x._isAvailable !== false);
	const ctx = { base: "" };
	const rich = (html: unknown) => htmlBlocks(str(html), ctx);

	const graphicSrc = (g: J) => str(g.large) || str(g.medium) || str(g.small) || str(g.src);
	const image = (g: unknown, caption = ""): Block[] => {
		const o = obj(g);
		const src = graphicSrc(o);
		if (!src) return [];
		const cap = line(caption || str(o.attribution));
		return [{ kind: "image", src, alt: text(str(o.alt)), ...(cap ? { caption: cap } : {}) }];
	};
	const heading = (level: 1 | 2 | 3 | 4, html: unknown): Block[] => {
		const t = line(str(html));
		return t ? [{ kind: "heading", level, text: t }] : [];
	};
	const feedback = (c: J) => {
		const f = obj(c._feedback);
		const correct = line(str(f.correct));
		const incorrect = line(str(obj(f._incorrect).final) || str(f._incorrect));
		return { ...(correct ? { correct } : {}), ...(incorrect ? { incorrect } : {}) };
	};

	let droppedInstructions = 0;
	const component = (c: J, level: 1 | 2 | 3 | 4): Block[] => {
		const kind = str(c._component);
		const at = `component ${str(c._id)}`;
		const lose = (effect: Loss["effect"], detail: string) => losses.push({ at, source: `adapt:${kind}`, effect, detail });
		const items = arr(c._items);
		const intro = [...heading(level, c.displayTitle), ...rich(c.body)];
		if (text(str(c.instruction)) && !["mcq", "gmcq", "matching", "textinput"].includes(kind)) droppedInstructions++;
		// A question's instruction stays visible as its description; `stem` in prax.ts splits it off.
		const prompt = () => {
			const instruction = line(str(c.instruction));
			const stem = inline(str(c.body)) || line(str(c.displayTitle));
			return [instruction, stem || "Question"].filter(Boolean).join("\n");
		};
		switch (kind) {
			case "text":
				return intro;
			case "graphic":
				return [...intro, ...image(c._graphic)];
			case "accordion":
			case "tabs":
				return [...intro, { kind: "container", as: kind === "tabs" ? "tab" : "accordion", items: items.map((i, n): Item => ({ title: line(str(i.title)) || `Item ${n + 1}`, blocks: [...rich(i.body), ...image(i._graphic)] })) }];
			case "narrative":
			case "dynamic-narrative":
				lose("approximated", "narrative carousel imported as a sequence of steps");
				return [...intro, { kind: "container", as: "sequence", items: items.map((i, n): Item => ({ title: line(str(i.title)) || `Step ${n + 1}`, blocks: [...image(i._graphic), ...rich(i.body)] })) }];
			case "hotgraphic":
				lose("approximated", "hot graphic pins imported as an accordion after the image; pin positions are not kept");
				return [...intro, ...image(c._graphic), { kind: "container", as: "accordion", items: items.map((i, n): Item => ({ title: line(str(i.title)) || `Pin ${n + 1}`, blocks: [...image(i._graphic), ...rich(i.body)] })) }];
			case "flipcard":
				return [...intro, { kind: "cards", items: items.map((i, n) => ({ title: line(str(i.frontTitle ?? i.title)) || `Card ${n + 1}`, front: image(i.frontImage ?? i._graphic), back: [...heading(4, i.backTitle), ...rich(i.backBody)] })) }];
			case "mcq":
			case "gmcq": {
				if (kind === "gmcq") lose("approximated", "answer images are not shown on the options; their alt text is the option label");
				const options = items.map((i) => ({ text: line(str(i.text)) || neutralize(text(str(obj(i._graphic).alt))), correct: i._shouldBeSelected === true, ...(str(i.feedback) ? { feedback: line(str(i.feedback)) } : {}) }));
				const partly = text(str(obj(obj(c._feedback)._partlyCorrect).final));
				if (partly && Number(c._selectable) !== 1) lose("dropped", "partly-correct feedback has no Studio equivalent");
				return [...heading(level, c.displayTitle), { kind: "choice", prompt: prompt(), multiple: Number(c._selectable) !== 1, options, ...feedback(c) }];
			}
			case "matching":
				return [...heading(level, c.displayTitle), { kind: "match", prompt: prompt(), pairs: items.map((i) => [line(str(i.text)), line(str(arr(i._options).find((o) => o._isCorrect === true)?.text))] as [string, string]), ...feedback(c) }];
			case "textinput": {
				// `_answers` is a list of accepted strings (or, with `_allowsAnyCase` etc., nested lists).
				const accepted = (i: J) => (Array.isArray(i._answers) ? i._answers.flat().map(str).filter(Boolean) : []);
				const parts = items.flatMap((i, n) => [`${n ? "\n" : ""}${text(str(i.prefix))} `.trimStart(), { answers: accepted(i) }, ` ${text(str(i.suffix))}`.trimEnd()]);
				return [...heading(level, c.displayTitle), { kind: "fillBlank", prompt: prompt(), parts, ...feedback(c) }];
			}
			case "media": {
				const media = obj(c._media);
				const src = str(media.mp4) || str(media.webm) || str(media.ogv) || str(media.mp3) || str(media.source);
				const cc = arr(media.cc);
				const captions = str((cc.find((t) => str(t.srclang) === lang) ?? cc[0])?.src);
				const transcript = rich(obj(c._transcript).inlineTranscriptBody);
				if (!src) return intro;
				const player: Block = /\.mp3$/i.test(src) ? { kind: "audio", src } : { kind: "video", src, ...(captions ? { captions } : {}) };
				return [...intro, player, ...transcript];
			}
			case "blank":
			case "assessmentResults":
				return [];
			default: {
				const url = str(c._source);
				if (/^(https?:)?\/\//.test(url)) {
					const full = url.startsWith("//") ? `https:${url}` : url;
					// Wrapper pages that pass the real player URL through (…?oriurl=https://youtube…).
					const inner = /[?&](?:oriurl|url|src)=(https?[^&]+)/.exec(full)?.[1];
					const target = inner ? decodeURIComponent(inner) : full;
					const local = str(obj(c._media).mp4);
					if (local && existsSync(join(root, local))) return [...intro, { kind: "video", src: local }];
					return [...intro, /youtube|youtu\.be|vimeo|loom|wistia/i.test(target) ? { kind: "video", src: target.split("&")[0] ?? target } : { kind: "embed", url: target }];
				}
				lose("dropped", `unsupported component "${kind}"; its title and body text were kept`);
				return intro;
			}
		}
	};

	const lessons: Lesson[] = [];
	const visit = (parent: string, trail: string[]) => {
		for (const co of childrenOf(parent, contentObjects)) {
			const title = text(str(co.displayTitle)) || text(str(co.title));
			if (str(co._type) === "menu") {
				visit(str(co._id), [...trail, title]);
				continue;
			}
			// Headings nest under whichever of page, article and block actually have a visible title.
			const pages: Page[] = [];
			const pageTitle = heading(1, co.displayTitle || co.title);
			const first: Block[] = [...pageTitle, ...rich(co.body)];
			const below = (depth: number, titled: unknown): { own: Block[]; next: number } => {
				const own = heading(Math.min(depth, 4) as 1 | 2 | 3 | 4, titled);
				return { own, next: own.length ? depth + 1 : depth };
			};
			for (const article of childrenOf(str(co._id), articles)) {
				const page: Page = { ...(text(str(article.displayTitle)) ? { title: text(str(article.displayTitle)) } : {}), blocks: pages.length ? [] : [...first] };
				const a = below(pageTitle.length ? 2 : 1, article.displayTitle);
				const articleColour = styling.background("article", article) ?? styling.background("page", co) ?? theme?.background;
				const articleTone = tone(articleColour);
				if (articleTone !== "light") page.blocks.push({ kind: "divider", tone: articleTone });
				let currentTone = articleTone;
				const content: Block[] = [...rich(article.body)];
				for (const block of childrenOf(str(article._id), blocksJson)) {
					const blockTone = tone(styling.background("block", block) ?? articleColour);
					if (blockTone !== currentTone) content.push({ kind: "divider", tone: blockTone });
					currentTone = blockTone;
					const b = below(a.next, block.displayTitle);
					content.push(...b.own, ...rich(block.body));
					for (const c of childrenOf(str(block._id), components)) content.push(...component(c, Math.min(b.next, 4) as 1 | 2 | 3 | 4));
				}
				// An assessment article is Adapt's graded quiz: its questions submit together and pass at _scoreToPass.
				const assessment = obj(article._assessment);
				if (assessment._isEnabled === true) {
					const pass = Number(assessment._scoreToPass);
					const percent = assessment._isPercentageBased !== false && Number.isFinite(pass);
					if (!percent && Number.isFinite(pass)) losses.push({ at: `article ${str(article._id)}`, source: "adapt:assessment", effect: "approximated", detail: `pass mark of ${pass} correct answers is not a percentage; no passing score was set` });
					if (obj(assessment._banks)._isEnabled === true || obj(assessment._randomisation)._isEnabled === true) losses.push({ at: `article ${str(article._id)}`, source: "adapt:assessment", effect: "approximated", detail: "question banks or randomisation are not imported; every question is shown in order" });
					page.blocks.push({ kind: "group", title: line(str(article.displayTitle)) || "Assessment", ...(percent ? { passingScore: pass } : {}), blocks: content });
				} else page.blocks.push(...a.own, ...content);
				pages.push(page);
			}
			if (!pages.length) pages.push({ blocks: first });
			lessons.push({ sourceId: str(co._id), title: [...trail, title].filter(Boolean).join(": ") || `Page ${lessons.length + 1}`, pages });
		}
	};
	visit(str(course._id) || "course", []);
	if (droppedInstructions) losses.push({ at: "course", source: "adapt:instruction", effect: "dropped", detail: `${droppedInstructions} component instruction(s) describing the original player's controls ("click the arrow…") were not imported` });
	if (contentObjects.some((c) => str(c._type) === "menu")) losses.push({ at: "course", source: "adapt:menu", effect: "approximated", detail: "menu levels are flattened; each page becomes a lesson titled with its menu path" });

	const sourceText: string[] = [];
	inventory([course, contentObjects, articles, blocksJson, components].map((list) => (Array.isArray(list) ? list.filter((x) => x._isHidden !== true) : list)), sourceText);
	return {
		tool: "adapt",
		...(theme ? { theme } : {}),
		// Builds often share `_id: "course"`, so the title keeps separate modules distinct.
		sourceId: `${str(course._id)}\n${str(course.title)}`,
		title: text(str(course.displayTitle)) || text(str(course.title)) || "Adapt course",
		...(text(str(course.description)) ? { description: text(str(course.description)) } : {}),
		locale: lang,
		lessons,
		losses,
		sourceText,
	};
}
