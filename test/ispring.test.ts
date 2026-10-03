import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { importPackage } from "../src/import.ts";
import { extractIspring } from "../src/extract/ispring.ts";
import { walk } from "../src/write.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "praxity-import-ispring-"));

test("player palette, shown logo, outline and character-weighted slide fonts map safely", () => {
	const root = tmp();
	const pres = {
		t: "Synthetic theme", s: [{ s: "data/slide1.js", c: "data/slide1.css", x: "Font sample" }], f: [{ n: "fnt0", l: "Lato" }, { n: "PFn", l: "Open Sans" }],
		k: { l: { "button.face.normal": "#ABCDEF", "button.content.normal": "#FFFFFF", "page.background": "#123456", "button.face.over": "#654321" }, s: { v: true, o: true, l: true } },
		C: { l: { i: "data/logo.png" } },
	};
	mkdirSync(join(root, "data"));
	writeFileSync(join(root, "data/logo.png"), "logo");
	writeFileSync(join(root, "data/player.js"), 'var schema={colors:{A:"l"},controlPanel:{A:"c",showOutline:{A:"o"}}};throw Error("never execute");');
	writeFileSync(join(root, "data/slide1.css"), '#txt0 {font-family:fnt0;}');
	writeFileSync(join(root, "data/slide1.js"), slideJs('<div><span id="txt0">Font sample</span></div>'));
	const write = () => writeFileSync(join(root, "index.html"), `<script>var presInfo="${deflateSync(JSON.stringify(pres)).toString("base64")}";</script>`);
	write();
	const course = extractIspring(root, "");
	assert.deepEqual(course.theme, { density: "compact", blockSpacing: "compact", accent: "#abcdef", buttonBackground: "#abcdef", buttonText: "#ffffff", bodyFont: "Lato", headingFont: "Lato", navigation: "sidebar", logo: "data/logo.png" });
	assert.equal(course.losses.filter((l) => l.source === "ispring:theme").length, 1);
	pres.k.s.v = false;
	write();
	assert.equal(extractIspring(root, "").theme?.logo, undefined);
	assert.equal(extractIspring(root, "").theme?.navigation, "slides");
	pres.k.s.v = true;
	pres.C.l.i = "../outside.png";
	write();
	assert.equal(extractIspring(root, "").theme?.logo, undefined);
	writeFileSync(join(root, "data/player.js"), "/* null skin */");
	assert.equal(extractIspring(root, "").theme?.navigation, "slides");
	pres.k.l["button.face.normal"] = "url(javascript:alert(1))";
	write();
	assert.equal(extractIspring(root, "").theme?.accent, undefined);
	writeFileSync(join(root, "index.html"), `<script>var presInfo="${Buffer.from(JSON.stringify({ t: "Bare", s: [] })).toString("base64")}";</script>`);
	assert.deepEqual(extractIspring(root, "").theme, { density: "compact", blockSpacing: "compact" });
});

/** iSpring's slide files hand the player an HTML string in a single-quoted JS literal. */
const slideJs = (html: string) => `(function(){var loadHandler=window['sl_{G}'];loadHandler&&loadHandler(0, '${html.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}', '{"s":[]}');})();`;
const rt = (a: string) => ({ h: `<p style="font-size:16px">${a.replace(/^<p>|<\/p>$/g, "")}</p>`, a, r: [], d: [] });
const feedback = { F: { c: { v: rt("<p>Right!</p>") }, i: { v: rt("<p>Nope.</p>") }, a: { v: rt("<p>Thanks.</p>") } } };

function ispringPackage(questions?: unknown[]): string {
	const dir = tmp();
	mkdirSync(join(dir, "res/data/quiz1/images"), { recursive: true });
	writeFileSync(join(dir, "imsmanifest.xml"), `<?xml version="1.0"?><manifest identifier="m1"><organizations default="o"><organization identifier="o"><title>Safety &amp; you</title><item identifier="i" identifierref="r"><title>Safety &amp; you</title></item></organization></organizations><resources><resource identifier="r" type="webcontent" href="res/index.html"><file href="res/index.html"/></resource></resources></manifest>`);
	for (const f of ["img0.png", "img1.png", "img2.png", "narr.mp3", "quiz1/images/helmet.png"]) writeFileSync(join(dir, "res/data", f), f);

	// Slide 1: layout layer with a background, then the slide's own shapes. Spans wrap mid-word; `x` carries the text.
	writeFileSync(
		join(dir, "res/data/slide1.js"),
		slideJs(
			`<div id="spr0"><div id="spr1" class="kern slide"><img id="bg" src="data/img0.png" width="720px" height="540px" alt=""/></div>` +
				`<div id="spr2" class="kern slide"><div id="spr3" style="left:10px;"><div style="width:0px;"><span id="t0">Safety first</span></div></div>` +
				`<div id="spr4"><img id="i1" src="data/img1.png" width="100" height="80" alt="Wet floor sign"/></div>` +
				`<div id="spr5"><div style="width:0px;"><span id="t1">Wear glo</span></div><div style="width:0px;"><span id="t2">ves *now*.</span></div><div style="width:0px;"><span id="t3">Check twice.</span></div></div></div></div>`,
		),
	);
	// Slide 2: text rendered as glyph paths (no line boxes), so text and pictures cannot be interleaved.
	writeFileSync(
		join(dir, "res/data/slide2.js"),
		slideJs(`<div id="spr0"><div id="spr1" class="kern slide"><div id="svg0"><svg width="10" height="10"><path d="M0,0 h1"/></svg></div><div id="spr2"><img id="i2" src="data/img2.png" width="50" height="50" alt="Exit"/></div></div></div>`),
	);
	const quiz = {
		d: {
			T: "Safety check",
			s: { q: { pst: "quizPassingScore" } },
			sl: {
				i: { tp: "IntroSlide", D: rt("<p>Answer every question.</p>"), a: { o: [] } },
				g: [
					{
						T: "Group 1",
						s: { ps: { u: "percents", v: 70 } },
						S: questions ?? [
							{ tp: "MultipleChoice", D: rt("<p>Which is PPE?</p>"), C: { chs: [{ t: rt("<p>Gloves</p>"), c: true, f: { v: rt("<p>Yes: gloves.</p>") } }, { t: rt("<p>Coffee</p>"), c: false }] }, s: { ee: true, ...feedback }, a: { o: [{ tp: "shape", I: "content" }, { tp: "image", I: "Picture 1", n: "Helmet", i: "storage://images/helmet.png" }] } },
							{ tp: "TypeIn", D: rt("<p>Boots are made of?</p>"), C: { chs: [{ t: "steel" }, { t: "Steel" }] }, s: { ee: true, ...feedback } },
							{ tp: "FillInTheBlank", D: rt("<p>Complete</p>"), C: { rt: { a: '<p>Wear <span id="qmFillInTheBlank1"></span> and <span id="qmFillInTheBlank2"></span>.</p>', r: [{ id: "qmFillInTheBlank1", data: { v: ["gloves", "mitts"] } }, { id: "qmFillInTheBlank2", data: { v: ["boots"] } }] } }, s: { ee: true, ...feedback } },
							{ tp: "Sequence", D: rt("<p>Order the steps</p>"), C: { chs: [{ t: rt("<p>Stop</p>") }, { t: rt("<p>Look</p>") }] }, s: { ee: true, ...feedback } },
							{ tp: "Matching", D: rt("<p>Match</p>"), C: { m: [{ p: { t: rt("<p>Hand</p>") }, r: { t: rt("<p>Glove</p>") } }], d: { chs: [{ t: rt("<p>Hat</p>") }] } }, s: { ee: true, ...feedback } },
							{ tp: "Essay", D: rt("<p>Describe a hazard</p>"), s: { ee: false, ...feedback } },
							{ tp: "Hotspot", D: rt("<p>Tap the exit</p>"), C: { a: [], i: "storage://images/helmet.png" }, s: { ee: true, ...feedback } },
						],
					},
				],
				r: { g: [{ tp: "ResultSlide", D: rt("<p>You passed.</p>") }] },
			},
		},
	};
	writeFileSync(join(dir, "res/data/quiz1.js"), `(function(){var loadHandler=window['q_{G}'];var quizInfo = "${Buffer.from(JSON.stringify(quiz)).toString("base64")}";loadHandler&&loadHandler(1, quizInfo);})();`);
	writeFileSync(join(dir, "res/data/player.js"), "/* player */");

	const pres = {
		i: "{G}",
		t: "Safety & you",
		ui: "issuite_10.0.3_9003;",
		b: { l: "fr" },
		s: [
			{ t: "Safety first", I: "1:258", s: "data/slide1.js", l: 0, x: "Safety first\r\nWear gloves *now*.\rCheck twice.", e: [{ p: 0.001 }] },
			{ t: "Exits", I: "2:259", s: "data/slide2.js", l: 1, x: "Know your exits", n: "Say hello.\r\nThen pause.", S: [{ i: "a1", a: "aud1" }], e: [{ p: 0.001 }, { p: 1 }, { p: 2 }], i: { a: [{ t: "link" }] } },
			{ t: "Secret", I: "3:260", s: "data/slide3.js", l: 1, x: "hidden", v: false },
			{ st: "q", t: "Quiz", I: "4:261", s: "data/quiz1.js", l: 0 },
			{ st: "i", t: "Timeline", I: "5:262", s: "data/interaction1.js", l: 1 },
		],
	};
	const presInfo = deflateSync(Buffer.from(JSON.stringify(pres))).toString("base64");
	writeFileSync(
		join(dir, "res/index.html"),
		`<!DOCTYPE html>\n<!-- Created with iSpring --><!--version 10.0.3.9003 --><html lang="en"><head><title>Safety</title></head><body><audio id="aud1" src="data/narr.mp3"></audio><script>var presInfo = "${presInfo}";</script></body></html>`,
	);
	return dir;
}

test("imports an iSpring export: outline chapters, slide text order, notes, media, quiz and losses", async () => {
	const out = join(tmp(), "course");
	const report = await importPackage(ispringPackage(), out);
	assert.equal(report.detected.tool, "ispring");
	assert.equal(report.course.toolVersion, "10.0.3.9003");
	assert.deepEqual(readdirSync(out).sort(), ["01-safety-first.prax", "02-quiz.prax", "assets", "course.yaml", "import-report.json", "praxity.json"], "top-level outline entries become lessons; hidden slides are skipped; the quiz pass mark goes to praxity.json");
	assert.match(readFileSync(join(out, "course.yaml"), "utf8"), /^title: "Safety & you"\n[\s\S]*^locale: fr$/m, "title from the manifest, language from the player branding");
	const one = readFileSync(join(out, "01-safety-first.prax"), "utf8");
	assert.match(one, /^## Safety first\n\n\/assets\/res\/data\/img1\.png\nalt: Wet floor sign\n\nWear gloves \\\*now\\\*\.\n\nCheck twice\.$/m, "text comes from the slide text index in shape order, pictures sit where the markup places them, the title shape is the heading");
	assert.doesNotMatch(one, /img0\.png|glo\nves/, "the layout layer's background is not content; wrapped lines are not split");
	assert.match(one, /^--- Exits\n\nKnow your exits\n\n\/assets\/res\/data\/img2\.png\nalt: Exit\n\n\/assets\/res\/data\/narr\.mp3\n\n> Say hello\.\n> Then pause\.\nas: note$/m, "glyph-path text keeps its order before the pictures; narration and speaker notes follow");
	const quiz = readFileSync(join(out, "02-quiz.prax"), "utf8");
	assert.match(quiz, /^Answer every question\.\n\n#{1,2} Safety check\nas: assessment-group\nshowResultsSummary: true\npassingScore: 70\n\n\/assets\/res\/data\/quiz1\/images\/helmet\.png\nalt: Helmet\n\n#{2,3} Which is PPE\?\nas: choice\nscored: true\ncorrect: Right!\nincorrect: Nope\.\n\n\(x\) Gloves\nfeedback: Yes: gloves\.\n\( \) Coffee$/m, "intro slide, group with passing score, question pictures, choices with feedback");
	assert.match(quiz, /^#{2,3} Boots are made of\?\nas: fill-blank\nscored: true\ncorrect: Right!\nincorrect: Nope\.\n\n\{steel\|Steel\}$/m, "every accepted short answer is kept, with its feedback");
	assert.match(quiz, /^Wear \{gloves\|mitts\} and \{boots\}\.$/m, "blank markers become answers with alternatives");
	assert.match(quiz, /^#{2,3} Order the steps\nas: order\nscored: true\ncorrect: Right!\nincorrect: Nope\.\n\n1\. Stop\n2\. Look$/m);
	assert.match(quiz, /^#{2,3} Match\nas: match\nscored: true\nshuffle: true\ncorrect: Right!\nincorrect: Nope\.\n\nHand :: Glove$/m);
	assert.match(quiz, /^#{2,3} Describe a hazard\nas: free-response$/m);
	assert.doesNotMatch(quiz, /Tap the exit|You passed/, "a hotspot without areas and result messages remain losses");
	const sources = report.losses.map((l) => l.source);
	for (const s of ["ispring:hidden-slide", "ispring:interaction", "ispring:animation", "ispring:reading-order", "ispring:question/Hotspot", "ispring:question/Essay", "ispring:question/Matching", "ispring:quiz/result"]) assert.ok(sources.includes(s), `${s} is reported`);
	assert.ok(!sources.includes("ispring:question/Sequence"), "order feedback is now kept");
	assert.ok(!report.losses.some((l) => l.source === "ispring:question/Matching" && l.detail.includes("feedback")));
	assert.equal(report.losses.find((l) => l.source === "ispring:question/Hotspot")?.at, "slide 4/question 7");
	assert.ok(report.losses.find((l) => l.source === "ispring:question/Matching")?.detail.includes('"Hat"'), "matching distractors are named");
});

async function quizOutput(questions: unknown[]) {
	const pkg = ispringPackage(questions);
	const course = extractIspring(pkg, "res");
	const blocks = [...walk(course.lessons.flatMap((l) => l.pages.flatMap((p) => p.blocks)))];
	const out = join(tmp(), "course");
	const report = await importPackage(pkg, out);
	return { course, blocks, report, prax: readFileSync(join(out, "02-quiz.prax"), "utf8") };
}

test("Likert questions keep scale labels and statements as a matrix or a single rating", async () => {
	const { blocks, course, prax } = await quizOutput([
		{ tp: "LikertScale", D: rt("Survey"), C: { s: [rt("Clear instructions"), rt("Useful practice")], l: ["Never", "Sometimes", "Always"] }, s: { ee: false, ...feedback } },
		{ tp: "LikertScale", D: rt("Rate this"), C: { s: [rt("I feel prepared")], l: ["Low", "High"] }, s: { ee: false } },
		{ tp: "LikertScale", D: rt("Incomplete scale"), C: { s: [rt("Unmapped statement")], l: ["Only label"] } },
	]);
	assert.deepEqual(blocks.find((b) => b.kind === "matrix"), { kind: "matrix", prompt: "Survey", statements: ["Clear instructions", "Useful practice"], scale: ["Never", "Sometimes", "Always"] });
	assert.deepEqual(blocks.find((b) => b.kind === "rating"), { kind: "rating", prompt: "Rate this\nI feel prepared", scale: ["Low", "High"] });
	assert.match(prax, /as: matrix\nwidth: wide\n\n1: Never\n2: Sometimes\n3: Always\n\n- Clear instructions\n- Useful practice/);
	assert.match(prax, /I feel prepared\nas: rating\ndisplay: scenario\ndescription: Rate this\n\n1: Low\n2: High/);
	assert.ok(course.sourceText.includes("Unmapped statement"));
	assert.ok(course.sourceText.includes("Only label"));
	assert.ok(course.losses.some((l) => l.source.endsWith("LikertScale") && l.detail.includes("Thanks.")), "survey feedback is still reported");
});

const area = { t: "rectangle", l: "Panel", r: { x: 1000, y: 2000, w: 2000, h: 4000 }, c: true };
const hotspot = { tp: "Hotspot", D: rt("Select the panel"), C: { i: "storage://images/helmet.png", a: [area] }, s: { ee: true, ...feedback } };

test("hotspot rects, ovals and freeforms become image-relative percent centres with correct flags", async () => {
	const { blocks, prax, report } = await quizOutput([{
		...hotspot,
		C: { ...hotspot.C, a: [area, { t: "oval", l: "Dial", r: { x: 6000, y: 1000, w: 2000, h: 2000 }, c: false }, { t: "freeform", r: { x: 2000, y: 6000, w: 2000, h: 2000 }, p: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }], c: false }] },
		a: { o: [{ tp: "shape", I: "content", S: { a: { a: false, t: "Control panel diagram" } } }] },
	}]);
	assert.deepEqual(blocks.find((b) => b.kind === "hotspot"), {
		kind: "hotspot", prompt: "Select the panel", src: "res/data/quiz1/images/helmet.png", alt: "Control panel diagram",
		spots: [{ label: "Panel", x: 20, y: 40, correct: true }, { label: "Dial", x: 70, y: 20, correct: false }, { label: "Spot 3", x: 30, y: 70, correct: false }],
	});
	assert.match(prax, /as: hotspot\nscored: true\n\n\/assets\/res\/data\/quiz1\/images\/helmet.png\nalt: Control panel diagram\nspot: Panel; 20%; 40%; correct\nspot: Dial; 70%; 20%\nspot: Spot 3; 30%; 70%/);
	assert.ok(report.losses.some((l) => l.detail.includes("regions became points")));
	assert.ok(report.losses.some((l) => l.source.endsWith("Hotspot") && l.detail.includes("feedback not kept")));
});

test("unusable hotspot geometry is a loss; missing images and alt use the writer's existing handling", async () => {
	const { blocks, course, report, prax } = await quizOutput([
		{ ...hotspot, C: { ...hotspot.C, a: [{ ...area, l: "Invalid area label", r: { x: 1000, y: 0, w: 0, h: 20 } }] } },
		{ ...hotspot, C: { ...hotspot.C, i: "storage://images/missing.png" } },
		hotspot,
	]);
	assert.equal(blocks.filter((b) => b.kind === "hotspot").length, 2);
	assert.ok(course.sourceText.includes("Invalid area label"));
	assert.ok(report.losses.some((l) => l.at === "slide 4/question 1" && l.effect === "dropped"));
	assert.ok(report.losses.some((l) => l.detail.includes("hotspot question dropped: its image is missing")));
	assert.match(prax, /alt: Select the panel\nspot: Panel/);
	assert.equal((prax.match(/as: hotspot/g) ?? []).length, 1);
});

const dndObjects = [
	{ tp: "shape", I: "a", rt: rt("Bolt") },
	{ tp: "shape", I: "b", rt: rt("Washer") },
	{ tp: "shape", I: "c", rt: rt("Cable") },
	{ tp: "image", I: "bin", n: "Automatic bin label", i: "storage://images/helmet.png", S: { a: { a: false, t: "Hardware bin" } } },
	{ tp: "shape", I: "shelf", rt: rt("Electrical shelf") },
];
const chain = (o: string, d: string) => ({ o: { s: o }, d: { s: d } });

test("drag-and-drop uses object IDs for match and categorize answer keys and alt for pictures", async () => {
	const { blocks, course, prax, report } = await quizOutput([
		{ tp: "DND", D: rt("Connect"), C: { d: [chain("a", "bin"), chain("c", "shelf")] }, a: { o: dndObjects }, s: { ee: true, ...feedback } },
		{ tp: "DND", D: rt("Sort"), C: { d: [chain("a", "bin"), chain("b", "bin"), chain("c", "shelf")] }, a: { o: dndObjects }, s: { ee: true, ...feedback } },
	]);
	assert.deepEqual(blocks.find((b) => b.kind === "match"), { kind: "match", prompt: "Connect", pairs: [["Bolt", "Hardware bin"], ["Cable", "Electrical shelf"]], correct: "Right!", incorrect: "Nope." });
	assert.deepEqual(blocks.find((b) => b.kind === "categorize"), { kind: "categorize", prompt: "Sort", categories: [{ name: "Hardware bin", items: ["Bolt", "Washer"] }, { name: "Electrical shelf", items: ["Cable"] }], correct: "Right!", incorrect: "Nope." });
	assert.match(prax, /Bolt :: Hardware bin\nCable :: Electrical shelf/);
	assert.match(prax, /as: categorize\nscored: true\nshuffle: true\ncorrect: Right!\nincorrect: Nope\.\n\nHardware bin:\n- Bolt\n- Washer\n\nElectrical shelf:\n- Cable/);
	assert.ok(course.sourceText.includes("Hardware bin"));
	assert.equal(report.losses.filter((l) => l.source.endsWith("DND")).length, 2);
	assert.ok(report.losses.filter((l) => l.source.endsWith("DND")).every((l) => l.effect === "approximated" && l.detail.includes("picture")));
});

test("unresolved and ambiguous drag-and-drop keys remain losses without shrinking the source inventory", async () => {
	const { course, blocks } = await quizOutput([
		{ tp: "DND", D: rt("Missing destination"), C: { d: [chain("a", "missing")] }, a: { o: dndObjects } },
		{ tp: "DND", D: rt("Two destinations"), C: { d: [chain("a", "bin"), chain("a", "shelf")] }, a: { o: dndObjects } },
	]);
	assert.ok(!blocks.some((b) => b.kind === "match" || b.kind === "categorize"));
	assert.ok(course.sourceText.includes("Bolt"));
	assert.ok(course.sourceText.includes("Hardware bin"));
	assert.equal(course.losses.filter((l) => l.source.endsWith("DND") && l.effect === "dropped").length, 2);
});

test("word-bank blanks preserve answer positions, alternatives, literal text and unanswered markers", async () => {
	const { blocks, course, prax, report } = await quizOutput([{
		tp: "WordBank", D: rt("Complete the instruction"),
		C: { rt: { a: `<p>Move <span id="qmWordBank2"></span> to <span id='qmWordBank1'></span>, then <span id="qmWordBank3"></span> and <span id="qmWordBank4"></span>.</p>`, r: [{ id: "qmWordBank1", data: { v: ["rack", "shelf"] } }, { id: "qmWordBank2", data: { v: "$& <crate>" } }, { id: "qmWordBank3", data: { v: [] } }] }, ew: ["unused"] },
		s: { ee: true, ...feedback },
	}]);
	assert.deepEqual(blocks.find((b) => b.kind === "fillBlank"), { kind: "fillBlank", prompt: "Complete the instruction", parts: ["Move ", { answers: ["$& <crate>"] }, " to ", { answers: ["rack", "shelf"] }, ", then ", { answers: [] }, " and ", { answers: [] }, "."], style: "word-bank", bank: ["unused", "rack", "shelf", "$& <crate>"], correct: "Right!", incorrect: "Nope." });
	assert.match(prax, /correct: Right!\nincorrect: Nope\.\n\nMove \{\$& <crate>\} to \{rack\|shelf\}, then ____ and ____\./);
	assert.ok(course.sourceText.includes("unused"));
	assert.ok(course.sourceText.includes("$& <crate>"));
	assert.ok(report.losses.some((l) => l.source === "fill-blank:word-bank" && l.detail.includes("open blank")));
	assert.ok(report.losses.some((l) => l.detail.includes("unanswered blanks")));
});

test("typed and numeric blanks keep literal punctuation and accepted alternatives", async () => {
	const { blocks, prax } = await quizOutput([
		{ tp: "TypeIn", D: rt("Enter the token"), C: { chs: [{ t: "a|b" }, { t: "{value}" }, { t: "C:\\temp" }, { t: "~word*" }] } },
		{ tp: "Numeric", D: rt("Enter the number"), C: { na: [{ co: "equal", op: 2.5 }] } },
		{ tp: "FillInTheBlank", D: rt("Complete"), C: { rt: { a: '<p>Keep {literal}, ____ and *stars*: <span id="qmFillInTheBlank1"></span>.</p>', r: [{ id: "qmFillInTheBlank1", data: { v: ["a|b", "{value}"] } }] } } },
	]);
	assert.deepEqual(blocks.filter((b) => b.kind === "fillBlank").map((b) => b.parts), [
		[{ answers: ["a|b", "{value}", "C:\\temp", "~word*"] }],
		[{ answers: ["2.5"] }],
		["Keep {literal}, ____ and *stars*: ", { answers: ["a|b", "{value}"] }, "."],
	]);
	assert.ok(prax.includes(String.raw`{a\|b|\{value\}|C:\\temp|\~word*}`));
	assert.ok(prax.includes(String.raw`Keep \{literal\}, \____ and \*stars\*: {a\|b|\{value\}}.`));
});

test("dropdowns keep every source choice in order and use only the indexed answer", async () => {
	const { blocks, course, prax } = await quizOutput([{
		tp: "MultipleChoiceText", D: rt("Choose tokens"), C: { rt: {
			a: '<p><span id="qmMultipleChoiceText2"></span> then <span id="qmMultipleChoiceText1"></span>.</p>',
			r: [{ id: "qmMultipleChoiceText1", data: { v: ["first", "a|b", "last"], i: 1 } }, { id: "qmMultipleChoiceText2", data: { v: ["wrong", "*star", "{value}"], i: 2 } }],
		} },
	}]);
	assert.deepEqual(blocks.find((b) => b.kind === "fillBlank"), { kind: "fillBlank", prompt: "Choose tokens", style: "dropdown", parts: [{ answers: ["{value}"], choices: ["wrong", "*star", "{value}"] }, " then ", { answers: ["a|b"], choices: ["first", "a|b", "last"] }, "."] });
	assert.ok(prax.includes(String.raw`{wrong|\*star|*\{value\}} then {first|*a\|b|last}.`));
	assert.ok(prax.includes("style: dropdown"));
	assert.ok(course.sourceText.includes("last"));
	assert.ok(!course.losses.some((l) => l.source.endsWith("MultipleChoiceText")));
});

test("dropdowns never invent a key for absent, fractional or out-of-range indices", async () => {
	const { blocks, report, prax } = await quizOutput([undefined, 0.5, 8].map((i) => ({
		tp: "MultipleChoiceText", D: rt("Choose"), C: { rt: { a: '<span id="qmMultipleChoiceText1"></span>', r: [{ id: "qmMultipleChoiceText1", data: { v: ["first", "second"], ...(i === undefined ? {} : { i }) } }] } },
	})));
	assert.ok(blocks.filter((b) => b.kind === "fillBlank").every((b) => typeof b.parts[0] !== "string" && b.parts[0]?.answers.length === 0));
	assert.equal(report.losses.filter((l) => l.source === "fill-blank:dropdown").length, 3);
	assert.doesNotMatch(prax, /style: dropdown|\{first/);
});

test("word banks keep extras first, repeated entries, alternatives and source run order", async () => {
	const { blocks, prax, report } = await quizOutput([{
		tp: "WordBank", D: rt("Place tokens"), C: { rt: {
			a: '<p><span id="qmWordBank2"></span>, <span id="qmWordBank1"></span>, <span id="qmWordBank3"></span>.</p>',
			r: [{ id: "qmWordBank1", data: { v: ["a|b", "{alt}"] } }, { id: "qmWordBank2", data: { v: "repeat" } }, { id: "qmWordBank3", data: { v: "repeat" } }],
		}, ew: ["unused", "unused", "C:\\temp"] },
	}]);
	assert.deepEqual(blocks.find((b) => b.kind === "fillBlank"), { kind: "fillBlank", prompt: "Place tokens", style: "word-bank", bank: ["unused", "unused", "C:\\temp", "a|b", "{alt}", "repeat", "repeat"], parts: [{ answers: ["repeat"] }, ", ", { answers: ["a|b", "{alt}"] }, ", ", { answers: ["repeat"] }, "."] });
	assert.ok(prax.includes(String.raw`bank: unused | unused | C:\\temp | a\|b | \{alt\} | repeat | repeat`));
	assert.ok(prax.includes(String.raw`{repeat}, {a\|b|\{alt\}}, {repeat}.`));
	assert.ok(prax.includes("style: word-bank"));
	assert.ok(!report.losses.some((l) => l.source.endsWith("WordBank") || l.source === "fill-blank:word-bank"));
});

test("ispring import is deterministic", async () => {
	const pkg = ispringPackage();
	const [a, b] = [join(tmp(), "a"), join(tmp(), "b")];
	await importPackage(pkg, a);
	await importPackage(pkg, b);
	for (const f of ["01-safety-first.prax", "02-quiz.prax", "course.yaml"]) assert.equal(readFileSync(join(a, f), "utf8"), readFileSync(join(b, f), "utf8"), f);
});

test("iSpring uses recorded slide backgrounds and only recorded edge-to-edge image geometry", () => {
	const root = tmp();
	mkdirSync(join(root, "data"));
	const pres = { w: 800, h: 600, k: { l: { "page.background": "#123456" } }, s: [
		{ s: "data/slide1.js", c: "data/slide1.css" }, { s: "data/slide2.js" }, { s: "data/slide3.js" },
	] };
	writeFileSync(join(root, "index.html"), `<script>var presInfo="${Buffer.from(JSON.stringify(pres)).toString("base64")}";</script>`);
	writeFileSync(join(root, "data/slide1.css"), '#page {background-color:#ABCDEF;}');
	writeFileSync(join(root, "data/slide1.js"), slideJs('<div id="page"><div class="kern slide"><img src="data/master.png" width="800" height="600"></div><div class="kern slide"><div><img src="data/photo.png" width="800" height="600"></div><div style="left:20px"><img src="data/inset.png" width="800"></div><img src="data/ordinary.png" width="200"><img src="data/unknown.png"></div></div>'));
	writeFileSync(join(root, "data/slide2.js"), slideJs('<div style="background-color:#abc"><div class="kern slide"></div></div>'));
	writeFileSync(join(root, "data/slide3.js"), slideJs('<div style="background-color:#ABCDEF"><div class="kern slide"></div></div>'));
	const course = extractIspring(root, "");
	assert.equal(course.theme?.background, "#abcdef");
	const images = course.lessons.flatMap((l) => l.pages.flatMap((p) => p.blocks)).filter((b) => b.kind === "image");
	assert.deepEqual(images.map((b) => [b.src, b.layout]), [["data/photo.png", "full"], ["data/inset.png", undefined], ["data/ordinary.png", undefined], ["data/unknown.png", undefined]]);
	assert.equal(course.losses.filter((l) => l.source === "ispring:theme" && l.effect === "approximated").length, 1);
	writeFileSync(join(root, "data/slide1.css"), '#page {background-color:#123456;}');
	writeFileSync(join(root, "data/slide3.js"), slideJs('<div><div class="kern slide"></div></div>'));
	assert.equal(extractIspring(root, "").theme?.background, "#123456", "equal page counts use code-unit order");
	pres.s.splice(1);
	writeFileSync(join(root, "index.html"), `<script>var presInfo="${Buffer.from(JSON.stringify(pres)).toString("base64")}";</script>`);
	for (const [css, expected] of [
		['#page {background-color:#111; background:#fff}', '#ffffff'],
		['@charset "utf-8"; #page {content:"{";background:#fff}', '#ffffff'],
		['#page {background-color:#111; background:url(texture.png)}', undefined],
		['#page {background-color:#111 !important; background:#fff}', '#111111'],
		['#page {background:#111 !important; background-color:#fff !important}', '#ffffff'],
		['@media print {#page {background:#111}} @supports(display:grid) {@media print {#page {background:#222}}} .wrapper #page {background:#333}', undefined],
	] as const) {
		writeFileSync(join(root, "data/slide1.css"), css);
		assert.equal(extractIspring(root, "").theme?.background, expected, css);
	}
	for (const style of ['left:0%;', 'left:1em;', 'transform:scale(2);', '-webkit-transform:scale(2);']) {
		writeFileSync(join(root, "data/slide1.js"), slideJs(`<div style="${style}"><div class="kern slide"><img src="data/photo.png" width="800"></div></div>`));
		const blocks = extractIspring(root, "").lessons[0]!.pages[0]!.blocks;
		assert.equal(blocks[0]?.kind === "image" ? blocks[0].layout : "missing image", undefined, style);
	}
});

test("slide hero uses overlapping foreground text, font prominence and recorded alt", () => {
	const root = tmp();
	mkdirSync(join(root, "data"));
	const shape = (value: string, size: number, left = 30, extra = "") => `<div style="left:${left}px;top:60px;${extra}"><div style="width:0px;"><span data-width="200" style="font-size:${size}px;line-height:48px;color:#fff;">${value}</span></div></div>`;
	const picture = (width = 720, extra = "", alt = "") => `<img src="data/photo.png" width="${width}" height="540" alt="${alt}" style="${extra}"/>`;
	const read = (markup: string, shapes = "Small subtitle\r\nRepeated title\r\nRemaining text") => {
		writeFileSync(join(root, "index.html"), `<script>presInfo="${Buffer.from(JSON.stringify({ w: 720, h: 540, s: [{ t: "Repeated title", s: "data/slide.js", x: shapes }] })).toString("base64")}"</script>`);
		writeFileSync(join(root, "data/slide.js"), slideJs(`<div><div class="kern slide">${markup}</div></div>`));
		return extractIspring(root, "").lessons[0]!.pages[0]!.blocks;
	};
	const texts = shape("Small subtitle", 20) + shape("Repeated title", 40) + shape("Remaining text", 12);
	assert.deepEqual(read(picture() + texts), [
		{ kind: "heading", level: 1, text: "Repeated title", subtitle: "Small subtitle", background: { src: "data/photo.png", alt: "", overlay: "dark" } },
		{ kind: "paragraph", text: "Remaining text" },
	]);
	const tied = read(picture(720, "", "Photo description") + shape("First", 30) + shape("Second", 30), "First\r\nSecond");
	assert.equal(tied[0]?.kind, "heading");
	if (tied[0]?.kind === "heading") {
		assert.equal(tied[0].text, "First");
		assert.equal(tied[0].background?.alt, "Photo description");
	}
	for (const markup of [
		picture(400) + texts,
		picture() + shape("Outside", 40, 800),
		texts + picture(),
		picture(720, "transform:rotate(1deg);") + texts,
		picture(720, "z-index:2;") + texts,
		picture() + shape("Rotated", 40, 30, "transform:rotate(1deg);"),
	]) {
		const plain = markup.includes("Outside") ? "Outside" : markup.includes("Rotated") ? "Rotated" : undefined;
		assert.equal(read(markup, plain).some((b) => b.kind === "heading" && b.background), false);
	}
	for (const style of ["transform:translateX(900px);", "transform:rotate(10deg);", "left:50%;"]) {
		const transformed = shape("Transformed", 40, 20, "width:400px;height:80px;").replace('style="font-size:40px;', `style="${style}font-size:40px;`);
		assert.equal(read(picture() + transformed, "Transformed").some((b) => b.kind === "heading" && b.background), false);
	}
	const flat = read(shape("Above", 40, 30, "z-index:2;") + picture(720, "z-index:1;"), "Above");
	assert.equal(flat[0]?.kind === "heading" ? flat[0].text : "missing", "Above");
	const tiedZ = read(picture(720, "z-index:1;") + shape("Above", 40, 30, "z-index:1;"), "Above");
	assert.ok(tiedZ[0]?.kind === "heading" && tiedZ[0].background);
	const nestedZ = read(picture() + `<div style="z-index:1;">${shape("Nested", 40, 30, "z-index:2;")}</div>`, "Nested");
	assert.equal(nestedZ.some((b) => b.kind === "heading" && b.background), false);
	const unsized = read(picture() + shape("Unsized", 40).replace("font-size:40px;", ""), "Unsized");
	assert.equal(unsized[0]?.kind === "heading" ? unsized[0].background?.overlay : "missing", "dark");
	const inherited = read(picture() + shape("Smaller", 20) + `<div style="font-size:50px;color:#000;">${shape("Inherited", 40).replace("font-size:40px;", "").replace("color:#fff;", "")}</div>`, "Smaller\r\nInherited");
	assert.equal(inherited[0]?.kind === "heading" ? inherited[0].text : "missing", "Inherited");
	assert.equal(inherited[0]?.kind === "heading" ? inherited[0].background?.overlay : "missing", "light");
	for (const [color, overlay] of [["#000000", "light"], ["", undefined]] as const) {
		const blocks = read(picture() + shape("Title", 40).replace("color:#fff;", color ? `color:${color};` : ""), "Title");
		assert.equal(blocks[0]?.kind === "heading" ? blocks[0].background?.overlay : "missing", overlay);
	}
});

test("question attempts retain finite and unlimited counts and terminal feedback, with losses for retry text", () => {
	const values = [undefined, 1, 3, -1, 0, 1.5];
	const root = ispringPackage(values.map((a) => ({
		tp: "MultipleChoice", D: rt("Choose a tool."), C: { chs: [{ t: rt("Hammer"), c: true }] },
		s: { a, ee: true, F: { i: { v: rt("That tool does not fit.") }, at: { v: rt("Try another tool.") } } },
	})));
	const course = extractIspring(root, "res");
	const assessment = course.lessons.flatMap((l) => l.pages.flatMap((p) => p.blocks)).find((b) => b.kind === "group");
	assert.ok(assessment?.kind === "group");
	const questions = assessment.blocks.filter((b) => b.kind === "choice");
	assert.deepEqual(questions.map((q) => q.attempts), [undefined, 1, 3, 0, undefined, undefined]);
	assert.ok(questions.every((q) => q.incorrect === "That tool does not fit."));
	assert.equal(course.losses.filter((l) => /unlimited question attempts/.test(l.detail)).length, 0);
	assert.equal(course.losses.filter((l) => /retry feedback/.test(l.detail)).length, 2);
	assert.ok(course.sourceText.includes("Try another tool."));
});

test("attempts propagate to matching, ordering, categorization, hotspots and blanks", () => {
	const questions = [
		{ tp: "Matching", C: { m: [{ p: { t: rt("Hammer") }, r: { t: rt("Tool") } }] } },
		{ tp: "Sequence", C: { chs: [{ t: rt("Open") }, { t: rt("Close") }] } },
		{ tp: "DND", C: { d: [chain("a", "bin"), chain("b", "bin")] }, a: { o: dndObjects } },
		{ tp: "Hotspot", C: { i: "storage://images/helmet.png", a: [{ t: "rectangle", c: true, r: { x: 0, y: 0, w: 1000, h: 1000 } }] } },
		{ tp: "TypeIn", C: { chs: [{ t: "steel" }] } },
	].map((q) => ({ ...q, D: rt("Respond."), s: { a: 4 } }));
	const course = extractIspring(ispringPackage(questions), "res");
	const group = course.lessons.flatMap((l) => l.pages.flatMap((p) => p.blocks)).find((b) => b.kind === "group");
	assert.ok(group?.kind === "group");
	assert.deepEqual(group.blocks.flatMap((b) => "attempts" in b ? [[b.kind, b.attempts]] : []), [
		["match", 4], ["order", 4], ["categorize", 4], ["hotspot", 4], ["fillBlank", 4],
	]);
});

test("iSpring applies size headings and columns only to fixed slide geometry", () => {
	const root = tmp();
	mkdirSync(join(root, "data"));
	const values = ["Large line", "Body one", "Body two", "Beside picture"];
	writeFileSync(join(root, "index.html"), `<script>presInfo="${Buffer.from(JSON.stringify({ w: 900, h: 600, s: [{ t: "Different page title", s: "data/slide.js", x: values.join("\r\n") }] })).toString("base64")}"</script>`);
	const shape = (value: string, i: number) => `<div style="left:${i === 3 ? 240 : 0}px;top:${i === 3 ? 220 : i * 50}px;width:300px;height:40px;"><div style="width:0px;"><span data-width="300" style="font-size:${i === 0 ? 40 : 20}px">${value}</span></div></div>`;
	const read = (transform = "") => {
		writeFileSync(join(root, "data/slide.js"), slideJs(`<div><div class="kern slide">${values.slice(0, 3).map(shape).join("")}<img src="photo.png" width="200" height="160" style="left:0px;top:200px;${transform}"/>${shape(values[3]!, 3)}</div></div>`));
		return extractIspring(root, "");
	};
	const course = read();
	assert.equal(course.theme?.contentWidth, 900);
	assert.deepEqual(course.lessons[0]!.pages[0]!.blocks.map((b) => b.kind), ["heading", "paragraph", "paragraph", "columns"]);
	assert.ok(read("transform:rotate(10deg)").lessons[0]!.pages[0]!.blocks.every((b) => b.kind !== "columns"));
});

test("iSpring sizes fixed pictures even when glyph text cannot be matched to line boxes", () => {
	const root = tmp();
	mkdirSync(join(root, "data"));
	for (const x of ["", "Glyph paragraph"]) {
		writeFileSync(join(root, "index.html"), `<script>presInfo="${Buffer.from(JSON.stringify({ w: 1000, h: 600, s: [{ s: "data/slide.js", x }] })).toString("base64")}"</script>`);
		for (const [width, style, layout] of [[349, "", "small"], [350, "", "medium"], [599, "", "medium"], [600, "", undefined], [1000, "", "full"], [200, "transform:rotate(5deg);", undefined], [200, "left:10%;", undefined]] as const) {
			writeFileSync(join(root, "data/slide.js"), slideJs(`<div><div class="kern slide"><img src="photo.png" width="${width}" height="100" style="${style}"/></div></div>`));
			const blocks = extractIspring(root, "").lessons[0]!.pages[0]!.blocks;
			assert.equal(blocks.find((b) => b.kind === "image")?.layout, layout);
			if (x) assert.deepEqual(blocks[0], { kind: "paragraph", text: x });
		}
	}
});

test("iSpring Likert layout copies are consumed only after successful mapping", async () => {
	const q = { tp: "LikertScale", D: rt("Rate examples"), C: { s: [rt("First row"), rt("Second row")], l: ["Low", "High"] }, s: { ee: false }, a: { o: ["1", "2", "Low", "Rate examples", "Keep instruction"].map((value, i) => ({ I: `text${i}`, tp: "text", rt: rt(value) })) } };
	const { blocks } = await quizOutput([q]);
	const group = blocks.find((b) => b.kind === "group");
	assert.deepEqual(group?.blocks.filter((b) => b.kind === "paragraph"), [{ kind: "paragraph", text: "Keep instruction" }]);
	q.C.l = ["Low"];
	const failed = await quizOutput([q]);
	assert.ok(failed.blocks.some((b) => b.kind === "paragraph" && b.text === "Low"));
});
