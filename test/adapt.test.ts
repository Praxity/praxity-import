import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importPackage } from "../src/import.ts";
import { extractAdapt } from "../src/extract/adapt.ts";

test("imports an Adapt build: pages become lessons, components become blocks", async () => {
	const root = mkdtempSync(join(tmpdir(), "adapt-"));
	const en = join(root, "course/en");
	mkdirSync(join(en, "images"), { recursive: true });
	writeFileSync(join(en, "images/pic.png"), "png");
	const w = (f: string, v: unknown) => writeFileSync(join(f === "config" ? join(root, "course") : en, `${f}.json`), JSON.stringify(v));
	w("config", { _defaultLanguage: "en" });
	w("course", { _id: "course", title: "Safety", displayTitle: "Safety" });
	w("contentObjects", [{ _id: "co-1", _parentId: "course", _type: "page", title: "P", displayTitle: "Hazards" }]);
	w("articles", [{ _id: "a-1", _parentId: "co-1", displayTitle: "" }]);
	w("blocks", [{ _id: "b-1", _parentId: "a-1", displayTitle: "" }]);
	w("components", [
		{ _id: "c-1", _parentId: "b-1", _component: "graphic", displayTitle: "Wet floors", body: "<p>Mop spills.</p>", _graphic: { large: "course/en/images/pic.png", alt: "Wet floor sign" } },
		{ _id: "c-2", _parentId: "b-1", _component: "mcq", displayTitle: "Check", body: "<p>Which is PPE?</p>", _selectable: 1, _items: [{ text: "Gloves", _shouldBeSelected: true }, { text: "Coffee", _shouldBeSelected: false }], _feedback: { correct: "Yes", _incorrect: { final: "No" }, _partlyCorrect: { final: "Lorem ipsum" } } },
		{ _id: "c-4", _parentId: "b-1", _component: "textinput", displayTitle: "Fill", body: "<p>Complete it.</p>", instruction: "Use the technical term", _items: [{ prefix: "Wear", suffix: "on your hands", _answers: ["gloves", "mitts"] }] },
		{ _id: "c-3", _parentId: "b-1", _component: "hidden", _isHidden: true, body: "<p>never shown</p>" },
	]);
	const out = join(mkdtempSync(join(tmpdir(), "adapt-out-")), "c");
	const report = await importPackage(root, out);
	assert.equal(report.detected.tool, "adapt");
	const prax = readFileSync(join(out, "01-hazards.prax"), "utf8");
	assert.match(prax, /^# Hazards\n\n## Wet floors\n\nMop spills\.\n\n\/assets\/course\/en\/images\/pic\.png\nalt: Wet floor sign$/m, "headings nest under the titled page without skipping levels");
	assert.match(prax, /^## Which is PPE\?\nas: choice\ncorrect: Yes\nincorrect: No\n\n\(x\) Gloves\n\( \) Coffee$/m);
	assert.match(prax, /description: Use the technical term\n\nWear \{gloves\|mitts\} on your hands/, "string answer keys and question instructions survive");
	assert.doesNotMatch(prax, /never shown|Lorem/);
});

test("Adapt CSS theme maps base rules and safely ignores missing or escaping stylesheets", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "adapt-theme-"));
	const outside = mkdtempSync(join(tmpdir(), "adapt-theme-outside-"));
	t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
	mkdirSync(join(root, "course/en"), { recursive: true });
	mkdirSync(join(root, "adapt/css"), { recursive: true });
	writeFileSync(join(root, "course/config.json"), '{"_defaultLanguage":"en"}');
	writeFileSync(join(root, "course/en/course.json"), '{"_id":"course","title":"Theme sample"}');
	writeFileSync(join(root, "course/en/components.json"), "[]");
	assert.equal(extractAdapt(root).theme, undefined);
	const cssPath = join(root, "adapt/css/adapt.css");
	writeFileSync(cssPath, `
		@charset "UTF-8";
		/* Ignore comments containing body { color: #bad; } */
		body { font-family: "Lato", sans-serif; color: #123; background: #fefefe url('tile{1}.png'); }
		h1, h2 { font-family: "Merriweather", serif; }
		.navigation { background-color: #246ABC; }
		.button { background-color: #456 !important; color: #fff; border-radius: 2px; }
		.button { background-color: #999; border-radius: 4px; }
		body .button { color: #000; }
		.button:hover { color: #000; }
		@media (max-width: 600px) { body { color: #999; } .navigation { background: #000; } }
		@supports (display: grid) { @media screen { body { font-family: "Other"; } } }
	`);
	const course = extractAdapt(root);
	assert.deepEqual(course.theme, {
		accent: "#246abc", text: "#112233", background: "#fefefe", buttonBackground: "#445566", buttonText: "#ffffff",
		bodyFont: "Lato", headingFont: "Merriweather", corners: 4,
	});
	assert.equal(course.losses.filter((l) => l.source === "adapt:theme" && l.effect === "approximated").length, 1);
	assert.equal(course.losses.find((l) => l.source === "adapt:theme")?.at, "adapt/css/adapt.css");
	const out = join(outside, "output");
	await importPackage(root, out);
	const yaml = readFileSync(join(out, "course.yaml"), "utf8");
	assert.match(yaml, /colorAccent: "#246abc"/);
	assert.match(yaml, /colorButtonBackground: "#445566"/);
	assert.match(yaml, /fontFamily: \["Lato", "sans-serif"\]/);
	assert.match(yaml, /borderRadius: 4/);
	assert.doesNotMatch(yaml, /navArchetype|logoUrl/);
	writeFileSync(cssPath, 'body { font-family: "Lato", sans-serif; background-color: #abc; background: url(image.png); }');
	assert.equal(extractAdapt(root).theme?.headingFont, "Lato", "headings inherit the body family");
	assert.equal(extractAdapt(root).theme?.background, undefined, "image-only shorthand resets the colour");
	rmSync(cssPath);
	writeFileSync(join(outside, "secret.css"), "body { color: #abcdef; }");
	symlinkSync(join(outside, "secret.css"), cssPath);
	assert.equal(extractAdapt(root).theme, undefined, "an escaping stylesheet symlink is never read");
	assert.equal(extractAdapt(root).losses.some((l) => l.source === "adapt:theme"), false);
});

test("Adapt section classes and generated IDs map bands, restore parent backgrounds and prefer content over chrome", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "adapt-bands-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "course/en"), { recursive: true });
	mkdirSync(join(root, "adapt/css"), { recursive: true });
	const w = (name: string, value: unknown) => writeFileSync(join(root, `course/en/${name}.json`), JSON.stringify(value));
	writeFileSync(join(root, "course/config.json"), '{"_defaultLanguage":"en"}');
	w("course", { _id: "course", title: "Bands" });
	w("contentObjects", [{ _id: "page", _parentId: "course", _type: "page", displayTitle: "Page" }]);
	w("articles", [
		{ _id: "a1", _parentId: "page", _classes: "purple", displayTitle: "Article one", body: "<p>Introduction</p>" },
		{ _id: "a2", _parentId: "page", displayTitle: "Article two" },
	]);
	w("blocks", [
		{ _id: "b1", _parentId: "a1", _classes: "dark" },
		{ _id: "b2", _parentId: "a1" },
		{ _id: "b3", _parentId: "a1", _classes: "white" },
		{ _id: "b4", _parentId: "a1", _classes: "reset" },
		{ _id: "b5", _parentId: "a2", _classes: "purple" },
		{ _id: "b6", _parentId: "a2" },
		{ _id: "b7", _parentId: "a2", _classes: "inverted" },
	]);
	w("components", Array.from({ length: 7 }, (_, i) => ({ _id: `c${i + 1}`, _parentId: `b${i + 1}`, _component: "text", body: `<p>Text ${i + 1}</p>` })));
	writeFileSync(join(root, "adapt/css/adapt.css"), `
		body { background: #ddd; }
		.page { background: #eeddaa; }
		.article { background-color: #fff; }
		.navigation { background: #005599; }
		.article.purple { background: #773399 !important; }
		.article.purple { background: #ff9900; }
		.purple { background: #ff9900; }
		.block.dark { background: #222; }
		.block.white { background: #fff; }
		.reset { background: #000; background: url('tile.png'); }
		.b6 { background: #222; }
		.inverted:hover { background: #111; }
		.block .inverted { background: #333; }
		@media (max-width: 600px) { .article.purple { background: #fff !important; } }
	`);
	const course = extractAdapt(root);
	assert.equal(course.theme?.background, "#ffffff");
	assert.equal(course.theme?.accent, "#005599");
	assert.equal(course.theme?.sectionAccent, "#773399", "first coloured section in display order defines the accent band");
	assert.equal(course.theme?.sectionDark, "#222222");
	const pages = course.lessons[0]!.pages;
	assert.deepEqual(pages.map((p) => p.blocks.filter((b) => b.kind === "divider").map((b) => b.tone)), [
		["accent", "dark", "accent", "light", "accent"], ["accent", "dark", "light"],
	]);
	assert.equal(course.losses.filter((l) => l.source === "adapt:theme").length, 1);
	assert.deepEqual(course.sourceText.filter((s) => s.startsWith("Text")), Array.from({ length: 7 }, (_, i) => `Text ${i + 1}`));
	const output = join(root, "output");
	await importPackage(root, output);
	const yaml = readFileSync(join(output, "course.yaml"), "utf8");
	assert.match(yaml, /colorBackgroundLight: "#ffffff"/);
	assert.match(yaml, /sectionAccentBackground: "#773399"/);
	assert.match(yaml, /sectionDarkBackground: "#222222"/);
	assert.match(yaml, /sectionRhythmMode: manual/);
	const prax = readFileSync(join(output, "01-page.prax"), "utf8");
	assert.match(prax, /palette: accent/);
	assert.match(prax, /palette: dark/);
	assert.match(prax, /palette: light/);
});
