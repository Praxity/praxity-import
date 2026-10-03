import { insidePackage } from "../input.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { blocks as htmlBlocks, inline, line, neutralize, text } from "../html.ts";
import type { Block, Course, Item, Lesson, Loss, Page } from "../model.ts";
import { walk } from "../write.ts";
import { extractStoryline } from "./storyline.ts";

/* Rise JSON is untyped vendor data; these readers narrow it field by field. */
type J = Record<string, unknown>;
const obj = (v: unknown): J => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : {});
const arr = (v: unknown): J[] => (Array.isArray(v) ? v.map(obj) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** Base64 course JSON, from whichever of Rise's three export layouts is present. */
function loadCourse(root: string, dir: string): J {
	const file = (f: string) => join(root, dir, f);
	const index = existsSync(file("index.html")) ? readFileSync(file("index.html"), "utf8") : "";
	const candidates: string[] = [];
	const defaultLocale = /"default"\s*:\s*"([^"]+)"/.exec(index)?.[1];
	if (existsSync(file("locales"))) {
		const locales = readdirSync(file("locales")).filter((f) => f.endsWith(".js")).sort();
		const first = defaultLocale && locales.includes(`${defaultLocale}.js`) ? `${defaultLocale}.js` : locales[0];
		if (first) candidates.push(readFileSync(file(`locales/${first}`), "utf8"));
	}
	if (existsSync(file("runtime-data.js"))) candidates.push(readFileSync(file("runtime-data.js"), "utf8"));
	candidates.push(index);
	for (const src of candidates) {
		const literals = [...src.matchAll(/["']([A-Za-z0-9+/=]{200,})["']/g)].map((m) => m[1] ?? "").sort((a, b) => b.length - a.length);
		for (const b64 of literals) {
			try {
				const data = obj(JSON.parse(Buffer.from(b64, "base64").toString("utf8")));
				if (obj(data.course).lessons) return data;
			} catch {
				/* not the course payload; try the next literal */
			}
		}
	}
	throw new Error("Rise package found, but its course data could not be decoded");
}

/** Visible strings in a Rise node, for coverage. Skips hidden items and UI-chrome fields. */
const TEXT_KEYS = new Set(["title", "heading", "paragraph", "description", "caption", "name", "feedback", "feedbackCorrect", "feedbackIncorrect", "matchTitle", "alt", "label", "text"]);
function inventory(node: unknown, out: string[], family = ""): void {
	if (Array.isArray(node)) return node.forEach((n) => inventory(n, out, family));
	if (!node || typeof node !== "object") return;
	const o = node as J;
	if (o.isHidden === true || o.deleted === true) return;
	const fam = str(o.family) || family;
	for (const [k, v] of Object.entries(o)) {
		if (typeof v === "string" && TEXT_KEYS.has(k) && fam !== "continue") {
			const t = text(v);
			if (t) out.push(t);
		} else if (v && typeof v === "object" && !["settings", "theme", "dimensions", "poses", "character"].includes(k)) inventory(v, out, fam);
	}
}

export function extractRise(root: string, dir: string): Course {
	const data = loadCourse(root, dir);
	const course = obj(data.course);
	const losses: Loss[] = [];
	const assetDir = posix.join(dir, "assets");

	/** First of a media record's names that exists under assets/, trying each raw and URL-decoded. */
	const local = (f: J, keys: string[]): string | undefined => {
		const names = keys
			.map((k) => str(f[k]))
			.filter((n) => n && !/^https?:/.test(n))
			.flatMap((n) => [n, posix.basename(n)])
			.flatMap((n) => {
				try {
					return [n, decodeURIComponent(n)];
				} catch {
					return [n];
				}
			});
		return names.map((n) => posix.join(assetDir, n)).find((p) => existsSync(join(root, p))) ?? (names[0] ? posix.join(assetDir, names[0]) : undefined);
	};
	const NAMES = ["crushedKey", "src", "url", "key", "filename", "originalUrl"];

	const mediaBlocks = (media: unknown, caption?: string): Block[] => {
		const m = obj(media);
		const cap = caption ? line(caption) : "";
		const embed = obj(m.embed);
		if (str(embed.src) || str(embed.url)) {
			let url = str(embed.originalUrl) || str(embed.url) || str(embed.src);
			if (url.startsWith("//")) url = `https:${url}`;
			const wrapped = /[?&]url=([^&]+)/.exec(url)?.[1];
			const src = wrapped ? decodeURIComponent(wrapped) : url;
			const title = str(embed.title);
			return /youtube|youtu\.be|vimeo|loom|wistia/i.test(src) ? [{ kind: "video", src, ...(title ? { title } : {}), ...(cap ? { caption: cap } : {}) }] : [{ kind: "embed", url: src }];
		}
		const image = obj(m.image);
		if (Object.keys(image).length) {
			const src = local(image, NAMES);
			return src ? [{ kind: "image", src, alt: str(image.alt), ...(cap ? { caption: cap } : {}) }] : [];
		}
		const video = obj(m.video);
		const custom = obj(m.customVideo);
		if (Object.keys(video).length || Object.keys(custom).length) {
			const src = (Object.keys(video).length ? local(video, NAMES) : undefined) ?? local(custom, ["src"]);
			const subtitle = str(custom.subtitle) || str(video.subtitle) || str(video.captions);
			const captions = subtitle ? local({ subtitle }, ["subtitle"]) : undefined;
			return src ? [{ kind: "video", src, ...(cap ? { caption: cap } : {}), ...(captions ? { captions } : {}) }] : [];
		}
		const audio = obj(m.audio);
		if (Object.keys(audio).length) {
			const src = local(audio, NAMES);
			return src ? [{ kind: "audio", src }] : [];
		}
		const file = obj(m.attachment);
		if (Object.keys(file).length) {
			const src = local(file, ["key", "filename", "originalUrl"]);
			const label = neutralize(str(file.originalUrl) || posix.basename(str(file.key)) || "Download");
			return src ? [{ kind: "file", src, label }] : [];
		}
		return [];
	};

	const ctx = { base: dir };
	const rich = (html: unknown) => htmlBlocks(str(html), ctx);

	/** One Rise block, as prax blocks. `at` locates losses. */
	const convert = (b: J, at: string): Block[] => {
		const type = str(b.type);
		const variant = str(b.variant);
		const family = str(b.family);
		const items = arr(b.items);
		const lose = (effect: Loss["effect"], detail: string) => losses.push({ at, source: `rise:${type}/${variant || family}`, effect, detail });

		switch (type) {
			case "text": {
				if (family === "impact" && variant === "note") return items.map((i) => ({ kind: "note", text: inline(str(i.paragraph)) }) as Block).filter((n) => n.kind === "note" && n.text);
				const itemBlocks = (i: J): Block[] => {
					const h = line(str(i.heading));
					const level = variant.startsWith("subheading") ? 3 : 2;
					return [...(h ? [{ kind: "heading", level, text: h } as Block] : []), ...rich(i.paragraph), ...(i.table ? tableOf(i.table) : [])];
				};
				if (variant === "two column" || variant === "three column") return [{ kind: "columns", columns: items.map(itemBlocks) }];
				return items.flatMap(itemBlocks);
			}
			case "statement":
				return items.flatMap((i) => rich(i.paragraph));
			case "quote":
				return items.flatMap((i) => {
					const q = inline(str(i.paragraph));
					const speaker = text(str(i.name));
					const centered = ["a", "b", "c", "d", "centered", "centred", "avatar"].includes(variant);
					const style = variant === "background" ? "shaded" : centered ? "none" : undefined;
					// Studio's smallest image is far larger than Rise's round speaker avatar, so the avatar is left out.
					if (Object.keys(obj(obj(i.avatar).media)).length) lose("dropped", "quote speaker avatar not shown; the speaker name is kept");
					if (variant === "background" && Object.keys(obj(obj(i.background).media)).length) lose("approximated", "quote background image replaced by a shaded quote");
					return [...(q ? [{ kind: "quote", text: q, ...(speaker ? { speaker } : {}), ...(style ? { style } : {}) } as Block] : [])];
				});
			case "list": {
				const listItems = items.map((i) => line(str(i.paragraph))).filter(Boolean);
				if (variant === "checkboxes") lose("approximated", "checkbox list imported as a plain list");
				return listItems.length ? [{ kind: "list", ordered: variant === "numbered", items: listItems }] : [];
			}
			case "image": {
				// Rise's image blocks are layouts: full-bleed hero/full, a centred image, or an image beside text.
				const layout: "full" | "large" | undefined = variant === "full" || variant === "hero" ? "full" : variant === "centered" ? "large" : undefined;
				return items.flatMap((i) => {
					const pics = mediaBlocks(i.media, str(i.caption)).map((m) => (m.kind === "image" ? { ...m, ...(layout ? { layout } : variant === "text aside" ? { layout: "medium" as const } : {}) } : m));
					const words = rich(i.paragraph);
					if (variant === "text aside" && pics.length && words.length) return [{ kind: "columns", columns: [pics, words] } as Block];
					return [...pics, ...words];
				});
			}
			case "gallery":
				return items.flatMap((i) => mediaBlocks(i.media, str(i.caption)));
			case "multimedia": {
				if (variant === "code") return items.flatMap((i) => (str(i.code) ? [{ kind: "code", text: str(i.code), ...(str(i.language) ? { lang: str(i.language) } : {}) } as Block] : []));
				return items.flatMap((i) => [...mediaBlocks(i.media, str(i.caption)), ...rich(i.description)]);
			}
			case "divider":
				return [{ kind: "divider" }];
			case "chart": {
				// Rise charts are one labelled series; Studio draws bar and line charts from a two-column table.
				const rows = items.map((i) => [line(str(i.type)), neutralize(str(i.value))]);
				if (!rows.length) return [];
				if (variant !== "bar" && variant !== "line") lose("approximated", `${variant || "unknown"} chart shown as a bar chart; its colours are not kept`);
				const title = line(str(b.title));
				return [...(title ? [{ kind: "heading", level: 3, text: title } as Block] : []), { kind: "table", rows: [[line(str(b.itemsLabel)) || "Item", line(str(b.valuesLabel)) || "Value"], ...rows], chart: variant === "line" ? "line" : "bar" }];
			}
			case "knowledgeCheck":
				return items.flatMap((q) => question(q, at));
			case "interactive":
				return interactive(b, at, lose);
			default:
				lose("dropped", `unrecognised Rise block type "${type}"`);
				return [];
		}
	};

	const tableOf = (t: unknown): Block[] => {
		const rows = arr(obj(t).rows ?? t).map((r) => arr(r.cells ?? r).map((c) => line(str(c.value ?? c.text ?? c))));
		return rows.length ? [{ kind: "table", rows }] : [];
	};

	/** Rise keeps a default image on text-only card faces; only image faces show it. */
	const face = (f: unknown): Block[] => {
		const o = obj(f);
		const showsMedia = /image/i.test(str(o.type)) || (!str(o.type) && !text(str(o.description)));
		return [...(showsMedia ? mediaBlocks(o.media) : []), ...rich(o.description)];
	};

	const itemBlocks = (i: J): Block[] => [...mediaBlocks(i.media), ...rich(i.description ?? i.paragraph)];

	const interactive = (b: J, at: string, lose: (e: Loss["effect"], d: string) => void): Block[] => {
		// Rise spells some variants with and without spaces across versions ("labeled graphic", "labeledgraphic").
		const variant = str(b.variant).replace(/\s+/g, "");
		const items = arr(b.items).filter((i) => i.isHidden !== true);
		switch (str(b.family) === "flashcard" ? "flashcard" : variant) {
			case "accordion":
			case "tabs":
				return [{ kind: "container", as: variant === "tabs" ? "tab" : "accordion", items: items.map((i) => ({ title: line(str(i.title)) || "Untitled", blocks: itemBlocks(i) })) }];
			case "process":
			case "timeline": {
				// Rise shows a process's introduction first and its summary last, whatever the stored order.
				const rank = (i: J) => (str(i.type) === "intro" ? 0 : str(i.type) === "summary" ? 2 : 1);
				const steps: Item[] = [...items].sort((a, b) => rank(a) - rank(b)).map((i, n) => ({ title: [line(str(i.date)), line(str(i.title))].filter(Boolean).join(": ") || `Step ${n + 1}`, blocks: itemBlocks(i) }));
				// A process is a carousel of step cards in Rise; Studio's slide-layout cards are the closest match.
				if (variant === "process") return [{ kind: "cards", items: steps.map((s) => ({ title: s.title, front: s.blocks, back: [] })) }];
				return [{ kind: "container", as: "sequence", items: steps }];
			}
			case "flashcard":
				return [{ kind: "cards", items: items.map((i, n) => ({ title: `Card ${n + 1}`, front: face(i.front), back: face(i.back) })) }];
			case "sorting": {
				const piles = arr(b.piles);
				return [{ kind: "categorize", prompt: "Sort each item into the correct category.", categories: piles.map((p) => ({ name: line(str(p.title)), items: items.filter((i) => str(i.pileId) === str(p.id)).map((i) => line(str(i.title))) })) }];
			}
			case "labeledgraphic": {
				lose("approximated", "labeled graphic markers imported as an accordion after the image; marker positions are not kept");
				const markers = items.flatMap((i) => (arr(i.markers).length ? arr(i.markers) : [i]));
				const images = [b, ...items].flatMap((i) => mediaBlocks(i.media));
				return [...images, { kind: "container", as: "accordion", items: markers.map((m, n) => ({ title: line(str(m.title)) || `Marker ${n + 1}`, blocks: itemBlocks(m) })) }];
			}
			case "scenario": {
				lose("approximated", "branching scenario flattened into a sequence of scenes; branching and try-again logic are not imported");
				const scenes: Item[] = [];
				for (const scene of items)
					for (const slide of arr(scene.slides)) {
						const body = rich(slide.description);
						const responses = arr(slide.responses);
						if (responses.length) body.push({ kind: "list", ordered: false, items: responses.map((r) => [line(str(r.description)), line(str(r.feedback))].filter(Boolean).join(" — ")) });
						scenes.push({ title: line(str(slide.title)) || line(str(scene.title)) || `Scene ${scenes.length + 1}`, blocks: body });
					}
				return scenes.length ? [{ kind: "container", as: "sequence", items: scenes }] : [];
			}
			case "button":
			case "buttonstack":
				return items.flatMap((i) => {
					const url = str(i.destination) || str(i.url) || str(i.link);
					const label = line(str(i.label) || str(i.buttonText) || str(i.title));
					const desc = rich(i.description);
					return /^(https?:|mailto:)/.test(url) && label ? [...desc, { kind: "paragraph", text: `[${label.replace(/[[\]]/g, "")}](${url.replace(/[()\s]/g, encodeURIComponent)})` } as Block] : desc;
				});
			case "storyline": {
				// Reached only when the story is not in the package; see `embedded`.
				const story = obj(obj(obj(items[0]).media).storyline);
				lose("dropped", `embedded Storyline interaction "${str(story.title)}" is not in the package (${str(story.src)})`);
				return [];
			}
			default:
				lose("dropped", `unrecognised interactive variant "${str(b.variant)}"`);
				return [];
		}
	};


	const question = (q: J, at: string): Block[] => {
		const type = str(q.type);
		const answers = arr(q.answers);
		const prompt = inline(str(q.title));
		const pre = mediaBlocks(q.media);
		const corrects = new Set([str(q.correct), ...(Array.isArray(q.corrects) ? q.corrects.map(str) : [])].filter(Boolean));
		const isCorrect = (a: J) => a.correct === true || corrects.has(str(a.id));
		const fb = { ...(str(q.feedbackCorrect) ? { correct: line(str(q.feedbackCorrect)) } : {}), ...(str(q.feedbackIncorrect) ? { incorrect: line(str(q.feedbackIncorrect)) } : {}) };
		switch (type) {
			case "MULTIPLE_CHOICE":
			case "MULTIPLE_RESPONSE": {
				const options = answers.map((a) => ({ text: line(str(a.title)), correct: isCorrect(a), ...(str(a.feedback) ? { feedback: line(str(a.feedback)) } : {}) }));
				if (!options.some((o) => o.correct)) losses.push({ at, source: `rise:question/${type}`, effect: "approximated", detail: "no correct answer found in the package; imported with none marked" });
				return [...pre, { kind: "choice", prompt, multiple: type === "MULTIPLE_RESPONSE", options, ...fb }];
			}
			case "MATCHING":
				return [...pre, { kind: "match", prompt, pairs: answers.map((a) => [line(str(a.title)), line(str(a.matchTitle))] as [string, string]), ...fb }];
			case "FILL_IN_THE_BLANK": {
				const accepted = answers.map((a) => text(str(a.title))).filter(Boolean);
				const stemText = text(str(q.title));
				const blank = /_{3,}/.exec(stemText);
				const gap = { answers: accepted };
				const parts = blank ? [stemText.slice(0, blank.index), gap, stemText.slice(blank.index + blank[0].length)] : [`${stemText} `, gap];
				return [...pre, { kind: "fillBlank", prompt: "Complete the sentence.", parts, ...fb }];
			}
			case "ORDERING":
			case "SEQUENCE":
				return [...pre, { kind: "order", prompt, items: answers.map((a) => line(str(a.title))) }];
			default:
				losses.push({ at, source: `rise:question/${type}`, effect: "dropped", detail: `unrecognised question type "${type}"` });
				return [];
		}
	};

	/**
	 * A Storyline interaction embedded in a Rise lesson, when its published
	 * story ships in the package: its slides become pages at the block's place.
	 */
	const embeddedText: string[] = [];
	const embedded = (b: J, at: string): Page[] | undefined => {
		if (str(b.variant) !== "storyline") return undefined;
		const story = obj(obj(obj(arr(b.items)[0]).media).storyline);
		const base = posix.join(assetDir, posix.dirname(str(story.src)));
		if (!str(story.src) || !insidePackage(root, posix.join(base, "html5/data/js/data.js"))) return undefined;
		const sub = extractStoryline(join(root, base));
		const rebase = (src: string) => (/^https?:/i.test(src) ? src : posix.join(base, src));
		const pages = sub.lessons.flatMap((l) => l.pages);
		for (const p of pages)
			for (const blk of walk(p.blocks)) {
				if (blk.kind === "image" || blk.kind === "audio" || blk.kind === "file") blk.src = rebase(blk.src);
				if (blk.kind === "heading" && blk.background) blk.background.src = rebase(blk.background.src);
				if (blk.kind === "video") {
					blk.src = rebase(blk.src);
					if (blk.captions) blk.captions = rebase(blk.captions);
				}
			}
		losses.push({ at, source: "rise:interactive/storyline", effect: "approximated", detail: `embedded Storyline interaction "${str(story.title)}" imported as ${pages.length} page(s) in place of the block` }, ...sub.losses.map((l) => ({ ...l, at: `${at}/${l.at}` })));
		embeddedText.push(...sub.sourceText);
		return pages;
	};

	const lessons: Lesson[] = [];
	// Rise records the course title over its cover image; descriptions retain their block structure.
	const coverTheme = obj(course.theme);
	if (coverTheme.hideCoverPage !== true) {
		const cover = mediaBlocks(obj(course.coverImage).media);
		const description = rich(course.description);
		const image = cover.find((b) => b.kind === "image");
		const heading: Block = { kind: "heading", level: 1, text: line(str(course.title)) || "Course", ...(image ? { background: { src: image.src, alt: image.alt } } : {}) };
		if (cover.length || description.length) lessons.push({ sourceId: `${str(course.id)}-cover`, title: text(str(course.title)) || "Course", pages: [{ blocks: [heading, ...cover.filter((b) => b !== image), ...description] }] });
	}
	for (const l of arr(course.lessons)) {
		if (l.deleted === true) continue;
		const title = text(str(l.title)) || text(str(course.title)) || `Lesson ${lessons.length + 1}`;
		const at = `lesson ${str(l.id)}`;
		if (str(l.type) === "section") {
			losses.push({ at, source: "rise:section", effect: "approximated", detail: `section heading "${title}" is not a Studio construct; its lessons follow in order` });
			continue;
		}
		const pages: Page[] = [{ blocks: [{ kind: "heading", level: 1, text: line(str(l.title)) || neutralize(title) }, ...rich(l.description)] }];
		const itemsList = arr(l.items);
		if (str(l.type) === "quiz") {
			const settings = obj(l.settings);
			const pass = Number(str(settings.passingScore));
			// Studio's exported groups ignore quiz-order shuffle and quiz attempts, even though inspect preserves them.
			// requireAll only requires answers before submission; deckGate only governs slide decks.
			// Zero retries already matches Studio's single submission; Rise uses -1 for unlimited retries.
			const unsupported = [settings.randomizeQuestionOrder === true && "random question order", Number(settings.retryCount) === -1 && "unlimited quiz retries", Number(settings.retryCount) > 0 && `a limit of ${str(settings.retryCount)} retries`, settings.passToContinue === true && "passing to continue"].filter(Boolean);
			if (unsupported.length) losses.push({ at, source: "rise:quiz", effect: "approximated", detail: `quiz settings not carried over: ${unsupported.join(", ")}` });
			const members = [...rich(l.description), ...itemsList.flatMap((q) => question(q, `${at}/${str(q.id)}`))];
			pages[0] = { blocks: [{ kind: "group", title: line(str(l.title)) || neutralize(title), ...(str(settings.passingScore) !== "" && Number.isFinite(pass) ? { passingScore: pass } : {}), ...(settings.shuffleAnswerChoices === true ? { shuffle: true } : {}), blocks: members }] };
		} else {
			// Rise colours whole blocks (accent, tint, dark); runs of the same colour become one Studio section band.
			let band: "light" | "dark" | "accent" | "cool" = "light";
			for (const b of itemsList) {
				const story = embedded(b, `${at}/${str(b.id)}`);
				if (story) {
					pages.push(...story, { blocks: [] });
					band = "light";
					continue;
				}
				const out = convert(b, `${at}/${str(b.id)}`);
				// A Rise "continue" divider gates the rest of the lesson: the nearest Studio construct is a new page.
				if (str(b.type) === "divider" && str(b.variant) === "continue") {
					pages.push({ blocks: [] });
					band = "light";
					continue;
				}
				const kind = str(obj(b.settings).backgroundType).toUpperCase();
				const tone = kind === "ACCENT" ? "accent" : kind === "DARK" ? "dark" : kind === "TINT" ? "cool" : "light";
				const page = pages.at(-1) as Page;
				if (out.length && tone !== band) {
					page.blocks.push({ kind: "divider", tone });
					band = tone;
				}
				page.blocks.push(...out);
			}
		}
		const kept = pages.filter((p, i) => i === 0 || p.blocks.length);
		lessons.push({ sourceId: str(l.id), title, pages: kept });
	}

	const sourceText: string[] = [];
	const heading = text(str(course.title));
	if (heading) sourceText.push(heading);
	if (text(str(course.description))) sourceText.push(text(str(course.description)));
	inventory(arr(course.lessons), sourceText);
	sourceText.push(...embeddedText);

	const theme = obj(course.theme);
	const corners = str(theme.blockCorners).toUpperCase();
	if (str(theme.coverPageType) || str(theme.lessonHeaderImage) || str(theme.navigationOverlayImage)) losses.push({ at: "theme", source: "rise:theme", effect: "approximated", detail: "cover page and lesson header styling (cover layout, header and navigation background images) have no Studio equivalent" });

	return {
		tool: "rise",
		theme: {
			// Rise always sets lesson content on white.
			background: "#ffffff",
			density: "comfortable",
			...(typeof theme.contentWidth === "number" && Number.isFinite(theme.contentWidth) && theme.contentWidth > 0 ? { contentWidth: theme.contentWidth } : {}),
			...(str(theme.colorAccent) || str(course.color) ? { accent: str(theme.colorAccent) || str(course.color) } : {}),
			...(str(course.headingTypeface) ? { headingFont: str(course.headingTypeface) } : {}),
			...(str(course.bodyTypeface) ? { bodyFont: str(course.bodyTypeface) } : {}),
			...(corners === "ROUNDED" ? { corners: 8 } : corners === "SQUARE" ? { corners: 0 } : {}),
			...(str(theme.navigationType).toUpperCase() === "SIDEBAR" ? { navigation: "sidebar" as const } : {}),
		},
		sourceId: str(course.id) || heading,
		title: heading || "Untitled course",
		...(text(str(course.description)) ? { description: text(str(course.description)) } : {}),
		...(str(course.locale) || str(obj(data.labelSet).iso639Code) ? { locale: str(course.locale) || str(obj(data.labelSet).iso639Code) } : {}),
		lessons,
		losses,
		sourceText,
	};
}
