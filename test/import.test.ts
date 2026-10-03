import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { blocks, inline } from "../src/html.ts";
import { importPackage } from "../src/import.ts";
import { extractRise } from "../src/extract/rise.ts";
import { escapeLines } from "../src/prax.ts";
import { coverage } from "../src/verify.ts";
import { parseXml, textOf, find } from "../src/xml.ts";
import type { Block } from "../src/model.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "praxity-import-test-"));

function risePackage(): string {
	const dir = tmp();
	const course = {
		course: {
			id: "c1",
			title: "Safety <b>basics</b>",
			lessons: [
				{
					id: "l1",
					type: "blocks",
					title: "Hazards",
					items: [
						{ id: "b1", type: "text", family: "text", variant: "heading paragraph", items: [{ heading: "<p><strong>Why it matters</strong></p>", paragraph: "<p>Wear <em>gloves</em> at 3 * 4 sites.</p><p>Tip: check twice.</p>" }] },
						{ id: "b2", type: "image", family: "image", variant: "full", items: [{ media: { image: { key: "x/hazard.png", crushedKey: "hazard.png", alt: "Wet floor sign" } }, caption: "<p>Mind the floor</p>" }] },
						{ id: "b3", type: "divider", family: "continue", variant: "continue", items: [{ title: "CONTINUE" }] },
						{ id: "b4", type: "interactive", family: "interactive", variant: "accordion", items: [{ title: "Gloves", description: "<p>Nitrile.</p>" }, { title: "Boots", description: "<p>Steel toe.</p>" }] },
						{ id: "b5", type: "knowledgeCheck", family: "knowledgeCheck", variant: "multiple choice", items: [{ type: "MULTIPLE_CHOICE", title: "<p>Which is PPE?</p>", answers: [{ id: "a", title: "Gloves", correct: true, feedback: "Yes" }, { id: "b", title: "Coffee", correct: false }] }] },
						{ id: "b6", type: "interactive", family: "interactive-fullscreen", variant: "scenario", items: [] },
					],
				},
			],
		},
		labelSet: { iso639Code: "en" },
	};
	const b64 = Buffer.from(JSON.stringify(course)).toString("base64");
	mkdirSync(join(dir, "lib/rise"), { recursive: true });
	mkdirSync(join(dir, "locales"));
	mkdirSync(join(dir, "assets"));
	writeFileSync(join(dir, "index.html"), `<script>window.i18n = {"available":["und"],"default":"und"};</script>`);
	writeFileSync(join(dir, "locales/und.js"), `window.__resolveJsonp("course:und", "${b64}")`);
	writeFileSync(join(dir, "assets/hazard.png"), "png");
	return dir;
}

test("imports a Rise export into a Studio course folder", async () => {
	const out = join(tmp(), "course");
	const report = await importPackage(risePackage(), out);
	assert.equal(report.detected.tool, "rise");
	assert.deepEqual(readdirSync(out).sort(), ["01-hazards.prax", "assets", "course.yaml", "import-report.json"]);
	const prax = readFileSync(join(out, "01-hazards.prax"), "utf8");
	assert.match(prax, /^## Why it matters$/m, "whole-heading bold is dropped");
	assert.match(prax, /Wear \*gloves\* at 3 \\\* 4 sites\./, "literal asterisk is escaped, not emphasis");
	assert.match(prax, /^\\Tip: check twice\.$/m, "a key-like line is escaped");
	assert.match(prax, /^\/assets\/hazard\.png\nalt: Wet floor sign\ncaption: Mind the floor$/m);
	assert.match(prax, /^--- $|^---$/m, "the continue divider starts a new page");
	assert.match(prax, /^## Gloves\nas: accordion\n\nNitrile\.\n\n## Boots\n\nSteel toe\.\n\nclose: accordion$/m);
	assert.match(prax, /^\(x\) Gloves\nfeedback: Yes\n\( \) Coffee$/m);
	assert.ok(report.losses.some((l) => l.source === "rise:interactive/scenario"), "unmappable blocks are reported, not hidden");
	assert.match(readFileSync(join(out, "course.yaml"), "utf8"), /^title: "Safety basics"$/m);
});

test("Rise process becomes slide cards: introduction, steps, then summary; a pie chart becomes a bar chart table", () => {
	const root = risePackage();
	const course = { id: "c2", title: "T", lessons: [{ id: "l", type: "blocks", title: "L", items: [
		{ id: "p", type: "interactive", family: "interactive-fullscreen", variant: "process", items: [{ type: "intro", title: "Start" }, { type: "summary", title: "End" }, { type: "step", title: "One" }, { type: "step", title: "Two" }] },
		{ id: "c", type: "chart", family: "chart", variant: "pie", title: "Share", items: [{ type: "Yes", value: "70" }, { type: "No", value: "30" }], itemsLabel: "", valuesLabel: "" },
	] }], theme: { hideCoverPage: true } };
	writeFileSync(join(root, "locales/und.js"), `window.__resolveJsonp("course:und", "${Buffer.from(JSON.stringify({ course })).toString("base64")}")`);
	const result = extractRise(root, "");
	const blocks = result.lessons[0]!.pages[0]!.blocks;
	const process = blocks.find((b) => b.kind === "cards");
	assert.deepEqual(process?.kind === "cards" ? process.items.map((i) => i.title) : [], ["Start", "One", "Two", "End"]);
	const chart = blocks.findIndex((b) => b.kind === "table");
	assert.deepEqual(blocks.slice(chart - 1, chart + 1), [{ kind: "heading", level: 3, text: "Share" }, { kind: "table", rows: [["Item", "Value"], ["Yes", "70"], ["No", "30"]], chart: "bar" }]);
	assert.ok(result.losses.some((l) => l.source === "rise:chart/pie" && l.effect === "approximated"));
});

test("video and audio Studio cannot play are dropped with a media loss, not copied", async () => {
	const root = risePackage();
	mkdirSync(join(root, "assets/clip.hls"), { recursive: true });
	for (const f of ["assets/clip.hls/main.m3u8", "assets/clip.hls/stream_0.m3u8", "assets/clip.mp4", "assets/old.flv", "assets/tone.mp3"]) writeFileSync(join(root, f), "x");
	const course = { id: "m", title: "Media", lessons: [{ id: "l", type: "blocks", title: "L", items: [
		{ id: "v1", type: "multimedia", family: "multimedia", variant: "video", items: [{ media: { video: { key: "clip.hls/main.m3u8" } } }] },
		{ id: "v2", type: "multimedia", family: "multimedia", variant: "video", items: [{ media: { video: { key: "clip.mp4" } } }] },
		{ id: "v3", type: "multimedia", family: "multimedia", variant: "video", items: [{ media: { video: { key: "old.flv" } } }] },
		{ id: "a1", type: "multimedia", family: "multimedia", variant: "audio", items: [{ media: { audio: { key: "tone.mp3" } } }] },
	] }], theme: { hideCoverPage: true } };
	writeFileSync(join(root, "locales/und.js"), `window.__resolveJsonp("course:und", "${Buffer.from(JSON.stringify({ course })).toString("base64")}")`);
	const out = join(tmp(), "media");
	const report = await importPackage(root, out);
	const media = report.losses.filter((l) => l.source.startsWith("media:"));
	assert.deepEqual(media.map((l) => [l.source, l.effect]), [["media:video", "dropped"], ["media:video", "dropped"]]);
	assert.match(media[0]!.detail, /HLS stream playlist/);
	assert.match(media[1]!.detail, /a \.flv file/);
	const prax = readFileSync(join(out, report.lessons[0]!.file), "utf8");
	assert.doesNotMatch(prax, /m3u8|\.flv/);
	assert.match(prax, /clip\.mp4/);
	assert.match(prax, /tone\.mp3/);
	assert.ok(!existsSync(join(out, "assets/clip.hls")), "unplayable files are not copied");
});

test("adjacent column rows are each closed, so Studio keeps them as separate rows", async () => {
	const { lesson } = await import("../src/prax.ts");
	const row = (a: string, b: string): Block => ({ kind: "columns", columns: [[{ kind: "paragraph", text: a }], [{ kind: "paragraph", text: b }]] });
	const out = lesson({ sourceId: "l", title: "L", pages: [{ blocks: [row("A", "B"), row("C", "D")] }] }, "lesson-x", undefined, new Map());
	assert.equal(out.match(/^as: col$/gm)?.length, 4);
	assert.match(out, /B\n\nclose: col\n\nas: col\n\nC/);
});

test("a card set opens with a bare as: card line and holds every card as a sub-heading", async () => {
	const { block } = await import("../src/prax.ts");
	const out = block({ kind: "cards", items: [{ title: "One", front: [{ kind: "paragraph", text: "Front" }], back: [{ kind: "paragraph", text: "Back" }] }, { title: "Two", front: [{ kind: "paragraph", text: "Only" }], back: [] }] }, { assets: new Map(), item: 2 });
	assert.equal(out, "as: card\nlayout: slides\n\n### One\n\nFront\n\ncard: back\nBack\n\n### Two\n\nOnly\n\nclose: card");
});

test("in a deck only unlimited-attempt graded questions override Studio's gate, which opens on a correct answer or spent attempts", async () => {
	const { block } = await import("../src/prax.ts");
	const q = { kind: "choice", prompt: "Q", scored: true, multiple: false, options: [{ text: "A", correct: true }] } satisfies Block;
	assert.doesNotMatch(block(q, { assets: new Map(), item: 2, deck: true }), /deckGate/);
	assert.doesNotMatch(block({ ...q, attempts: 2 }, { assets: new Map(), item: 2, deck: true }), /deckGate/);
	assert.match(block({ ...q, attempts: 0 }, { assets: new Map(), item: 2, deck: true }), /^scored: true\ndeckGate: attempt\nattempts: 0$/m);
	assert.doesNotMatch(block({ ...q, attempts: 0 }, { assets: new Map(), item: 2 }), /deckGate/);
	const group = { kind: "group", title: "Quiz", passingScore: 80, blocks: [q] } satisfies Block;
	assert.doesNotMatch(block(group, { assets: new Map(), item: 1, deck: true }), /deckGate/);
	assert.equal(block({ kind: "table", rows: [["a", "b"], ["x", "1"]], chart: "line" }, { assets: new Map(), item: 2 }), "| a | b |\n| x | 1 |\nchart: line");
});

test("Rise cover image becomes a hero while the description retains its paragraphs", async () => {
	const root = risePackage();
	const course = { id: "cover", title: "Cover title", description: "<p>First paragraph.</p><p>Second paragraph.</p>", coverImage: { media: { image: { key: "hazard.png", alt: "Cover description" } } }, lessons: [], theme: { hideCoverPage: false } };
	const read = () => {
		writeFileSync(join(root, "locales/und.js"), `window.__resolveJsonp("course:und", "${Buffer.from(JSON.stringify({ course })).toString("base64")}")`);
		return extractRise(root, "");
	};
	assert.deepEqual(read().lessons[0]!.pages[0]!.blocks, [
		{ kind: "heading", level: 1, text: "Cover title", background: { src: "assets/hazard.png", alt: "Cover description" } },
		{ kind: "paragraph", text: "First paragraph." },
		{ kind: "paragraph", text: "Second paragraph." },
	]);
	const out = join(tmp(), "cover");
	const report = await importPackage(root, out);
	assert.match(readFileSync(join(out, report.lessons[0]!.file), "utf8"), /# Cover title\nbackground: \/assets\/hazard.png\nwidth: full\nbackgroundAlt: Cover description\n\nFirst paragraph\.\n\nSecond paragraph\./);
	course.coverImage.media.image.alt = "";
	const decorative = read().lessons[0]!.pages[0]!.blocks[0];
	assert.ok(decorative?.kind === "heading");
	assert.equal(decorative.background?.alt, "");
	const bare = await importPackage(root, join(tmp(), "bare"));
	assert.ok(bare.losses.some((l) => l.source === "file:assets/hazard.png" && /hero background picture has no alternative text/.test(l.detail)), "a hero keeps the missing-alt review notice");
	course.coverImage.media.image.key = "";
	assert.ok(!read().lessons[0]!.pages[0]!.blocks.some((b) => b.kind === "heading" && b.background));
	course.theme.hideCoverPage = true;
	assert.equal(read().lessons.length, 0);
});

test("the same input always produces the same bytes", async () => {
	const pkg = risePackage();
	const [a, b] = [join(tmp(), "a"), join(tmp(), "b")];
	await importPackage(pkg, a);
	await importPackage(pkg, b);
	for (const f of ["01-hazards.prax", "course.yaml", "import-report.json"]) assert.equal(readFileSync(join(a, f), "utf8"), readFileSync(join(b, f), "utf8"), f);
});

test("imports a static HTML SCORM package in manifest order", async () => {
	const dir = tmp();
	mkdirSync(join(dir, "m1"));
	writeFileSync(join(dir, "imsmanifest.xml"), `<?xml version="1.0"?><manifest identifier="M"><organizations default="o"><organization identifier="o"><title>Course &amp; more</title>
		<item identifier="i1"><title>Module 1</title><item identifier="i1a" identifierref="r1"><title>Intro</title></item><item identifier="i1b" identifierref="r2"/></item>
	</organization></organizations><resources><resource identifier="r1" href="m1/a.html"><file href="m1/a.html"/></resource><resource identifier="r2" href="m1/b.html"/></resources></manifest>`);
	writeFileSync(join(dir, "m1/a.html"), `<html><head><title>A</title></head><body><nav>Menu</nav><h1>Intro</h1><p>First <a href="https://example.com">link</a>.</p><ul><li>one<ul><li>nested</li></ul></li></ul></body></html>`);
	writeFileSync(join(dir, "m1/b.html"), `<html><body><script>render()</script></body></html>`);
	const out = join(tmp(), "course");
	const report = await importPackage(dir, out);
	assert.equal(report.detected.tool, "html");
	assert.equal(report.lessons.length, 1);
	const prax = readFileSync(join(out, "01-module-1.prax"), "utf8");
	assert.match(prax, /# Intro\n\nFirst \[link\]\(https:\/\/example\.com\)\.\n\n- one\n- nested/);
	assert.doesNotMatch(prax, /Menu/, "navigation chrome is skipped");
	assert.ok(report.losses.some((l) => /generated by script/.test(l.detail)));
});

test("html conversion keeps inline formatting and document order", () => {
	assert.equal(inline("<p>a <strong> b </strong>c</p>"), "a **b** c");
	assert.equal(inline("{{x}} and [t]{d} and @icon{mail} and a==b and snake_case and [1] a*b c:\\d"), "\\{{x}} and \\[t]{d} and \\@icon{mail} and a\\=\\=b and snake_case and [1] a\\*b c:\\\\d");
	assert.deepEqual(
		blocks("<h2>T</h2><p>x</p><img src='i.png' alt='A'><table><tr><th>h</th></tr><tr><td>c|d</td></tr></table>", { base: "dir" }).map((b) => b.kind),
		["heading", "paragraph", "image", "table"],
	);
});

test("a pipe followed by key: in a value cannot split it into parameters", async () => {
	const { block } = await import("../src/prax.ts");
	const out = block({ kind: "image", src: "a.png", alt: "x", caption: "Photo | credit: Jane" }, { assets: new Map(), item: 2 });
	assert.match(out, /^caption: Photo \\\| credit: Jane$/m);
});

test("a heading over a picture becomes a hero heading; without the picture its subtitle is a paragraph", async () => {
	const { block } = await import("../src/prax.ts");
	const ctx = { assets: new Map([["img/bg.jpg", "assets/bg.jpg"]]), item: 1 };
	assert.equal(block({ kind: "heading", level: 1, text: "Welcome", subtitle: "Part | note: one", background: { src: "img/bg.jpg", alt: "", overlay: "dark" } }, ctx), "# Welcome\nbackground: /assets/bg.jpg\nwidth: full\noverlay: dark\nsubtitle: Part \\| note: one");
	assert.equal(block({ kind: "heading", level: 2, text: "Welcome", subtitle: "Part one" }, ctx), "## Welcome\n\nPart one");
});

test("reserved line starts are escaped, ordinary text is not", () => {
	assert.equal(escapeLines("--- x\n# y\nas: note\nhttps://e.com/v\nplain: text here\nfine"), "\\--- x\n\\# y\n\\as: note\n\\https://e.com/v\n\\plain: text here\nfine");
});

test("xml reader handles self-closing tags, entities and prefixes", () => {
	const doc = parseXml(`<a:root><b x="1"/><c>one &amp; <![CDATA[<two>]]></c></a:root>`);
	assert.equal(find(doc, "b")[0]?.attrs.x, "1");
	assert.equal(textOf(find(doc, "c")[0]), "one & <two>");
});

test("coverage counts repeated words and ignores neutralized markup", () => {
	const c = coverage(["the cat and the hat", "3 * 4"], ["the cat and hat", "3 \\* 4"]);
	assert.equal(c.sourceWords, 7);
	assert.equal(c.matched, 6);
	assert.deepEqual(c.missing, ["the×1"]);
});

test("asset paths from package data cannot reach outside the package", async () => {
	const { symlinkSync } = await import("node:fs");
	const dir = tmp();
	const secret = join(tmp(), "secret.png");
	writeFileSync(secret, "secret");
	symlinkSync(secret, join(dir, "linked.png"));
	writeFileSync(join(dir, "index.html"), `<html><body><h1>T</h1><p>x</p><img src="../../../../../../${secret}" alt="a"><img src="linked.png" alt="b"><img src="${secret}" alt="c"></body></html>`);
	const out = join(tmp(), "course");
	const report = await importPackage(dir, out);
	assert.deepEqual(readdirSync(out).sort(), ["01-imported-course.prax", "course.yaml", "import-report.json"], "no assets copied");
	assert.equal(report.losses.filter((l) => /missing from the package/.test(l.detail)).length, 2, "symlink and absolute path are refused; the ../ path never resolves");
});

test("question feedback sits with the question's parameters; new question blocks serialize", async () => {
	const { block } = await import("../src/prax.ts");
	const ctx = { assets: new Map([["img/map.png", "assets/img/map.png"]]), item: 2 };
	assert.match(block({ kind: "match", prompt: "Pair", pairs: [["a", "b"]], correct: "Yes", incorrect: "No" }, ctx), /^## Pair\nas: match\nshuffle: true\ncorrect: Yes\nincorrect: No\n\na :: b$/);
	assert.match(block({ kind: "order", prompt: "Order", items: ["x", "y"], correct: "Yes" }, ctx), /^## Order\nas: order\ncorrect: Yes\n\n1\. x\n2\. y$/);
	assert.equal(block({ kind: "matrix", prompt: "Rate", scale: ["Low", "High"], statements: ["Speed", "Cost"] }, ctx), "## Rate\nas: matrix\nwidth: wide\n\n1: Low\n2: High\n\n- Speed\n- Cost");
	assert.equal(block({ kind: "rating", prompt: "How useful?", scale: ["No", "Yes"] }, ctx), "## How useful?\nas: rating\n\n1: No\n2: Yes");
	assert.equal(
		block({ kind: "hotspot", prompt: "Find the exit", src: "img/map.png", alt: "Floor plan", spots: [{ label: "Exit; east", x: 12.345, y: 150, correct: true }, { label: "", x: 50, y: 50, correct: false }] }, ctx),
		"## Find the exit\nas: hotspot\n\n/assets/img/map.png\nalt: Floor plan\nspot: Exit\\; east; 12.3%; 100%; correct\nspot: Spot 2; 50%; 50%",
	);
});

test("all scored question kinds put recorded retries in the question header", async () => {
	const { block } = await import("../src/prax.ts");
	const questions: Block[] = [
		{ kind: "choice", prompt: "Pick", multiple: false, options: [{ text: "A", correct: true }, { text: "B", correct: false }] },
		{ kind: "match", prompt: "Match", pairs: [["A", "X"], ["B", "Y"]] },
		{ kind: "order", prompt: "Order", items: ["A", "B"] },
		{ kind: "categorize", prompt: "Sort", categories: [{ name: "X", items: ["A"] }, { name: "Y", items: ["B"] }] },
		{ kind: "hotspot", prompt: "Find", src: "picture.png", alt: "Diagram", spots: [{ label: "A", x: 30, y: 50, correct: true }] },
		{ kind: "fillBlank", prompt: "Fill", parts: [{ answers: ["A"] }] },
	];
	for (const q of questions) {
		for (const attempts of [undefined, 1, 3, 0, -1, 2.5, Infinity]) {
			const output = block({ ...q, attempts } as Block, { assets: new Map(), item: 2, graded: true });
			if (attempts === 3 || attempts === 0) assert.ok(output.split("\n\n")[0]!.includes(`scored: true\nattempts: ${attempts}\nfeedbackMode: retry`));
			else assert.doesNotMatch(output, /attempts:|feedbackMode:/);
		}
	}
});

test("refusals say whether the course lives on a remote server or in an unknown player", async () => {
	const { ImportError } = await import("../src/model.ts");
	const remote = tmp();
	writeFileSync(join(remote, "index.html"), `<html><head><script src="https://content.example.com/load.js"></script></head><body></body></html>`);
	await assert.rejects(importPackage(remote, join(tmp(), "a")), (e) => e instanceof ImportError && e.code === "not_self_contained" && /content\.example\.com/.test(e.message));
	const player = tmp();
	writeFileSync(join(player, "index.html"), `<html><head><script src="https://cdn.example.com/video.js"></script><script src="app.js"></script></head><body></body></html>`);
	writeFileSync(join(player, "app.js"), "render()");
	await assert.rejects(importPackage(player, join(tmp(), "b")), (e) => e instanceof ImportError && e.code === "no_readable_content");
});

test("fill-blank parts, answers, dropdowns and word banks serialize with Studio escapes", async () => {
	const { block } = await import("../src/prax.ts");
	const ctx = { assets: new Map(), item: 2 };
	assert.equal(block({ kind: "fillBlank", prompt: "Fill", parts: ["A {brace}, a ____ line and ", { answers: ["a|b", "~0.5", "{x}"] }, "."] }, ctx), "## Fill\nas: fill-blank\n\nA \\{brace\\}, a \\____ line and {a\\|b|\\~0.5|\\{x\\}}.");
	assert.equal(block({ kind: "fillBlank", prompt: "Pick", style: "dropdown", parts: ["Sky is ", { answers: ["blue"], choices: ["red", "blue", "*star"] }, "."] }, ctx), "## Pick\nas: fill-blank\nstyle: dropdown\n\nSky is {red|*blue|\\*star}.");
	assert.equal(block({ kind: "fillBlank", prompt: "Bank", style: "word-bank", bank: ["red", "blue", "red", "a|b"], parts: [{ answers: ["red"] }, " then ", { answers: [] }] }, ctx), "## Bank\nas: fill-blank\nstyle: word-bank\nbank: red | blue | red | a\\|b\n\n{red} then ____");
});

test("an invalid dropdown or word bank falls back to typed blanks with a loss", async () => {
	const dir = tmp();
	writeFileSync(join(dir, "index.html"), "<html><body><h1>T</h1><p>x</p></body></html>");
	const { writeProject } = await import("../src/write.ts");
	const course = {
		tool: "test", sourceId: "s", title: "T", losses: [], sourceText: [],
		lessons: [{ sourceId: "l", title: "L", pages: [{ blocks: [
			{ kind: "fillBlank" as const, prompt: "D", style: "dropdown" as const, parts: [{ answers: ["x"], choices: ["x"] }] },
			{ kind: "fillBlank" as const, prompt: "W", style: "word-bank" as const, bank: ["red"], parts: [{ answers: ["red"] }, { answers: ["red"] }] },
		] }] }],
	};
	const out = join(tmp(), "c");
	const written = await writeProject(course, dir, out);
	assert.equal(written.losses.filter((l) => l.source.startsWith("fill-blank:")).length, 2);
	assert.doesNotMatch(readFileSync(join(out, "01-l.prax"), "utf8"), /style:/);
});

test("the pass mark comes from the manifest, else the quiz, and goes to praxity.json as a fraction beside Studio's default page threshold", async () => {
	const html = tmp();
	writeFileSync(join(html, "a.html"), "<html><body><h1>A</h1><p>x</p></body></html>");
	writeFileSync(join(html, "imsmanifest.xml"), `<manifest identifier="M"><organizations default="o"><organization identifier="o"><title>C</title><item identifier="i" identifierref="r"><title>A</title><adlcp:masteryscore>70</adlcp:masteryscore></item></organization></organizations><resources><resource identifier="r" href="a.html"/></resources></manifest>`);
	const a = join(tmp(), "a");
	const report = await importPackage(html, a);
	assert.equal(report.passingScore, 70);
	assert.deepEqual(JSON.parse(readFileSync(join(a, "praxity.json"), "utf8")), { version: 1, export: { format: "scorm-1.2", completionThreshold: 0.8, requireKnowledgeChecks: false, passingScore: 0.7 } });
	assert.ok(!report.losses.some((l) => l.source === "lms:pass-mark"));

	const measure = tmp();
	writeFileSync(join(measure, "a.html"), "<html><body><h1>A</h1><p>x</p></body></html>");
	writeFileSync(join(measure, "imsmanifest.xml"), `<manifest identifier="M2"><organizations default="o"><organization identifier="o"><title>C</title><item identifier="i" identifierref="r"><title>A</title><imsss:sequencing><imsss:objectives><imsss:primaryObjective satisfiedByMeasure="false"><imsss:minNormalizedMeasure>0.6</imsss:minNormalizedMeasure></imsss:primaryObjective></imsss:objectives></imsss:sequencing></item></organization></organizations><resources><resource identifier="r" href="a.html"/></resources></manifest>`);
	const c = join(tmp(), "c");
	assert.equal((await importPackage(measure, c)).passingScore, undefined, "a measure that does not decide success is ignored");
	assert.equal(existsSync(join(c, "praxity.json")), false, "no pass mark, no project settings: Studio's defaults apply");
});

test("questions in a quiz group are scored; standalone knowledge checks are not", async () => {
	const { block } = await import("../src/prax.ts");
	const q = { kind: "choice" as const, prompt: "Q", multiple: false, options: [{ text: "a", correct: true }, { text: "b", correct: false }] };
	assert.doesNotMatch(block(q, { assets: new Map(), item: 2 }), /scored/);
	assert.match(block({ kind: "group", title: "Quiz", passingScore: 50, blocks: [q] }, { assets: new Map(), item: 2 }), /### Q\nas: choice\nscored: true\n/);
});

test("Rise quiz-level settings retain losses without conflating question order, choice order or question retries", async () => {
	const { block } = await import("../src/prax.ts");
	const root = risePackage();
	for (const shuffleAnswerChoices of [false, true]) {
		const course = { id: "quiz-course", title: "Quiz course", theme: { hideCoverPage: true }, lessons: [{ id: "quiz", type: "quiz", title: "Quiz", settings: { passingScore: 80, randomizeQuestionOrder: true, retryCount: 2, passToContinue: true, shuffleAnswerChoices }, items: [{ id: "q", type: "MULTIPLE_CHOICE", title: "Pick one", answers: [{ id: "a", title: "Alpha", correct: true }, { id: "b", title: "Beta", correct: false }] }] }] };
		writeFileSync(join(root, "locales/und.js"), `window.__resolveJsonp("course:und", "${Buffer.from(JSON.stringify({ course })).toString("base64")}")`);
		const result = extractRise(root, "");
		const group = result.lessons[0]!.pages[0]!.blocks[0]!;
		assert.ok(group.kind === "group");
		assert.equal(group.shuffle === true, shuffleAnswerChoices);
		const prax = block(group, { assets: new Map(), item: 1 });
		assert.doesNotMatch(prax.split("\n\n")[0]!, /shuffle:|attempts:|requireAll:|deckGate:/);
		assert.equal(prax.includes("shuffle: true"), shuffleAnswerChoices);
		assert.doesNotMatch(prax, /attempts:/);
		const loss = result.losses.find((l) => l.source === "rise:quiz");
		assert.equal(loss?.at, "lesson quiz");
		for (const setting of ["random question order", "2 retries", "passing to continue"]) assert.ok(loss?.detail.includes(setting));
		for (const retryCount of [0, -1, 2]) {
			Object.assign(course.lessons[0]!.settings, { randomizeQuestionOrder: false, passToContinue: false, retryCount });
			writeFileSync(join(root, "locales/und.js"), `window.__resolveJsonp("course:und", "${Buffer.from(JSON.stringify({ course })).toString("base64")}")`);
			const losses = extractRise(root, "").losses.filter((l) => l.source === "rise:quiz");
			assert.equal(losses.length, retryCount === 0 ? 0 : 1);
			if (retryCount === -1) assert.match(losses[0]!.detail, /unlimited quiz retries/);
		}
	}
});

test("a page made of several articles keeps all of them, not just the first", async () => {
	const dir = tmp();
	writeFileSync(join(dir, "index.html"), `<html><body><header>Site</header><section id="main"><h1>Unit</h1><article><h2>First</h2><p>One.</p></article><article><h2>Second</h2><p>Two.</p></article></section></body></html>`);
	const out = join(tmp(), "c");
	await importPackage(dir, out);
	const prax = readFileSync(join(out, readdirSync(out).find((f) => f.endsWith(".prax"))!), "utf8");
	assert.match(prax, /## First\n\nOne\.\n\n## Second\n\nTwo\./);
	assert.doesNotMatch(prax, /Site/, "chrome outside the main section is skipped");
});

test("the source theme maps to Studio design: catalogue fonts kept, others fall back with a loss", async () => {
	const { designYaml } = await import("../src/theme.ts");
	const losses: Array<{ detail: string }> = [];
	const lines = designYaml({ accent: "#E51F30", headingFont: "Poppins Bold", bodyFont: "BrandSerif Text", corners: 8, navigation: "sidebar" }, "assets/logo.png", (l) => losses.push(l));
	assert.deepEqual(lines, ["design:", "  palette: clean", '  colorAccent: "#e51f30"', "  typography:", '    body:\n      fontFamily: ["serif"]', '    headings:\n      fontFamily: ["Poppins", "sans-serif"]', "  borderRadius: 8", "  navArchetype: sidebar", "  brand:", "    logoUrl: /assets/logo.png", "    logoPlacement: header"]);
	assert.equal(losses.length, 1);
	assert.match(losses[0]!.detail, /BrandSerif Text.*generic serif/);
	assert.deepEqual(designYaml({ accent: "not-a-colour" }, undefined, () => {}), ["design:", "  palette: clean"], "invalid colours are ignored; the neutral preset remains");
	assert.deepEqual(designYaml({ background: "#101820", sectionAccent: "#7030a0" }, undefined, () => {}), ["design:", "  palette: clean", "  colorMode: dark", '  colorBackgroundDark: "#101820"', '  sectionAccentBackground: "#7030a0"'], "a dark content background reads in dark mode");
	const grey: Array<{ detail: string }> = [];
	assert.deepEqual(designYaml({ accent: "#d3d3d3" }, undefined, (l) => grey.push(l)), ["design:", "  palette: clean"], "a neutral grey is not a brand accent");
	assert.match(grey[0]!.detail, /neutral grey/);
});

test("columns, image layout and coloured section bands serialize", async () => {
	const { block } = await import("../src/prax.ts");
	const ctx = { assets: new Map([["a.png", "assets/a.png"]]), item: 2 };
	assert.equal(block({ kind: "columns", columns: [[{ kind: "image", src: "a.png", alt: "A", layout: "medium" }], [{ kind: "paragraph", text: "Beside." }]] }, ctx), "as: col\n\n/assets/a.png\nalt: A\nsize: medium\n\nas: col\n\nBeside.\n\nclose: col");
	assert.equal(block({ kind: "image", src: "a.png", alt: "A", layout: "full" }, ctx), "/assets/a.png\nalt: A\nwidth: full");
	assert.equal(block({ kind: "image", src: "a.png", alt: "A", layout: "small", ratio: "square", fit: "contain" }, ctx), "/assets/a.png\nalt: A\nsize: small\nratio: square\nfit: contain");
	assert.equal(block({ kind: "image", src: "a.png", alt: "A", ratio: "square" }, ctx), "/assets/a.png\nalt: A\nratio: square");
	assert.equal(block({ kind: "image", src: "a.png", alt: "A", fit: "contain" }, ctx), "/assets/a.png\nalt: A\nfit: contain");
	assert.equal(block({ kind: "divider", tone: "accent" }, ctx), "--\npalette: accent");
});

test("images inside columns are resolved and copied like any other asset", async () => {
	const dir = tmp();
	writeFileSync(join(dir, "pic.png"), "png");
	const { writeProject } = await import("../src/write.ts");
	const course = { tool: "test", sourceId: "s", title: "T", losses: [], sourceText: [], lessons: [{ sourceId: "l", title: "L", pages: [{ blocks: [{ kind: "columns" as const, columns: [[{ kind: "image" as const, src: "pic.png", alt: "A" }, { kind: "image" as const, src: "gone.png", alt: "B" }], [{ kind: "paragraph" as const, text: "Text" }]] }] }] }] };
	const out = join(tmp(), "c");
	const written = await writeProject(course, dir, out);
	assert.equal(existsSync(join(out, "assets/pic.png")), true);
	assert.match(readFileSync(join(out, "01-l.prax"), "utf8"), /^\/assets\/pic\.png$/m);
	assert.ok(written.losses.some((l) => /gone\.png/.test(l.source)), "a missing file inside a column is dropped with a loss");
});

test("embedded assets fill missing files, preserve disk files and ignore map insertion order", async () => {
	const { writeProject } = await import("../src/write.ts");
	const dir = tmp();
	writeFileSync(join(dir, "disk.png"), "disk bytes");
	const entries: Array<[string, Buffer]> = [
		["images/picture.png", Buffer.from([0, 127, 255])],
		["disk.png", Buffer.from("embedded duplicate")],
		["logo.png", Buffer.from("logo bytes")],
		["unused.png", Buffer.from("unused bytes")],
	];
	const outputs = [join(tmp(), "a"), join(tmp(), "b")];
	for (const [i, out] of outputs.entries()) {
		const course = {
			tool: "test", sourceId: "s", title: "T", losses: [], sourceText: [], theme: { logo: "logo.png" },
			embedded: new Map(i ? entries.toReversed() : entries),
			lessons: [{ sourceId: "l", title: "L", pages: [{ blocks: ["images/picture.png", "disk.png"].map((src) => ({ kind: "image" as const, src, alt: "A picture" })) }] }],
		};
		const written = await writeProject(course, dir, out);
		assert.equal(written.assets, 3);
		assert.deepEqual(written.losses, []);
		assert.deepEqual(readFileSync(join(out, "assets/images/picture.png")), entries[0]![1]);
		assert.equal(readFileSync(join(out, "assets/disk.png"), "utf8"), "disk bytes");
		assert.equal(readFileSync(join(out, "assets/logo.png"), "utf8"), "logo bytes");
		assert.equal(existsSync(join(out, "assets/unused.png")), false);
		assert.match(readFileSync(join(out, "01-l.prax"), "utf8"), /^\/assets\/images\/picture\.png$/m);
	}
	for (const file of ["course.yaml", "01-l.prax", "assets/images/picture.png", "assets/disk.png", "assets/logo.png"]) {
		assert.deepEqual(readFileSync(join(outputs[0]!, file)), readFileSync(join(outputs[1]!, file)), file);
	}
});

test("unsafe embedded paths are dropped with missing-file losses", async () => {
	const { writeProject } = await import("../src/write.ts");
	const dir = tmp();
	const out = join(tmp(), "course");
	const paths = ["../escape.png", "/absolute.png", "C:/drive.png", "..\\escape.png", "images/../../escape.png", "images/../escape.png", "image\0.png"];
	const course = {
		tool: "test", sourceId: "s", title: "T", losses: [], sourceText: [],
		embedded: new Map(paths.map((src) => [src, Buffer.from("untrusted bytes")])),
		lessons: [{ sourceId: "l", title: "L", pages: [{ blocks: paths.map((src) => ({ kind: "image" as const, src, alt: "A picture" })) }] }],
	};
	const written = await writeProject(course, dir, out);
	assert.equal(written.assets, 0);
	assert.deepEqual(written.losses.map((loss) => loss.source), paths.map((src) => `file:${src}`));
	assert.deepEqual(readdirSync(out).sort(), ["01-l.prax", "course.yaml"]);
	assert.equal(existsSync(join(out, "../escape.png")), false);
});

test("filename alternatives use the same missing-alt path for images and hotspots", async () => {
	const { writeProject } = await import("../src/write.ts");
	const dir = tmp();
	writeFileSync(join(dir, "pic.png"), "png");
	const filenames = ["image-2.jpg", "sample-photo.JPEG", "sample photo 2.PNG", "media/pic.gif", "C:\\media\\pic.svg", "pic.webp", "pic.bmp", "pic.tif", "pic.TIFF", "clip.mp4", "sound.MP3"];
	const image = (alt: string, src = "pic.png") => ({ kind: "image" as const, src, alt });
	const hotspot = (alt: string) => ({ kind: "hotspot" as const, src: "pic.png", alt, prompt: "Choose the square", spots: [{ label: "Square", x: 50, y: 50, correct: true }] });
	const missing = image("");
	const remote = image("media/pic.PNG", "https://example.org/pic.png");
	const named = filenames.map((alt) => image(alt));
	const meaningful = ["A square beside a circle", "The file pic.png is selected", "pic.png.", "A diagram\ncaption.png"].map((alt) => image(alt));
	const plainHotspot = hotspot("");
	const namedHotspot = hotspot("map.PNG");
	const course = { tool: "test", sourceId: "s", title: "T", losses: [], sourceText: [], lessons: [{ sourceId: "l", title: "L", pages: [{ blocks: [missing, remote, { kind: "columns" as const, columns: [named, meaningful] }, plainHotspot, namedHotspot] }] }] };
	const out = join(tmp(), "course");
	const written = await writeProject(course, dir, out);
	assert.ok([missing, remote, ...named].every((b) => b.alt === ""));
	assert.deepEqual(meaningful.map((b) => b.alt), ["A square beside a circle", "The file pic.png is selected", "pic.png.", "A diagram\ncaption.png"]);
	assert.equal(namedHotspot.alt, plainHotspot.alt);
	const imageLosses = written.losses.filter((l) => /^image has no alternative text/.test(l.detail));
	assert.equal(imageLosses.length, filenames.length + 2);
	assert.ok(imageLosses.every((l) => l.detail === imageLosses[0]!.detail && l.effect === "approximated"));
	assert.equal(written.losses.filter((l) => /hotspot image has no alternative text/.test(l.detail)).length, 2);
	const prax = readFileSync(join(out, "01-l.prax"), "utf8");
	assert.equal(prax.match(/^decorative: true$/gm)?.length, filenames.length + 2);
	assert.match(prax, /alt: A square beside a circle/);
});

test("Rise quote variants retain speakers and styles, report avatars, and keep recorded content width", async () => {
	const root = risePackage();
	const course = { id: "quotes", title: "Quotes", theme: { hideCoverPage: true, contentWidth: 920 }, lessons: [{ id: "l", title: "L", type: "blocks", items: [
		{ type: "quote", variant: "a", items: [{ name: "Example speaker", paragraph: "<p>Recorded quotation.</p>", avatar: { media: { image: { src: "hazard.png", alt: "Portrait" } } } }] },
		{ type: "quote", variant: "c", items: [{ paragraph: "Second quotation.", avatar: { media: { image: { src: "hazard.png" } } } }] },
		{ type: "quote", variant: "background", items: [{ paragraph: "Third quotation.", background: { media: { image: { src: "hazard.png" } } } }] },
		{ type: "quote", variant: "other", items: [{ paragraph: "Last quotation." }] },
	] }] };
	writeFileSync(join(root, "locales/und.js"), `window.__resolveJsonp("course:und", "${Buffer.from(JSON.stringify({ course })).toString("base64")}")`);
	const result = extractRise(root, "");
	const quotes = result.lessons[0]!.pages[0]!.blocks.filter((b) => b.kind === "quote");
	assert.deepEqual(quotes.map((b) => b.style), ["none", "none", "shaded", undefined]);
	assert.equal(quotes[0]?.speaker, "Example speaker");
	assert.equal(result.lessons[0]!.pages[0]!.blocks.filter((b) => b.kind === "image").length, 0, "avatars are not images");
	assert.equal(result.losses.filter((l) => /avatar/.test(l.detail) && l.effect === "dropped").length, 2);
	assert.equal(result.theme?.contentWidth, 920);
	assert.equal(result.theme?.density, "comfortable");
	const out = join(tmp(), "course");
	const report = await importPackage(root, out);
	const prax = readFileSync(join(out, report.lessons[0]!.file), "utf8");
	assert.match(prax, /> Recorded quotation\.\nspeaker: Example speaker\nstyle: none/);
	assert.match(prax, /> Third quotation\.\nstyle: shaded/);
	assert.match(readFileSync(join(out, "course.yaml"), "utf8"), /contentMaxWidth: 920\n  density: comfortable/);
});
