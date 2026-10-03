import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { extractXerte } from "../src/extract/xerte.ts";
import { importPackage } from "../src/import.ts";
import { detect } from "../src/detect.ts";
import { verify } from "../src/verify.ts";

const XML = `<learningObject name="Synthetic course" editorVersion="3.13" language="en-GB" trackingPassed="80%">
<text name="Start"><![CDATA[<p>First <strong>paragraph</strong>.</p><img src="FileLocation + 'media/pic.svg'" alt="Blue circle"/><audio src="media/voice.mp3"></audio>]]></text>
<bullets name="Steps" text="&lt;p&gt;Read in order.&lt;/p&gt;"><![CDATA[<ul><li>One</li><li>Two</li></ul>]]></bullets>
<quiz name="Check" instructions="Choose carefully." order="random" singleRight="Yes." singleWrong="No." multiRight="Both." multiWrong="Try both." onCompletion="Results only.">
<question type="Single Answer" prompt="Pick one." feedback="Shared feedback."><option text="Alpha" correct="true" feedback="Alpha feedback."/><option text="Beta" correct="false" feedback="Beta feedback."/></question>
<question type="Multiple Answer" prompt="Pick both."><option text="Gamma" correct="true"/><option text="Delta" correct="true"/><option text="Epsilon" correct="false"/></question>
<question type="Numeric" prompt="Hidden unsupported prompt."/>
</quiz>
<hotspot name="Unsupported" text="Omitted content stays inventoried."/>
</learningObject>`;

test("Xerte XML preserves page order, HTML media, choices and independent source inventory", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "xerte-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "media"));
	mkdirSync(join(root, "common_html5/js"), { recursive: true });
	writeFileSync(join(root, "common_html5/js/xenith.js"), "throw new Error(\"must never execute\");");
	writeFileSync(join(root, "template.xml"), XML);
	writeFileSync(join(root, "media/pic.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4" fill="blue"/></svg>');
	writeFileSync(join(root, "media/voice.mp3"), "synthetic audio");
	const course = extractXerte(root);
	assert.deepEqual(course, extractXerte(root));
	assert.equal(course.passingScore, 80);
	const pages = course.lessons[0]!.pages;
	assert.deepEqual(pages.map((p) => p.title), ["Start", "Steps", "Check", "Unsupported"]);
	assert.deepEqual(pages[0]!.blocks.map((b) => b.kind), ["paragraph", "image", "audio"]);
	assert.deepEqual(pages[0]!.blocks[1], { kind: "image", src: "media/pic.svg", alt: "Blue circle" });
	assert.deepEqual(pages[1]!.blocks, [{ kind: "paragraph", text: "Read in order." }, { kind: "list", ordered: false, items: ["One", "Two"] }]);
	const choice = pages[2]!.blocks[1];
	assert.equal(choice?.kind, "choice");
	if (choice?.kind === "choice") {
		assert.equal(choice.multiple, false);
		assert.equal(choice.correct, "Shared feedback. Yes.");
		assert.deepEqual(choice.options, [{ text: "Alpha", correct: true, feedback: "Alpha feedback." }, { text: "Beta", correct: false, feedback: "Beta feedback." }]);
	}
	const multiple = pages[2]!.blocks[2];
	assert.equal(multiple?.kind === "choice" && multiple.multiple, true);
	assert.ok(course.sourceText.includes("Omitted content stays inventoried."));
	assert.ok(course.sourceText.includes("Hidden unsupported prompt."));
	assert.ok(course.losses.some((l) => l.at === "template.xml/hotspot[4]" && l.effect === "dropped"));
	assert.ok(course.losses.some((l) => l.at === "template.xml/quiz[3]/question[3]"));
	assert.ok(course.losses.some((l) => l.at === "template.xml/quiz[3]/@onCompletion"));
	const out = join(root, "output");
	assert.equal(detect(root).tool, "xerte");
	const report = await importPackage(root, out);
	assert.equal(report.detected.tool, "xerte");
	if (process.env.PRAXITY_CLI) {
		const checked = await verify(out, course.sourceText);
		assert.equal(checked.parse.ok, true, JSON.stringify(checked));
		assert.equal(checked.export?.ok, true, JSON.stringify(checked));
	}
});

test("Xerte rejects unsafe XML paths and reports malformed answer keys without inventing them", (t) => {
	const root = mkdtempSync(join(tmpdir(), "xerte-safe-"));
	const outside = mkdtempSync(join(tmpdir(), "xerte-outside-"));
	t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
	writeFileSync(join(outside, "secret.xml"), XML);
	symlinkSync(join(outside, "secret.xml"), join(root, "template.xml"));
	assert.throws(() => extractXerte(root), /outside the package/);
	assert.throws(() => extractXerte(root, "../secret.xml"), /outside the package/);
	assert.throws(() => extractXerte(root, join(outside, "secret.xml")), /outside the package/);
	rmSync(join(root, "template.xml"));
	writeFileSync(join(root, "template.xml"), XML.replace('text="Alpha" correct="true"', 'text="Alpha" correct="maybe"'));
	const course = extractXerte(root);
	assert.equal(course.lessons[0]!.pages[2]!.blocks.filter((b) => b.kind === "choice").length, 1);
	assert.ok(course.losses.some((l) => l.at === "template.xml/quiz[3]/question[1]"));
	assert.ok(course.sourceText.includes("Alpha"));
});


test("Xerte feedback flags follow the player and pass thresholds accept fractions or percentages", (t) => {
	const root = mkdtempSync(join(tmpdir(), "xerte-feedback-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const [flags, correct, optionFeedback] of [
		['showfeedback="false"', undefined, undefined],
		['showfeedback="0"', undefined, undefined],
		['judge="false"', "Shared feedback.", "Alpha feedback."],
		['judge="true" showfeedback="true"', "Shared feedback. Yes.", "Alpha feedback."],
	] as const) {
		writeFileSync(join(root, "template.xml"), XML.replace('<quiz name="Check"', `<quiz ${flags} name="Check"`).replace('trackingPassed="80%"', 'trackingPassed="0,8"'));
		const course = extractXerte(root);
		assert.equal(course.passingScore, 80);
		const choice = course.lessons[0]!.pages[2]!.blocks[1];
		assert.equal(choice?.kind, "choice");
		if (choice?.kind === "choice") {
			assert.equal(choice.correct, correct);
			assert.equal(choice.options[0]?.feedback, optionFeedback);
		}
	}
	writeFileSync(join(root, "template.xml"), XML.replace('<quiz name="Check"', '<quiz img="media/extra.png" caption="Unmapped caption" name="Check"'));
	const course = extractXerte(root);
	assert.ok(course.sourceText.includes("Unmapped caption"));
	assert.ok(course.losses.some((l) => l.at === "template.xml/quiz[3]/@img"));
	assert.ok(course.losses.some((l) => l.at === "template.xml/quiz[3]/@caption"));
});
