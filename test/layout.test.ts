import assert from "node:assert/strict";
import { test } from "node:test";
import { slideLayout, type HeroItem } from "../src/extract/hero.ts";
import type { Block } from "../src/model.ts";
import { designYaml } from "../src/theme.ts";

test("relative headings use the median, retain order and leave multiline text alone", () => {
	const sizes = [20, 40, 26, 25.9, 20, 20, 20, 20, 20];
	const blocks: Block[] = sizes.map((_, i) => ({ kind: "paragraph", text: `Text ${i}` }));
	const items = blocks.map((b, i) => ({ blocks: [b], order: i, fontSize: sizes[i], singleLine: i !== 6 }));
	items[6]!.fontSize = 60;
	slideLayout(blocks, items, 800, 600);
	assert.deepEqual(blocks.map((b) => b.kind === "heading" ? b.level : b.kind), ["paragraph", 2, 3, "paragraph", "paragraph", "paragraph", "paragraph", "paragraph", "paragraph"]);
	assert.deepEqual(blocks.map((b) => "text" in b ? b.text : ""), sizes.map((_, i) => `Text ${i}`));
});

test("columns require fixed, separated boxes and at least half vertical overlap", () => {
	const run = (x: number, y: number, w = 200) => {
		const words: Block = { kind: "paragraph", text: "Recorded text" };
		const picture: Block = { kind: "image", src: "image.png", alt: "Example" };
		const blocks = [words, picture];
		const items: HeroItem[] = [
			{ blocks: [words], order: 0, box: { x, y, w, h: 100 } },
			{ blocks: [picture], order: 1, box: { x: 0, y: 0, w: 200, h: 200 } },
		];
		slideLayout(blocks, items, 800, 600);
		return blocks;
	};
	assert.deepEqual(run(200, 150), [{ kind: "columns", columns: [[{ kind: "image", src: "image.png", alt: "Example" }], [{ kind: "paragraph", text: "Recorded text" }]] }]);
	for (const [x, y, w] of [[199, 0, 200], [200, 151, 200], [NaN, 0, 200], [200, 0, 0]]) assert.deepEqual(run(x!, y!, w).map((b) => b.kind), ["paragraph", "image"]);
});

test("design emits recorded page widths, a player-sized slide deck width, and keeps absent settings absent", () => {
	for (const contentWidth of [320, 720, 1400, undefined]) {
		const yaml = designYaml({ format: "slides", contentWidth, density: "compact", blockSpacing: "compact" }, undefined, () => {}).join("\n");
		assert.match(yaml, /contentMaxWidth: 960\n  density: compact\n  blockSpacing: compact/);
	}
	assert.ok(designYaml({ contentWidth: 1200, density: "comfortable" }, undefined, () => {}).includes("  contentMaxWidth: 1200"));
	assert.doesNotMatch(designYaml({}, undefined, () => {}).join("\n"), /density|blockSpacing|contentMaxWidth/);
	for (const contentWidth of [NaN, Infinity, 0, -1]) assert.doesNotMatch(designYaml({ contentWidth }, undefined, () => {}).join("\n"), /contentMaxWidth/);
});

test("a tall picture beside text is framed square; a wide one is not", () => {
	for (const [h, framed] of [[300, true], [120, false]] as const) {
		const photo: Block = { kind: "image", src: "photo.png", alt: "" };
		const caption: Block = { kind: "paragraph", text: "Beside" };
		const blocks = [photo, caption];
		slideLayout(blocks, [{ blocks: [photo], box: { x: 0, y: 0, w: 200, h }, order: 0 }, { blocks: [caption], box: { x: 220, y: 0, w: 200, h: 100 }, order: 1 }], 800, 600);
		assert.equal(blocks[0]?.kind, "columns");
		assert.deepEqual(photo.kind === "image" && [photo.ratio, photo.fit], framed ? ["square", "contain"] : [undefined, undefined]);
	}
});

test("columns take the first text's place, so text never moves past other content", () => {
	const instruction: Block = { kind: "paragraph", text: "Instruction" };
	const explanation: Block = { kind: "paragraph", text: "Explanation" };
	const photo: Block = { kind: "image", src: "photo.png", alt: "" };
	const ordered = [photo, instruction, explanation];
	slideLayout(ordered, [{ blocks: [photo], box: { x: 0, y: 0, w: 200, h: 100 }, order: 0 }, { blocks: [instruction], box: { x: 0, y: 300, w: 600, h: 50 }, order: 1 }, { blocks: [explanation], box: { x: 220, y: 0, w: 200, h: 100 }, order: 2 }], 800, 600);
	assert.deepEqual(ordered, [instruction, { kind: "columns", columns: [[photo], [explanation]] }]);
});

test("columns can join non-adjacent slide objects without losing intervening content", () => {
	const paragraph: Block = { kind: "paragraph", text: "Beside image" };
	const note: Block = { kind: "note", text: "Unrelated content" };
	const image: Block = { kind: "image", src: "photo.png", alt: "" };
	const blocks = [paragraph, note, image];
	slideLayout(blocks, [{ blocks: [paragraph], box: { x: 200, y: 0, w: 200, h: 100 }, order: 0 }, { blocks: [image], box: { x: 0, y: 0, w: 200, h: 100 }, order: 2 }], 800, 600);
	assert.deepEqual(blocks, [{ kind: "columns", columns: [[image], [paragraph]] }, note]);
	const later: Block = { kind: "paragraph", text: "Also beside image" };
	const interrupted = [paragraph, note, later, image];
	slideLayout(interrupted, [{ blocks: [paragraph], box: { x: 200, y: 0, w: 200, h: 100 }, order: 0 }, { blocks: [later], box: { x: 200, y: 0, w: 200, h: 100 }, order: 2 }, { blocks: [image], box: { x: 0, y: 0, w: 200, h: 100 }, order: 3 }], 800, 600);
	assert.deepEqual(interrupted, [{ kind: "columns", columns: [[image], [paragraph]] }, note, later]);
});

test("recorded list body sizes contribute to the heading baseline", () => {
	const title: Block = { kind: "paragraph", text: "Section title" };
	const list: Block = { kind: "list", ordered: false, items: ["One", "Two"] };
	const body: Block = { kind: "paragraph", text: "Body text" };
	const blocks = [title, list, body];
	slideLayout(blocks, [{ blocks: [title], order: 0, fontSize: 30 }, { blocks: [list], order: 1, fontSize: 20 }, { blocks: [body], order: 2, fontSize: 20 }], 800, 600);
	assert.deepEqual(blocks, [{ kind: "heading", level: 2, text: "Section title" }, list, body]);
});

test("column runs stay on one side, need half the text height, and never reuse text", () => {
	const run = (boxes: Array<{ x: number; y: number; w: number; h: number }>) => {
		const image: Block = { kind: "image", src: "photo.png", alt: "" };
		const paragraphs: Block[] = boxes.map((_, i) => ({ kind: "paragraph", text: String(i) }));
		const blocks = [image, ...paragraphs];
		slideLayout(blocks, [{ blocks: [image], box: { x: 300, y: 100, w: 200, h: 100 }, order: 0 }, ...paragraphs.map((b, i) => ({ blocks: [b], box: boxes[i], order: i + 1 }))], 1000, 600);
		return blocks;
	};
	const right = { x: 500, y: 100, w: 200, h: 100 };
	const left = { ...right, x: 0 };
	for (const boxes of [[right, left, right], [left, right, left], [right, { ...right, x: NaN }, right]]) {
		const blocks = run(boxes);
		assert.deepEqual(blocks.map((b) => b.kind), ["columns", "paragraph", "paragraph"]);
		assert.ok(blocks[0]?.kind === "columns");
		assert.equal(blocks[0].columns.flat().length, 2);
	}
	assert.equal(run([{ ...right, h: 200 }])[0]?.kind, "columns");
	assert.equal(run([{ ...right, h: 201 }])[0]?.kind, "image");
	const text: Block = { kind: "paragraph", text: "Shared" };
	const pictures: Block[] = [1, 2].map((i) => ({ kind: "image", src: `${i}.png`, alt: "" }));
	const blocks = [text, ...pictures];
	slideLayout(blocks, [{ blocks: [text], box: right, order: 0 }, ...pictures.map((b, i) => ({ blocks: [b], box: { x: 300, y: 100, w: 200, h: 100 }, order: i + 1 }))], 1000, 600);
	assert.deepEqual(blocks.map((b) => b.kind), ["columns", "image"]);
});

test("picture rows require consecutive fixed boxes, allow slight overlap and sort left to right", () => {
	const run = (boxes: Array<HeroItem["box"]>, interrupted = false) => {
		const images: Block[] = boxes.map((_, i) => ({ kind: "image", src: `${i}.png`, alt: "" }));
		const blocks: Block[] = [...images];
		if (interrupted) blocks.splice(1, 0, { kind: "note", text: "Keep this position" });
		slideLayout(blocks, images.map((b, i) => ({ blocks: [b], box: boxes[i], order: i })), 1000, 600);
		return { blocks, images };
	};
	const left = { x: 0, y: 0, w: 200, h: 100 };
	const middle = { x: 200, y: 50, w: 200, h: 200 };
	const right = { x: 400, y: 0, w: 200, h: 100 };
	const { blocks, images } = run([right, left, middle]);
	assert.deepEqual(blocks, [{ kind: "columns", columns: [[images[1]], [images[2]], [images[0]]] }]);
	assert.ok(images.every((b) => b.kind === "image" && b.layout === "small"));
	for (const box of [{ ...middle, x: 199 }, { ...middle, x: 100 }, { ...middle, x: 100, w: 100 }]) {
		assert.equal(run([left, box]).blocks[0]?.kind, "columns");
	}
	for (const box of [{ ...middle, y: 51 }, { ...middle, x: 99 }, { ...middle, x: 99, w: 100 }, { ...left, y: 100 }, { ...left }, undefined, { ...middle, w: NaN }]) {
		assert.deepEqual(run([left, box]).blocks.map((b) => b.kind), ["image", "image"]);
	}
	assert.deepEqual(run([left, middle], true).blocks.map((b) => b.kind), ["image", "note", "image"]);
});

test("only tall small and medium pictures get square contain frames", () => {
	for (const [w, h, layout, framed] of [
		[200, 300, "small", true], [200, 299, "small", false], [200, 100, "small", false],
		[350, 525, "medium", true], [599, 899, "medium", true], [600, 900, undefined, false],
	] as const) {
		const image: Block = { kind: "image", src: "portrait.png", alt: "Synthetic portrait" };
		slideLayout([image], [{ blocks: [image], box: { x: 0, y: 0, w, h }, order: 0 }], 1000, 600);
		assert.deepEqual(image, { kind: "image", src: "portrait.png", alt: "Synthetic portrait", ...(layout ? { layout } : {}), ...(framed ? { ratio: "square", fit: "contain" } : {}) });
	}
	const full: Block = { kind: "image", src: "full.png", alt: "", layout: "full" };
	const hotspot: Block = { kind: "hotspot", src: "map.png", alt: "Map", prompt: "Find a point", spots: [] };
	const blocks: Block[] = [full, hotspot];
	const unchanged = structuredClone(blocks);
	slideLayout(blocks, blocks.map((b, order) => ({ blocks: [b], box: { x: 0, y: 0, w: 1000, h: 1500 }, order })), 1000, 600);
	assert.deepEqual(blocks, unchanged);
	const image: Block = { kind: "image", src: "hero.png", alt: "" };
	const title: Block = { kind: "paragraph", text: "Synthetic cover" };
	const hero: Block[] = [image, title];
	slideLayout(hero, [{ blocks: [image], box: { x: 0, y: 0, w: 300, h: 600 }, order: 0 }, { blocks: [title], box: { x: 0, y: 0, w: 200, h: 40 }, order: 1 }], 300, 600);
	assert.deepEqual(hero, [{ kind: "heading", level: 1, text: "Synthetic cover", background: { src: "hero.png", alt: "" } }]);
});

test("picture rows never reuse pictures already placed beside text", () => {
	const images: Block[] = [0, 1].map((i) => ({ kind: "image", src: `${i}.png`, alt: "" }));
	const paragraph: Block = { kind: "paragraph", text: "Beside the first picture" };
	const blocks = [...images, paragraph];
	slideLayout(blocks, [
		{ blocks: [images[0]!], order: 0, box: { x: 0, y: 0, w: 100, h: 100 } },
		{ blocks: [images[1]!], order: 1, box: { x: 100, y: 0, w: 100, h: 100 } },
		{ blocks: [paragraph], order: 2, box: { x: -100, y: 0, w: 100, h: 100 } },
	], 1000, 600);
	assert.deepEqual(blocks, [images[1], { kind: "columns", columns: [[paragraph], [images[0]!]] }]);
});

test("pictures beside the anchor join the text column in reading order and retain slide sizing", () => {
	for (const direction of [-1, 1]) {
		const anchor: Block = { kind: "image", src: "anchor.png", alt: "" };
		const heading: Block = { kind: "heading", level: 2, text: "Synthetic heading" };
		const first: Block = { kind: "image", src: "first.png", alt: "" };
		const paragraph: Block = { kind: "paragraph", text: "After pictures" };
		const second: Block = { kind: "image", src: "second.png", alt: "" };
		const blocks: Block[] = [heading, anchor, first, second, paragraph];
		const x = direction === 1 ? 600 : -100;
		slideLayout(blocks, [
			{ blocks: [heading], order: 0, box: { x, y: 100, w: 300, h: 40 } },
			{ blocks: [anchor], order: 1, box: { x: 200, y: 100, w: 400, h: 300 } },
			{ blocks: [first], order: 2, box: { x: x + 100, y: 100, w: 100, h: 300 } },
			{ blocks: [second], order: 3, box: { x, y: 250, w: 100, h: 300 } },
			{ blocks: [paragraph], order: 4, box: { x, y: 150, w: 300, h: 40 } },
		], 1000, 600);
		const text = [heading, first, second, paragraph];
		assert.deepEqual(blocks, [{ kind: "columns", columns: direction === 1 ? [[anchor], text] : [text, [anchor]] }]);
		for (const image of [first, second]) assert.deepEqual(image, { kind: "image", src: image.src, alt: "", layout: "small", ratio: "square", fit: "contain" });
	}
});

test("text columns stop at pictures on the other side, below, overlapping or without fixed geometry", () => {
	for (const box of [
		{ x: 0, y: 100, w: 100, h: 200 },
		{ x: 500, y: 301, w: 100, h: 200 },
		{ x: 499, y: 100, w: 100, h: 200 },
		undefined,
	]) {
		const anchor: Block = { kind: "image", src: "anchor.png", alt: "" };
		const heading: Block = { kind: "heading", level: 2, text: "Synthetic heading" };
		const picture: Block = { kind: "image", src: "outside.png", alt: "" };
		const later: Block = { kind: "paragraph", text: "Stay after the picture" };
		const blocks: Block[] = [anchor, heading, picture, later];
		slideLayout(blocks, [
			{ blocks: [anchor], order: 0, box: { x: 200, y: 100, w: 300, h: 300 } },
			{ blocks: [heading], order: 1, box: { x: 500, y: 100, w: 300, h: 40 } },
			{ blocks: [picture], order: 2, box },
			{ blocks: [later], order: 3 },
		], 1000, 600);
		assert.deepEqual(blocks, [{ kind: "columns", columns: [[anchor], [heading]] }, picture, later]);
	}
});

test("text columns never take an earlier picture or reuse an anchor", () => {
	const first: Block = { kind: "image", src: "first.png", alt: "" };
	const second: Block = { kind: "image", src: "second.png", alt: "" };
	const left: Block = { kind: "paragraph", text: "Left of the first picture" };
	const right: Block = { kind: "paragraph", text: "Right of the second picture" };
	const blocks: Block[] = [left, first, right, second];
	slideLayout(blocks, [
		{ blocks: [left], order: 0, box: { x: 0, y: 100, w: 100, h: 100 } },
		{ blocks: [first], order: 1, box: { x: 100, y: 100, w: 200, h: 200 } },
		{ blocks: [right], order: 2, box: { x: 600, y: 100, w: 100, h: 100 } },
		{ blocks: [second], order: 3, box: { x: 400, y: 100, w: 200, h: 200 } },
	], 1000, 600);
	assert.deepEqual(blocks, [
		{ kind: "columns", columns: [[left], [first]] },
		{ kind: "columns", columns: [[second], [right]] },
	]);
});

test("a picture before the text joins its column without crossing intervening content", () => {
	for (const interrupted of [false, true]) {
		const anchor: Block = { kind: "image", src: "anchor.png", alt: "" };
		const picture: Block = { kind: "image", src: "figure.png", alt: "" };
		const note: Block = { kind: "note", text: "Keep this position" };
		const text: Block = { kind: "paragraph", text: "After the figure" };
		const blocks: Block[] = [anchor, picture, ...(interrupted ? [note] : []), text];
		slideLayout(blocks, [
			{ blocks: [anchor], order: 0, box: { x: 0, y: 0, w: 400, h: 300 } },
			{ blocks: [picture], order: 1, box: { x: 400, y: 0, w: 100, h: 300 } },
			{ blocks: [text], order: 2, box: { x: 400, y: 0, w: 300, h: 40 } },
		], 1000, 600);
		assert.deepEqual(blocks, interrupted ? [picture, note, { kind: "columns", columns: [[anchor], [text]] }] : [{ kind: "columns", columns: [[anchor], [picture, text]] }]);
	}
});
