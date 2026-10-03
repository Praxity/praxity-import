import { createHash } from "node:crypto";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { isFileName, text, unescape } from "./html.ts";
import { insidePackage } from "./input.ts";
import type { Blank, Block, Course, Loss } from "./model.ts";
import { type AssetMap, courseYaml, lesson } from "./prax.ts";
import { convertHls, ffmpegVersion, type HlsSource, hlsSource } from "./media.ts";
import { designYaml } from "./theme.ts";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export function slug(title: string): string {
	const s = title
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40)
		.replace(/-$/, "");
	return s || "lesson";
}

/** Every block, depth first, including container, card and question children. */
export function* walk(blocks: Block[]): Generator<Block> {
	for (const b of blocks) {
		yield b;
		if (b.kind === "container") for (const it of b.items) yield* walk(it.blocks);
		if (b.kind === "cards") for (const c of b.items) yield* walk([...c.front, ...c.back]);
		if (b.kind === "group") yield* walk(b.blocks);
		if (b.kind === "columns") for (const c of b.columns) yield* walk(c);
	}
}

const isLocal = (src: string) => !/^https?:/i.test(src);

/** Embedded files have no disk path to validate with insidePackage. Require plain relative POSIX paths. */
function embeddedAsset(course: Course, src: string): Buffer | undefined {
	if (/^[a-zA-Z]:|[\\\0]/.test(src) || src.split("/").some((part) => !part || part === "." || part === "..")) return undefined;
	return course.embedded?.get(src);
}

/** File types Studio's player plays directly (its direct-video check and audio parser). */
const PLAYABLE = { video: ["mp4", "webm", "ogg", "mov"], audio: ["mp3", "wav", "ogg", "m4a", "flac", "aac"] } as const;
const extension = (src: string) => /\.([a-z0-9]+)$/i.exec(src.split(/[?#]/)[0] ?? "")?.[1]?.toLowerCase() ?? "";
/** Why Studio cannot play a local media file, or undefined when it can. */
function unplayable(kind: "video" | "audio", src: string): string | undefined {
	const ext = extension(src);
	if ((PLAYABLE[kind] as readonly string[]).includes(ext)) return undefined;
	const what = ext === "m3u8" ? "an HLS stream playlist (.m3u8, played from .ts segments)" : ext ? `a .${ext} file` : "a file without a media extension";
	return `${kind} ${src} is ${what}, which Studio cannot play; Studio plays ${PLAYABLE[kind].join(", ")}. Convert it and add it to the lesson`;
}

/** Stable, readable asset name: the package path, minus a leading `assets/`, made path-safe. */
function assetName(src: string, taken: Set<string>): string {
	const clean = posix.normalize(src).replace(/^assets\//, "").split("/").filter((seg) => seg && seg !== "." && seg !== "..").map((seg) => seg.replace(/[^A-Za-z0-9._-]+/g, "-"));
	const base = `assets/${clean.join("/") || "file"}`;
	let name = base;
	for (let i = 2; taken.has(name); i++) name = base.replace(/(\.[^./]*)?$/, `-${i}$1`);
	taken.add(name);
	return name;
}

/**
 * Why Studio would reject a dropdown or word-bank question, or undefined when
 * it is valid: each dropdown needs two distinct choices including a correct
 * one; a bank needs no open blanks, a copy of every primary answer per blank
 * and every alternative.
 */
function selectionProblem(blanks: Blank[], style: "dropdown" | "word-bank", bank: string[]): string | undefined {
	if (!blanks.length) return "no blanks";
	if (style === "dropdown") {
		if (blanks.some((b) => b.answers.some((a) => !b.choices?.includes(a)))) return "a dropdown blank has an accepted answer outside its choices";
		const bad = blanks.find((b) => new Set(b.choices ?? []).size < 2 || !b.answers.some((a) => b.choices?.includes(a)));
		return bad ? "a dropdown blank has fewer than two choices or no correct choice among them" : undefined;
	}
	if (blanks.some((b) => !b.answers.length)) return "a word-bank question has an open blank";
	const left = new Map<string, number>();
	for (const w of bank) left.set(w, (left.get(w) ?? 0) + 1);
	for (const b of blanks) {
		const n = left.get(b.answers[0] as string) ?? 0;
		if (n < 1) return `the word bank lacks a copy of "${b.answers[0]}"`;
		left.set(b.answers[0] as string, n - 1);
	}
	const missing = blanks.flatMap((b) => b.answers.slice(1)).find((a) => !bank.includes(a));
	return missing ? `the word bank lacks the alternative "${missing}"` : undefined;
}

/**
 * Drop blocks whose local file is missing (Studio refuses to export them) and
 * name the rest. Mutates `course` so the report and the files agree.
 */
type Conversion = { at: string; source: HlsSource };

function resolveAssets(course: Course, root: string, convert: boolean, conversions: Map<string, Conversion>): AssetMap {
	const assets: AssetMap = new Map();
	const taken = new Set<string>();
	const present = (src: string) => insidePackage(root, src) !== undefined || embeddedAsset(course, src) !== undefined;
	const keep = (blocks: Block[], at: string): Block[] =>
		blocks.filter((b) => {
			if (b.kind === "container") b.items.forEach((it) => (it.blocks = keep(it.blocks, at)));
			if (b.kind === "cards") b.items.forEach((c) => ((c.front = keep(c.front, at)), (c.back = keep(c.back, at))));
			if (b.kind === "group") b.blocks = keep(b.blocks, at);
			if (b.kind === "columns") b.columns = b.columns.map((c) => keep(c, at));
			if (b.kind === "fillBlank" && b.style) {
				const problem = selectionProblem(b.parts.filter((p): p is Blank => typeof p !== "string"), b.style, b.bank ?? []);
				if (problem) {
					course.losses.push({ at, source: `fill-blank:${b.style}`, effect: "approximated", detail: `${problem}; imported as typed blanks` });
					delete b.style;
					delete b.bank;
				}
			}
			if (b.kind === "video" && b.captions && isLocal(b.captions)) {
				if (present(b.captions)) {
					if (!assets.has(b.captions)) assets.set(b.captions, assetName(b.captions, taken));
				} else {
					course.losses.push({ at, source: `file:${b.captions}`, effect: "dropped", detail: "captions file is missing from the package" });
					delete b.captions;
				}
			}
			if (b.kind === "heading" && b.background) {
				const bg = b.background;
				if (isFileName(bg.alt) || /^["'\u201c\u201d\u2018\u2019\s]*$/.test(bg.alt)) bg.alt = "";
				if (isLocal(bg.src) && !present(bg.src)) {
					course.losses.push({ at, source: `file:${bg.src}`, effect: "dropped", detail: "heading background picture is missing from the package" });
					delete b.background;
				} else {
					if (!bg.alt) course.losses.push({ at, source: `file:${bg.src}`, effect: "approximated", detail: "hero background picture has no alternative text in the source; imported as decorative, review whether it conveys information" });
					if (isLocal(bg.src) && !assets.has(bg.src)) assets.set(bg.src, assetName(bg.src, taken));
				}
			}
			if ((b.kind === "image" || b.kind === "hotspot") && isFileName(b.alt)) b.alt = "";
			if ((b.kind === "video" || b.kind === "audio") && b.title && isFileName(b.title)) delete b.title;
			if (b.kind === "hotspot") {
				if (!b.alt.trim()) {
					b.alt = unescape(text(b.prompt.replace(/\n/g, " ")));
					course.losses.push({ at, source: `file:${b.src}`, effect: "approximated", detail: "hotspot image has no alternative text in the source; the question text is used, review it" });
				}
				if (isLocal(b.src) && !present(b.src)) {
					course.losses.push({ at, source: `file:${b.src}`, effect: "dropped", detail: "hotspot question dropped: its image is missing from the package" });
					return false;
				}
				if (isLocal(b.src) && !assets.has(b.src)) assets.set(b.src, assetName(b.src, taken));
				return true;
			}
			if (b.kind !== "image" && b.kind !== "video" && b.kind !== "audio" && b.kind !== "file") return true;
			if (isLocal(b.src) && !present(b.src)) {
				course.losses.push({ at, source: `file:${b.src}`, effect: "dropped", detail: `${b.kind} file is missing from the package` });
				return false;
			}
			// Copying a format Studio cannot play leaves a broken player that no check notices; say so instead.
			const problem = isLocal(b.src) && (b.kind === "video" || b.kind === "audio") ? unplayable(b.kind, b.src) : undefined;
			if (problem) {
				const hls = b.kind === "video" && extension(b.src) === "m3u8";
				if (hls && convert) {
					const source = ffmpegVersion() ? hlsSource(root, b.src) : "ffmpeg is not on PATH";
					if (typeof source !== "string") {
						// `video.hls/main.m3u8` becomes `video.mp4`; any other playlist keeps its name with .mp4.
						const target = /\.hls\/[^/]+\.m3u8$/i.test(b.src) ? `${posix.dirname(b.src).replace(/\.hls$/i, "")}.mp4` : b.src.replace(/\.m3u8$/i, ".mp4");
						if (!assets.has(b.src)) assets.set(b.src, assetName(target, taken));
						if (!conversions.has(b.src)) conversions.set(b.src, { at, source });
						return true;
					}
					course.losses.push({ at, source: `media:${b.kind}`, effect: "dropped", detail: `${problem}; --convert-media could not convert it: ${source}` });
					return false;
				}
				course.losses.push({ at, source: `media:${b.kind}`, effect: "dropped", detail: hls ? `${problem}, or run the import with --convert-media and ffmpeg installed` : problem });
				return false;
			}
			// Authors sometimes type "" into an alt field to mean "none"; that is empty, not text.
			if (b.kind === "image" && /^["'\u201c\u201d\u2018\u2019\s]*$/.test(b.alt)) b.alt = "";
			if (b.kind === "image" && !b.alt) course.losses.push({ at, source: `file:${b.src}`, effect: "approximated", detail: "image has no alternative text in the source; imported as decorative, review whether it conveys information" });
			if (!isLocal(b.src)) return true;
			if (!assets.has(b.src)) assets.set(b.src, assetName(b.src, taken));
			return true;
		});
	for (const l of course.lessons) l.pages.forEach((p, i) => (p.blocks = keep(p.blocks, `${l.sourceId}/page ${i + 1}`)));
	return assets;
}

/** The course's pass mark: stated by the source, else the one all its assessment groups share. */
function passMark(course: Course): number | undefined {
	if (course.passingScore !== undefined) return course.passingScore;
	const marks = new Set(course.lessons.flatMap((l) => l.pages.flatMap((p) => [...walk(p.blocks)])).flatMap((b) => (b.kind === "group" && b.passingScore !== undefined ? [b.passingScore] : [])));
	return marks.size === 1 ? [...marks][0] : undefined;
}

/** Remove every video block that plays `src`, wherever it is nested. */
function dropVideo(blocks: Block[], src: string): Block[] {
	return blocks.filter((b) => {
		if (b.kind === "container") b.items.forEach((it) => (it.blocks = dropVideo(it.blocks, src)));
		if (b.kind === "cards") b.items.forEach((c) => ((c.front = dropVideo(c.front, src)), (c.back = dropVideo(c.back, src))));
		if (b.kind === "group") b.blocks = dropVideo(b.blocks, src);
		if (b.kind === "columns") b.columns = b.columns.map((c) => dropVideo(c, src));
		return !(b.kind === "video" && b.src === src);
	});
}

export type Written = {
	outputPath: string;
	courseId: string;
	lessons: Array<{ file: string; id: string; title: string; pages: number; blocks: number }>;
	assets: number;
	losses: Loss[];
	/** The LMS pass threshold written to praxity.json, in percent. */
	passingScore?: number;
	/** ffmpeg's version line when --convert-media converted any file. */
	mediaConverter?: string;
};

export async function writeProject(course: Course, root: string, out: string, opts: { convertMedia?: boolean } = {}): Promise<Written> {
	const conversions = new Map<string, Conversion>();
	const assets = resolveAssets(course, root, opts.convertMedia === true, conversions);
	// Conversions run before lessons are written, so a failed one can still leave its block out.
	let converted = 0;
	for (const [src, { at, source }] of [...conversions].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const name = assets.get(src)!;
		await mkdir(join(out, name, ".."), { recursive: true });
		try {
			await convertHls(root, source, join(out, name));
			converted++;
			course.losses.push({ at, source: "media:converted", effect: "approximated", detail: `HLS stream ${src} converted to ${name}: the highest-bandwidth variant${source.resolution ? ` (${source.resolution})` : ""}${source.audio ? " with its default audio" : ""}, streams copied without re-encoding; other bitrates are not kept` });
		} catch (e) {
			await rm(join(out, name), { force: true });
			assets.delete(src);
			for (const l of course.lessons) for (const p of l.pages) p.blocks = dropVideo(p.blocks, src);
			const why = String((e as { stderr?: string }).stderr || (e as Error).message).trim().split("\n")[0];
			course.losses.push({ at, source: "media:video", effect: "dropped", detail: `video ${src} is an HLS stream Studio cannot play, and ffmpeg could not convert it: ${why}` });
		}
	}
	// The logo goes through the same package-boundary and naming rules as any other asset.
	let logo: string | undefined;
	const logoSrc = course.theme?.logo;
	if (logoSrc && isLocal(logoSrc)) {
		if (insidePackage(root, logoSrc) || embeddedAsset(course, logoSrc) !== undefined) {
			logo = assets.get(logoSrc) ?? assetName(logoSrc, new Set(assets.values()));
			assets.set(logoSrc, logo);
		} else course.losses.push({ at: "theme", source: `file:${logoSrc}`, effect: "dropped", detail: "logo file is missing from the package" });
	}
	const bands = course.lessons.some((l) => l.pages.some((p) => [...walk(p.blocks)].some((b) => b.kind === "divider" && b.tone !== undefined && b.tone !== "light")));
	const design = designYaml(course.theme ?? {}, logo, (loss) => course.losses.push(loss), bands);
	const courseId = `import-${hash(`${course.tool}\n${course.sourceId}`).slice(0, 24)}`;
	await mkdir(out, { recursive: true });
	const lessons: Written["lessons"] = [];
	const lang = course.locale;
	for (const [i, l] of course.lessons.entries()) {
		const file = `${String(i + 1).padStart(2, "0")}-${slug(l.title)}.prax`;
		const id = `lesson-${hash(`${course.sourceId}\n${l.sourceId}`).slice(0, 24)}`;
		await writeFile(join(out, file), lesson(l, id, lang, assets, course.theme?.format === "slides"));
		const blocks = l.pages.reduce((n, p) => n + [...walk(p.blocks)].length, 0);
		lessons.push({ file, id, title: l.title, pages: l.pages.length, blocks });
	}
	await writeFile(join(out, "course.yaml"), courseYaml(course, courseId, lessons.map((l) => l.file), design));
	for (const [src, name] of [...assets].sort(([a], [b]) => (a < b ? -1 : 1))) {
		if (conversions.has(src)) continue;
		await mkdir(join(out, name, ".."), { recursive: true });
		const file = insidePackage(root, src);
		if (file) await copyFile(file, join(out, name));
		else await writeFile(join(out, name), embeddedAsset(course, src)!);
	}
	// Studio judges pass/fail against praxity.json's export.passingScore (a fraction). The rest is Studio's own
	// new-project default, so the pass mark is the only change; completionThreshold stays a share of pages.
	const pass = passMark(course);
	if (pass !== undefined && pass > 0 && pass <= 100) await writeFile(join(out, "praxity.json"), `${JSON.stringify({ version: 1, export: { format: "scorm-1.2", completionThreshold: 0.8, requireKnowledgeChecks: false, passingScore: pass / 100 } }, null, "\t")}\n`);
	const converter = converted ? ffmpegVersion() : undefined;
	return { outputPath: out, courseId, lessons, assets: assets.size, losses: course.losses, ...(pass !== undefined ? { passingScore: pass } : {}), ...(converter ? { mediaConverter: converter } : {}) };
}
