import { slideLayout, type HeroItem } from "./hero.ts";
import { insidePackage } from "../input.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { neutralize, parse, text } from "../html.ts";
import { parseLiteral } from "../jslit.ts";
import { type Blank, type Block, type Course, type Inline, type Loss, markScored, type Option, type Page, type Theme } from "../model.ts";

/*
 * Captivate publishes its project as a JavaScript object literal:
 * `cp.D = cp.model.data = {...}` in assets/js/CPM.js (Captivate 9 to 2019) or
 * assets/js/project.js (Captivate 12+), and `cp.model['<id>Data'] = {...}` per
 * question pool. Slides list their items (`si`); each item has a timing entry
 * (`Slide1`) and a display entry (`Slide1c`, via `mdi`). Classic text is
 * rendered to PNG with the words kept in `accstr`; Captivate 12+ keeps
 * Draft.js JSON in `text`.
 */
type J = Record<string, unknown>;
const obj = (v: unknown): J => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : str(v).split(",")).map((s) => s.trim()).filter(Boolean);

/** The object literal that follows `cp.model.data =` or `cp.model['…'] =`, parsed without executing it. */
function loadModel(file: string): J {
	const src = readFileSync(file, "utf8");
	const m = /cp\.model(?:\.data|\[[^\]]+\])\s*=\s*\{/.exec(src);
	if (!m) throw new Error(`Captivate model not found in ${file}`);
	return obj(parseLiteral(src, m.index + m[0].length - 1));
}

/** Captivate's image caches are object literals, not executable package scripts. */
function imageCache(root: string, base: string, embedded: Map<string, Buffer>, losses: Loss[]): void {
	const dir = posix.join(base, "dr");
	if (!existsSync(join(root, dir))) return;
	for (const name of readdirSync(join(root, dir)).sort().filter((n) => /^img.*\.json$/.test(n))) {
		const rel = `${dir}/${name}`;
		const file = insidePackage(root, rel);
		if (!file) continue;
		const source = readFileSync(file, "utf8");
		// imgmd.json usually indexes caches, but some publishes also put image assignments in it.
		for (const match of source.matchAll(/\bcp\.imagesJSONCache\w*\s*=\s*\{/g)) {
			let entries: J;
			try { entries = obj(parseLiteral(source, match.index + match[0].length - 1)); }
			catch {
				losses.push({ at: rel, source: "captivate:image-cache", effect: "dropped", detail: "image cache object could not be parsed" });
				continue;
			}
			for (const key of Object.keys(entries).sort()) {
				// The vendor terminates these maps with a sentinel, not an image entry.
				if (key === "___" && entries[key] === "___") continue;
				const safe = !/^[a-zA-Z]:|[\\\x00-\x1f\x7f]/.test(key) && key.split("/").every((p) => p && p !== "." && p !== "..");
				const path = safe ? posix.join(base, key) : "";
				if (safe && (insidePackage(root, path) || embedded.has(path))) continue;
				const encoded = typeof entries[key] === "string" ? entries[key] as string : "";
				const bytes = Buffer.from(encoded, "base64");
				const base64 = encoded.length > 0 && (bytes.toString("base64") === encoded || bytes.toString("base64").replace(/=+$/, "") === encoded);
				const signature = bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
					bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")) ||
					["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("latin1")) ||
					(bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP");
				if (safe && base64 && signature) embedded.set(path, bytes);
				else losses.push({ at: `${rel}/${key}`, source: "captivate:image-cache", effect: "dropped", detail: safe ? "cache entry is not base64 PNG, JPEG, GIF or WebP image data" : "cache entry has an unsafe package-relative image path" });
			}
		}
	}
}

/** Published design values only; a missing setting leaves Studio's default in place. */
function captivateTheme(data: J, slides: J[], losses: Loss[]): Theme | undefined {
	const project = obj(data.project);
	const playbar = obj(data.playBarProperties);
	const enabled = (v: unknown) => v === true || v === 1 || v === "1";
	const json = (v: unknown): J => {
		try { return typeof v === "string" ? obj(JSON.parse(v)) : obj(v); } catch { return {}; }
	};
	const modern = obj(data.projectThemeData);
	const variables = json(modern.theme);
	const resolve = (value: unknown): string => {
		let result = str(value).trim();
		const seen = new Set<string>();
		while (result.startsWith("var(")) {
			const key = /^var\((--[\w-]+)\)$/.exec(result)?.[1];
			if (!key || seen.has(key)) return "";
			seen.add(key);
			result = str(variables[key]).trim();
		}
		return result;
	};
	const theme: Theme = {};
	const colour = (key: "accent" | "background" | "text" | "buttonBackground" | "buttonText", value: unknown) => {
		const c = resolve(value);
		if (/^#[0-9a-f]{6}$/i.test(c)) theme[key] = c.toLowerCase();
	};
	colour("background", project.prjBgColor);
	if (enabled(project.hasTOC)) theme.navigation = "sidebar";
	const details: string[] = [];
	if (enabled(playbar.hasPlayBar)) {
		if (enabled(playbar.applyColors)) {
			const opaque = (key: string) => {
				const c = obj(playbar[key]);
				return (c.alpha === undefined || c.alpha === 100) && (playbar.alpha === undefined || playbar.alpha === 100) ? c.bc : undefined;
			};
			colour("accent", opaque("GlowColor"));
			colour("buttonBackground", opaque("FaceColor"));
			colour("buttonText", opaque("IconColor"));
		}
		details.push("playbar layout, controls, hover effects and opacity are not preserved; applied face, icon and glow colours become button and accent colours");
	}
	if (enabled(obj(data.borderProperties).hasBorder)) details.push("player borders are not preserved");
	if (enabled(project.hasTOC)) details.push("TOC placement and styling become Studio sidebar navigation");
	if (Object.keys(modern).length) {
		const defaults = obj(json(modern.meta).default_presets);
		const body = str(defaults["1"]) || "text-body-1";
		const slide = obj(json(modern.other_presets)[str(defaults["3"]) || "cp_default_slide_style"]);
		colour("accent", variables["--primary"]);
		colour("text", variables[`--${body}--color`]);
		if (enabled(obj(slide.meta).fillEnable) && obj(slide.meta).fillType === 1 && (slide.fillOpacity === undefined || slide.fillOpacity === 1)) colour("background", slide.backgroundColor ?? slide.fill);
		colour("buttonBackground", variables["--button-normal--primaryColor"]);
		colour("buttonText", variables["--text-button-normal--color"]);
		const heading = resolve(variables["--text-heading-1--fontFamily"]);
		const bodyFont = resolve(variables[`--${body}--fontFamily`]);
		if (heading) theme.headingFont = heading;
		if (bodyFont) theme.bodyFont = bodyFont;
		details.push("responsive type sizes, additional text styles, object presets and button states have no course-wide Studio equivalent");
	}
	if (!theme.bodyFont) {
		// ponytail: classic vt captions are the font fallback, weighted by non-whitespace
		// characters; ties use font-name code-unit order. Raster-only captions supply no font.
		const weights = new Map<string, number>();
		const visit = (node: ReturnType<typeof parse> | ReturnType<typeof parse>["childNodes"][number], inherited = "") => {
			let font = inherited;
			if ("tagName" in node) {
				const style = node.attrs.find((a) => a.name === "style")?.value ?? "";
				const family = /(?:^|;)\s*font-family\s*:\s*([^;]+)/i.exec(style)?.[1];
				if (family) font = family.split(",")[0]!.replace(/["']/g, "").trim().replace(/\s+(regular|bold|italic)$/i, "");
			}
			if (node.nodeName === "#text" && "value" in node && font) weights.set(font, (weights.get(font) ?? 0) + node.value.replace(/\s/g, "").length);
			if ("childNodes" in node) for (const child of node.childNodes) visit(child, font);
		};
		for (const key of Object.keys(data).sort()) {
			const item = obj(data[key]);
			if ([19, 589, 590, 612].includes(num(item.type)) && str(item.vt)) visit(parse(str(item.vt)));
		}
		const fonts = [...weights].filter(([, n]) => n > 0).sort(([a, an], [b, bn]) => bn - an || (a < b ? -1 : a > b ? 1 : 0));
		if (fonts[0]) {
			theme.bodyFont = fonts[0][0];
			details.push("body font is the most frequent classic caption font by non-whitespace character count; local caption styling is not preserved");
		}
	}
	const backgrounds = new Map<string, number>();
	for (const slide of slides) {
		const canvas = obj(slide.canvasData);
		const colour = resolve(Object.keys(canvas).length ? enabled(canvas.fe) && canvas.fa === 1 ? canvas.bc : undefined : slide.bc).toLowerCase();
		if (/^#[0-9a-f]{6}$/.test(colour)) backgrounds.set(colour, (backgrounds.get(colour) ?? 0) + 1);
	}
	// One vote per recorded slide; equal counts use colour code-unit order.
	const background = [...backgrounds].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]?.[0];
	if (background) {
		theme.background = background;
		details.push("most frequent recorded opaque slide background applied course-wide; ties use colour code-unit order");
	}
	if (slides.length) details.push("slide-specific typography, backgrounds, positioning, gradients and decorative shapes are not reproduced");
	if (str(project.htmlBgColor) && str(project.htmlBgColor) !== str(project.prjBgColor)) details.push("the outer HTML player background has no separate Studio field");
	if (details.length) losses.push({ at: "project", source: "captivate:theme", effect: "approximated", detail: details.join("; ") });
	return Object.keys(theme).length ? theme : undefined;
}

/** Draft.js content as plain blocks; `bold`/`italic` are per-character flags for inline markdown. */
type Draft = { type: string; text: string; bold: boolean[]; italic: boolean[] };
function draft(json: unknown): Draft[] {
	let editor: J = {};
	try {
		editor = obj(JSON.parse(str(json)));
	} catch {
		return [];
	}
	return arr(editor.blocks).map((b) => {
		const o = obj(b);
		const t = str(o.text);
		const bold = Array<boolean>(t.length).fill(false);
		const italic = Array<boolean>(t.length).fill(false);
		for (const r of arr(o.inlineStyleRanges).map(obj)) {
			const flags = str(r.style) === "fontWeight:bold" ? bold : str(r.style) === "fontStyle:italic" ? italic : undefined;
			if (flags) for (let i = num(r.offset); i < Math.min(t.length, num(r.offset) + num(r.length)); i++) flags[i] = true;
		}
		return { type: str(o.type), text: t, bold, italic };
	});
}

/** Inline markdown for one Draft block: runs of identical bold/italic flags, markers kept off edge spaces. */
function draftInline(d: Draft): Inline {
	let out = "";
	for (let i = 0; i < d.text.length; ) {
		let j = i;
		while (j < d.text.length && d.bold[j] === d.bold[i] && d.italic[j] === d.italic[i]) j++;
		const run = neutralize(d.text.slice(i, j));
		const core = run.trim();
		const mark = `${d.bold[i] ? "**" : ""}${d.italic[i] ? "*" : ""}`;
		out += core && mark ? run.replace(core, `${mark}${core}${mark}`) : run;
		i = j;
	}
	return out.replace(/\s+/g, " ").trim();
}

const GENERIC_ACC = /^(Image|Click Box|Video|Button|Smart Shape|Text Caption|Highlight Box|Web Object|Text Entry Box.*|Rollover.*|Zoom.*)?$/;
const CLASSIC = { clickBox: 13, image: 15, textCaption: 19, textEntry: 24, button: 29, video: 98, shape: 612, webObject: 652, hotspot: 684, container: 1268 };
/** Question-slide parts the question block already carries: prompt (79), answers (80), column headers (87), submit/progress/review (91, 92, 94), Likert grid (96), hotspot area (131). */
const QUIZ_TYPES = new Set([79, 80, 87, 91, 92, 94, 96, 131]);
/** Quiz chrome that is neither authored text nor an answer: buttons, progress, review area, letters and entry boxes. */
const QUIZ_CHROME = new Set([91, 92, 94, 96, 131, 10011, 10088, 10094, 10098, 10180, 10182]);

export function extractCaptivate(root: string): Course {
	const modelFile = ["assets/js/CPM.js", "assets/js/project.js"].map((f) => insidePackage(root, f)).find((f) => !!f);
	if (!modelFile) throw new Error("Captivate package found, but assets/js/CPM.js or assets/js/project.js is missing");
	const data = loadModel(modelFile);
	let meta: J = {};
	let toc = new Map<string, string>();
	if (existsSync(join(root, "project.txt"))) {
		try {
			const project = obj(JSON.parse(readFileSync(join(root, "project.txt"), "utf8")));
			meta = obj(project.metadata);
			toc = new Map(arr(project.toc).map((t) => [str(obj(t).id), str(obj(t).title)]));
		} catch {
			/* project.txt is optional; the model carries everything needed */
		}
	}
	const main = obj(data.project_main);
	const project = obj(data.project);
	const losses: Loss[] = [];
	const sourceText: string[] = [];
	const embedded = new Map<string, Buffer>();
	imageCache(root, "", embedded, losses);

	/** Alternative-state copies of an object; they share its place on the slide and are not separate content. */
	const variants = (model: J): Set<number> => {
		const out = new Set<number>();
		for (const v of Object.values(model)) for (const st of arr(obj(v).stl).slice(1)) for (const uid of arr(obj(st).stsi)) out.add(num(uid));
		return out;
	};

	type Item = { name: string; type: number; it: J; c: J; tag: string; top: number; left: number };
	/** Items of a slide, flattened through Captivate 12+ containers, minus state variants. */
	const items = (model: J, holder: J, skip: Set<number>, out: Item[] = []): Item[] => {
		for (const ref of arr(holder.si).map(obj)) {
			const name = str(ref.n);
			const it = obj(model[name]);
			const c = obj(model[str(it.mdi)]);
			if (!Object.keys(it).length || skip.has(num(c.uid)) || it.baseItemIdForPropertyFlow !== undefined) continue;
			const pos = obj(obj(parseJson(it.widgetProps)).sizeNPos);
			const b = arr(c.b).map(num);
			const hasBox = b.length === 4 && (b[0] !== 0 || b[1] !== 0);
			out.push({ name, type: num(it.type ?? ref.t), it, c, tag: str(it.tag), top: num(pos.top) || (hasBox ? (b[1] ?? 0) : 0), left: num(pos.left) || (hasBox ? (b[0] ?? 0) : 0) });
			items(model, it, skip, out);
		}
		return out;
	};

	const parseJson = (v: unknown): unknown => {
		try {
			return JSON.parse(str(v));
		} catch {
			return undefined;
		}
	};

	/** Authored text of an item: Draft.js blocks (12+), a checkbox label, or the accessibility string (classic). */
	const draftOf = (x: Item): Draft[] => {
		if (typeof x.it.text === "string") return draft(x.it.text);
		const normal = obj(obj(parseJson(x.it.widgetProps)).normal);
		return normal.editorState ? draft(JSON.stringify(normal.editorState)) : [];
	};
	const plain = (x: Item): string => {
		const d = draftOf(x);
		if (d.length) return d.map((b) => b.text).join(" ").replace(/\s+/g, " ").trim();
		const acc = str(x.c.accstr ?? x.it.accstr).trim();
		return GENERIC_ACC.test(acc) ? "" : acc;
	};
	const displayAlt = (display: J): string => {
		const a11y = str(obj(display.accProps).a11yText).trim();
		if (typeof obj(display.accProps).a11yText === "string") return a11y;
		const acc = str(display.accstr).trim();
		return GENERIC_ACC.test(acc) ? "" : acc;
	};

	const alt = (x: Item) => displayAlt(x.c);

	const textBlocks = (x: Item): Block[] => {
		const d = draftOf(x);
		if (!d.length) {
			const t = plain(x);
			return t ? [{ kind: "paragraph", text: neutralize(t) }] : [];
		}
		const level = Math.min(4, num(obj(x.c.accProps).a11yHeadingLevel)) as 1 | 2 | 3 | 4 | 0;
		const out: Block[] = [];
		for (const b of d) {
			const t = draftInline(b);
			if (!t) continue;
			const ordered = b.type === "ordered-list-item";
			const last = out.at(-1);
			if (b.type.endsWith("-list-item")) {
				if (last?.kind === "list" && last.ordered === ordered) last.items.push(t);
				else out.push({ kind: "list", ordered, items: [t] });
			} else if (level) out.push({ kind: "heading", level, text: t });
			else out.push({ kind: "paragraph", text: t });
		}
		return out;
	};

	const captions = (slide: J): string[] => {
		const cc = slide.audCC;
		if (typeof cc === "string") return arr(parseJson(cc)).map((c) => str(obj(c).text).trim()).filter(Boolean);
		return arr(cc).map((c) => {
			const t = obj(obj(c).t);
			const key = Object.keys(t).sort()[0];
			return key ? text(str(t[key])) : "";
		}).filter(Boolean);
	};

	/** Slide narration: an entry of project_main.slideAudios whose frame range starts inside the slide. */
	const slideAudios = list(main.slideAudios).map((n) => obj(data[n]));
	const narration = (slide: J): string | undefined => {
		const from = num(slide.from);
		const to = num(slide.to);
		const hit = slideAudios.find((a) => num(a.from) >= from && num(a.from) <= to && str(a.src));
		return hit ? str(hit.src) : undefined;
	};

	const question = (model: J, slide: J, all: Item[], base: string, at: string): Block[] => {
		const q = obj(model[str(slide.qs)]);
		const type = str(q.qtp);
		if (!Object.keys(q).length || type === "InteractiveItemQuestion") return [];
		const byName = new Map(all.flatMap((x) => [[x.name, x], [str(x.it.mdi), x]] as Array<[string, Item]>));
		// Answer lists name timing or display entries (including `hotspot`, `fib` and `sha` suffixes).
		const itemOf = (ref: string): Item | undefined => {
			const name = ref.split(":")[0] ?? "";
			return byName.get(name) ?? byName.get(name.replace(/c$/, ""));
		};
		// Matching items label themselves with a letter in `atxtlms`; the wording is in `aAnsTxtlms`.
		const answerText = (x: Item | undefined): string => (x ? neutralize(str(x.c.aAnsTxtlms).trim() || str(x.c.atxtlms).trim() || plain(x)) : "");
		const textOf = (ref: string): string => answerText(itemOf(ref));
		const aid = (x: Item) => str(x.c.aid ?? x.it.aid);
		// Captivate strips quotation marks from `qt`; the slide's caption keeps the learner's exact wording.
		const letters = (t: string) => t.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
		const questionItem = all.find((x) => x.tag === "slide-item-question-text") ?? (str(q.qt).trim() ? all.find((x) => x.type === 79 && letters(plain(x)) === letters(str(q.qt))) : undefined);
		const prompt = neutralize((questionItem ? plain(questionItem) : "") || str(q.qt).trim() || "Question");
		const answerRefs = list(q.ail).length ? list(q.ail) : list(q.ao);
		const answers = answerRefs.map(itemOf).filter((x): x is Item => !!x);
		const correct = new Set(list(q.cal));
		const isCorrect = (x: Item) => x.c.ic === true || correct.has(x.name) || correct.has(`${x.name}c`) || correct.has(aid(x));
		const lose = (effect: Loss["effect"], detail: string) => losses.push({ at, source: `captivate:question/${type || "unknown"}`, effect, detail });
		// Classic and modern players use different sentinels for unlimited attempts.
		const unlimited = q.noa === (modelFile.endsWith("project.js") ? 1024 : 9999);
		const attempts = unlimited ? { attempts: 0 } : Number.isSafeInteger(q.noa) && num(q.noa) > 0 ? { attempts: num(q.noa) } : {};
		const incorrect = textOf(list(q.ifc).at(-1) ?? "");
		const retry = [q.sfrc === false ? "" : textOf(str(q.frc)), ...list(q.ifc).slice(0, -1).map(textOf)].filter(Boolean);
		if (retry.some((t) => t !== incorrect)) lose("approximated", "distinct retry feedback cannot be represented; only final incorrect feedback is kept");
		const feedback = {
			...attempts,
			...(textOf(str(q.osc)) ? { correct: textOf(str(q.osc)) } : {}),
			...(incorrect ? { incorrect } : {}),
		};
		switch (type) {
			case "MCQ":
			case "TrueFalse": {
				const options: Option[] = answers.map((x) => ({ text: answerText(x), correct: isCorrect(x) }));
				if (!options.length) {
					lose("dropped", "question has no readable answer options");
					return [{ kind: "paragraph", text: prompt }];
				}
				if (!options.some((o) => o.correct)) lose("approximated", "no correct answer found; imported with none marked");
				return [{ kind: "choice", prompt, multiple: options.filter((o) => o.correct).length > 1, options, ...feedback }];
			}
			case "LIKERT": {
				const scale = list(q.rsv).map(neutralize);
				const statements = answers.map(answerText).filter(Boolean);
				if (!scale.length || !statements.length || statements.length !== answerRefs.length) {
					lose("dropped", "rating scale has missing or unreadable statements or scale labels; the question text is kept as a paragraph");
					return [{ kind: "paragraph", text: prompt }];
				}
				return statements.length === 1
					? [{ kind: "rating", prompt: prompt === statements[0] ? prompt : `${prompt}\n${statements[0]}`, scale }]
					: [{ kind: "matrix", prompt, statements, scale }];
			}
			case "ShortAnswer": {
				if (correct.size) {
					if (answers.some((x) => x.c.cs === true)) lose("approximated", "case-sensitive answer matching has no field in the course model");
					return [{ kind: "fillBlank", prompt, parts: [{ answers: [...correct] }], ...feedback }];
				}
				if (feedback.correct || feedback.incorrect) lose("dropped", "free-response feedback has no field in the course model");
				return [{ kind: "freeResponse", prompt }];
			}
			case "FIB": {
				// Each `ao` entry names a blank; its caption holds the sentence, without a reliable text offset.
				const blanks = list(q.ao).map((ref) => obj(model[ref.split(":")[0] ?? ""]));
				const sentences = [...new Set(blanks.map((b) => {
					const caption = str(obj(model[str(b.capN)]).mdi) || `${str(b.capN)}c`;
					return str(obj(model[caption]).fibText).trim();
				}).filter(Boolean))];
				// Captivate's FIBAnswer uses `sac` for a combo box and `allAnswers` for its ordered options.
				const dropdown = blanks.length > 0 && blanks.every((b) => b.sac === true);
				const accepted: Blank[] = blanks.map((b) => ({ answers: list(b.correctAnswers), ...(b.sac === true ? { choices: list(b.allAnswers) } : {}) }));
				if (!blanks.length || accepted.some((b) => !b.answers.length)) lose("approximated", "some fill-in-the-blank answers could not be read; unanswerable blanks are kept as ____");
				if (!dropdown && blanks.some((b) => b.sac === true)) lose("approximated", "mixed dropdown and typed blanks imported as typed blanks; per-blank interaction styles and dropdown distractors are not kept");
				if (blanks.some((b) => b.cs === true)) lose("approximated", "case-sensitive answer matching has no field in the course model");
				lose("approximated", "blank positions could not be recovered; answers follow the source sentence in answer-list order");
				const parts: Array<string | Blank> = sentences.length ? [`${sentences.join(" ")} `] : [];
				for (const b of accepted.length ? accepted : [{ answers: [] }]) {
					if (parts.length && typeof parts.at(-1) !== "string") parts.push(" ");
					parts.push(b);
				}
				return [{ kind: "fillBlank", prompt, parts, ...(dropdown ? { style: "dropdown" } : {}), ...feedback }];
			}
			case "Hotspot": {
				const box = (v: unknown): [number, number, number, number] | undefined => {
					const b = arr(v);
					return b.length === 4 && b.every((n) => typeof n === "number" && Number.isFinite(n)) && num(b[2]) > num(b[0]) && num(b[3]) > num(b[1])
						? b as [number, number, number, number] : undefined;
				};
				const regions = answers.map((x) => box(x.c.b ?? x.it.b));
				if (!answers.length || answers.length !== answerRefs.length || regions.some((b) => !b)) {
					lose("dropped", `hotspot question "${prompt}" dropped: answer references or region bounds could not be read`);
					return [];
				}
				const centres = regions.map((b) => ({ x: ((b?.[0] ?? 0) + (b?.[2] ?? 0)) / 2, y: ((b?.[1] ?? 0) + (b?.[3] ?? 0)) / 2 }));
				const background = obj(model[str(slide.mdi)]);
				const candidates = [
					...all.filter((x) => isPicture(x) && !hiddenItem(x)).map((x) => ({ display: x.c, src: imagePath(x.c), alt: alt(x), bounds: box(x.c.b) })),
					{ display: background, src: imagePath(background), alt: displayAlt(background), bounds: box(background.b) ?? box([0, 0, project.w, project.h]) },
				];
				const image = candidates.find((c) => {
					if (!c.src || !c.bounds || !centres.every((p) => p.x >= c.bounds![0] && p.x <= c.bounds![2] && p.y >= c.bounds![1] && p.y <= c.bounds![3])) return false;
					// A bare background is not the question image when the targets are separate foreground content.
					return !all.some((x) => {
						if (x.c === c.display || hiddenItem(x) || !(isPicture(x) || x.type === CLASSIC.textCaption || x.type === CLASSIC.shape || x.tag === "slide-item-text")) return false;
						const b = box(x.c.b);
						return b && regions.some((r) => r && b[0] < r[2] && b[2] > r[0] && b[1] < r[3] && b[3] > r[1]);
					});
				});
				if (!image?.bounds) {
					lose("dropped", `hotspot question "${prompt}" dropped: regions have no shared image with readable bounds; separate pictures/captions need compositing and Studio choice options cannot display images`);
					return [];
				}
				const [left, top, right, bottom] = image.bounds;
				lose("approximated", "hotspot regions became centre points on the question image; region shapes and sizes are not preserved");
				if (feedback.correct || feedback.incorrect) lose("dropped", "hotspot feedback has no field in the course model");
				if (!answers.some(isCorrect)) lose("approximated", "no correct hotspot answer found; imported with none marked");
				return [{ kind: "hotspot", prompt, ...attempts, src: posix.join(base, image.src), alt: image.alt, spots: answers.map((x, i) => ({
					label: answerText(x) || `Spot ${i + 1}`, x: ((centres[i]?.x ?? 0) - left) / (right - left) * 100, y: ((centres[i]?.y ?? 0) - top) / (bottom - top) * 100, correct: isCorrect(x),
				})) }];
			}
			case "Matching": {
				const left = list(q.aio).map(itemOf).filter((x): x is Item => !!x);
				const right = list(q.aco).map(itemOf).filter((x): x is Item => !!x);
				const pairs = left.flatMap((l): Array<[Inline, Inline]> => {
					const r = right.find((x) => aid(x) === aid(l));
					return r ? [[answerText(l), answerText(r)]] : [];
				});
				if (!pairs.length) {
					lose("dropped", "matching pairs could not be read; the question text is kept as a paragraph");
					return [{ kind: "paragraph", text: prompt }];
				}
				return [{ kind: "match", prompt, pairs, ...feedback }];
			}
			case "Sequence": {
				const ordered = (correct.size ? [...correct] : list(q.ao)).map(itemOf).filter((x): x is Item => !!x);
				if (!ordered.length) {
					lose("dropped", "sequence items could not be read; the question text is kept as a paragraph");
					return [{ kind: "paragraph", text: prompt }];
				}
				if (!correct.size) lose("approximated", "no correct order found; items imported in display order");
				return [{ kind: "order", prompt, items: ordered.map(answerText), ...feedback }];
			}
			default:
				lose("dropped", `${type || "unknown"} question is not imported; its text is kept as a paragraph`);
				return [{ kind: "paragraph", text: prompt }];
		}
	};

	/** Image path of a display entry; shapes without an image fill carry a bare "dr/". */
	const imagePath = (c: J): string => (str(c.ip).endsWith("/") ? "" : str(c.ip));
	const isPicture = (x: Item) => x.type === CLASSIC.image || x.tag === "cp-shape-lib-item";
	const hiddenItem = (x: Item) => x.c.visible === 0 || x.c.visible === "0";

	/** Classic drag/drop keys use type IDs (`t`); participant names (`n`) locate their labels. */
	const dragDrop = (model: J, slide: J, ordered: Item[], at: string) => {
		const blocks: Block[] = [];
		const usedText = new Set<string>();
		const participants = new Set<string>();
		const byName = new Map(ordered.flatMap((x) => [[x.name, x], [str(x.it.mdi), x]] as Array<[string, Item]>));
		for (const ref of arr(slide.iph).map(obj)) {
			const interaction = obj(model[str(ref.n)]);
			if (num(ref.t) !== 633 && !arr(interaction.ds).length && !arr(interaction.dt).length) continue;
			const sources = arr(interaction.ds).map(obj);
			const targets = arr(interaction.dt).map(obj);
			for (const entry of [...sources, ...targets]) participants.add(str(entry.n));
			const lose = (effect: Loss["effect"], detail: string) => losses.push({ at: `${at}/${str(ref.n)}`, source: "captivate:drag-and-drop", effect, detail });
			const keys = arr(interaction.cal).map(obj);
			if (keys.length !== 1 || keys[0]?.isSeq !== false) {
				lose("dropped", `${sources.length} sources and ${targets.length} targets: ${!keys.length ? "no graded answer key" : keys.length > 1 ? "alternative answer keys" : "a sequence-dependent answer key"}; readable slide text is kept`);
				continue;
			}
			// ponytail: accept only fixed, single-use pairs; richer Captivate expressions remain losses until needed.
			const expression = str(keys[0].a);
			const key = /^\\b((?:\(t:\w+-t:\w+\)\{1\})+)\\b$/.exec(expression);
			const pairs = key ? [...key[1]!.matchAll(/\(t:(\w+)-t:(\w+)\)\{1\}/g)].map((m) => [m[1]!, m[2]!] as const) : [];
			const associations = new Map(pairs);
			if (!sources.length || !targets.length || pairs.length !== sources.length || associations.size !== sources.length ||
				new Set(sources.map((s) => str(s.t))).size !== sources.length || new Set(targets.map((t) => str(t.t))).size !== targets.length ||
				new Set([...sources, ...targets].map((entry) => str(entry.n))).size !== sources.length + targets.length ||
				sources.some((s) => !targets.some((t) => str(t.t) === associations.get(str(s.t)))) || targets.some((t) => !pairs.some(([, id]) => id === str(t.t)))) {
				lose("dropped", `${sources.length} sources and ${targets.length} targets: the answer key is not a complete set of unambiguous single-use source/target pairs; readable slide text is kept`);
				continue;
			}
			const label = (entry: J) => {
				const item = byName.get(str(entry.n));
				return item ? neutralize(plain(item) || alt(item)) : "";
			};
			if ([...sources, ...targets].some((entry) => !label(entry)) || new Set(targets.map(label)).size !== targets.length) {
				lose("dropped", "source or target labels are missing or target labels are indistinguishable; readable slide text is kept");
				continue;
			}
			const feedbackText = (name: unknown) => {
				const item = byName.get(str(name));
				if (item) usedText.add(item.name);
				return item ? neutralize(plain(item)) : "";
			};
			const correct = feedbackText(interaction.osc);
			const incorrect = feedbackText(interaction.ofc);
			// DD.Interaction reads ma and enforces the limit only when it is positive.
			const attempts = Number.isSafeInteger(interaction.ma) ? { attempts: Math.max(0, num(interaction.ma)) } : {};
			const feedback = { ...attempts, ...(correct ? { correct } : {}), ...(incorrect ? { incorrect } : {}) };
			const prompts = ordered.filter((x) => !participants.has(x.name) && !usedText.has(x.name) && !hiddenItem(x) &&
				(x.type === CLASSIC.textCaption || x.type === CLASSIC.shape || x.tag === "slide-item-text" || x.type === 79) &&
				/^(cp\.jumpToNextSlide\(\);|cpCmndResume = 1;)?$/.test(str(x.it.oca)) && plain(x));
			const prompt = prompts.map((x) => neutralize(plain(x))).join("\n") || neutralize(str(slide.lb)) || "Question";
			for (const x of prompts) usedText.add(x.name);
			for (const entry of [...sources, ...targets]) usedText.add(str(entry.n));
			const categories = targets.map((t) => ({ name: label(t), items: sources.filter((s) => associations.get(str(s.t)) === str(t.t)).map(label) }));
			const kind = categories.every((c) => c.items.length === 1) ? "match" : "categorize";
			blocks.push(kind === "match" ? { kind, prompt, pairs: categories.map((c) => [c.items[0]!, c.name]), ...feedback } : { kind, prompt, categories, ...feedback });
			lose("approximated", `drag-and-drop imported as ${kind}; placement, drop actions and interaction scoring are not preserved`);
			if (targets.some((t) => str(t.osc) || str(t.ofc))) lose("dropped", "per-target feedback has no field in the course model");
		}
		const orphaned = ordered.filter((x) => x.it.isDD === true && !participants.has(x.name));
		if (orphaned.length) losses.push({ at, source: "captivate:drag-and-drop", effect: "dropped", detail: `${orphaned.length} drag-and-drop objects have no referenced interaction definition with sources, targets and an answer key; readable slide text is kept` });
		return { blocks, usedText };
	};

	/** Pictures repeated on three or more slides are the slide template (logos, navigation art), not content. */
	const chrome = new Set<string>();
	const skip = variants(data);
	{
		const usage = new Map<string, Set<string>>();
		for (const sid of list(main.slides))
			for (const x of items(data, obj(data[sid]), skip)) {
				const ip = isPicture(x) ? imagePath(x.c) : "";
				if (ip) (usage.get(ip) ?? usage.set(ip, new Set()).get(ip))?.add(sid);
			}
		for (const [ip, slides] of usage) if (slides.size >= 3) chrome.add(ip);
		if (chrome.size) losses.push({ at: "project", source: "captivate:template", effect: "dropped", detail: `${chrome.size} pictures repeated on 3+ slides are treated as slide template chrome and skipped: ${[...chrome].sort().join(", ").slice(0, 300)}` });
	}

	const slides: J[] = [];
	const page = (model: J, sid: string, index: number, base: string, skip: Set<number>): Page | undefined => {
		const slide = obj(model[sid]);
		const at = `${base ? `${base}/` : ""}${sid}`;
		const all = items(model, slide, skip);
		const scoreIndex = obj(model.quizzingData).anyScoreSlide;
		// anyScoreSlide is a zero-based slide index; 111 is kCPOTScoringResult.
		if ((Number.isSafeInteger(scoreIndex) && num(scoreIndex) >= 0 && list(obj(model.project_main).slides)[num(scoreIndex)] === sid) || all.some((x) => x.type === 111)) {
			losses.push({ at, source: "captivate:results", effect: "dropped", detail: "result slide skipped because Studio reports the score itself" });
			return undefined;
		}
		const isQuestion = str(slide.st) === "Question Slide";
		const q = obj(model[str(slide.qs)]);
		const questions = isQuestion ? question(model, slide, all, base, at) : [];
		if (isQuestion && str(q.qtp) === "Hotspot" && !questions.length) return undefined;
		slides.push(slide);
		const title = str(slide.lb).trim() || toc.get(sid) || `Slide ${index + 1}`;
		const blocks: Block[] = [];
		const heroItems: HeroItem[] = [];
		const src = (p: string) => posix.join(base, p);
		const image = (ip: string, alt: string) => {
			if (!ip || chrome.has(ip)) return;
			blocks.push({ kind: "image", src: src(ip), alt });
		};
		const background = obj(model[str(slide.mdi)]);
		image(imagePath(background), displayAlt(background));
		if (blocks.length && !project.responsive && !project.isResponsive && !background.rpvt && !background.tr && !background.r) {
			const b = arr(background.b);
			// slide.mdi is the full-slide canvas; classic publishes may record a zero box.
			const bounds = background.b === undefined || (b.length === 4 && b.every((v) => v === 0)) ? [0, 0, project.w, project.h] : b;
			if (bounds.length === 4 && bounds.every((v) => typeof v === "number" && Number.isFinite(v))) heroItems.push({ blocks: [...blocks], box: { x: num(bounds[0]), y: num(bounds[1]), w: num(bounds[2]) - num(bounds[0]), h: num(bounds[3]) - num(bounds[1]) }, order: -1 });
		}
		const audio = narration(slide);
		if (audio) blocks.push({ kind: "audio", src: src(audio) });
		const cc = captions(slide);
		if (cc.length) blocks.push({ kind: "paragraph", text: neutralize(cc.join(" ")) });

		// Answer options and feedback captions reach the page through the question block, not as loose text.
		const quizParts = new Set(isQuestion ? [...list(q.ail), ...list(q.ao), ...list(q.aio), ...list(q.aco), str(q.osc), str(q.oic), str(q.frc), str(q.tfcn), ...list(q.ifc)].map((a) => a.split(":")[0]?.replace(/c$/, "") ?? "") : []);
		const quizPart = (x: Item) => isQuestion && (quizParts.has(x.name) || x.type >= 10000 || QUIZ_TYPES.has(x.type));
		const counts = new Map<string, number>();
		const count = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
		const hidden: string[] = [];
		const hotspots: string[] = [];
		const byPosition = (a: { x: Item; i: number }, b: { x: Item; i: number }) => a.x.top - b.x.top || a.x.left - b.x.left || a.i - b.i;
		const indexed = all.map((x, i) => ({ x, i }));
		const readingOrder = (entries: typeof indexed): Item[] => {
			const rows: Array<{ centre?: number; entries: typeof indexed }> = [];
			for (const entry of entries.sort(byPosition)) {
				const b = arr(entry.x.c.b);
				const centre = !entry.x.it.widgetProps && b.length === 4 && b.every((v) => typeof v === "number" && Number.isFinite(v)) && num(b[2]) > num(b[0]) && num(b[3]) > num(b[1])
					? (num(b[1]) + num(b[3])) / 2 : undefined;
				// ponytail: scan the slide's rows; index them only if object counts make this costly.
				// Fixed boxes within 10px of the first item's vertical centre share a row.
				// The anchor never moves, so nearby rows cannot merge through chained offsets.
				const row = centre === undefined ? undefined : rows.find((r) => r.centre !== undefined && Math.abs(r.centre - centre) <= 10);
				if (row) row.entries.push(entry);
				else rows.push({ centre, entries: [entry] });
			}
			return rows.flatMap((r) => r.entries.sort((a, b) => a.x.left - b.x.left || a.i - b.i).map(({ x }) => x));
		};
		// Objects hidden until an action shows them (reveal panels, feedback) follow the visible content.
		const ordered = [...readingOrder(indexed.filter((e) => !hiddenItem(e.x))), ...readingOrder(indexed.filter((e) => hiddenItem(e.x)))];
		const dd = dragDrop(model, slide, ordered, at);
		for (const x of ordered) {
			if (quizPart(x) || (x.tag.startsWith("slide-item-") && !["slide-item-text", "slide-item-image"].includes(x.tag))) continue;
			if (hiddenItem(x)) {
				const t = plain(x);
				if (!t) continue;
				if (!dd.usedText.has(x.name)) hidden.push(t);
			}
			const start = blocks.length;
			switch (x.type) {
				case CLASSIC.clickBox:
					count("click box");
					break;
				case CLASSIC.button:
					count("button");
					break;
				case CLASSIC.hotspot:
					if (str(x.it.htsptFb).trim()) hotspots.push(str(x.it.htsptFb).trim());
					break;
				case CLASSIC.textEntry: {
					const expected = list(x.it.exp);
					const label = neutralize(str(x.c.txt).trim() || "Text entry");
					if (x.it.val && expected.length) blocks.push({ kind: "fillBlank", prompt: label, parts: [{ answers: expected }] });
					else blocks.push({ kind: "freeResponse", prompt: label });
					count("text entry box");
					break;
				}
				case CLASSIC.video:
					if (str(x.c.mp4)) blocks.push({ kind: "video", src: src(str(x.c.mp4)), ...(alt(x) ? { title: alt(x) } : {}) });
					break;
				case CLASSIC.webObject:
					if (/^https?:\/\//.test(str(x.c.wou))) blocks.push({ kind: "embed", url: str(x.c.wou) });
					else count("local web object");
					break;
				case CLASSIC.image:
					image(imagePath(x.c), alt(x));
					break;
				default: {
					const t = dd.usedText.has(x.name) ? [] : textBlocks(x);
					if (t.length) blocks.push(...t);
					else if (x.tag === "cp-shape-lib-item") image(imagePath(x.c), alt(x));
					if (x.type === CLASSIC.shape && str(x.it.oca) && !/^(cp\.jumpToNextSlide\(\);|cpCmndResume = 1;)?$/.test(str(x.it.oca))) count("shape with an action");
				}
			}
			const b = arr(x.c.b);
			if (!hiddenItem(x) && !project.responsive && !project.isResponsive && !x.c.rpvt && !x.c.tr && !x.c.r && !x.it.widgetProps && b.length === 4 && b.every((v) => typeof v === "number" && Number.isFinite(v))) {
				let fontSize: number | undefined;
				let color: string | undefined;
				// Classic captions retain their authored type in vt even when rendered as PNG.
				const visit = (node: ReturnType<typeof parse> | ReturnType<typeof parse>["childNodes"][number], size?: number, ink?: string) => {
					if ("tagName" in node) {
						const style = node.attrs.find((a) => a.name === "style")?.value ?? "";
						const recorded = /(?:^|;)\s*font-size\s*:\s*(\d+(?:\.\d+)?)(px|pt)\b/i.exec(style);
						if (recorded) size = Number(recorded[1]) * (recorded[2]!.toLowerCase() === "pt" ? 4 / 3 : 1);
						ink = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(style)?.[1]?.trim() ?? ink;
					}
					if (node.nodeName === "#text" && "value" in node && node.value.trim() && (fontSize === undefined || (size !== undefined && size > fontSize))) { fontSize = size; color = ink; }
					if ("childNodes" in node) for (const child of node.childNodes) visit(child, size, ink);
				};
				visit(parse(str(x.c.vt)));
				heroItems.push({ blocks: blocks.slice(start), box: { x: b[0] as number, y: b[1] as number, w: (b[2] as number) - (b[0] as number), h: (b[3] as number) - (b[1] as number) }, order: all.indexOf(x), fontSize, color, singleLine: !/[\r\n]|<br\b/i.test(str(x.c.vt) || plain(x)) && draftOf(x).length <= 1 });
			}
			const itemAudio = str(obj(model[str(x.it.ia)]).src);
			if (itemAudio) blocks.push({ kind: "audio", src: src(itemAudio) });
			if (arr(x.it.stl).length > 1) count("multi-state object");
		}
		blocks.push(...dd.blocks);
		if (hotspots.length) {
			blocks.push({ kind: "list", ordered: false, items: hotspots.map(neutralize) });
			losses.push({ at, source: "captivate:hotspot", effect: "approximated", detail: `${hotspots.length} 360° hotspot labels imported as a list; their placement and click feedback are not` });
		}
		if (isQuestion) {
			// Captivate flags surveys (is), knowledge checks (ikc) and pretests (ipq); anything else is graded.
			if (!(q.is === true || q.ikc === true || q.ipq === true)) markScored(questions);
			for (const question of questions) if (question.kind === "matrix" || question.kind === "rating") {
				const labels = new Set([question.prompt, ...question.scale, ...question.scale.map((_, i) => String(i + 1)), ...(question.kind === "matrix" ? question.statements : []), "Likert", "Likert Scale"]);
				for (let i = blocks.length - 1; i >= 0; i--) {
					const b = blocks[i]!;
					if (b.kind === "paragraph" && labels.has(b.text.trim())) blocks.splice(i, 1);
				}
			}
			// The question owns its image; do not also emit it as a separate illustration.
			for (const q of questions) if (q.kind === "hotspot") {
				for (let i = blocks.length - 1; i >= 0; i--) {
					const b = blocks[i];
					if (b?.kind === "image" && b.src === q.src) blocks.splice(i, 1);
				}
			}
			blocks.push(...questions);
		}
		if (counts.size) losses.push({ at, source: "captivate:interaction", effect: "dropped", detail: `${[...counts].map(([k, n]) => `${n} ${k}${n > 1 ? "s" : ""}`).join(", ")}: actions, states, scoring and timing are not imported` });
		if (str(slide.ea) || str(slide.sea)) losses.push({ at, source: "captivate:slide-action", effect: "dropped", detail: "slide enter/exit actions (advanced actions, variables) are not imported" });
		if (hidden.length) losses.push({ at, source: "captivate:hidden", effect: "approximated", detail: `${hidden.length} objects hidden until an action shows them are imported inline after the visible content: ${hidden.map((h) => `"${h.slice(0, 40)}"`).join(", ").slice(0, 300)}` });
		slideLayout(blocks, heroItems, num(project.w), num(project.h));
		return { title, blocks };
	};

	/** Everything a learner can read, gathered per slide without going through the block mapping. */
	const inventory = (model: J, sid: string, skip: Set<number>) => {
		const slide = obj(model[sid]);
		const push = (s: string) => s.trim() && sourceText.push(s.trim());
		push(str(slide.lb));
		const background = obj(model[str(slide.mdi)]);
		if (imagePath(background) && !chrome.has(imagePath(background))) push(displayAlt(background));
		sourceText.push(...captions(slide));
		let promptItem = false;
		for (const x of items(model, slide, skip)) {
			if (QUIZ_CHROME.has(x.type) || (x.tag.startsWith("slide-item-") && !/^slide-item-(text|image|question-text|answer-|question-caption)/.test(x.tag))) continue;
			if (x.type === 79 || x.tag === "slide-item-question-text") promptItem = true;
			push(str(x.c.aAnsTxtlms) || str(x.c.atxtlms) || plain(x));
			push(str(obj(x.c.accProps).a11yText));
			push(str(x.it.htsptFb));
		}
		const q = obj(model[str(slide.qs)]);
		if (str(q.qtp) && str(q.qtp) !== "InteractiveItemQuestion") {
			if (!promptItem) push(str(q.qt));
			list(q.rsv).forEach(push);
		}
	};

	const slideIds = list(main.slides);
	const pages = slideIds.map((sid, i) => page(data, sid, i, "", skip)).filter((p): p is Page => !!p);
	for (const sid of slideIds) inventory(data, sid, skip);

	const poolsDir = join(root, "pools");
	if (existsSync(poolsDir)) {
		for (const id of readdirSync(poolsDir).sort()) {
			const file = insidePackage(root, `pools/${id}/${id}.js`);
			if (!file) continue;
			const pool = loadModel(file);
			imageCache(root, `pools/${id}`, embedded, losses);
			const poolSkip = variants(pool);
			const ids = Object.keys(pool).filter((k) => /^Slide\d+$/.test(k) && str(obj(pool[k]).st) === "Question Slide").sort((a, b) => num(obj(pool[a]).id) - num(obj(pool[b]).id));
			ids.forEach((sid, i) => {
				const p = page(pool, sid, pages.length + i, `pools/${id}`, poolSkip);
				if (p) pages.push(p);
			});
			for (const sid of ids) inventory(pool, sid, poolSkip);
			if (ids.length) losses.push({ at: `pools/${id}`, source: "captivate:pool", effect: "approximated", detail: `${ids.length} pool questions appended as pages; the random draw into the quiz is not preserved` });
		}
	}

	const version = str(meta.generatorVersion);
	const major = Number(version.split(".")[0]);
	const marketing = { 10: "2017", 11: "2019" }[major];
	const projectName = str(project.pN).replace(/\.cptx?$/i, "").trim();
	const title = str(meta.title).trim() || projectName || "Untitled course";
	const description = str(meta.description).trim();
	if (description) sourceText.unshift(description);
	sourceText.unshift(title);
	const lang = str(obj(data.pref).lang).trim();
	const theme = captivateTheme(data, slides, losses) ?? {};
	theme.density = theme.blockSpacing = "compact";
	if (num(project.w) > 0 && Number.isFinite(num(project.w))) theme.contentWidth = num(project.w);
	return {
		tool: "captivate",
		...(theme ? { theme } : {}),
		...(version ? { toolVersion: `Captivate ${marketing ? `${marketing} ` : ""}${version}` } : {}),
		sourceId: projectName || title,
		title,
		...(description ? { description } : {}),
		...(lang ? { locale: lang } : {}),
		lessons: [{ sourceId: projectName || slideIds[0] || "project", title, pages }],
		embedded,
		losses,
		sourceText,
	};
}
