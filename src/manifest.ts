import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { find, kids, parseXml, textOf, type XmlElement } from "./xml.ts";

export type ManifestItem = { id: string; title: string; href?: string; depth: number };

export type Manifest = {
	identifier: string;
	title: string;
	/** "1.2", "2004 3rd Edition", "CAM 1.3" … as declared, or "unknown". */
	version: string;
	items: ManifestItem[];
	/** Every file the manifest lists, for detection. */
	files: string[];
	/** The LMS pass mark in percent: SCORM 1.2 masteryscore or SCORM 2004 minNormalizedMeasure. */
	masteryScore?: number;
};

/** Resolve an href against a base, dropping query/hash. */
const at = (base: string, href: string) => posix.normalize(posix.join(base, decodeURIComponent(href.split(/[?#]/)[0] ?? "")));

export function readManifest(root: string): Manifest | undefined {
	const path = join(root, "imsmanifest.xml");
	if (!existsSync(path)) return undefined;
	const doc = parseXml(readFileSync(path, "utf8"));
	const manifest = find(doc, "manifest")[0];
	if (!manifest) return undefined;
	const base = manifest.attrs["xml:base"] ?? "";
	const resources = new Map<string, XmlElement>();
	for (const r of find(manifest, "resource")) if (r.attrs.identifier) resources.set(r.attrs.identifier, r);
	const resourcesBase = find(manifest, "resources")[0]?.attrs["xml:base"] ?? "";
	const hrefOf = (r: XmlElement | undefined) => {
		const href = r?.attrs.href;
		return href ? at(posix.join(base, resourcesBase, r.attrs["xml:base"] ?? ""), href) : undefined;
	};

	const orgs = find(manifest, "organizations")[0];
	const org = (orgs && (kids(orgs, "organization").find((o) => o.attrs.identifier === orgs.attrs.default) ?? kids(orgs, "organization")[0])) || undefined;
	const items: ManifestItem[] = [];
	const walk = (el: XmlElement, depth: number) => {
		for (const item of kids(el, "item")) {
			if (item.attrs.isvisible === "false") continue;
			const href = hrefOf(resources.get(item.attrs.identifierref ?? ""));
			items.push({ id: item.attrs.identifier ?? `item-${items.length + 1}`, title: textOf(kids(item, "title")[0]), ...(href ? { href } : {}), depth });
			walk(item, depth + 1);
		}
	};
	if (org) walk(org, 0);

	const files = [...resources.values()].flatMap((r) => kids(r, "file").map((f) => f.attrs.href ?? "")).filter(Boolean);
	const version = textOf(find(manifest, "schemaversion")[0]) || "unknown";
	const title = textOf(org && kids(org, "title")[0]) || textOf(find(manifest, "title")[0]) || textOf(find(manifest, "langstring")[0]);
	const mastery12 = Number(textOf(find(manifest, "masteryscore")[0]));
	// A SCORM 2004 measure only decides success when the primary objective is satisfied by measure.
	const primary = find(manifest, "primaryobjective").find((o) => o.attrs.satisfiedByMeasure === "true");
	const measure = primary && find(primary, "minnormalizedmeasure")[0];
	const mastery2004 = Number(textOf(measure) || measure?.attrs.minNormalizedMeasure) * 100;
	const masteryScore = [mastery12, mastery2004].find((n) => Number.isFinite(n) && n > 0 && n <= 100);
	return { identifier: manifest.attrs.identifier ?? "manifest", title, version, items, files, ...(masteryScore !== undefined ? { masteryScore } : {}) };
}
