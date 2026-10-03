import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detect } from "../src/detect.ts";
import { extractLiaScript } from "../src/extract/liascript.ts";
import { importPackage } from "../src/import.ts";

function fixture(root: string, markdown: string, source = "lesson.md") {
	writeFileSync(join(root, "index.html"), '<html><head><meta name="apple-mobile-web-app-title" content="LiaScript"></head><body>Loading</body></html>');
	writeFileSync(join(root, "imsmanifest.xml"), `<manifest identifier="synthetic"><organizations><organization><title>Synthetic</title><item parameters="./${source}" identifierref="r"/></organization></organizations><resources><resource identifier="r" href="index.html"/></resources></manifest>`);
	writeFileSync(join(root, "lesson.md"), markdown);
}

test("LiaScript maps the selected Markdown in order and round-trips its blocks through Studio", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "lia-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	fixture(root, `<!-- language: en -->
# First lesson
Read **carefully** and [visit](https://example.org).

- Alpha
- Beta

![Blue square](picture.svg "Image caption")

| Name | Value |
| --- | --- |
| A | B |

> A quotation.

\`\`\`js
const x = "<unsafe>";
\`\`\`

## Questions
Choose one.

[( )] Wrong
[(X)] Right

Choose two.

[[X]] First
[[ ]] Neither
[[X]] Second

Name the colour.

[[blue]]

# Last lesson
<div><p>HTML content.</p><img src="picture.svg" alt="Square"></div>

{{1}} Animated words.

@unsupported
`);
	writeFileSync(join(root, "README.md"), "Unrelated documentation must not be imported.");
	writeFileSync(join(root, "picture.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="blue"/></svg>');
	assert.equal(detect(root).tool, "liascript");
	const course = extractLiaScript(root);
	assert.deepEqual(course, extractLiaScript(root));
	assert.equal(course.lessons.length, 2);
	assert.deepEqual(course.lessons[0]!.pages.map((p) => p.title), ["First lesson", "Questions"]);
	const initial = course.lessons[0]!.pages[0]!.blocks;
	assert.deepEqual(initial.map((b) => b.kind), ["heading", "paragraph", "list", "image", "paragraph", "table", "quote", "code"]);
	assert.deepEqual(initial.at(-1), { kind: "code", lang: "js", text: 'const x = "<unsafe>";' });
	const questions = course.lessons[0]!.pages[1]!.blocks;
	assert.deepEqual(questions.map((b) => b.kind), ["heading", "choice", "choice", "fillBlank"]);
	assert.equal(questions[1]?.kind === "choice" && questions[1].options[1]?.correct, true);
	assert.equal(questions[2]?.kind === "choice" && questions[2].multiple, true);
	assert.deepEqual(questions[3], { kind: "fillBlank", prompt: "Name the colour.", parts: [{ answers: ["blue"] }] });
	assert.ok(course.losses.some((l) => l.source === "liascript:extension" && /^\.\/lesson.md:\d+$/.test(l.at)));
	assert.match(course.sourceText.join(" "), /unsupported/);
	assert.doesNotMatch(course.sourceText.join(" "), /Unrelated documentation/);
	const report = await importPackage(root, join(root, "output"), { verify: !!process.env.PRAXITY_CLI });
	assert.equal(report.assets, 1);
	assert.match(readFileSync(join(root, "output", report.lessons[0]!.file), "utf8"), /as: choice/);
	if (process.env.PRAXITY_CLI) {
		assert.equal(report.verification?.parse.ok, true, JSON.stringify(report.verification));
		assert.equal(report.verification?.export?.ok, true, JSON.stringify(report.verification));
		assert.equal(report.verification?.export?.accessibility, "passed");
	}
});

test("LiaScript requires both fingerprints, respects existing detectors and refuses escaped source paths", (t) => {
	const root = mkdtempSync(join(tmpdir(), "lia-safe-"));
	const outside = mkdtempSync(join(tmpdir(), "lia-outside-"));
	t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
	fixture(root, "# Heading\nText.");
	writeFileSync(join(root, "index.html"), "<p>LiaScript mentioned in ordinary content</p>");
	assert.equal(detect(root).tool, "html");
	fixture(root, "# Heading\nText.");
	writeFileSync(join(root, "trivantis.js"), "");
	assert.equal(detect(root).tool, "lectora");
	rmSync(join(root, "trivantis.js"));
	for (const source of ["../outside.md", "/absolute.md", "%2e%2e%2foutside.md"]) {
		fixture(root, "# Heading\nText.", source);
		assert.throws(() => extractLiaScript(root), /no readable shipped Markdown/);
	}
	fixture(root, "# Heading\nText.");
	writeFileSync(join(outside, "outside.md"), "# Private\nNever read.");
	rmSync(join(root, "lesson.md"));
	symlinkSync(join(outside, "outside.md"), join(root, "lesson.md"));
	assert.throws(() => extractLiaScript(root), /no readable shipped Markdown/);
	writeFileSync(join(root, "template.xml"), '<learningObject name="Synthetic"><text><![CDATA[<p>A</p>]]></text></learningObject>');
	writeFileSync(join(root, "index.html"), "<p>Loader</p>");
	assert.equal(detect(root).tool, "html");
	mkdirSync(join(root, "common_html5/js"), { recursive: true });
	writeFileSync(join(root, "common_html5/js/xenith.js"), "");
	assert.equal(detect(root).tool, "xerte");
});

test("ambiguous LiaScript answers, executable HTML and unsupported syntax produce pointed losses", (t) => {
	const root = mkdtempSync(join(tmpdir(), "lia-loss-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	fixture(root, `# Heading
Two marked single answers.

[(X)] First
[(X)] Second

[[unknown|evaluation]]

[[matrix] [values]]

<script>throw new Error("never executed")</script>
<input type="text">
<img src="data:image/png;base64,AA" alt="Unavailable">
`);
	const course = extractLiaScript(root);
	assert.ok(course.losses.some((l) => l.source === "liascript:quiz"));
	assert.ok(course.losses.some((l) => l.source === "liascript:extension"));
	assert.ok(course.losses.some((l) => l.source === "liascript:html"));
	assert.ok(course.sourceText.join(" ").includes("matrix"));
	assert.ok(course.lessons[0]!.pages[0]!.blocks.every((b) => b.kind !== "choice" && b.kind !== "fillBlank"));
});

test("LiaScript code examples retain comments and scripts as literal source", (t) => {
	const root = mkdtempSync(join(tmpdir(), "lia-code-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const code = '<!-- Explain the example -->\n<script>example()</script>';
	fixture(root, `<!--\n\`\`\`js\nmacroOnly()\n\`\`\`\n-->\n# Examples\n\n\`\`\`html\n${code}\n\`\`\`\n\nUse \`<script>inlineExample()</script>\` literally.\n\n<script>runtimeOnly()</script>\n`);
	const course = extractLiaScript(root);
	const blocks = course.lessons[0]!.pages[0]!.blocks;
	assert.deepEqual(blocks[1], { kind: "code", lang: "html", text: code });
	assert.equal(blocks[2]?.kind === "paragraph" && blocks[2].text, "Use <script>inlineExample()</script> literally.");
	assert.match(course.sourceText.join(" "), /Explain the example/);
	assert.match(course.sourceText.join(" "), /example\(\)/);
	assert.match(course.sourceText.join(" "), /inlineExample\(\)/);
	assert.doesNotMatch(course.sourceText.join(" "), /runtimeOnly|macroOnly/);
	assert.equal(course.losses.filter((l) => l.source === "liascript:runtime").length, 2);
});
