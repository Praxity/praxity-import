import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { extractCaptivate } from "../src/extract/captivate.ts";
import { importPackage } from "../src/import.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "praxity-import-captivate-"));

function files(dir: string, entries: Record<string, string>) {
	for (const [rel, content] of Object.entries(entries)) {
		mkdirSync(join(dir, rel, ".."), { recursive: true });
		writeFileSync(join(dir, rel), content);
	}
}

/** Synthetic question data only. Real package text never belongs in fixtures. */
function questionPackage(q: Record<string, unknown>, objects: Record<string, Record<string, unknown>> = {}, extra: Record<string, unknown> = {}): string {
	const dir = tmp();
	const model = {
		project: { pN: "Synthetic quiz", w: 800, h: 600 }, project_main: { slides: "Slide1" },
		Slide1: { st: "Question Slide", qs: "Question1", mdi: "Slide1c", si: Object.entries(objects).filter(([, o]) => o.mdi).map(([n, o]) => ({ n, t: o.type })) },
		Slide1c: {}, Question1: { qt: "Choose a response.", ...q }, ...objects, ...extra,
	};
	files(dir, { "assets/js/CPM.js": `cp.model.data = ${JSON.stringify(model)};`, "index.html": "<html></html>" });
	return dir;
}

/** Captivate 2017/2019 layout: text rendered to PNG, words in `accstr`, one flat model in CPM.js. */
function classicPackage(): string {
	const dir = tmp();
	const model = `{pref:{acc:0},
Slide1:{lb:'Intro',id:1,from:1,to:90,mdi:'Slide1c',st:'Normal Slide',audCC:[{sf:1,ef:30,t:{1024:'<div><span>Welcome to the</span></div>'}},{sf:31,ef:60,t:{1024:'<div>course.</div>'}}],accstr:' ',si:[{n:'Cap2',t:19},{n:'Cap1',t:19},{n:'Img1',t:15},{n:'Btn1',t:13},{n:'Cap1b',t:19},{n:'Hid1',t:612}],qs:''},
Slide1c:{b:[0,0,0,0],uid:1,ip:'dr/bg.png',dn:'Slide1',visible:'1',sr:cp.fd},
StAd0:{from:1,to:60,src:'ar/narr.mp3',du:2000},
Cap1:{type:19,mdi:'Cap1c',stl:[{stn:'Normal',stsi:[11]},{stn:'Hover',stsi:[13]}]},Cap1c:{b:[10,20,300,60],uid:11,ip:'dr/Cap1.png',accstr:'Hello *world* ',visible:1},
Cap1b:{type:19,mdi:'Cap1bc'},Cap1bc:{b:[10,20,300,60],uid:13,ip:'dr/Cap1b.png',accstr:'Hello hovered ',visible:1},
Cap2:{type:19,mdi:'Cap2c'},Cap2c:{b:[10,100,300,140],uid:12,accstr:'Second line ',visible:1},
Img1:{type:15,mdi:'Img1c'},Img1c:{b:[400,20,600,200],uid:14,ip:'dr/photo.png',accstr:'A red valve ',visible:1},
Btn1:{type:13,mdi:'Btn1c',oca:'cp.jumpToNextSlide();'},Btn1c:{b:[0,300,100,340],uid:15,accstr:'Click Box ',visible:1},
Hid1:{type:612,mdi:'Hid1c'},Hid1c:{b:[0,0,100,100],uid:16,accstr:'Well done ',visible:0},
Slide2:{lb:'',id:2,from:91,to:180,mdi:'Slide2c',st:'Question Slide',si:[{n:'A1',t:612},{n:'A2',t:612},{n:'Fb1',t:19}],qs:'Slide2q'},Slide2c:{b:[0,0,0,0],uid:2,dn:'Slide2',visible:'1'},
Slide2q:{qt:'Which valve is red?',qtp:'MCQ',cal:'A2',osc:'Fb1',ifc:[],ao:['A1c:0','A2c:1']},
A1:{type:612,mdi:'A1c'},A1c:{b:[0,0,1,1],uid:21,accstr:'Blue one ',visible:1},A2:{type:612,mdi:'A2c'},A2c:{b:[0,10,1,1],uid:22,accstr:'Red one ',visible:1},
Fb1:{type:19,mdi:'Fb1c'},Fb1c:{b:[0,50,1,1],uid:23,accstr:'Correct! ',visible:0},
project:{pN:'Valves 101'},project_main:{slides:'Slide1,Slide2',slideAudios:'StAd0',questions:''}}`;
	files(dir, {
		"assets/js/CPM.js": `if(!window.cp)window.cp = function(str){return document.getElementById(str)};cp.CPProjInit = function(){cp.model = {}; cp.D = cp.model.data = ${model};};\ncp.CPPreInit=function(){cp.CPProjInit();};`,
		"project.txt": JSON.stringify({ metadata: { generator: "Captivate", generatorVersion: "11.5.5", title: "", description: "" }, toc: [{ id: "Slide1", title: "Slide 1" }, { id: "Slide2", title: "Slide 2" }] }),
		"dr/bg.png": "png",
		"dr/photo.png": "png",
		"ar/narr.mp3": "mp3",
		"index.html": "<html></html>",
	});
	return dir;
}

/** Captivate 12+ layout: Draft.js text, a11y props, nested containers, a question pool. */
function modernPackage(): string {
	const dir = tmp();
	const text = (blocks: unknown[]) => JSON.stringify({ blocks });
	const model = `{pref:{lang:'en'},
Slide1:{lb:'Welcome',id:1,from:1,to:90,mdi:'Slide1c',st:'Normal Slide',audCC:'[{"start":0,"text":"Narrated intro."}]',si:[{n:'si10',t:1268}],accProps:{a11yTabOrder:[]},qs:''},
Slide1c:{b:[0,0,0,0],uid:1,dn:'Slide1',visible:'1'},
si10:{type:1268,mdi:'si10c',tag:'cp-custom-widget-container',si:[{n:'si20',t:1250},{n:'si30',t:15},{n:'si40',t:15},{n:'si21',t:1250},{n:'si50',t:1305}]},si10c:{b:[0,0,0,0],uid:10,visible:1},
si20:{type:1250,mdi:'si20c',tag:'slide-item-text',text:${JSON.stringify(text([{ text: "Safety first", type: "unstyled", inlineStyleRanges: [{ offset: 0, length: 6, style: "fontWeight:bold" }] }, { text: "Gloves", type: "unordered-list-item", inlineStyleRanges: [] }, { text: "Boots", type: "unordered-list-item", inlineStyleRanges: [] }]))},widgetProps:'{"sizeNPos":{"left":10,"top":10}}'},si20c:{b:[0,0,1,1],uid:20,visible:1,accProps:{a11yHeadingLevel:0}},
si21:{type:1250,mdi:'si21c',tag:'slide-item-text',text:${JSON.stringify(text([{ text: "Module 1", type: "unstyled", inlineStyleRanges: [] }]))},widgetProps:'{"sizeNPos":{"left":10,"top":0}}'},si21c:{b:[0,0,1,1],uid:21,visible:1,accProps:{a11yHeadingLevel:2}},
si30:{type:15,mdi:'si30c',tag:'slide-item-image',widgetProps:'{"sizeNPos":{"left":10,"top":50}}',stl:[{stn:1,stsi:[30]},{stn:2,stsi:[40]}]},si30c:{b:[0,0,1,1],uid:30,ip:'dr/valve.png',visible:1,accProps:{a11yText:'A valve',a11yVisibility:true}},
si40:{type:15,mdi:'si40c',tag:'slide-item-image',baseItemIdForPropertyFlow:30},si40c:{b:[0,0,1,1],uid:40,ip:'dr/valve.png',visible:1,accProps:{a11yText:'',a11yVisibility:true}},
si50:{type:1305,mdi:'si50c',tag:'cp-shape-lib-item',widgetProps:'{"sizeNPos":{"left":10,"top":90}}'},si50c:{b:[0,0,1,1],uid:50,ip:'dr/',visible:1},
project:{pN:'Safety.cptx'},project_main:{slides:'Slide1',slideAudios:'',questions:''}}`;
	const pool = `{Slide70:{lb:'Q1',id:70,mdi:'Slide70c',st:'Question Slide',si:[{n:'si71',t:1268}],qs:'Slide70q'},Slide70c:{b:[0,0,0,0],uid:70,visible:'1'},
si71:{type:1268,mdi:'si71c',tag:'container-multiple-choice',si:[{n:'si72',t:1250},{n:'si73',t:10090},{n:'si74',t:10090},{n:'si75',t:29}]},si71c:{uid:71,visible:1},
si72:{type:1250,mdi:'si72c',tag:'slide-item-question-text',text:${JSON.stringify(text([{ text: "Pick the PPE.", type: "unstyled", inlineStyleRanges: [] }]))}},si72c:{uid:72,visible:1,accProps:{a11yHeadingLevel:1}},
si73:{type:10090,mdi:'si73c',tag:'slide-item-answer-checkbox0',widgetProps:${JSON.stringify(JSON.stringify({ normal: { editorState: { blocks: [{ text: "Gloves", type: "unstyled", inlineStyleRanges: [] }] } } }))}},si73c:{uid:73,visible:1},
si74:{type:10090,mdi:'si74c',tag:'slide-item-answer-checkbox1',widgetProps:${JSON.stringify(JSON.stringify({ normal: { editorState: { blocks: [{ text: "Coffee", type: "unstyled", inlineStyleRanges: [] }] } } }))}},si74c:{uid:74,visible:1},
si75:{type:29,mdi:'si75c',tag:'slide-item-submit-button'},si75c:{uid:75,visible:1},
Slide70q:{qt:'Pick the PPE.',qtp:'MCQ',ail:['si73','si74'],cal:['si73'],osc:'',ifc:[]}}`;
	files(dir, {
		"assets/js/project.js": `if(!window.cp)window.cp = function(str){return document.getElementById(str)};cp.CPProjInit = function(){cp.model = {}; cp.D = cp.model.data = ${model};};`,
		"pools/7/7.js": `window.CPPool7Init = function() { cp.model['7Data']=${pool};};`,
		"project.txt": JSON.stringify({ metadata: { generator: "Captivate", generatorVersion: "13.2.0", title: "Safety Basics", description: "Intro course" }, contentStructure: [], toc: [{ id: "Slide1", title: "Welcome" }] }),
		"dr/valve.png": "png",
		"index.html": "<html></html>",
	});
	return dir;
}

test("imports a classic Captivate export: accessibility text, reading order, narration, states and a question slide", async () => {
	const root = classicPackage();
	const course = extractCaptivate(root);
	assert.equal(course.toolVersion, "Captivate 2019 11.5.5");
	assert.equal(course.title, "Valves 101");
	assert.ok(course.sourceText.includes("Well done"), "hidden text is inventoried");
	assert.ok(course.sourceText.includes("Welcome to the"), "closed captions are inventoried");
	assert.ok(!course.sourceText.includes("Hello hovered"), "state variants are not separate content");

	const out = join(tmp(), "course");
	const report = await importPackage(root, out);
	assert.equal(report.detected.tool, "captivate");
	const prax = readFileSync(join(out, report.lessons[0]?.file ?? ""), "utf8");
	assert.match(prax, /^\/assets\/dr\/bg\.png\ndecorative: true\n\n\/assets\/ar\/narr\.mp3\n\nWelcome to the course\.\n\nas: col\n\nHello \\\*world\\\*\n\nSecond line\n\nas: col\n\n\/assets\/dr\/photo\.png\nalt: A red valve\n\nclose: col\n\nWell done$/m, "background, narration, captions, then items top-to-bottom, hidden text last");
	assert.doesNotMatch(prax, /Hello hovered|Click Box/);
	assert.match(prax, /^--- Slide 2\n\n## Which valve is red\?\nas: choice\nscored: true\ncorrect: Correct!\n\n\( \) Blue one\n\(x\) Red one$/m);
	const sources = report.losses.map((l) => `${l.source}/${l.effect}`);
	assert.ok(sources.includes("captivate:interaction/dropped"), "click box recorded");
	assert.ok(sources.includes("captivate:hidden/approximated"), "hidden objects recorded");
});

test("imports a Captivate 13 export: Draft.js text, lists, headings, alt text, containers and a question pool", async () => {
	const root = modernPackage();
	const course = extractCaptivate(root);
	assert.equal(course.toolVersion, "Captivate 13.2.0");
	assert.equal(course.title, "Safety Basics");
	assert.equal(course.locale, "en");
	assert.ok(course.sourceText.includes("Narrated intro."));
	assert.ok(course.sourceText.includes("Pick the PPE."));

	const out = join(tmp(), "course");
	const report = await importPackage(root, out);
	const prax = readFileSync(join(out, report.lessons[0]?.file ?? ""), "utf8");
	assert.match(prax, /^Narrated intro\.\n\n## Module 1\n\n\*\*Safety\*\* first\n\n- Gloves\n- Boots\n\n\/assets\/dr\/valve\.png\nalt: A valve$/m);
	assert.equal(prax.match(/valve\.png/g)?.length, 1, "the hover-state copy of the image is not imported");
	assert.doesNotMatch(prax, /\/assets\/dr\n|\/dr\/\n/, "a shape without an image fill is not an image");
	assert.match(prax, /^--- Q1\n\n## Pick the PPE\.\nas: choice\nscored: true\n\n\(x\) Gloves\n\( \) Coffee$/m);
	assert.ok(report.losses.some((l) => l.source === "captivate:pool"), "pool draw recorded");
});

test("maps Likert surveys to rating or matrix, retaining the stem, statements and scale", async () => {
	for (const count of [1, 2]) {
		const root = questionPackage({ qtp: "LIKERT", rsv: ["Never", "Sometimes", "Always"], ao: count === 1 ? ["Ac:0"] : ["Ac:0", "Bc:1"] }, {
			A: { type: 10112, mdi: "Ac" }, Ac: { atxtlms: "I can find the exit." },
			...(count === 2 ? { B: { type: 10112, mdi: "Bc" }, Bc: { atxtlms: "I can raise the alarm." } } : {}),
		});
		const course = extractCaptivate(root);
		assert.deepEqual(course.lessons[0]?.pages[0]?.blocks, count === 1
			? [{ kind: "rating", prompt: "Choose a response.\nI can find the exit.", scale: ["Never", "Sometimes", "Always"] }]
			: [{ kind: "matrix", prompt: "Choose a response.", scale: ["Never", "Sometimes", "Always"], statements: ["I can find the exit.", "I can raise the alarm."] }]);
		assert.ok(course.sourceText.includes("Always"));
		assert.ok(course.sourceText.includes("I can find the exit."));
		assert.deepEqual(course.losses.map((loss) => [loss.source, loss.effect]), [["captivate:theme", "approximated"]]);
		const out = join(tmp(), "course");
		const report = await importPackage(root, out);
		const prax = readFileSync(join(out, report.lessons[0]!.file), "utf8");
		assert.match(prax, new RegExp(`as: ${count === 1 ? "rating" : "matrix"}`));
		assert.match(prax, /1: Never\n2: Sometimes\n3: Always/);
	}
	const incomplete = extractCaptivate(questionPackage({ qtp: "LIKERT", qt: "Rate the activity.", rsv: ["Low", "High"] }));
	assert.equal(incomplete.lessons[0]?.pages[0]?.blocks[0]?.kind, "paragraph");
	assert.match(incomplete.losses[0]!.detail, /missing or unreadable statements or scale labels/);
	assert.ok(incomplete.sourceText.includes("High"), "inventory does not depend on successful mapping");
});

test("maps hotspot display bounds to image-relative centres, with correct flags and source alt text", async () => {
	const root = questionPackage({ qtp: "Hotspot", ao: ["Ahotspot:0", "Bhotspot:1", "Chotspot:2"], cal: ["third"] }, {
		Picture: { type: 15, mdi: "Picturec" }, Picturec: { b: [100, 50, 500, 250], ip: "dr/panel.svg", accstr: "Three switches" },
		A: { type: 131, mdi: "Ahotspot" }, Ahotspot: { b: [180, 80, 220, 120], ic: true, aid: "first" },
		B: { type: 131, mdi: "Bhotspot" }, Bhotspot: { b: [380, 180, 420, 220], ic: false, aid: "second" },
		C: { type: 131, mdi: "Chotspot" }, Chotspot: { b: [280, 130, 320, 170], aid: "third" },
	});
	files(root, { "dr/panel.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="white"/><g fill="black"><circle cx="100" cy="50" r="10"/><circle cx="300" cy="150" r="10"/><circle cx="200" cy="100" r="10"/></g></svg>' });
	const course = extractCaptivate(root);
	assert.deepEqual(course.lessons[0]?.pages[0]?.blocks, [{ kind: "hotspot", scored: true, prompt: "Choose a response.", src: "dr/panel.svg", alt: "Three switches", spots: [
		{ label: "Spot 1", x: 25, y: 25, correct: true }, { label: "Spot 2", x: 75, y: 75, correct: false }, { label: "Spot 3", x: 50, y: 50, correct: true },
	] }]);
	assert.ok(course.losses.some((l) => l.effect === "approximated" && /regions became centre points/.test(l.detail)));
	const out = join(tmp(), "course");
	const report = await importPackage(root, out);
	const prax = readFileSync(join(out, report.lessons[0]!.file), "utf8");
	assert.match(prax, /as: hotspot\nscored: true\n\n\/assets\/dr\/panel.svg\nalt: Three switches\nspot: Spot 1; 25%; 25%; correct\nspot: Spot 2; 75%; 75%\nspot: Spot 3; 50%; 50%; correct/);
	assert.equal(prax.match(/panel.svg/g)?.length, 1);
});

test("uses slide dimensions for hotspot backgrounds and reports unmappable or missing images", async () => {
	const objects = { A: { type: 131, mdi: "Ahotspot" }, Ahotspot: { b: [200, 150, 600, 450], ic: true } };
	const q = { qtp: "Hotspot", ao: ["Ahotspot:0"] };
	const root = questionPackage(q, objects, { Slide1c: { b: [0, 0, 0, 0], ip: "dr/missing.png" } });
	assert.deepEqual(extractCaptivate(root).lessons[0]?.pages[0]?.blocks[0], { kind: "hotspot", scored: true, prompt: "Choose a response.", src: "dr/missing.png", alt: "", spots: [{ label: "Spot 1", x: 50, y: 50, correct: true }] });
	const report = await importPackage(root, join(tmp(), "course"));
	assert.ok(report.losses.some((l) => /hotspot question dropped: its image is missing/.test(l.detail)));
	for (const bad of [questionPackage(q, objects), questionPackage(q, { ...objects, Ahotspot: { b: [0, 0, 0, 0] } }), questionPackage({ ...q, ao: ["absent:0"] }, objects)]) {
		const course = extractCaptivate(bad);
		assert.ok(!course.lessons[0]?.pages[0]?.blocks.some((b) => b.kind === "hotspot"));
		assert.ok(course.losses.some((l) => l.source === "captivate:question/Hotspot" && l.effect === "dropped"));
	}
	for (const type of [15, 19]) {
		const composed = extractCaptivate(questionPackage(q, {
			...objects, Foreground: { type, mdi: "Foregroundc" }, Foregroundc: { b: [200, 150, 600, 450], ip: "dr/label.png", accstr: "The target" },
			Other: { type, mdi: "Otherc" }, Otherc: { b: [500, 350, 700, 550], ip: "dr/other.png", accstr: "Another target" },
		}, { Slide1c: { ip: "dr/background.png" } }));
		assert.ok(!composed.lessons[0]?.pages[0]?.blocks.some((b) => b.kind === "hotspot"));
		assert.ok(composed.losses.some((l) => /need compositing/.test(l.detail)), "a bare background cannot substitute for overlapping foreground pictures or captions");
	}
});

test("decodes safe image caches without executing scripts, overriding disk files or following escaping symlinks", async () => {
	const png = Buffer.from("89504e470d0a1a0a", "hex");
	const formats = new Map([
		["dr/a.png", png], ["dr/b.jpg", Buffer.from("ffd8ffe0", "hex")],
		["dr/c.gif", Buffer.from("GIF87a")], ["dr/d.gif", Buffer.from("GIF89a")],
		["dr/e.webp", Buffer.from("524946460000000057454250", "hex")],
	]);
	const objects = Object.fromEntries([...formats.keys()].flatMap((ip, i) => [[`Image${i}`, { type: 15, mdi: `Image${i}c` }], [`Image${i}c`, { ip, accstr: `Sample ${i}` }]]));
	const root = questionPackage({}, objects);
	const cache = Object.fromEntries([...formats].map(([path, bytes]) => [path, bytes.toString("base64")]));
	const invalid = ["../escape.png", "/absolute.png", "C:/drive.png", "dr/../traversal.png", "dr\\backslash.png", "dr/\0null.png", "dr/bad.png", "dr/base64.png", "dr/high-bit.gif", "dr/expression.png"];
	files(root, {
		"dr/img1.json": `cp.imagesJSONCache001=${JSON.stringify({ ...cache, ...Object.fromEntries(invalid.slice(0, 6).map((p) => [p, png.toString("base64")])), "dr/bad.png": Buffer.from("not an image").toString("base64"), "dr/base64.png": `${png.toString("base64")}!`, "dr/high-bit.gif": Buffer.from([...Buffer.from("GIF89a")].map((n) => n | 128)).toString("base64"), "dr/real.png": png.toString("base64"), ___: "___" }).replace(/}$/, ',"dr/expression.png":(function(){throw new Error("must not execute")})()}')};`,
		"dr/img2.json": `cp.imagesJSONCache002={"dr/a.png":"${Buffer.from("GIF89a").toString("base64")}"};`,
		"dr/imgmd.json": `cp.imagesJSONCacheForLocal=true; cp.imageToJSONPathMap={"dr/a.png":"img1.json"}; cp.imagesJSONCacheMetadata={"dr/metadata.png":"${png.toString("base64")}"};`,
		"dr/real.png": "disk wins",
	});
	const outside = tmp();
	files(outside, { "cache.json": `cp.imagesJSONCache999={"dr/outside.png":"${png.toString("base64")}"}` });
	symlinkSync(join(outside, "cache.json"), join(root, "dr/img999.json"));
	const course = extractCaptivate(root);
	assert.deepEqual([...course.embedded!], [...formats, ["dr/metadata.png", png]]);
	const losses = course.losses.filter((l) => l.source === "captivate:image-cache");
	assert.equal(losses.length, invalid.length);
	assert.ok(invalid.every((key) => losses.some((l) => l.at === `dr/img1.json/${key}` && l.effect === "dropped")));
	const out = join(tmp(), "course");
	const report = await importPackage(root, out);
	for (const [path, bytes] of formats) assert.deepEqual(readFileSync(join(out, "assets", path)), bytes);
	assert.ok(!report.losses.some((l) => l.source.startsWith("file:")), "decoded images resolve as present");
});

test("drops recorded result slides once, independent of their wording, and keeps their source inventory", () => {
	const objects = { Label: { type: 19, mdi: "Labelc" }, Labelc: { accstr: "Synthetic status" } };
	for (const markers of [
		{ quizzingData: { anyScoreSlide: 0 } },
		{ Label: { type: 111, mdi: "Labelc" } },
	]) {
		const course = extractCaptivate(questionPackage({}, objects, markers));
		assert.deepEqual(course.lessons[0]!.pages, []);
		assert.deepEqual(course.losses.filter((l) => l.effect === "dropped"), [{ at: "Slide1", source: "captivate:results", effect: "dropped", detail: "result slide skipped because Studio reports the score itself" }]);
		assert.ok(course.sourceText.includes("Synthetic status"));
	}
	for (const anyScoreSlide of [-1, undefined, 1, "0"]) {
		const course = extractCaptivate(questionPackage({}, objects, { quizzingData: { anyScoreSlide }, Labelc: { accstr: "Synthetic quiz results" } }));
		assert.equal(course.lessons[0]!.pages.length, 1, "English labels and invalid result indexes do not identify a result slide");
		assert.ok(!course.losses.some((l) => l.source === "captivate:results"));
	}
});

test("the question keeps the slide caption's exact wording when the question data strips its quotation marks", () => {
	const root = questionPackage({ qtp: "ShortAnswer", qt: "Describe the Red Valve?" }, {
		Prompt: { type: 79, mdi: "Promptc" }, Promptc: { accstr: "Describe the \u201cRed Valve\u201d?" },
	});
	const blocks = extractCaptivate(root).lessons[0]!.pages[0]!.blocks;
	const prompts = blocks.flatMap((b) => (b.kind === "freeResponse" ? [b.prompt] : b.kind === "paragraph" ? [b.text] : []));
	assert.deepEqual(prompts, ["Describe the \u201cRed Valve\u201d?"]);
});

test("drops a hotspot made from separate cached pictures, including its prompt and question chrome", () => {
	const root = questionPackage({ qtp: "Hotspot", qt: "Select a tile.", ao: ["Ahotspot:0", "Bhotspot:1"] }, {
		Prompt: { type: 79, mdi: "Promptc" }, Promptc: { accstr: "Select a tile." },
		Label: { type: 86, mdi: "Labelc" }, Labelc: { accstr: "Question heading" },
		A: { type: 131, mdi: "Ahotspot" }, Ahotspot: { b: [0, 0, 100, 100], ic: true },
		B: { type: 131, mdi: "Bhotspot" }, Bhotspot: { b: [200, 0, 300, 100] },
		First: { type: 15, mdi: "Firstc" }, Firstc: { b: [0, 0, 100, 100], ip: "dr/first.png", accstr: "First tile" },
		Second: { type: 15, mdi: "Secondc" }, Secondc: { b: [200, 0, 300, 100], ip: "dr/second.png", accstr: "Second tile" },
	});
	const encoded = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
	files(root, { "dr/img1.json": `cp.imagesJSONCache001={"dr/first.png":"${encoded}","dr/second.png":"${encoded}"};` });
	const course = extractCaptivate(root);
	assert.equal(course.embedded?.size, 2);
	assert.deepEqual(course.lessons[0]!.pages, []);
	assert.deepEqual(course.losses, [{ at: "Slide1", source: "captivate:question/Hotspot", effect: "dropped", detail: 'hotspot question "Select a tile." dropped: regions have no shared image with readable bounds; separate pictures/captions need compositing and Studio choice options cannot display images' }]);
	assert.ok(course.sourceText.includes("Select a tile."));
});

test("retains short-answer and FIB alternatives, and sequence/matching feedback", async () => {
	const feedback = { Good: { type: 10166, mdi: "Goodc" }, Goodc: { accstr: "That is correct." }, Bad: { type: 10168, mdi: "Badc" }, Badc: { accstr: "Try another answer." } };
	for (const qtp of ["ShortAnswer", "FIB", "Sequence", "Matching"]) {
		const root = questionPackage({ qtp, cal: qtp === "ShortAnswer" ? ["azure", "blue"] : qtp === "Sequence" ? ["Bc", "Ac"] : [], ao: qtp === "FIB" ? ["Afib:0"] : ["Ac:0", "Bc:1"], aio: ["Ac"], aco: ["Bc"], osc: "Good", ifc: ["Bad"] }, {
			...feedback, A: { type: 80, mdi: "Ac" }, Ac: { atxtlms: "First", aid: "pair" }, B: { type: 80, mdi: "Bc" }, Bc: { atxtlms: "Second", aid: "pair" },
			Afib: { correctAnswers: ["azure", "blue"], capN: "Sentence" }, Sentencec: { fibText: "The sky is" },
		});
		const course = extractCaptivate(root);
		const block = course.lessons[0]?.pages[0]?.blocks.at(-1);
		assert.equal(block?.kind, qtp === "Sequence" ? "order" : qtp === "Matching" ? "match" : "fillBlank");
		assert.ok(block && "correct" in block);
		assert.equal(block.correct, "That is correct.");
		assert.equal(block.incorrect, "Try another answer.");
		if (block.kind === "fillBlank") assert.deepEqual(block.parts, [...(qtp === "FIB" ? ["The sky is "] : []), { answers: ["azure", "blue"] }]);
		if (block.kind === "order") assert.deepEqual(block.items, ["Second", "First"]);
		assert.ok(!course.losses.some((l) => /first of|not enforced|feedback not kept/.test(l.detail)));
		const out = join(tmp(), "course");
		const report = await importPackage(root, out);
		assert.match(readFileSync(join(out, report.lessons[0]!.file), "utf8"), /correct: That is correct\.\nincorrect: Try another answer\./);
	}
});

test("keeps every FIB blank and preserves literal punctuation in answer keys", async () => {
	const course = extractCaptivate(questionPackage({ qtp: "FIB", ao: ["Afib:0", "Bfib:1", "Cfib:2"] }, {
		Afib: { correctAnswers: ["red", "scarlet"], capN: "Sentence", cs: true }, Bfib: { capN: "Sentence" }, Cfib: { correctAnswers: ["a|b"], capN: "Sentence" },
		Sentencec: { fibText: "The signal has three lights." },
	}));
	assert.equal(course.lessons[0]?.pages[0]?.blocks[0]?.kind, "fillBlank");
	const b = course.lessons[0]?.pages[0]?.blocks[0];
	assert.ok(b?.kind === "fillBlank");
	assert.deepEqual(b.parts, ["The signal has three lights. ", { answers: ["red", "scarlet"] }, " ", { answers: [] }, " ", { answers: ["a|b"] }]);
	assert.ok(course.losses.some((l) => /case-sensitive/.test(l.detail)));
	assert.ok(course.losses.some((l) => /unanswerable blanks/.test(l.detail)));
	assert.ok(!course.losses.some((l) => /syntax delimiters/.test(l.detail)));
	for (const qtp of ["ShortAnswer", "FIB"]) {
		const answers = ["a*b", "a_b", "`code`", "a|b", "{value}", "~0.5", "*star", "C:\\temp"];
		const root = questionPackage({ qtp, cal: answers, ao: ["Afib:0"] }, { Afib: { correctAnswers: answers } });
		const punctuation = extractCaptivate(root);
		const block = punctuation.lessons[0]?.pages[0]?.blocks[0];
		assert.ok(block?.kind === "fillBlank");
		assert.deepEqual(block.parts, [{ answers }], "literal answer keys must not go through inline neutralization");
		const out = join(tmp(), "course");
		const report = await importPackage(root, out);
		assert.ok(readFileSync(join(out, report.lessons[0]!.file), "utf8").includes("{a*b|a_b|`code`|a\\|b|\\{value\\}|\\~0.5|\\*star|C:\\\\temp}"));
	}
});

test("FIB dropdowns retain option order, distractors and every correct answer", async () => {
	const root = questionPackage({ qtp: "FIB", ao: ["Afib:0", "Bfib:1"] }, {
		Afib: { sac: true, allAnswers: ["red", "blue", "azure", "green"], correctAnswers: ["blue", "azure"], capN: "Sentence" },
		Bfib: { sac: true, allAnswers: ["a|b", "{value}", "*star"], correctAnswers: ["*star"], capN: "Sentence" },
		Sentencec: { fibText: "Literal {braces} and ____ with *stars*." },
	});
	const course = extractCaptivate(root);
	assert.deepEqual(course.lessons[0]?.pages[0]?.blocks[0], { kind: "fillBlank", scored: true, prompt: "Choose a response.", style: "dropdown", parts: [
		"Literal {braces} and ____ with *stars*. ", { answers: ["blue", "azure"], choices: ["red", "blue", "azure", "green"] }, " ", { answers: ["*star"], choices: ["a|b", "{value}", "*star"] },
	] });
	const out = join(tmp(), "course");
	const report = await importPackage(root, out);
	assert.ok(readFileSync(join(out, report.lessons[0]!.file), "utf8").includes("as: fill-blank\nscored: true\nstyle: dropdown\n\nLiteral \\{braces\\} and \\____ with \\*stars\\*. {red|*blue|*azure|green} {a\\|b|\\{value\\}|*\\*star}"));
	assert.ok(report.losses.some((l) => /blank positions/.test(l.detail)));
	assert.ok(!report.losses.some((l) => l.source === "fill-blank:dropdown"));
});

test("mixed FIB styles and invalid dropdowns keep answer keys with precise losses", async () => {
	for (const mixed of [true, false]) {
		const root = questionPackage({ qtp: "FIB", ao: mixed ? ["Afib:0", "Bfib:1"] : ["Afib:0"] }, {
			Afib: { sac: true, allAnswers: ["red", "blue"], correctAnswers: mixed ? ["blue"] : ["blue", "green"] },
			Bfib: { correctAnswers: ["green", "lime"] },
		});
		const out = join(tmp(), "course");
		const report = await importPackage(root, out);
		const prax = readFileSync(join(out, report.lessons[0]!.file), "utf8");
		assert.ok(prax.includes(mixed ? "{blue} {green|lime}" : "{blue|green}"));
		assert.doesNotMatch(prax, /style: dropdown/);
		assert.ok(report.losses.some((l) => mixed ? /mixed dropdown and typed blanks/.test(l.detail) : /answer outside/.test(l.detail)));
	}
});

test("validated text entries keep every alternative and literal prompt punctuation", async () => {
	const root = questionPackage({}, { Entry: { type: 24, mdi: "Entryc", val: true, exp: ["a|b", "{value}"] }, Entryc: { txt: "Enter *a token*" } });
	const block = extractCaptivate(root).lessons[0]?.pages[0]?.blocks[0];
	assert.deepEqual(block, { kind: "fillBlank", prompt: "Enter \\*a token\\*", parts: [{ answers: ["a|b", "{value}"] }] });
	const out = join(tmp(), "course");
	const report = await importPackage(root, out);
	assert.ok(readFileSync(join(out, report.lessons[0]!.file), "utf8").includes("## Enter \\*a token\\*\nas: fill-blank\n\n{a\\|b|\\{value\\}}"));
});

test("maps fixed drag/drop keys to match or categorize using type IDs and linked feedback", async () => {
	for (const many of [false, true]) {
		const root = questionPackage({}, {
			Prompt: { type: 19, mdi: "Promptc" }, Promptc: { accstr: "Sort the supplies.", b: [0, 0, 100, 20] },
			SourceA: { type: 612, mdi: "SourceAc", isDD: true }, SourceAc: { accstr: "Hammer" },
			SourceB: { type: 612, mdi: "SourceBc", isDD: true }, SourceBc: { accstr: "Saw" },
			TargetA: { type: 612, mdi: "TargetAc", isDD: true }, TargetAc: { accstr: "Toolbox" },
			...(!many ? { TargetB: { type: 612, mdi: "TargetBc", isDD: true }, TargetBc: { accstr: "Shelf" } } : {}),
			Good: { type: 19, mdi: "Goodc" }, Goodc: { accstr: "Everything is stored.", visible: 0 },
			Bad: { type: 19, mdi: "Badc" }, Badc: { accstr: "Try moving a tool.", visible: 0 },
		});
		const file = join(root, "assets/js/CPM.js");
		const model = JSON.parse(readFileSync(file, "utf8").slice("cp.model.data = ".length, -1));
		model.Slide1.st = "Normal Slide";
		model.Slide1.qs = "";
		model.Slide1.iph = [{ n: "Interaction", t: 633 }];
		model.Interaction = { ma: 3, ds: [{ n: "SourceA", t: "typeA" }, { n: "SourceB", t: "typeB" }], dt: [{ n: "TargetA", t: "binA" }, ...(!many ? [{ n: "TargetB", t: "binB" }] : [])], cal: [{ a: `\\b(t:typeA-t:binA){1}(t:typeB-t:${many ? "binA" : "binB"}){1}\\b`, isSeq: false }], osc: "Good", ofc: "Bad" };
		writeFileSync(file, `cp.model.data = ${JSON.stringify(model)};`);
		const course = extractCaptivate(root);
		assert.deepEqual(course.lessons[0]?.pages[0]?.blocks, [{ attempts: 3, prompt: "Sort the supplies.", correct: "Everything is stored.", incorrect: "Try moving a tool.", ...(many ? { kind: "categorize", categories: [{ name: "Toolbox", items: ["Hammer", "Saw"] }] } : { kind: "match", pairs: [["Hammer", "Toolbox"], ["Saw", "Shelf"]] }) }]);
		assert.ok(course.sourceText.includes("Hammer"));
		assert.ok(course.losses.some((l) => l.at === "Slide1/Interaction" && l.effect === "approximated"));
		assert.ok(!course.losses.some((l) => /objects|hidden/.test(l.detail)));
		const out = join(tmp(), "course");
		const report = await importPackage(root, out);
		const prax = readFileSync(join(out, report.lessons[0]!.file), "utf8");
		assert.match(prax, many ? /as: categorize[\s\S]*Toolbox:\n- Hammer\n- Saw/ : /as: match[\s\S]*Hammer :: Toolbox\nSaw :: Shelf/);

		model.Interaction.ma = 0;
		writeFileSync(file, `cp.model.data = ${JSON.stringify(model)};`);
		const unlimited = extractCaptivate(root);
		assert.ok(!unlimited.losses.some((l) => /unlimited drag-and-drop/.test(l.detail)));
		assert.ok(unlimited.lessons[0]!.pages[0]!.blocks.every((b) => "attempts" in b && b.attempts === 0));

		for (const cal of [[], [{ a: "\\b(t:typeA-t:binA){1}\\b", isSeq: false }], [{ a: model.Interaction.cal[0].a, isSeq: true }], [{ a: "\\b(t:.*-t:binA){2}\\b", isSeq: false }], [model.Interaction.cal[0], model.Interaction.cal[0]]]) {
			model.Interaction.cal = cal;
			writeFileSync(file, `cp.model.data = ${JSON.stringify(model)};`);
			const unsupported = extractCaptivate(root);
			assert.ok(unsupported.lessons[0]?.pages[0]?.blocks.every((b) => b.kind !== "match" && b.kind !== "categorize"));
			assert.ok(unsupported.lessons[0]?.pages[0]?.blocks.some((b) => b.kind === "paragraph" && b.text === "Hammer"));
			assert.ok(unsupported.losses.some((l) => l.source === "captivate:drag-and-drop" && l.effect === "dropped"));
			assert.deepEqual(unsupported.sourceText, course.sourceText, "inventory is independent of successful key mapping");
		}
	}
});

test("maps classic project, enabled skin colours and caption fonts without inventing missing settings", () => {
	const dir = questionPackage({}, {
		CapA: { type: 19, vt: '<span style="font-family:Zulu">abc</span>' },
		CapB: { type: 19, vt: '<span style="font-family:\'Lato regular\',Lato">a<span>b c</span></span>' },
		UnusedFont: { type: 15, vt: '<span style="font-family:Wrong">many characters</span>' },
	}, {
		project: { pN: "Synthetic theme", prjBgColor: "#FaFbFc", htmlBgColor: "#eeeeee", hasTOC: 1 },
		playBarProperties: { hasPlayBar: true, applyColors: true, FaceColor: { bc: "#123456", alpha: 100 }, GlowColor: { bc: "#ABCDEF", alpha: 100 }, IconColor: { bc: "#ffffff", alpha: 100 } },
		borderProperties: { hasBorder: true },
	});
	const course = extractCaptivate(dir);
	assert.deepEqual(course.theme, { density: "compact", blockSpacing: "compact", background: "#fafbfc", navigation: "sidebar", accent: "#abcdef", buttonBackground: "#123456", buttonText: "#ffffff", bodyFont: "Lato" });
	const losses = course.losses.filter((l) => l.source === "captivate:theme");
	assert.equal(losses.length, 1);
	assert.equal(losses[0]?.effect, "approximated");
	assert.match(losses[0]!.detail, /character count/);
	assert.deepEqual(extractCaptivate(dir).theme, course.theme);
	assert.deepEqual(extractCaptivate(questionPackage({}, {}, { project: { hasTOC: 0 }, playBarProperties: { hasPlayBar: true, applyColors: false, FaceColor: { bc: "#123456" } } })).theme, { density: "compact", blockSpacing: "compact" });
	assert.deepEqual(extractCaptivate(questionPackage({}, {}, { playBarProperties: { hasPlayBar: true, applyColors: true, FaceColor: { bc: "#123456", alpha: 50 } } })).theme, { density: "compact", blockSpacing: "compact", contentWidth: 800 });
});

test("maps Captivate 12/13 theme variables and presets, resolving references without executing JavaScript", () => {
	const dir = tmp();
	const model = {
		project: { pN: "Synthetic modern theme", prjBgColor: "#eeeeee", hasTOC: true }, project_main: { slides: "" },
		projectThemeData: {
			meta: JSON.stringify({ default_presets: { "1": "text-body-2", "3": "cp_default_slide_style" } }),
			theme: JSON.stringify({ "--primary": "var(--colour)", "--colour": "#123456", "--font1": "Lora", "--font2": "Lato", "--text-heading-1--fontFamily": "var(--font1)", "--text-body-2--fontFamily": "var(--font2)", "--text-body-2--color": "#222222", "--background": "#fafafa", "--button-normal--primaryColor": "var(--primary)", "--text-button-normal--color": "#ffffff" }),
			other_presets: JSON.stringify({ cp_default_slide_style: { meta: { fillEnable: 1, fillType: 1 }, backgroundColor: "var(--background)", fillOpacity: 1 } }),
		},
	};
	files(dir, { "assets/js/project.js": `cp.D = cp.model.data = ${JSON.stringify(model)}; throw new Error('must not execute');` });
	const course = extractCaptivate(dir);
	assert.deepEqual(course.theme, { density: "compact", blockSpacing: "compact", background: "#fafafa", navigation: "sidebar", accent: "#123456", text: "#222222", buttonBackground: "#123456", buttonText: "#ffffff", headingFont: "Lora", bodyFont: "Lato" });
	assert.equal(course.losses.filter((l) => l.source === "captivate:theme").length, 1);
	model.projectThemeData.theme = JSON.stringify({ "--primary": "var(--loop)", "--loop": "var(--primary)", "--text-heading-1--fontFamily": "var(--missing)", "--text-body-2--color": "expression(evil())" });
	files(dir, { "assets/js/project.js": `cp.model.data = ${JSON.stringify(model)};` });
	assert.deepEqual(extractCaptivate(dir).theme, { density: "compact", blockSpacing: "compact", background: "#eeeeee", navigation: "sidebar" });
	model.projectThemeData.theme = "not JSON";
	files(dir, { "assets/js/project.js": `cp.model.data = ${JSON.stringify(model)};` });
	assert.deepEqual(extractCaptivate(dir).theme, { density: "compact", blockSpacing: "compact", background: "#eeeeee", navigation: "sidebar" });
});

test("dominant classic and modern slide backgrounds override the project default with deterministic ties", () => {
	const root = tmp();
	const slides: Record<string, unknown>[] = [
		{ bc: "#ABCDEF" }, { canvasData: { bc: "#abcdef", fe: true, fa: 1 } }, { bc: "#123456" },
		{ canvasData: { bc: "#000000", fe: true, fa: 0.5 }, bc: "#000000" },
		{ canvasData: { bc: "#000000", fe: false, fa: 1 } }, { bc: "expression(evil())" },
	];
	const write = () => files(root, { "assets/js/CPM.js": `cp.model.data = ${JSON.stringify({
		project: { pN: "Synthetic background", prjBgColor: "#eeeeee" },
		project_main: { slides: slides.map((_, i) => `Slide${i}`).join(",") },
		Template: { type: 15, mdi: "Templatec" }, Templatec: { ip: "dr/template.png" },
		...Object.fromEntries(slides.map((slide, i) => [`Slide${i}`, { lb: "Slide", si: [{ n: "Template", t: 15 }], ...slide }])),
	})};` });
	write();
	const course = extractCaptivate(root);
	assert.equal(course.theme?.background, "#abcdef");
	assert.equal(course.losses.filter((l) => l.source === "captivate:theme" && l.effect === "approximated").length, 1);
	assert.match(course.losses.find((l) => l.source === "captivate:template" && l.effect === "dropped")!.detail, /1 pictures repeated on 3\+ slides.*dr\/template\.png/);
	assert.ok(course.lessons[0]!.pages.every((page) => page.blocks.length === 0), "template skipping is unchanged");
	slides.push({ bc: "#123456" });
	write();
	assert.equal(extractCaptivate(root).theme?.background, "#123456");
	slides.reverse();
	write();
	assert.equal(extractCaptivate(root).theme?.background, "#123456");
	slides.splice(0, slides.length, { canvasData: { bc: "#000000", fe: true, fa: 0.5 } });
	write();
	assert.equal(extractCaptivate(root).theme?.background, "#eeeeee");
});

test("Captivate promotes fixed pictures behind overlapping captions, preserving font rank and remaining blocks", () => {
	const root = tmp();
	const model = {
		project: { pN: "Synthetic hero", w: 800, h: 600 }, project_main: { slides: "Slide1" },
		Slide1: { lb: "Cover title", si: ["Picture", "Subtitle", "Title", "Body"].map((n) => ({ n })) },
		Picture: { type: 15, mdi: "Picturec" }, Picturec: { b: [0, 0, 800, 600], ip: "photo.png", accstr: "Fallback", accProps: { a11yText: "" } },
		Subtitle: { type: 19, mdi: "Subtitlec" }, Subtitlec: { b: [20, 20, 500, 50], accstr: "A short subtitle", vt: '<span style="font-size:20px;color:#fff">A short subtitle</span>' },
		Title: { type: 19, mdi: "Titlec" }, Titlec: { b: [20, 80, 700, 140], accstr: "Cover title", vt: '<span style="font-size:48px;color:#fff">Cover title</span>' },
		Body: { type: 19, mdi: "Bodyc" }, Bodyc: { b: [20, 200, 700, 250], accstr: "Keep this paragraph.", vt: '<span style="font-size:16px">Keep this paragraph.</span>' },
	};
	const read = () => {
		files(root, { "assets/js/CPM.js": `cp.model.data = ${JSON.stringify(model)}; throw new Error('never execute');` });
		return extractCaptivate(root).lessons[0]!.pages[0]!;
	};
	assert.deepEqual(read().blocks, [
		{ kind: "heading", level: 1, text: "Cover title", subtitle: "A short subtitle", background: { src: "photo.png", alt: "", overlay: "dark" } },
		{ kind: "paragraph", text: "Keep this paragraph." },
	]);
	for (const bounds of [[0, 0, 300, 300], [0, 0, 800, 420]]) {
		model.Picturec.b = bounds;
		if (bounds[3] === 420) for (const c of [model.Titlec, model.Subtitlec, model.Bodyc]) c.b = [20, 500, 700, 550];
		assert.ok(read().blocks.every((b) => b.kind !== "heading" || !b.background), "small and non-overlapping pictures remain images");
	}
	model.Picturec.b = [0, 0, 800, 600];
	model.Slide1.si.reverse();
	assert.ok(read().blocks.every((b) => b.kind !== "heading" || !b.background), "a picture drawn over text is not a hero");
	model.Slide1.si.reverse();
	Object.assign(model.Picturec, { tr: "rotate(10deg)" });
	assert.ok(read().blocks.every((b) => b.kind !== "heading" || !b.background), "transformed pictures remain images");
});

test("Captivate promotes the recorded slide canvas and preserves its alt text", () => {
	const root = tmp();
	const model = {
		project: { pN: "Synthetic canvas", w: 800, h: 600 }, project_main: { slides: "Slide1" },
		Slide1: { lb: "Canvas title", mdi: "Slide1c", si: [{ n: "Caption" }] },
		Slide1c: { b: [0, 0, 0, 0], ip: "canvas.png", accstr: "A distant mountain", accProps: { a11yText: "Recorded canvas description" } },
		Caption: { type: 19, mdi: "Captionc" }, Captionc: { b: [20, 80, 700, 140], accstr: "Canvas title", vt: '<span style="font-size:48px;color:#fff">Canvas title</span>' },
	};
	const read = () => {
		files(root, { "assets/js/CPM.js": `cp.model.data = ${JSON.stringify(model)};` });
		return extractCaptivate(root).lessons[0]!.pages[0]!.blocks;
	};
	assert.deepEqual(read(), [{ kind: "heading", level: 1, text: "Canvas title", background: { src: "canvas.png", alt: "Recorded canvas description", overlay: "dark" } }]);
	assert.ok(extractCaptivate(root).sourceText.includes("Recorded canvas description"));
	model.Slide1c.accProps.a11yText = "";
	const empty = read()[0];
	assert.equal(empty?.kind === "heading" ? empty.background?.alt : undefined, "");
	model.Slide1c.b = [0, 0, 200, 200];
	assert.equal(read()[0]?.kind, "image", "recorded smaller bounds take precedence over project size");
	Object.assign(model.Slide1c, { b: [0, 0, "100%", 600] });
	assert.equal(read()[0]?.kind, "image", "non-fixed bounds cannot fall back to project size");
	model.Slide1c.b = [0, 0, 0, 0];
	Object.assign(model.Slide1c, { tr: "rotate(10deg)" });
	assert.equal(read()[0]?.kind, "image");
});

test("question attempts retain finite and unlimited counts and final feedback, with losses for retry captions", () => {
	const objects = {
		Answer: { type: 80, mdi: "Answerc" }, Answerc: { atxtlms: "Valve", accstr: "Valve" },
		Retry: { type: 19, mdi: "Retryc" }, Retryc: { accstr: "Check the position." },
		Final: { type: 19, mdi: "Finalc" }, Finalc: { accstr: "The valve is closed." },
	};
	for (const noa of [undefined, 1, 3, 9999, 0, 1.5]) {
		const root = questionPackage({ qtp: "MCQ", ao: ["Answerc"], cal: ["Answer"], noa, ifc: ["Retry", "Final"] }, objects);
		const course = extractCaptivate(root);
		const q = course.lessons[0]!.pages[0]!.blocks.find((b) => b.kind === "choice");
		assert.ok(q?.kind === "choice");
		assert.equal(q.attempts, noa === 9999 ? 0 : noa === 1 || noa === 3 ? noa : undefined);
		assert.equal(q.incorrect, "The valve is closed.");
		assert.ok(course.losses.some((l) => l.at === "Slide1" && /retry feedback/.test(l.detail)));
		assert.equal(course.losses.some((l) => /unlimited question attempts/.test(l.detail)), false);
	}
	const root = tmp();
	files(root, { "assets/js/project.js": 'cp.model.data = {project:{},project_main:{slides:"Slide1"},Slide1:{st:"Question Slide",qs:"Q",si:[{n:"A",t:80}]},Q:{qtp:"MCQ",qt:"Select.",noa:1024,ao:["A"],cal:["A"]},A:{mdi:"Ac"},Ac:{accstr:"Answer"}};' });
	const course = extractCaptivate(root);
	assert.ok(!course.losses.some((l) => /unlimited question attempts/.test(l.detail)));
	const q = course.lessons[0]!.pages[0]!.blocks.find((b) => b.kind === "choice");
	assert.equal(q?.attempts, 0);
});

test("Captivate size headings and columns retain fixed geometry and stage width", () => {
	const root = tmp();
	const model = {
		project: { pN: "Layout", w: 960, h: 600 }, project_main: { slides: "Slide1" },
		Slide1: { si: ["Title", "Body", "Picture", "Aside"].map((n) => ({ n })) },
		Title: { type: 19, mdi: "Titlec" }, Titlec: { b: [0, 0, 600, 60], accstr: "Large title", vt: '<span style="font-size:40px">Large title</span>' },
		Body: { type: 19, mdi: "Bodyc" }, Bodyc: { b: [0, 80, 600, 120], accstr: "Body text", vt: '<span style="font-size:20px">Body text</span>' },
		Picture: { type: 15, mdi: "Picturec" }, Picturec: { b: [0, 200, 200, 400], ip: "photo.png", tr: "" },
		Aside: { type: 19, mdi: "Asidec" }, Asidec: { b: [220, 210, 600, 260], accstr: "Alongside", vt: '<span style="font-size:20px">Alongside</span>' },
	};
	const read = () => {
		files(root, { "assets/js/CPM.js": `cp.model.data = ${JSON.stringify(model)};` });
		return extractCaptivate(root);
	};
	const course = read();
	assert.equal(course.theme?.contentWidth, 960);
	assert.deepEqual(course.lessons[0]!.pages[0]!.blocks.map((b) => b.kind), ["heading", "paragraph", "columns"]);
	model.Picturec.tr = "rotate(10deg)";
	assert.ok(read().lessons[0]!.pages[0]!.blocks.every((b) => b.kind !== "columns"));
	assert.ok(read().lessons[0]!.pages[0]!.blocks.every((b) => b.kind !== "image" || b.layout === undefined));
	model.Picturec.tr = "";
	model.Asidec.b = [220, 450, 600, 500];
	for (const [width, layout] of [[300, "small"], [400, "medium"], [600, undefined]] as const) {
		model.Picturec.b = [0, 200, width, 400];
		assert.equal(read().lessons[0]!.pages[0]!.blocks.find((b) => b.kind === "image")?.layout, layout);
	}
});

test("Captivate Likert consumes repeated scale captions while retaining instructions", () => {
	const root = questionPackage({ qtp: "LIKERT", rsv: ["Low", "High"], ao: ["Ac", "Bc"] }, {
		A: { type: 10112, mdi: "Ac" }, Ac: { atxtlms: "First row" },
		B: { type: 10112, mdi: "Bc" }, Bc: { atxtlms: "Second row" },
		Scale: { type: 19, mdi: "Scalec" }, Scalec: { accstr: "1" },
		Label: { type: 19, mdi: "Labelc" }, Labelc: { accstr: "High" },
		Instruction: { type: 19, mdi: "Instructionc" }, Instructionc: { accstr: "Keep instruction" },
	});
	const blocks = extractCaptivate(root).lessons[0]!.pages[0]!.blocks;
	assert.deepEqual(blocks.filter((b) => b.kind === "paragraph"), [{ kind: "paragraph", text: "Keep instruction" }]);
	assert.ok(blocks.some((b) => b.kind === "matrix"));
});

test("Captivate reads fixed rows left to right within 10px of an anchored centre, then hidden rows", () => {
	const root = tmp();
	const captions = [
		{ name: "Right", b: [300, 90, 500, 160] },
		{ name: "Left", b: [10, 118, 100, 148] }, // Centres differ by 8px despite different heights.
		{ name: "Next", b: [0, 136, 100, 146] }, // 8px from Left, 16px from the row anchor.
		{ name: "BoundaryRight", b: [300, 180, 500, 200] },
		{ name: "BoundaryLeft", b: [10, 190, 100, 210] }, // Exactly 10px joins the row.
		{ name: "Separate", b: [0, 201, 100, 221] },
		{ name: "TieFirst", b: [20, 251, 100, 271] },
		{ name: "TieSecond", b: [20, 250, 100, 270] },
		{ name: "HiddenRight", b: [300, 0, 500, 30], visible: 0 },
		{ name: "HiddenLeft", b: [10, 8, 100, 38], visible: 0 },
	];
	const model = {
		project: {}, project_main: { slides: "Slide1" },
		Slide1: { si: captions.map(({ name }) => ({ n: name })) },
		...Object.fromEntries(captions.flatMap(({ name, ...display }) => [[name, { type: 19, mdi: `${name}c` }], [`${name}c`, { ...display, accstr: name }]])),
	};
	files(root, { "assets/js/CPM.js": `cp.model.data = ${JSON.stringify(model)};` });
	const course = extractCaptivate(root);
	assert.deepEqual(course.lessons[0]!.pages[0]!.blocks, ["Left", "Right", "Next", "BoundaryLeft", "BoundaryRight", "Separate", "TieFirst", "TieSecond", "HiddenLeft", "HiddenRight"].map((text) => ({ kind: "paragraph", text })));
	assert.deepEqual(extractCaptivate(root), course);
	assert.deepEqual(course.sourceText.slice(1), captions.map(({ name }) => name), "the independent inventory retains source order");
});
