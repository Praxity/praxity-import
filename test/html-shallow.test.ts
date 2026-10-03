import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { extractHtml } from "../src/extract/html.ts";
import { detect } from "../src/detect.ts";
import { importPackage } from "../src/import.ts";

test("HTML shallow warnings use word, page and file-size thresholds, with guarded paths", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "shallow-"));
	const outside = mkdtempSync(join(tmpdir(), "shallow-outside-"));
	t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
	const page = (words: number) => writeFileSync(join(root, "index.html"), `<main>${"word ".repeat(words)}</main>`);
	const warned = () => extractHtml(root).losses.some((l) => l.source === "html:shallow");
	page(49);
	mkdirSync(join(root, "data"));
	writeFileSync(join(root, "data/model.json"), " ".repeat(100 * 1024 - 1));
	assert.equal(warned(), false);
	writeFileSync(join(root, "data/model.json"), " ".repeat(100 * 1024));
	assert.equal(warned(), true);
	const report = await importPackage(root, join(outside, "output"));
	assert.ok(report.losses.some((l) => l.source === "html:shallow" && l.at === "data/model.json"));
	page(50);
	assert.equal(warned(), false);
	writeFileSync(join(root, "index.html"), '<main>Loader <a href="next.html">Next</a></main>');
	writeFileSync(join(root, "next.html"), "<main>Another page</main>");
	assert.equal(warned(), false);
	page(2);
	rmSync(join(root, "data/model.json"));
	writeFileSync(join(outside, "large.js"), " ".repeat(100 * 1024));
	symlinkSync(join(outside, "large.js"), join(root, "linked.js"));
	assert.equal(warned(), false);
});

test("eXeLearning static pages retain manifest navigation order and all article content", (t) => {
	const root = mkdtempSync(join(tmpdir(), "exe-html-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "imsmanifest.xml"), `<manifest identifier="exe"><organizations><organization><title>Example</title><item identifierref="b"><title>First node</title></item><item identifierref="a"><title>Second node</title></item></organization></organizations><resources><resource identifier="a" href="a.html"/><resource identifier="b" href="b.html"/></resources></manifest>`);
	for (const name of ["a", "b"]) writeFileSync(join(root, `${name}.html`), `<html><head><meta name="generator" content="eXeLearning"></head><body><nav>Chrome</nav><section id="main"><article><h2>${name} first</h2><p>All of the first article.</p></article><article><h2>${name} second</h2><p>All of the second article.</p></article></section></body></html>`);
	assert.equal(detect(root).tool, "html");
	const course = extractHtml(root);
	assert.deepEqual(course.lessons[0]!.pages.map((p) => p.title), ["First node", "Second node"]);
	assert.equal(course.lessons[0]!.pages[0]!.blocks.length, 4);
	assert.equal(course.sourceText.length, 2);
	assert.doesNotMatch(course.sourceText.join(" "), /Chrome/);
});
