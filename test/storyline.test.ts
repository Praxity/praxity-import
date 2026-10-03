import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importPackage } from "../src/import.ts";
import { extractStoryline, provided } from "../src/extract/storyline.ts";
import { walk } from "../src/write.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "praxity-import-storyline-"));

test("player theme uses explicit accent, visible logo and character-weighted text families", () => {
	const root = tmp();
	mkdirSync(join(root, "html5/data/js"), { recursive: true });
	writeFileSync(join(root, "logo.png"), "logo");
	writeFileSync(join(root, "html5/data/js/data.js"), provide("data", { scenes: [{ id: "scene", slides: [{ id: "one", html5url: "slide.js" }] }] }));
	writeFileSync(join(root, "slide.js"), provide("slide", { slideLayers: [{ isBaseLayer: true, objects: [
		textObj("a", 0, [para([span("1234", { fontFamily: '"Roboto Charset0_ABC","Roboto"' }), span("12", { fontFamily: '"Lato Charset0_DEF","Lato"' })])]),
		textObj("b", 1, [para([span("34", { fontFamily: '"Lato Charset0_DEF","Lato"' })])]),
	] }] }));
	const frame = { themeAccentColor: "0xAABBCC", controlOptions: { sidebarOptions: { sidebarEnabled: true, logoEnabled: true, html5_logo_url: "logo.png" } } };
	const writeFrame = () => writeFileSync(join(root, "html5/data/js/frame.js"), provide("frame", frame));
	writeFrame();
	const course = extractStoryline(root);
	assert.deepEqual(course.theme, { density: "compact", blockSpacing: "compact", accent: "#aabbcc", navigation: "sidebar", logo: "logo.png", bodyFont: "Lato", headingFont: "Lato" });
	assert.equal(course.losses.filter((l) => l.source === "storyline:theme").length, 1);
	writeFileSync(join(root, "slide.js"), provide("slide", { slideLayers: [{ isBaseLayer: true, objects: [textObj("plain", 0, [para([span("plain stack", { fontFamily: "Arial,sans-serif" }), span("", { fontFamily: "AAA" })])])] }] }));
	assert.equal(extractStoryline(root).theme?.bodyFont, "Arial");
	frame.controlOptions.sidebarOptions.logoEnabled = false;
	frame.controlOptions.sidebarOptions.sidebarEnabled = false;
	writeFrame();
	assert.equal(extractStoryline(root).theme?.logo, undefined);
	assert.equal(extractStoryline(root).theme?.navigation, "slides");
	frame.controlOptions.sidebarOptions.logoEnabled = true;
	frame.controlOptions.sidebarOptions.html5_logo_url = "../outside.png";
	writeFrame();
	const unsafe = extractStoryline(root);
	assert.equal(unsafe.theme?.logo, undefined);
	assert.equal(unsafe.losses.filter((l) => l.source === "storyline:theme").length, 1);
});

/** Storyline's data files: JSON wrapped in a single-quoted JS string literal. */
const provide = (name: string, data: unknown) => `window.globalProvideData('${name}', '${JSON.stringify(data).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}');`;

const span = (text: string, style: Record<string, unknown> = {}) => ({ text, style });
const para = (spans: ReturnType<typeof span>[], style: Record<string, unknown> = {}) => ({ spans, style: { tagType: "P", ...style } });
const textObj = (id: string, tabIndex: number, blocks: unknown[], extra: Record<string, unknown> = {}) => ({
	kind: "vectorshape",
	accType: "text",
	id,
	tabIndex,
	tabEnabled: true,
	textLib: [{ kind: "textdata", type: "acctext", vartext: { blocks, defaultBlockStyle: { baseSpanStyle: { fontIsBold: false, fontIsItalic: false } } } }],
	data: { vectorData: { altText: blocks.map((b) => (b as { spans: { text: string }[] }).spans.map((s) => s.text).join("")).join(" ") } },
	...extra,
});

test("hero uses the first large picture behind text, prominence and reading-order ties", async () => {
	const root = tmp();
	mkdirSync(join(root, "html5/data/js"), { recursive: true });
	writeFileSync(join(root, "picture.png"), "png");
	writeFileSync(join(root, "html5/data/js/data.js"), provide("data", { scenes: [{ id: "scene", slides: [{ id: "one", title: "Repeated title", html5url: "slide.js" }] }] }));
	const picture = { kind: "vectorshape", accType: "image", id: "picture", tabIndex: 9, xPos: 0, yPos: 0, width: 720, height: 540, imagelib: [{ url: "picture.png" }], data: { vectorData: { altText: "Recorded description" } } };
	const caption = (id: string, tab: number, value: string, size: number, extra = {}) => textObj(id, tab, [para([span(value, { fontSize: size, foregroundColor: "#ffffff" })])], { xPos: 30, yPos: 40, width: 400, height: 50, ...extra });
	const title = caption("title", 2, "Repeated title", 40);
	const subtitle = caption("subtitle", 1, "Short subtitle", 20);
	const remaining = caption("remaining", 0, "Remaining paragraph", 12);
	const read = (objects: unknown[], extras = {}) => {
		writeFileSync(join(root, "slide.js"), provide("slide", { width: 720, height: 540, slideLayers: [{ isBaseLayer: true, objects }], ...extras }));
		return extractStoryline(root).lessons[0]!.pages[0]!.blocks;
	};
	const expected = [
		{ kind: "heading", level: 1, text: "Repeated title", subtitle: "Short subtitle", background: { src: "picture.png", alt: "Recorded description", overlay: "dark" } },
		{ kind: "paragraph", text: "Remaining paragraph" },
	];
	assert.deepEqual(read([picture, title, subtitle, remaining]), expected);
	const out = join(tmp(), "course");
	const report = await importPackage(root, out);
	assert.match(readFileSync(join(out, report.lessons[0]!.file), "utf8"), /# Repeated title\nbackground: \/assets\/picture.png\nwidth: full\nbackgroundAlt: Recorded description\noverlay: dark\nsubtitle: Short subtitle/);
	const tied = read([picture, caption("later", 2, "Later", 30), caption("earlier", 1, "Earlier", 30)]);
	assert.equal(tied[0]?.kind === "heading" && tied[0].text, "Earlier");
	const twice = read([picture, { ...picture, id: "second", imagelib: [{ url: "second.png" }] }, title, subtitle]);
	assert.equal(twice.filter((b) => b.kind === "heading" && b.background).length, 1);
	assert.equal(twice[1]?.kind, "image");
	for (const objects of [
		[{ ...picture, width: 400 }, title],
		[picture, { ...title, xPos: 800 }],
		[title, picture],
		[{ ...picture, xPos: -300 }, title],
		[{ ...picture, rotation: 1 }, title],
		[picture, { ...title, rotation: 1 }],
		[{ kind: "objgroup", rotation: 1, objects: [picture, title] }],
		[{ ...picture, tabEnabled: false }, title],
	]) assert.ok(!read(objects).some((b) => b.kind === "heading" && b.background));
	assert.ok(read([{ ...picture, width: 504 }, title]).some((b) => b.kind === "heading" && b.background), "70% qualifies");
	const glyph = { ...title, textLib: [{ vectortext: {} }], data: { vectorData: { altText: "Glyph title" } } };
	assert.deepEqual(read([{ ...picture, data: { vectorData: { altText: "" } } }, glyph])[0], { kind: "heading", level: 1, text: "Glyph title", background: { src: "picture.png", alt: "" } });
	const dark = textObj("dark", 1, [para([span("Dark title", { fontSize: 40, foregroundColor: "#333333" })])], { xPos: 10, yPos: 10, width: 300, height: 60 });
	const darkHeading = read([picture, dark])[0];
	assert.ok(darkHeading?.kind === "heading");
	assert.equal(darkHeading.background?.overlay, "light");
	const multiline = caption("multi", 1, "First line\nSecond line", 20);
	const long = caption("long", 2, "x".repeat(120), 20);
	const withoutSubtitle = read([picture, title, multiline, long])[0];
	assert.ok(withoutSubtitle?.kind === "heading");
	assert.equal(withoutSubtitle.subtitle, undefined);
	writeFileSync(join(root, "html5/data/js/data.js"), provide("data", { scenes: [{ id: "scene", slides: [1, 2, 3].map((id) => ({ id, html5url: "slide.js" })) }] }));
	assert.ok(!read([picture, title]).some((b) => b.kind === "heading" && b.background), "template images stay skipped");
});

function storylinePackage(): string {
	const dir = tmp();
	mkdirSync(join(dir, "html5/data/js"), { recursive: true });
	mkdirSync(join(dir, "story_content"));
	writeFileSync(join(dir, "story_content/pic.png"), "png");
	writeFileSync(join(dir, "story.html"), `<!DOCTYPE html><html lang="en-US"><head><title>Safety</title></head><body></body></html>`);
	writeFileSync(join(dir, "meta.xml"), `<?xml version="1.0"?><meta><project id="p1" courseid="c1" title="Safety &amp; you"><description>Basics</description><application name="Articulate Storyline" version="3.99.1" /></project></meta>`);

	const slide1 = {
		title: "Welcome",
		slideLayers: [
			{
				kind: "slidelayer",
				isBaseLayer: true,
				objects: [
					// Source order is body first; tab order (focus order) puts the heading first.
					textObj("body", 2, [
						para([span("Wear "), span("gloves", { fontIsBold: true }), span(" at work.\n")]),
						para([span("one\n")], { listStyle: { listType: "bullet" } }),
						para([span("two\n")], { listStyle: { listType: "bullet" } }),
					]),
					textObj("head", 1, [para([span("It's \"Welcome\" time")], { tagType: "H1" })]),
					{ kind: "vectorshape", accType: "image", id: "img", tabIndex: 3, tabEnabled: true, imagelib: [{ kind: "imagedata", url: "story_content/pic.png", altText: "Wet floor" }], data: { vectorData: { altText: "Wet floor" } } },
					{ kind: "vectorshape", accType: "text", id: "shape", tabIndex: 4, tabEnabled: true, data: { vectorData: { altText: "Rectangle 1" } } },
					textObj("hidden", 5, [para([span("secret")])], { tabEnabled: false }),
					textObj("score", 6, [para([span("Score: "), span("%_player.Score%")])]),
					{ kind: "stategroup", objects: [textObj("s1", 7, [para([span("Start")])]), textObj("s2", 8, [para([span("Start")])])], events: [{ kind: "onrelease" }] },
					{ ...textObj("next", 9, [para([span("Next")])]), accType: "button", events: [{ kind: "onrelease" }] },
				],
			},
			{ kind: "slidelayer", id: "L2", objects: [textObj("more", 0, [para([span("Hidden detail")])])] },
		],
	};
	const slide2 = {
		title: "Quiz",
		slideLayers: [
			{
				kind: "slidelayer",
				isBaseLayer: true,
				objects: [
					textObj("q", 0, [para([span("Which is PPE?")])]),
					{ ...textObj("a", 1, [para([span("Gloves")])]), accType: "radio" },
					{ ...textObj("b", 2, [para([span("Coffee")])]), accType: "radio" },
					{ kind: "textinput", id: "entry", tabIndex: 3, tabEnabled: true, placeholder: "" },
				],
			},
			{ kind: "slidelayer", id: "ok", objects: [textObj("okt", 0, [para([span("Right!")])]), { ...textObj("okb", 1, [para([span("Continue")])]), accType: "button" }] },
			{ kind: "slidelayer", id: "no", objects: [textObj("not", 0, [para([span("Nope.")])])] },
		],
	};
	const data = {
		version: "3.99.1",
		projectId: "p1",
		tincanLanguage: "und",
		assetLib: [],
		scenes: [
			{ kind: "scene", id: "Msg", isMessageScene: true, slides: [{ kind: "slide", id: "prompt", title: "Resume", slideLayers: [] }] },
			{
				kind: "scene",
				id: "S1",
				lmsId: "Scene1",
				slides: [
					{ kind: "slide", id: "one", title: "Welcome", html5url: "html5/data/js/one.js" },
					{
						kind: "slide",
						id: "two",
						title: "Quiz",
						html5url: "html5/data/js/two.js",
						interactions: [
							{
								kind: "interaction",
								id: "i1",
								lmsId: "MultiChoice",
								type: "multiplechoice",
								lmstext: "Which is PPE?",
								choices: [{ id: "choice_a", lmstext: "Gloves" }, { id: "choice_b", lmstext: "Coffee" }],
								answers: [
									{ status: "correct", evaluate: { statements: [{ kind: "equals", choiceid: "choices.choice_a" }] }, actions: [{ kind: "if_action", thenActions: [{ kind: "show_slidelayer", objRef: { value: "ok" } }] }] },
									{ status: "incorrect", evaluate: { statements: [{ kind: "other" }] }, actions: [{ kind: "show_slidelayer", objRef: { value: "no" } }] },
								],
							},
							{ kind: "interaction", id: "i2", lmsId: "TextEntry", type: "fillin", lmstext: "Text Entry Interaction", choices: [{ id: "x", lmstext: "steel" }, { id: "y", lmstext: "Steel" }], answers: [{ status: "correct", evaluate: { statements: [] } }] },
						],
					},
				],
			},
		],
	};
	const frame = { navData: { outline: { links: [{ slideid: "_player.S1", displaytext: "Getting &amp; started", links: [{ slideid: "_player.S1.one", slidetitle: "Welcome" }] }] } } };
	writeFileSync(join(dir, "html5/data/js/data.js"), provide("data", data));
	writeFileSync(join(dir, "html5/data/js/frame.js"), provide("frame", frame));
	writeFileSync(join(dir, "html5/data/js/one.js"), provide("slide", slide1));
	writeFileSync(join(dir, "html5/data/js/two.js"), provide("slide", slide2));
	return dir;
}

test("imports a Storyline export: scenes, focus order, layers, quiz and losses", async () => {
	const out = join(tmp(), "course");
	const report = await importPackage(storylinePackage(), out);
	assert.equal(report.detected.tool, "storyline");
	assert.equal(report.course.toolVersion, "3.99.1");
	assert.deepEqual(readdirSync(out).sort(), ["01-getting-started.prax", "assets", "course.yaml", "import-report.json"], "message scenes are skipped; the scene is named from the player menu");
	assert.match(readFileSync(join(out, "course.yaml"), "utf8"), /^title: "Safety & you"\n[\s\S]*^locale: en$/m);
	const prax = readFileSync(join(out, "01-getting-started.prax"), "utf8");
	assert.match(prax, /^## It's "Welcome" time\n\nWear \*\*gloves\*\* at work\.\n\n- one\n- two\n\n\/assets\/story_content\/pic\.png\nalt: Wet floor$/m, "focus order, spans, lists and images");
	assert.doesNotMatch(prax, /Rectangle 1|secret|Next|Start/, "shapes, hidden objects and button labels are not content");
	assert.match(prax, /^\\?Score: %_player.Score%$/m, "unresolved variable references remain as source text");
	assert.match(prax, /^#{2,3} Hidden detail\nas: accordion\n\n\n\nclose: accordion$/m, "other layers use their first short line as the accordion title without repeating it");
	assert.match(prax, /^--- Quiz\n/m, "each slide is a page titled after the slide");
	assert.match(prax, /^#{2,3} Which is PPE\?\nas: choice\nscored: true\ncorrect: Right!\nincorrect: Nope\.\n\n\(x\) Gloves\n\( \) Coffee$/m, "answer key and feedback layers");
	assert.equal(prax.match(/Which is PPE\?/g)?.length, 1, "the question text object is not repeated as a paragraph");
	assert.match(prax, /^#{2,3} Quiz\nas: fill-blank\nscored: true\n\n\{steel\|Steel\}$/m, "text entry keeps all alternatives at the field's position");
	const sources = report.losses.map((l) => l.source);
	for (const s of ["storyline:button", "storyline:variable", "storyline:layer", "storyline:trigger"]) assert.ok(sources.includes(s), `${s} is reported`);
	assert.ok(!sources.includes("storyline:question/fillin"), "all accepted answers survive without a loss");
	assert.ok(report.losses.find((l) => l.source === "storyline:button")?.detail.includes('"Start", "Next"'), "state copies of a label are reported once");
});

test("storyline import is deterministic", async () => {
	const pkg = storylinePackage();
	const [a, b] = [join(tmp(), "a"), join(tmp(), "b")];
	await importPackage(pkg, a);
	await importPackage(pkg, b);
	for (const f of ["01-getting-started.prax", "course.yaml"]) assert.equal(readFileSync(join(a, f), "utf8"), readFileSync(join(b, f), "utf8"), f);
});

test("pictures on three distinct slides are template chrome; a unique whole-slide picture is content", async () => {
	const root = tmp();
	mkdirSync(join(root, "html5/data/js"), { recursive: true });
	const picture = (src: string, extra: Record<string, unknown> = {}) => ({ kind: "vectorshape", accType: "image", xPos: 0, yPos: 0, width: 80, height: 60, imagelib: [{ url: src }], data: { vectorData: { altText: "An illustration" } }, ...extra });
	const contents = [
		[picture("whole.png", { width: 800, height: 600 }), picture("logo.png"), picture("twice.png"), ...Array.from({ length: 3 }, () => picture("one-slide.png"))],
		[picture("logo.png"), picture("twice.png")],
		[{ kind: "svgimage", data: { imagedata: { url: "logo.png", width: 80, height: 60, altText: "An illustration" } } }],
	];
	for (const f of ["whole", "logo", "twice", "one-slide"]) writeFileSync(join(root, `${f}.png`), "png");
	const refs = contents.map((objects, i) => {
		const html5url = `slide-${i}.js`;
		writeFileSync(join(root, html5url), provide("slide", { width: 800, height: 600, slideLayers: [{ isBaseLayer: true, objects }] }));
		return { id: `slide-${i}`, html5url };
	});
	writeFileSync(join(root, "html5/data/js/data.js"), provide("data", { scenes: [{ id: "one", slides: refs.slice(0, 2) }, { id: "two", slides: refs.slice(2) }] }));
	const course = extractStoryline(root);
	const images = course.lessons.flatMap((l) => l.pages.map((p) => [...walk(p.blocks)].filter((b) => b.kind === "image").map((b) => b.src)));
	assert.deepEqual(images, [["whole.png", "twice.png", "one-slide.png", "one-slide.png", "one-slide.png"], ["twice.png"], []]);
	const losses = course.losses.filter((l) => l.source === "storyline:template");
	assert.equal(losses.length, 1);
	assert.equal(losses[0]!.effect, "dropped");
	assert.match(losses[0]!.detail, /1 pictures .*: logo\.png$/);
	const report = await importPackage(root, join(tmp(), "course"));
	assert.deepEqual(report.losses.filter((l) => l.source === "storyline:template"), losses);
});

test("result slides are identified by automatic completion of a recorded quiz, independently of titles", async () => {
	const root = tmp();
	mkdirSync(join(root, "html5/data/js"), { recursive: true });
	const complete = (id = "quiz") => ({ kind: "setquizcomplete", objRef: { type: "string", value: `_player.${id}` } });
	const refs = [
		{ id: "first", title: "Summary", events: [{ kind: "onslidestart", actions: [complete()] }] },
		{ id: "second", title: "Wrap up", events: [{ kind: "onslidestart", actions: [complete()] }] },
		{ id: "ordinary", title: "Results", events: [] },
		{ id: "button", title: "Practice", events: [{ kind: "onrelease", actions: [complete()] }] },
		{ id: "unknown", title: "Another page", events: [{ kind: "onslidestart", actions: [complete("unknown")] }] },
	].map(({ id, title, events }) => {
		const html5url = `${id}.js`;
		writeFileSync(join(root, html5url), provide("slide", { events, slideLayers: [{ isBaseLayer: true, objects: [textObj(id, 0, [para([span(`Text for ${id}`, id === "first" ? { fontFamily: "Lato" } : {})])])] }] }));
		return { id, title, html5url };
	});
	writeFileSync(join(root, "html5/data/js/data.js"), provide("data", { quizzes: [{ id: "quiz" }], scenes: [{ id: "only-results", slides: refs.slice(0, 1) }, { id: "scene", slides: refs.slice(1) }] }));
	const course = extractStoryline(root);
	assert.equal(course.lessons.length, 1, "a scene containing only results leaves no empty lesson");
	assert.equal(course.theme?.bodyFont, "Lato", "dropping results preserves the source theme inventory");
	assert.deepEqual(course.lessons[0]!.pages.map((p) => p.title), ["Results", "Practice", "Another page"]);
	assert.ok(course.sourceText.includes("Text for first"), "dropped content stays in the independent source inventory");
	const losses = course.losses.filter((l) => l.source === "storyline:results");
	assert.equal(losses.length, 1);
	assert.equal(losses[0]!.effect, "dropped");
	assert.match(losses[0]!.detail, /Studio reports the score itself: scene only-results\/slide first, scene scene\/slide second$/);
	const out = join(tmp(), "course");
	const report = await importPackage(root, out);
	const prax = readFileSync(join(out, report.lessons[0]!.file), "utf8");
	assert.doesNotMatch(prax, /Text for first|Text for second/);
	assert.match(prax, /Text for ordinary/);
});

test("variable references remain readable in spans, HTML and glyph-only text, with literal percents decoded", async () => {
	const objects = [
		textObj("styled", 0, [para([span("Value "), span("%Results.Total%"), span("^%^")])]),
		textObj("html", 1, [], { textLib: [{ vartext: "<p>HTML %Counter%^%^</p>" }] }),
		textObj("glyphs", 2, [], { textLib: [{ glyphs: [] }], data: { vectorData: { altText: "Glyph %Counter%^%^" } } }),
		textObj("constant", 3, [para([span("Fixed 50^%^")])]),
		textObj("variable-only", 4, [para([span("%Name%")])]),
	];
	const result = await importQuestion(questionPackage({}, objects));
	for (const expected of ["Value %Results.Total%%", "HTML %Counter%%", "Glyph %Counter%%", "Fixed 50%", "%Name%"]) {
		assert.ok(result.prax.includes(expected), expected);
		assert.ok(result.course.sourceText.includes(expected), expected);
	}
	assert.doesNotMatch(result.prax, /\^%\^/);
	assert.ok(result.report.losses.some((l) => l.source === "storyline:variable" && l.effect === "approximated" && /kept as source text in 4 text object\(s\)/.test(l.detail)));
});

/** Entirely synthetic interaction data; real package content stays out of fixtures. */
function questionPackage(interaction: Record<string, unknown>, objects: unknown[] = []): string {
	const dir = tmp();
	mkdirSync(join(dir, "html5/data/js"), { recursive: true });
	writeFileSync(join(dir, "story.html"), "<!doctype html><html lang='en'></html>");
	writeFileSync(join(dir, "picture.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
	writeFileSync(join(dir, "html5/data/js/data.js"), provide("data", { scenes: [{ id: "scene", slides: [{ id: "slide", title: "Practice", html5url: "html5/data/js/slide.js", interactions: Object.keys(interaction).length ? [interaction] : [] }] }] }));
	writeFileSync(join(dir, "html5/data/js/slide.js"), provide("slide", { id: "slide", width: 800, height: 600, slideLayers: [
		{ isBaseLayer: true, objects },
		{ id: "ok", objects: [textObj("yes", 0, [para([span("That fits.")])])] },
		{ id: "no", objects: [textObj("no", 0, [para([span("Try once more.")])])] },
	] }));
	return dir;
}

const answer = (statements: unknown[], status = "correct") => ({ status, evaluate: { statements }, actions: [{ kind: "show_slidelayer", objRef: { value: status === "correct" ? "ok" : "no" } }] });
const pair = (choice: string, statement: string) => ({ kind: "pair", choiceid: `choices.${choice}`, statementid: `statements.${statement}` });
const response = (statement: string, valueb: string) => ({ kind: "addpairresponse", valuea: `statements.${statement}`, valueb });

const attemptAction = (operator: string, limit: number, layer: string, id = "quiz") => ({
	kind: "if_action", condition: { statement: { kind: "compare", operator, valuea: `${id}.$AttemptCount`, typea: "property", valueb: limit, typeb: "number" } },
	thenActions: [{ kind: "show_slidelayer", objRef: { value: layer } }],
});

test("survey and free-response answer layers are omitted with a source pointer, without attaching feedback", async () => {
	for (const type of ["multiplechoice", "likert", "essay", "shortanswer"]) {
		const root = questionPackage({ id: "survey", type, issurvey: type !== "shortanswer", lmstext: "Your view?", choices: [{ id: "a", lmstext: "Low" }, { id: "b", lmstext: "High" }], answers: [answer([{ kind: "equals", choiceid: "choices.a" }]), answer([], "incorrect")] });
		const file = join(root, "html5/data/js/slide.js");
		const slide = provided(file) as { slideLayers: unknown[] };
		slide.slideLayers.push({ id: "detail", objects: [textObj("detail", 0, [para([span("More detail")]), para([span("Keep this explanation.")])])] });
		writeFileSync(file, provide("slide", slide));
		const { blocks, prax, course } = await importQuestion(root);
		assert.doesNotMatch(prax, /That fits|Try once more|correct:|incorrect:/);
		assert.ok(course.sourceText.includes("That fits."), "omitted response text remains in the independent inventory");
		assert.deepEqual(course.losses.filter((l) => l.source === "storyline:feedback").map((l) => [l.at, l.effect]), [["scene scene/slide slide/interaction survey/layer ok", "approximated"], ["scene scene/slide slide/interaction survey/layer no", "approximated"]]);
		assert.deepEqual(blocks.find((b) => b.kind === "container")?.items, [{ title: "More detail", blocks: [{ kind: "paragraph", text: "Keep this explanation." }] }]);
	}
});

test("layer titles consume only a short first text block and preserve the remaining reading order", async () => {
	const root = questionPackage({});
	const file = join(root, "html5/data/js/slide.js");
	const lines = (value: string, tab = 0) => textObj(`text-${tab}`, tab, [para([span(value)])]);
	writeFileSync(file, provide("slide", { slideLayers: [
		{ isBaseLayer: true, objects: [] },
		{ id: "short", objects: [lines("Body follows.", 2), lines("Short title", 1)] },
		{ id: "long", objects: [lines("x".repeat(120)), lines("After long text.", 1)] },
		{ id: "multiline", objects: [lines("First line\nSecond line")] },
		{ id: "picture", objects: [{ kind: "svgimage", tabIndex: 0, data: { imagedata: { url: "picture.png", altText: "Dot" } } }, lines("After the picture.", 1)] },
	] }));
	const { blocks, prax } = await importQuestion(root);
	const accordion = blocks.find((b) => b.kind === "container");
	assert.ok(accordion);
	assert.deepEqual(accordion.items.map((i) => i.title), ["Short title", "Layer 3", "Layer 4", "After the picture."]);
	assert.deepEqual(accordion.items[0]!.blocks, [{ kind: "paragraph", text: "Body follows." }]);
	assert.equal(prax.match(/Short title/g)?.length, 1);
	assert.equal(accordion.items[1]!.blocks.length, 2);
	assert.equal(accordion.items[2]!.blocks.length, 1);
	assert.deepEqual(accordion.items[3]!.blocks.map((b) => b.kind), ["image"]);
});

test("recorded answer bounds place a question beside a picture, including scaled groups and entry fields", async () => {
	const interaction = { id: "quiz", type: "multiplechoice", lmstext: "Choose a material", choices: [{ id: "choice_a", lmstext: "Wool" }, { id: "choice_b", lmstext: "Linen" }], answers: [answer([{ kind: "equals", choiceid: "choices.choice_a" }])] };
	const picture = { kind: "svgimage", id: "picture", tabIndex: 0, xPos: 0, yPos: 100, width: 200, height: 200, data: { imagedata: { url: "picture.png", altText: "Two materials" } } };
	const choices = ["a", "b"].map((id, i) => textObj(id, i + 2, [para([span(i ? "Linen" : "Wool")])], { accType: "radio", xPos: 250, yPos: 120 + i * 60, width: 200, height: 40 }));
	const root = questionPackage(interaction, [picture, ...choices]);
	const result = await importQuestion(root);
	const column = result.blocks[0];
	assert.ok(column?.kind === "columns");
	assert.deepEqual(column.columns.map((c) => c.map((b) => b.kind)), [["image"], ["choice"]]);
	assert.match(result.prax, /as: col[\s\S]*as: col[\s\S]*as: choice[\s\S]*close: col/);
	const read = (objects: unknown[]) => extractStoryline(questionPackage(interaction, objects)).lessons[0]!.pages[0]!.blocks;
	assert.ok(read([picture, { kind: "objgroup", xPos: 250, yPos: 100, scaleX: 50, scaleY: 50, objects: choices.map((o, i) => ({ ...o, xPos: 0, yPos: 40 + i * 120 })) }]).some((b) => b.kind === "columns"));
	const reversed = read([{ ...picture, xPos: 500 }, ...choices])[0];
	assert.ok(reversed?.kind === "columns");
	assert.deepEqual(reversed.columns.map((c) => c.map((b) => b.kind)), [["choice"], ["image"]]);
	for (const objects of [
		[{ ...picture, xPos: 300 }, ...choices],
		[{ ...picture, yPos: 400 }, ...choices],
		[picture, ...choices.map((o) => ({ ...o, width: undefined }))],
		[picture, ...choices.map((o) => ({ ...o, rotation: 10 }))],
		[picture, { kind: "objgroup", rotation: 10, objects: choices }],
	]) assert.ok(!read(objects).some((b) => b.kind === "columns"));
	const entry = extractStoryline(questionPackage({ id: "entry", type: "essay", lmstext: "Describe the material", issurvey: true }, [picture, { kind: "textinput", id: "input", tabIndex: 1, xPos: 250, yPos: 120, width: 200, height: 100 }])).lessons[0]!.pages[0]!.blocks[0];
	assert.ok(entry?.kind === "columns");
	assert.equal(entry.columns[1]![0]?.kind, "freeResponse");
});

test("choice families prefer referenced visible captions, including groups and glyph text, with label fallback", async () => {
	for (const type of ["multiplechoice", "multipleresponse", "truefalse"]) {
		const interaction = { id: "quiz", type, lmstext: "Select the material", choices: [
			{ id: "choice_a", lmstext: "Choice A" }, { id: "choice_b", lmstext: "Choice B" }, { id: "choice_c", lmstext: "Fallback" }, { id: "choice_d", lmstext: "Old caption" },
			{ id: "choice_e", lmstext: "Picture option" }, { id: "choice_f", lmstext: "Choice F" }, { id: "choice_g", lmstext: "Image choice" },
		], answers: [answer([{ kind: "equals", choiceid: "choices.choice_a" }])] };
		const result = await importQuestion(questionPackage(interaction, [
			{ kind: "objgroup", id: "a", accType: type === "multipleresponse" ? "checkbox" : "radio", objects: [
				textObj("letter", 0, [para([span("A")])], { accType: "button" }),
				textObj("caption", 1, [para([span("Wool [soft]")])]),
			] },
			{ kind: "vectorshape", id: "b", accType: "radio", textLib: [{ type: "vectortext" }], data: { vectorData: { altText: "Linen" } } },
			textObj("c", 3, [para([span(" ")])]),
			textObj("opaque", 4, [para([span("Cotton")])], { connectdata: "choices.choice_d" }),
			{ kind: "stategroup", id: "e", objects: [{ kind: "vectorshape", id: "e", accType: "image" }, textObj("selected", 5, [para([span("Selected")])])] },
			{ kind: "stategroup", id: "f", objects: [textObj("f", 6, [para([span("Silk")])]), textObj("visited", 7, [para([span("Visited")])])] },
			{ kind: "svgimage", id: "g", data: { imagedata: { altText: "An illustration" } } },
		]));
		const q = result.blocks.find((b) => b.kind === "choice");
		assert.equal(q?.kind, "choice");
		if (q?.kind !== "choice") continue;
		assert.deepEqual(q.options, [{ text: "Wool [soft]", correct: true }, { text: "Linen", correct: false }, { text: "Fallback", correct: false }, { text: "Cotton", correct: false }, { text: "Picture option", correct: false }, { text: "Silk", correct: false }, { text: "Image choice", correct: false }]);
		assert.equal(q.multiple, type === "multipleresponse");
		assert.doesNotMatch(result.prax, /Choice [AB]|Old caption/);
		assert.ok(result.course.sourceText.includes("Wool [soft]"));
		assert.ok(!result.course.sourceText.includes("Choice A"));
	}
});

test("matching and word-bank labels also use referenced object text", async () => {
	const choices = [{ id: "choice_a", lmstext: "Choice A" }, { id: "choice_b", lmstext: "Choice B" }];
	const objects = [textObj("a", 1, [para([span("Wool")])]), textObj("b", 2, [para([span("Linen")])]), textObj("target", 3, [para([span("Fabric")])])];
	const matching = await importQuestion(questionPackage({ id: "quiz", type: "matching", choices, statements: [{ id: "statement_target", lmstext: "Target A" }], answers: [answer([pair("choice_a", "statement_target"), pair("choice_b", "statement_target")])] }, objects));
	assert.deepEqual(matching.blocks.find((b) => b.kind === "categorize"), { kind: "categorize", prompt: "Question", scored: true, categories: [{ name: "Fabric", items: ["Wool", "Linen"] }], correct: "That fits." });
	const bank = await importQuestion(questionPackage({ id: "quiz", type: "wordbank", lmstext: "Choose ____.", choices, answers: [answer([{ kind: "equals", choiceid: "choices.choice_a" }])] }, objects.slice(0, 2)));
	assert.match(bank.prax, /bank: Wool \| Linen/);
	assert.match(bank.prax, /Choose \{Wool\}\./);
});

test("feedback uses final attempt branches and drops marked titles and a short top line above the message", async () => {
	const interaction = { id: "quiz", type: "multiplechoice", lmstext: "Pick a material", choices: [{ id: "a", lmstext: "Wool" }, { id: "b", lmstext: "Tin" }], answers: [
		{ ...answer([{ kind: "equals", choiceid: "choices.a" }]), actions: [attemptAction("lte", 3, "ok")] },
		// Final first: source ordering must not decide which feedback is final.
		{ status: "incorrect", evaluate: { statements: [{ kind: "other" }] }, actions: [attemptAction("gte", 3, "no"), attemptAction("lt", 3, "retry")] },
	] };
	const dir = questionPackage(interaction);
	const file = join(dir, "html5/data/js/slide.js");
	const slide = provided(file);
	slide.slideLayers = [
		{ isBaseLayer: true, objects: [] },
		{ id: "ok", name: "Réussi", objects: [
			textObj("layer-title", 0, [para([span("Réussi")])]),
			textObj("role-title", 1, [para([span("Outcome")])], { role: "heading" }),
			textObj("styled-title", 2, [para([span("Result")], { tagType: "H2" })]),
			textObj("message", 3, [para([span("Correct")])]),
		] },
		{ id: "no", objects: [textObj("body", 0, [para([span("Incorrect")])]), textObj("body2", 1, [para([span("Review the material.")])])] },
		{ id: "retry", objects: [textObj("retry-text", 0, [para([span("Select again.")])])] },
	];
	writeFileSync(file, provide("slide", slide));
	const result = await importQuestion(dir);
	assert.match(result.prax, /attempts: 3\nfeedbackMode: retry\ncorrect: Correct\nincorrect: Review the material\./);
	assert.ok(result.report.losses.some((l) => l.source === "storyline:feedback" && /1 incorrect feedback layer title/.test(l.detail)));
	assert.doesNotMatch(result.prax, /Réussi|Outcome|Result|Select again/);
	assert.ok(result.report.losses.some((l) => l.source === "storyline:feedback" && l.effect === "approximated" && /1 retry layer/.test(l.detail)));
	assert.ok(result.course.sourceText.includes("Select again."), "inventory retains omitted retry text");
	// The same retry/final decision expressed with an else branch.
	interaction.answers[1]!.actions = [{ ...attemptAction("lt", 3, "retry"), elseActions: attemptAction("gte", 3, "no").thenActions } as ReturnType<typeof attemptAction>];
	const dataFile = join(dir, "html5/data/js/data.js");
	const data = provided(dataFile) as { scenes: Array<{ slides: Array<{ interactions: unknown[] }> }> };
	data.scenes[0]!.slides[0]!.interactions = [interaction];
	writeFileSync(dataFile, provide("data", data));
	const branches = await importQuestion(dir);
	assert.doesNotMatch(branches.prax, /Select again/);
	assert.match(branches.prax, /incorrect: Review the material\./);
	assert.ok(branches.report.losses.some((l) => /3 correct feedback layer title/.test(l.detail)), "marked titles beside a message are counted");
	// A heading-marked object that is the layer's only text is the message itself.
	(slide.slideLayers as unknown[])[2] = { id: "no", objects: [textObj("only", 0, [para([span("Disconnect the supply first.")])], { role: "heading" })] };
	writeFileSync(file, provide("slide", slide));
	assert.match((await importQuestion(dir)).prax, /incorrect: Disconnect the supply first\./);
});

test("attempt cutoffs belong to the current interaction and conflicting counts are not invented", async () => {
	for (const [actions, expected] of [
		[[attemptAction("gte", 2, "no")], 2],
		[[attemptAction("gte", 1, "no")], 1],
		[[attemptAction("gte", 2, "no", "other")], undefined],
		[[attemptAction("gte", 2, "no"), attemptAction("gte", 3, "no")], undefined],
		[[attemptAction("gte", 2.5, "no")], undefined],
	] as const) {
		const result = await importQuestion(questionPackage({ id: "quiz", type: "fillin", lmstext: "Name a material", choices: [{ id: "a", lmstext: "wool" }], answers: [answer([]), { status: "incorrect", actions }] }));
		const q = result.blocks.find((b) => b.kind === "fillBlank");
		assert.equal(q?.kind === "fillBlank" ? q.attempts : undefined, expected);
		if (expected === 2) assert.match(result.prax, /attempts: 2\nfeedbackMode: retry/);
		else assert.doesNotMatch(result.prax, /attempts:|feedbackMode:/);
	}
});

async function importQuestion(dir: string) {
	const { extractStoryline } = await import("../src/extract/storyline.ts");
	const course = extractStoryline(dir);
	const out = join(tmp(), "course");
	const report = await importPackage(dir, out);
	const prax = readFileSync(join(out, report.lessons[0]!.file), "utf8");
	return { course, blocks: course.lessons[0]!.pages[0]!.blocks, report, prax };
}

test("Likert becomes a matrix or a single rating with source labels", async () => {
	const interaction = { id: "likert", type: "likert", lmstext: "Rate these statements", choices: [{ id: "low", lmstext: "Rarely" }, { id: "high" }], statements: [{ id: "a", lmstext: "I can find help" }, { id: "b", lmstext: "I can find tools" }] };
	const labels = [textObj("high", 0, [para([span("Often")])])];
	const matrix = await importQuestion(questionPackage(interaction, labels));
	assert.deepEqual(matrix.blocks.find((b) => b.kind === "matrix"), { kind: "matrix", prompt: "Rate these statements", scale: ["Rarely", "Often"], statements: ["I can find help", "I can find tools"] });
	assert.match(matrix.prax, /as: matrix\nwidth: wide\n\n1: Rarely\n2: Often\n\n- I can find help\n- I can find tools/);
	assert.ok(matrix.course.sourceText.includes("Often"), "inventory reads slide labels without deriving them from the mapping");
	const rating = await importQuestion(questionPackage({ ...interaction, statements: interaction.statements.slice(0, 1) }, labels));
	assert.match(rating.prax, /## I can find help\nas: rating\ndisplay: scenario\ndescription: Rate these statements\n\n1: Rarely\n2: Often/);
	const missing = await importQuestion(questionPackage(interaction));
	assert.ok(missing.report.losses.some((l) => l.source === "storyline:question/likert" && /incomplete/.test(l.detail)));
});

test("sequence uses answer positions, consumes its controller and retains feedback", async () => {
	const result = await importQuestion(questionPackage({ id: "sequence", type: "sequence", lmstext: "Arrange the steps", choices: [{ id: "c", lmstext: "Finish" }, { id: "a", lmstext: "Start" }, { id: "b", lmstext: "Work" }], statements: [{ id: "s2", lmstext: "2" }, { id: "s3", lmstext: "3" }, { id: "s1", lmstext: "1" }], responseDefinition: { actions: [response("s2", "list.#_pos1"), response("s1", "list.#_pos0"), response("s3", "list.#_pos2")] }, answers: [answer([pair("b", "s2"), pair("c", "s3"), pair("a", "s1")]), answer([{ kind: "other" }], "incorrect")] }, [
		{ id: "list", kind: "sequencectrl", data: { itemlist: [{ textdata: { altText: "Start" } }] } },
		{ id: "unrelated", kind: "sequencectrl" },
	]));
	assert.match(result.prax, /as: order\nscored: true\ncorrect: That fits\.\nincorrect: Try once more\.\n\n1\. Start\n2\. Work\n3\. Finish/);
	assert.equal(result.report.losses.filter((l) => l.source === "storyline:sequencectrl").length, 1, "only the bound controller is consumed");
	assert.ok(result.course.sourceText.includes("Start"));
	const incomplete = await importQuestion(questionPackage({ id: "bad", type: "sequence", choices: [{ id: "a", lmstext: "Start" }], statements: [{ id: "s1", lmstext: "1" }], answers: [answer([pair("missing", "s1")])] }));
	assert.ok(incomplete.report.losses.some((l) => /no complete/.test(l.detail)));
	assert.match(incomplete.prax, /That fits\./, "a rejected question does not consume feedback layers");
});

test("matching accounts for linked drag pieces and groups many-to-one keys as categories", async () => {
	const interaction = { id: "match", type: "matching", lmstext: "Match the materials", choices: [{ id: "choice_a", lmstext: "Tin" }, { id: "choice_b", lmstext: "Pine" }], statements: [{ id: "statement_metal", lmstext: "Metal" }, { id: "statement_wood", lmstext: "Wood" }], answers: [answer([pair("choice_a", "statement_metal"), pair("choice_b", "statement_wood")]), answer([{ kind: "other" }], "incorrect")] };
	const result = await importQuestion(questionPackage(interaction, [
		{ kind: "dragitem", id: "opaque-id", connectdata: "choices.choice_a", data: { textdata: { altText: "Tin" } } },
		{ kind: "dragitem", id: "b", connectdata: "choices.choice_b" },
		{ kind: "droparea", id: "metal" }, { kind: "droparea", id: "wood" }, { kind: "droparea", id: "unrelated" },
	]));
	assert.match(result.prax, /as: match\nscored: true\nshuffle: true\ncorrect: That fits\.\nincorrect: Try once more\.\n\nTin :: Metal\nPine :: Wood/);
	assert.equal(result.report.losses.filter((l) => l.source === "storyline:droparea").length, 1);
	assert.equal(result.report.losses.filter((l) => l.source === "storyline:dragitem").length, 0);
	const categories = await importQuestion(questionPackage({ ...interaction, answers: [answer([pair("choice_a", "statement_metal"), pair("choice_b", "statement_metal")]), answer([{ kind: "other" }], "incorrect")] }));
	assert.match(categories.prax, /as: categorize\nscored: true\nshuffle: true\ncorrect: That fits\.\nincorrect: Try once more\.\n\nMetal:\n- Tin\n- Pine/);
});

test("word banks place accepted alternatives at their blanks and keep unknown blanks explicit", async () => {
	const choices = [{ id: "c", lmstext: "cold" }, { id: "a", lmstext: "warm" }, { id: "b", lmstext: "hot" }, { id: "d", lmstext: "blue" }];
	const result = await importQuestion(questionPackage({ id: "bank", type: "wordbank", lmstext: "The cup is ____ and the sky is ____; ____ remains.", choices, statements: [{ id: "s1" }, { id: "s2" }, { id: "s3" }], answers: [answer([pair("a", "s1"), pair("b", "s1"), pair("d", "s2")]), answer([{ kind: "other" }], "incorrect")] }));
	assert.match(result.prax, /as: fill-blank\nscored: true\ncorrect: That fits\.\nincorrect: Try once more\.\n\nThe cup is \{warm\|hot\} and the sky is \{blue\}; ____ remains\./);
	assert.ok(result.report.losses.some((l) => /1 blank\(s\).*no readable explicit answer/.test(l.detail)));
	assert.ok(result.report.losses.some((l) => l.source === "fill-blank:word-bank" && /open blank/.test(l.detail)));
	assert.deepEqual(result.blocks.find((b) => b.kind === "fillBlank"), { kind: "fillBlank", scored: true, prompt: "The cup is \\___\\_ and the sky is \\___\\_; \\___\\_ remains.", style: "word-bank", bank: ["cold", "warm", "hot", "blue"], parts: ["The cup is ", { answers: ["warm", "hot"] }, " and the sky is ", { answers: ["blue"] }, "; ", { answers: [] }, " remains."], correct: "That fits.", incorrect: "Try once more." });
	const single = await importQuestion(questionPackage({ id: "single", type: "wordbank", lmstext: "Choose a temperature", choices, responseDefinition: { actions: [{ kind: "addchoiceresponse", value: "slot.$DragConnectData" }] }, answers: [answer([{ kind: "equals", choiceid: "choices.a" }, { kind: "equals", choiceid: "choices.b" }])] }, [
		{ id: "slot", kind: "droparea" }, { id: "drag", kind: "dragitem", connectdata: "choices.a" },
	]));
	assert.match(single.prax, /style: word-bank\nbank: cold \| warm \| hot \| blue\ncorrect: That fits\.\n\n\{warm\|hot\}/);
	assert.ok(!single.report.losses.some((l) => /storyline:(droparea|dragitem)$/.test(l.source)));
});

test("word banks retain repeated entries and distractors, and report insufficient copies", async () => {
	const choices = [{ id: "a", lmstext: "red" }, { id: "b", lmstext: "blue" }, { id: "c", lmstext: "red" }, { id: "d", lmstext: "green" }];
	const interaction = { id: "bank", type: "wordbank", lmstext: "The pattern is ____, ____, then ____.", choices, statements: [{ id: "s1" }, { id: "s2" }, { id: "s3" }], answers: [answer([pair("a", "s1"), pair("b", "s2"), pair("c", "s3")])] };
	const result = await importQuestion(questionPackage(interaction));
	const block = result.blocks.find((b) => b.kind === "fillBlank");
	assert.ok(block?.kind === "fillBlank");
	assert.deepEqual(block.bank, ["red", "blue", "red", "green"]);
	assert.deepEqual(block.parts, ["The pattern is ", { answers: ["red"] }, ", ", { answers: ["blue"] }, ", then ", { answers: ["red"] }, "."]);
	assert.match(result.prax, /style: word-bank\nbank: red \| blue \| red \| green\ncorrect: That fits\.\n\nThe pattern is \{red\}, \{blue\}, then \{red\}\./);
	assert.ok(!result.report.losses.some((l) => /typed blanks|distractor word/.test(l.detail)));
	const insufficient = await importQuestion(questionPackage({ ...interaction, choices: choices.filter((c) => c.id !== "c"), answers: [answer([pair("a", "s1"), pair("b", "s2"), pair("a", "s3")])] }));
	assert.doesNotMatch(insufficient.prax, /style: word-bank/);
	assert.match(insufficient.prax, /The pattern is \{red\}, \{blue\}, then \{red\}\./);
	assert.ok(insufficient.report.losses.some((l) => l.source === "fill-blank:word-bank" && /lacks a copy of "red"/.test(l.detail)));
});

test("hotspot centres use image-relative displayed bounds, including group offsets", async () => {
	const interaction = { id: "hotspots", type: "hotspot", lmstext: "Select the symbol", choices: [{ id: "choice_r", lmstext: "Rectangle" }, { id: "choice_p", lmstext: "Polygon" }, { id: "choice_incorrect", lmstext: "Elsewhere" }], answers: [answer([{ kind: "equals", choiceid: "choices.choice_r" }]), answer([{ kind: "other" }], "incorrect")] };
	const objects = [
		{ kind: "vectorshape", accType: "image", id: "background", xPos: 0, yPos: 0, width: 800, height: 600, imagelib: [{ url: "picture.png" }] },
		{ kind: "vectorshape", accType: "image", id: "image", xPos: 100, yPos: 50, width: 200, height: 100, imagelib: [{ url: "picture.png", width: 1000, height: 500 }], data: { vectorData: { altText: "Two symbols" } } },
		{ kind: "objgroup", xPos: 20, yPos: 10, objects: [{ kind: "vectorshape", id: "r", xPos: 100, yPos: 60, width: 40, height: 20, tabEnabled: false }] },
		{ kind: "vectorshape", id: "p", xPos: 250, yPos: 100, width: 20, height: 20, data: { shape: "polygon" } },
	];
	const result = await importQuestion(questionPackage(interaction, objects));
	assert.deepEqual(result.blocks.find((b) => b.kind === "hotspot"), { kind: "hotspot", scored: true, prompt: "Select the symbol", src: "picture.png", alt: "Two symbols", spots: [{ label: "Rectangle", x: 20, y: 30, correct: true }, { label: "Polygon", x: 80, y: 60, correct: false }] });
	assert.match(result.prax, /as: hotspot\nscored: true\n\n\/assets\/picture.png\nalt: Two symbols\nspot: Rectangle; 20%; 30%; correct\nspot: Polygon; 80%; 60%/);
	assert.ok(result.report.losses.some((l) => l.effect === "approximated" && /regions?\(s\) became centre points/.test(l.detail)));
	assert.match(result.prax, /That fits\./, "hotspot feedback remains on a layer because its model has no feedback fields");
	const missing = await importQuestion(questionPackage(interaction, objects.slice(2)));
	assert.ok(missing.report.losses.some((l) => /no unambiguous image/.test(l.detail)));
});

test("fill-in keeps feedback from answer layers", async () => {
	const result = await importQuestion(questionPackage({ id: "fill", type: "fillin", lmstext: "Name the material", choices: [{ id: "a", lmstext: "cotton" }], answers: [answer([{ kind: "equals", choiceid: "choices.a" }]), answer([{ kind: "other" }], "incorrect")] }, [{ kind: "textinput", id: "entry" }]));
	assert.match(result.prax, /as: fill-blank\nscored: true\ncorrect: That fits\.\nincorrect: Try once more\.\n\n\{cotton\}/);
});

test("fill-in and numeric answers retain all alternatives and literal punctuation", async () => {
	for (const type of ["fillin", "numeric"]) {
		const values = type === "numeric" ? ["42", "42.0"] : ["a|b", "{cotton}", "~0.5", "*star", "C:\\temp"];
		const result = await importQuestion(questionPackage({ id: "fill", type, lmstext: "Enter the value", choices: values.map((lmstext, i) => ({ id: String(i), lmstext })), answers: values.map((_, i) => answer([{ kind: "equals", choiceid: `choices.${i}` }])) }));
		const block = result.blocks.find((b) => b.kind === "fillBlank");
		assert.ok(block?.kind === "fillBlank");
		assert.deepEqual(block.parts, [{ answers: values }]);
		assert.ok(result.prax.includes(type === "numeric" ? "{42|42.0}" : "{a\\|b|\\{cotton\\}|\\~0.5|\\*star|C:\\\\temp}"));
		assert.ok(!result.report.losses.some((l) => /only the first/.test(l.detail)));
	}
});

test("custom drop flags used by completion triggers become matching, unrelated flags do not", async () => {
	const compare = (valuea: string, valueb: unknown, typea: string, typeb: string) => ({ kind: "compare", operator: "eq", valuea, valueb, typea, typeb });
	const set = (variable: string) => ({ kind: "adjustvar", variable, operator: "set", value: { type: "boolean", value: true } });
	const drag = (id: string, target: string, flag: string, label: string) => ({ kind: "objgroup", id, dragdrop: { dragenabled: true }, objects: [textObj(`${id}-text`, 0, [para([span(label)])])], events: [{ kind: "ondragconnect", actions: [{ kind: "if_action", condition: { statement: { kind: "and", statements: [compare("$DropTargetId", target, "property", "string")] } }, thenActions: [set(flag)] }] }] });
	const objects = [drag("a", "t1", "_player.One", "Alpha"), drag("b", "t2", "_player.Two", "Beta"),
		textObj("t1", 1, [para([span("____")])], { dragdrop: { dropenabled: true } }), textObj("t2", 2, [para([span("____")])], { dragdrop: { dropenabled: true } }),
		{ kind: "vectorshape", id: "gate", events: [{ actions: [{ kind: "if_action", condition: { statement: { kind: "and", statements: [compare("_player.#One", true, "var", "boolean"), compare("_player.#Two", true, "var", "boolean")] } }, thenActions: [set("_player.Done")] }] }] },
	];
	const result = await importQuestion(questionPackage({}, objects));
	assert.match(result.prax, /as: match\nshuffle: true\n\nAlpha :: Target 1\nBeta :: Target 2/);
	assert.ok(result.report.losses.some((l) => l.source === "storyline:dragdrop" && l.effect === "approximated" && /completion/.test(l.detail)));
	assert.ok(!result.report.losses.some((l) => l.source === "storyline:dragdrop" && l.effect === "dropped"));
	const noGate = await importQuestion(questionPackage({}, objects.slice(0, -1)));
	assert.ok(!noGate.blocks.some((b) => b.kind === "match"));
	assert.ok(noGate.report.losses.some((l) => /no mapped answer key/.test(l.detail)));
	const unrelated = await importQuestion(questionPackage({}, [...objects, { kind: "objgroup", id: "unrelated", dragdrop: { dragenabled: true } }]));
	assert.ok(unrelated.blocks.some((b) => b.kind === "match"));
	assert.ok(unrelated.report.losses.some((l) => l.source === "storyline:dragdrop" && l.effect === "dropped" && /1 drag-and-drop/.test(l.detail)), "unbound drag objects are still reported");
});

test("word-bank blanks follow bound field order and literal answer syntax cannot create blanks", async () => {
	const result = await importQuestion(questionPackage({ id: "bank", type: "wordbank", lmstext: "First ____ then ____.", choices: [{ id: "a", lmstext: "A{B}|C" }, { id: "b", lmstext: "second" }], statements: [{ id: "s2" }, { id: "s1" }], responseDefinition: { actions: [response("s2", "last.$DragConnectData"), response("s1", "first.$DragConnectData")] }, answers: [answer([pair("b", "s2"), pair("a", "s1")])] }, [{ kind: "droparea", id: "last", tabIndex: 2 }, { kind: "droparea", id: "first", tabIndex: 1 }]));
	assert.ok(result.prax.includes("bank: A\\{B\\}\\|C | second"));
	assert.ok(result.prax.includes("First {A\\{B\\}\\|C} then {second}."));
	assert.ok(!result.report.losses.some((l) => /literal braces or pipes/.test(l.detail)));
	const unknown = await importQuestion(questionPackage({ id: "unknown", type: "wordbank", lmstext: "First ____ then ____.", choices: [{ id: "a", lmstext: "word" }], answers: [answer([{ kind: "equals", choiceid: "choices.a" }])] }));
	assert.match(unknown.prax, /\nFirst ____ then ____\./);
	assert.ok(unknown.report.losses.some((l) => /2 blank\(s\).*no readable explicit answer/.test(l.detail)));
});

test("hotspot response references resolve opaque region ids; bad geometry stays a loss", async () => {
	const interaction = { id: "opaque", type: "hotspot", lmstext: "Choose the circle", choices: [{ id: "choice", lmstext: "Circle" }], responseDefinition: { actions: [{ kind: "if_action", condition: { statement: { kind: "hittestpoint", objRef: { value: "region" } } }, thenActions: [{ kind: "addchoiceresponse", value: "choices.choice" }] }] }, answers: [answer([{ kind: "equals", choiceid: "choices.choice" }])] };
	const image = { kind: "svgimage", id: "image", xPos: 0, yPos: 0, data: { imagedata: { url: "picture.png", width: 200, height: 100, altText: "Circle drawing" } } };
	const region = { kind: "vectorshape", id: "region", xPos: 90, yPos: 40, width: 20, height: 20 };
	const result = await importQuestion(questionPackage(interaction, [image, region]));
	assert.match(result.prax, /alt: Circle drawing\nspot: Circle; 50%; 50%; correct/);
	for (const bad of [{ ...region, width: 0 }, { ...region, rotation: 30 }]) {
		const rejected = await importQuestion(questionPackage(interaction, [image, bad]));
		assert.ok(rejected.report.losses.some((l) => l.source === "storyline:question/hotspot" && /geometry/.test(l.detail)));
		assert.ok(!rejected.blocks.some((b) => b.kind === "hotspot"));
	}
});

test("dominant opaque slide background uses slide counts and deterministic ties", () => {
	const root = tmp();
	mkdirSync(join(root, "html5/data/js"), { recursive: true });
	const fill = (rgb: string, alpha = 100) => ({ type: "fill", fill: { type: "linear", colors: [{ kind: "color", rgb, alpha }] } });
	const backgrounds = [fill("0xABCDEF"), fill("0xabcdef"), fill("0x123456"), fill("0x000000", 50), { type: "fill", fill: { type: "linear", colors: [{ kind: "color", rgb: "0x000000", alpha: 100 }, { kind: "color", rgb: "0xffffff", alpha: 100 }] } }, { type: "swf" }];
	const write = () => {
		writeFileSync(join(root, "html5/data/js/data.js"), provide("data", { scenes: [
			{ id: "scene", slides: backgrounds.map((_, i) => ({ id: String(i), html5url: `slide${i}.js` })) },
			{ id: "messages", isMessageScene: true, slides: [{ id: "message", html5url: "slide2.js" }] },
		] }));
		backgrounds.forEach((background, i) => writeFileSync(join(root, `slide${i}.js`), provide("slide", { background, slideLayers: [] })));
	};
	write();
	const course = extractStoryline(root);
	assert.equal(course.theme?.background, "#abcdef");
	assert.equal(course.losses.filter((l) => l.source === "storyline:theme" && l.effect === "approximated").length, 1);
	backgrounds.push(fill("0x123456"));
	write();
	assert.equal(extractStoryline(root).theme?.background, "#123456");
	backgrounds.reverse();
	write();
	assert.equal(extractStoryline(root).theme?.background, "#123456");
	assert.deepEqual(extractStoryline(root).sourceText, course.sourceText);
});

test("glyph height per line ranks heroes and headings; recorded list styles survive", () => {
	const root = tmp();
	mkdirSync(join(root, "html5/data/js"), { recursive: true });
	writeFileSync(join(root, "picture.png"), "png");
	writeFileSync(join(root, "html5/data/js/data.js"), provide("data", { scenes: [{ id: "scene", slides: [{ id: "s", html5url: "slide.js" }] }] }));
	const glyph = (id: string, value: string, height: number, order: number, x = 10, y = 30) => ({ kind: "vectorshape", accType: "text", id, tabIndex: order, xPos: x, yPos: y, width: 300, height, textLib: [{ vectortext: { left: 0, top: 0, right: 300, bottom: height } }], data: { vectorData: { altText: value } } });
	const picture = { kind: "vectorshape", accType: "image", xPos: 0, yPos: 0, width: 800, height: 600, imagelib: [{ url: "picture.png" }] };
	const read = (objects: unknown[]) => {
		writeFileSync(join(root, "slide.js"), provide("slide", { width: 800, height: 600, slideLayers: [{ isBaseLayer: true, objects }] }));
		return extractStoryline(root);
	};
	const body = glyph("body", "First line\nSecond line\nThird line", 90, 3);
	const title = glyph("title", "Hero title", 60, 2);
	const kicker = glyph("kicker", "Kicker", 28, 1);
	let course = read([picture, body, kicker, title]);
	assert.deepEqual(course.lessons[0]!.pages[0]!.blocks[0], { kind: "heading", level: 1, text: "Hero title", subtitle: "Kicker", background: { src: "picture.png", alt: "" } });
	assert.equal(course.theme?.contentWidth, 800);
	const glyphWithPaths = { ...body, data: { vectorData: { altText: "Wrapped body text" } }, textLib: [{ vectortext: { top: 0, bottom: 90, pr: { l: "Lib", i: 0 } } }] };
	writeFileSync(join(root, "html5/data/js/paths.js"), provide("paths", { Lib: { "commandset-0": { children: [10, 40, 70].map((y) => ({ nodeType: "tspan", y })) } } }));
	assert.equal(read([picture, glyphWithPaths, kicker, title]).lessons[0]!.pages[0]!.blocks[0]?.kind, "heading");
	const hero = read([picture, glyphWithPaths, kicker, title]).lessons[0]!.pages[0]!.blocks[0]!;
	assert.ok(hero.kind === "heading" && hero.text === "Hero title");
	const image = { ...picture, xPos: 0, yPos: 180, width: 200, height: 180, tabIndex: 3 };
	course = read([title, glyph("small", "Smaller line", 30, 1), glyph("small2", "Another line", 30, 2), image, glyph("aside", "Text beside image", 30, 4, 220, 200)]);
	assert.deepEqual(course.lessons[0]!.pages[0]!.blocks.map((b) => b.kind), ["paragraph", "heading", "paragraph", "columns"]);
	const list = textObj("list", 0, [para([span("First")], { listStyle: { listType: "bullet" } }), para([span("Second")], { listStyle: { listType: "bullet" } }), para([span("Third")], { listStyle: { listType: "numbered" } }), para([span("Plain")], { listStyle: { listType: "none" } })]);
	assert.deepEqual(read([list]).lessons[0]!.pages[0]!.blocks, [{ kind: "list", ordered: false, items: ["First", "Second"] }, { kind: "list", ordered: true, items: ["Third"] }, { kind: "paragraph", text: "Plain" }]);
});

test("glyph hero overlays use the text's own fill, including light colours below half luminance", () => {
	const root = tmp();
	mkdirSync(join(root, "html5/data/js"), { recursive: true });
	writeFileSync(join(root, "html5/data/js/data.js"), provide("data", { scenes: [{ id: "scene", slides: [{ id: "s", html5url: "slide.js" }] }] }));
	const picture = { kind: "vectorshape", accType: "image", xPos: 0, yPos: 0, width: 800, height: 600, imagelib: [{ url: "photo.png" }] };
	const title = textObj("title", 1, [], { xPos: 20, yPos: 30, width: 400, height: 60, textLib: [{ vectortext: { top: 0, bottom: 60, pr: { l: "Lib", i: 1 } } }], data: { vectorData: { altText: "Synthetic title", fill: "#000000" } } });
	writeFileSync(join(root, "slide.js"), provide("slide", { width: 800, height: 600, slideLayers: [{ isBaseLayer: true, objects: [picture, title] }] }));
	for (const [fill, overlay] of [["#88aadd", "dark"], ["#fff", "dark"], ["#333", "light"], [undefined, undefined], ["none", undefined]] as const) {
		writeFileSync(join(root, "html5/data/js/paths.js"), provide("paths", { Lib: {
			"commandset-0": { nodeType: "text", "font-size": "90px", fill: "#000000" },
			"commandset-1": { nodeType: "g", children: [{ nodeType: "text", "font-size": "40px", fill, children: [{ nodeType: "tspan", y: 40 }] }] },
		} }));
		const hero = extractStoryline(root).lessons[0]!.pages[0]!.blocks[0];
		assert.ok(hero?.kind === "heading" && hero.background);
		assert.equal(hero.background.overlay, overlay);
	}
});

test("Storyline columns keep consecutive beside text and size standalone displayed pictures", async () => {
	const root = tmp();
	mkdirSync(join(root, "html5/data/js"), { recursive: true });
	writeFileSync(join(root, "html5/data/js/data.js"), provide("data", { scenes: [{ id: "scene", slides: [{ id: "s", html5url: "slide.js" }] }] }));
	writeFileSync(join(root, "photo.png"), "png");
	const picture = { kind: "vectorshape", accType: "image", xPos: 0, yPos: 100, width: 200, height: 200, imagelib: [{ url: "photo.png" }] };
	const caption = (id: string, tab: number, y: number) => textObj(id, tab, [para([span(id)])], { xPos: 220, yPos: y, width: 300, height: 60 });
	const read = (objects: unknown[]) => {
		writeFileSync(join(root, "slide.js"), provide("slide", { width: 1000, height: 600, slideLayers: [{ isBaseLayer: true, objects }] }));
		return extractStoryline(root).lessons[0]!.pages[0]!.blocks;
	};
	const blocks = read([picture, caption("second", 2, 220), caption("first", 1, 110), caption("below", 3, 301), caption("after", 4, 220)]);
	assert.deepEqual(blocks.map((b) => b.kind), ["columns", "paragraph", "paragraph"]);
	assert.ok(blocks[0]?.kind === "columns");
	assert.deepEqual(blocks[0].columns[1], [{ kind: "paragraph", text: "first" }, { kind: "paragraph", text: "second" }]);
	assert.ok(blocks[0].columns[0]?.[0]?.kind === "image" && !blocks[0].columns[0][0].layout);
	const sizes = read([0.349, 0.35, 0.599, 0.6].map((fraction, tabIndex) => ({ ...picture, width: 1000, scaleX: fraction * 100, tabIndex })));
	assert.deepEqual(sizes.map((b) => b.kind === "image" ? b.layout : b.kind), ["small", "medium", "medium", undefined]);
	const output = join(tmp(), "course");
	const report = await importPackage(root, output);
	const prax = readFileSync(join(output, report.lessons[0]!.file), "utf8");
	assert.equal(prax.match(/^size: small$/gm)?.length, 1);
	assert.equal(prax.match(/^size: medium$/gm)?.length, 2);
	for (const extra of [{ rotation: 10 }, { scaleX: -100 }, { width: 0 }]) {
		const image = read([{ ...picture, ...extra }])[0];
		assert.ok(image?.kind === "image" && image.layout === undefined);
	}
});

test("buttons that jump to a slide are a menu list; Next-style buttons stay chrome", async () => {
	const jump = (slide: string) => ({ events: [{ kind: "onrelease", actions: [{ kind: "gotoplay", objRef: { type: "string", value: `_player.scene.${slide}` } }] }] });
	const button = (id: string, tab: number, label: string, extra: Record<string, unknown>) => ({ ...textObj(id, tab, [para([span(label)])]), accType: "button", ...extra });
	const objects = [
		textObj("intro", 0, [para([span("Choose a topic")])]),
		button("b1", 1, "First topic", jump("s1")),
		button("b2", 2, "Second topic", jump("s2")),
		button("next", 3, "Next", { events: [{ kind: "onrelease", actions: [{ kind: "exe_actiongroup", objRef: { type: "string", value: "_player.NextSlide" } }] }] }),
	];
	const { blocks, report } = await importQuestion(questionPackage({}, objects));
	assert.deepEqual(blocks.slice(0, 2), [{ kind: "paragraph", text: "Choose a topic" }, { kind: "list", ordered: false, items: ["First topic", "Second topic"] }]);
	assert.ok(report.losses.some((l) => l.source === "storyline:menu" && /2 menu button/.test(l.detail)));
	assert.ok(report.losses.some((l) => l.source === "storyline:button" && /"Next"/.test(l.detail)));
	const lone = await importQuestion(questionPackage({}, [textObj("intro", 0, [para([span("Welcome")])]), button("start", 1, "Start course", jump("s1"))]));
	assert.ok(!lone.blocks.some((b) => b.kind === "list"), "a single jump button is navigation, not a menu");
	assert.ok(lone.report.losses.some((l) => l.source === "storyline:button" && /"Start course"/.test(l.detail)));
	assert.ok(!lone.report.losses.some((l) => l.source === "storyline:menu"));
});

test("Likert consumes scale headers and generic labels, preserving unrelated text", async () => {
	const interaction = { id: "scale", type: "likert", issurvey: true, lmstext: "Rate the examples", choices: [{ id: "a", lmstext: "Low" }, { id: "b", lmstext: "High" }], statements: [{ id: "x", lmstext: "First row" }, { id: "y", lmstext: "Second row" }] };
	const objects = ["Rate the examples", "1", "2", "Low", "Likert", "Keep this instruction"].map((value, i) => textObj(`label${i}`, i, [para([span(value, { fontSize: 40 })])]));
	const { blocks } = await importQuestion(questionPackage(interaction, objects));
	assert.deepEqual(blocks.filter((b) => b.kind === "paragraph" || b.kind === "heading"), [{ kind: "paragraph", text: "Keep this instruction" }]);
});
