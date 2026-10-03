import type { Block } from "../model.ts";

export type Box = { x: number; y: number; w: number; h: number };
export type HeroItem = { blocks: Block[]; box?: Box; order: number; fontSize?: number; color?: string; singleLine?: boolean };

const valid = (b: Box | undefined): b is Box => !!b && [b.x, b.y, b.w, b.h].every(Number.isFinite) && b.w > 0 && b.h > 0;
const area = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** Classify recorded ink by contrast with black/white; absent colours leave Studio's dark default. */
function overlay(color = ""): "dark" | "light" | undefined {
	color = ({ white: "#ffffff", black: "#000000" } as Record<string, string>)[color.toLowerCase()] ?? color;
	if (/^#[\da-f]{3}$/i.test(color)) color = `#${[...color.slice(1)].map((c) => c + c).join("")}`;
	const rgb = /^#[\da-f]{6}$/i.test(color) ? [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)) : /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(color)?.slice(1).map(Number);
	if (!rgb || rgb.some((c) => c < 0 || c > 255)) return;
	const [r = 0, g = 0, b = 0] = rgb.map((c) => c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
	const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	return (luminance + 0.05) / 0.05 > 1.05 / (luminance + 0.05) ? "dark" : "light";
}

const copy = (item: HeroItem): string => item.blocks.length && item.blocks.every((b) => (b.kind === "paragraph" || b.kind === "heading") && !(b.kind === "heading" && b.background)) ? item.blocks.map((b) => (b as Extract<Block, { kind: "paragraph" | "heading" }>).text).join("\n") : "";

/** Match sequential badges to paragraph rows using only fixed recorded boxes. */
export function numberedList(blocks: Block[], items: HeroItem[]): void {
	items = items.filter((item) => item.blocks.length && item.blocks.every((b) => blocks.includes(b) && b.kind === "paragraph"));
	const badges = items.filter((item) => item.blocks.length === 1 && /^[1-9]\d*$/.test(copy(item))).sort((a, b) => Number(copy(a)) - Number(copy(b)));
	if (badges.length < 2 || badges.some((item, i) => Number(copy(item)) !== i + 1 || !valid(item.box))) return;
	const rows = items.filter((item) => !badges.includes(item) && valid(item.box)).flatMap((item) => {
		// ponytail: paragraphs sharing a box use equal rows; use per-paragraph
		// geometry instead when the publisher records uneven paragraph heights.
		const h = item.box!.h / item.blocks.length;
		return item.blocks.map((block, i) => ({ item, block, y: item.box!.y + i * h, h }));
	});
	const matched = badges.map((badge) => rows.filter((row) => {
		const center = badge.box!.y + badge.box!.h / 2;
		return center >= row.y && center < row.y + row.h;
	}));
	if (matched.some((rows) => rows.length !== 1)) return;
	const points = matched.map((rows) => rows[0]!);
	if (new Set(points.map((row) => row.block)).size !== badges.length) return;
	// Never split a multi-paragraph object or silently reorder its paragraphs.
	for (const item of new Set(points.map((row) => row.item))) if (item.blocks.some((b, i) => points.filter((row) => row.item === item)[i]?.block !== b)) return;
	const list: Block = { kind: "list", ordered: true, items: points.map((row) => (row.block as Extract<Block, { kind: "paragraph" }>).text) };
	const consumed = new Set([...badges.flatMap((item) => item.blocks), ...points.map((row) => row.block)]);
	const first = blocks.find((b) => points.some((row) => row.block === b))!;
	blocks.splice(0, blocks.length, ...blocks.flatMap((b) => b === first ? [list] : consumed.has(b) ? [] : [b]));
	const firstItem = points.find((row) => row.block === first)!.item;
	firstItem.blocks = [list];
}

/**
 * A fixed, unrotated picture must cover at least 70% of the visible slide.
 * Callers apply vendor chrome/visibility rules before supplying candidates.
 * Items retain reading order; `order` records drawing order independently.
 */
export function promoteHero(blocks: Block[], items: HeroItem[], width: number, height: number): boolean {
	const slide = { x: 0, y: 0, w: width, h: height };
	if (!valid(slide)) return false;
	const emitted = new Set(blocks);
	items = items.filter((item) => item.blocks.every((b) => emitted.has(b)));
	for (const picture of items.filter((i) => i.blocks.length === 1 && i.blocks[0]?.kind === "image").sort((a, b) => a.order - b.order)) {
		if (!valid(picture.box) || area(picture.box, slide) < width * height * 0.7) continue;
		const texts = items.filter((t) => t.order > picture.order && valid(t.box) && area(picture.box!, t.box) > 0 && copy(t).trim())
			.sort((a, b) => (Number.isFinite(b.fontSize) ? b.fontSize! : 0) - (Number.isFinite(a.fontSize) ? a.fontSize! : 0));
		const title = texts[0];
		if (!title) continue;
		const subtitle = texts.slice(1).find((t) => t.singleLine !== false && !/[\r\n\v]/.test(copy(t)) && copy(t).length < 120);
		const image = picture.blocks[0] as Extract<Block, { kind: "image" }>;
		const shade = overlay(title.color);
		const heading: Block = { kind: "heading", level: 1, text: copy(title), background: { src: image.src, alt: image.alt, ...(shade ? { overlay: shade } : {}) }, ...(subtitle ? { subtitle: copy(subtitle) } : {}) };
		const consumed = new Set([...picture.blocks, ...title.blocks, ...(subtitle?.blocks ?? [])]);
		const remaining = blocks.flatMap((b): Block[] => b === image && image.caption ? [{ kind: "paragraph", text: image.caption }] : consumed.has(b) ? [] : [b]);
		blocks.splice(0, blocks.length, heading, ...remaining);
		return true;
	}
	return false;
}

/** Apply only to emitted objects: question text and hero content are already consumed. */
export function slideLayout(blocks: Block[], items: HeroItem[], width: number, height: number): void {
	promoteHero(blocks, items, width, height);
	items = items.filter((item) => item.blocks.length && item.blocks.every((b) => blocks.includes(b)));
	const words = (item: HeroItem) => item.blocks.every((block) => block.kind === "paragraph" || block.kind === "list" || (block.kind === "heading" && !block.background));
	const textItems = items.filter((item) => words(item) && Number.isFinite(item.fontSize) && item.fontSize! > 0);
	const sizes = textItems.map((item) => item.fontSize!).sort((a, b) => a - b);
	const mid = Math.floor(sizes.length / 2);
	const median = sizes.length % 2 ? sizes[mid]! : (sizes[mid - 1]! + sizes[mid]!) / 2;
	const headings = textItems.filter((item) => item.singleLine !== false && item.blocks.length === 1 && item.blocks[0]?.kind === "paragraph" && !/[\r\n\v]/.test(copy(item)) && item.fontSize! >= median * 1.3);
	const largest = Math.max(...headings.map((item) => item.fontSize!));
	for (const item of headings) {
		const previous = item.blocks[0]!;
		const heading: Block = { kind: "heading", level: item.fontSize === largest ? 2 : 3, text: copy(item) };
		blocks[blocks.indexOf(previous)] = heading;
		item.blocks = [heading];
	}
	const used = new Set<HeroItem>();
	for (const picture of items.filter((item) => item.blocks.length === 1 && item.blocks[0]?.kind === "image")) {
		if (used.has(picture) || !valid(picture.box)) continue;
		const side = (item: HeroItem): number => {
			const followingPicture = item.blocks.length === 1 && item.blocks[0]?.kind === "image" && items.indexOf(item) > items.indexOf(picture);
			if (used.has(item) || (!words(item) && !followingPicture) || !valid(item.box)) return 0;
			const a = picture.box!, b = item.box;
			const gap = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
			const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
			return gap >= 0 && overlap >= b.h * 0.5 ? (a.x <= b.x ? 1 : -1) : 0;
		};
		let first = items.findIndex((item) => words(item) && side(item) !== 0);
		if (first < 0) continue;
		const direction = side(items[first]!);
		// Include a consecutive beside-picture run before the first text, keeping its reading order.
		while (first > 0 && side(items[first - 1]!) === direction && blocks.slice(blocks.indexOf(items[first - 1]!.blocks.at(-1)!) + 1, blocks.indexOf(items[first]!.blocks[0]!)).every((b) => picture.blocks.includes(b))) first--;
		const text: Block[] = [];
		let end = blocks.indexOf(items[first]!.blocks[0]!);
		for (const item of items.slice(first)) {
			if (item === picture) continue;
			// Unpositioned content can be absent from items, but still ends the text column.
			const between = blocks.slice(end, blocks.indexOf(item.blocks[0]!));
			if (side(item) !== direction || between.some((b) => !picture.blocks.includes(b))) break;
			used.add(item);
			// Size pictures relative to the slide, without nesting a picture row in this column.
			if (!words(item)) pictureLayout(item.blocks, [item], width);
			text.push(...item.blocks);
			end = blocks.indexOf(item.blocks.at(-1)!) + 1;
		}
		used.add(picture);
		// A tall picture fills its column's width; framing it square keeps the row no taller than it is wide.
		const anchor = picture.blocks[0];
		if (anchor?.kind === "image" && picture.box!.h >= picture.box!.w * 1.25) {
			anchor.ratio = "square";
			anchor.fit = "contain";
		}
		const columns = direction === 1 ? [picture.blocks, text] : [text, picture.blocks];
		const consumed = new Set([...picture.blocks, ...text]);
		// The columns take the first text's place: only the picture moves, so text keeps its reading order.
		const index = blocks.slice(0, blocks.indexOf(text[0]!)).filter((b) => !consumed.has(b)).length;
		const remaining = blocks.filter((b) => !consumed.has(b));
		remaining.splice(index, 0, { kind: "columns", columns });
		blocks.splice(0, blocks.length, ...remaining);
	}
	pictureLayout(blocks, items, width);
}

/** Size recorded pictures and join consecutive pictures sharing a row. */
export function pictureLayout(blocks: Block[], items: HeroItem[], width: number): void {
	const pictures = new Map(items.filter((item) => item.blocks.length === 1 && item.blocks[0]?.kind === "image" && blocks.includes(item.blocks[0]) && valid(item.box)).map((item) => [item.blocks[0]!, item]));
	for (const [image, item] of pictures) {
		if (image.kind !== "image" || !Number.isFinite(width) || width <= 0) continue;
		const fraction = item.box!.w / width;
		if (fraction < 0.35) image.layout = "small";
		else if (fraction < 0.6) image.layout = "medium";
		if ((image.layout === "small" || image.layout === "medium") && item.box!.h >= item.box!.w * 1.5) {
			image.ratio = "square";
			image.fit = "contain";
		}
	}
	for (let i = 0; i < blocks.length; i++) {
		const first = pictures.get(blocks[i]!);
		if (!first) continue;
		const row = [first];
		for (let j = i + 1; j < blocks.length; j++) {
			const next = pictures.get(blocks[j]!);
			if (!next || !row.every((item) => {
				const a = item.box!, b = next.box!;
				const distance = Math.abs(a.x + a.w / 2 - b.x - b.w / 2);
				const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
				return distance >= Math.min(a.w, b.w) * 0.5 && overlap >= Math.min(a.h, b.h) * 0.5;
			})) break;
			row.push(next);
		}
		if (row.length > 1) blocks.splice(i, row.length, { kind: "columns", columns: row.sort((a, b) => a.box!.x - b.box!.x).map((item) => item.blocks) });
	}
}
