import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export type Source = {
	id: string;
	tool: string;
	git?: string;
	commit?: string;
	clone?: string;
	path?: string;
	zip?: string;
	sha256?: string;
	file?: string;
	member?: string;
	licence?: string;
};
export type ManifestFile = { path: string; sha256: string; bytes: number };

export const repo = join(import.meta.dirname, "..");

export function corpusRoot(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.PRAXITY_IMPORT_CORPUS || join(repo, "corpus/local"));
}

const readSources = (p: string): Source[] => (JSON.parse(readFileSync(p, "utf8")) as { sources: Source[] }).sources;

export function loadSources(root: string): { sources: Source[]; privateList: boolean } {
	const local = join(root, "sources.local.json");
	const privateList = existsSync(local);
	return { sources: [...readSources(join(repo, "corpus/sources.json")), ...(privateList ? readSources(local) : [])], privateList };
}

export function inputOf(s: Source, root: string): string {
	if (s.zip && s.file) return join(root, "zips", s.file);
	if (s.file) return resolve(root, s.file);
	return join(root, s.clone ?? "", s.path ?? "");
}

export function hashTree(root: string): ManifestFile[] {
	const files: ManifestFile[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir).sort()) {
			if (name === ".git" || name === ".DS_Store" || (dir === root && name === "manifest.json")) continue;
			const p = join(dir, name);
			if (statSync(p).isDirectory()) walk(p);
			else {
				const bytes = readFileSync(p);
				files.push({ path: relative(root, p).replaceAll("\\", "/"), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
			}
		}
	};
	walk(root);
	return files;
}

export type CheckResult = { missing: string[]; changed: string[]; unlisted: string[] };

export function checkManifest(root: string, manifest: ManifestFile[]): CheckResult {
	const actual = new Map(hashTree(root).map((f) => [f.path, f]));
	const listed = new Set(manifest.map((f) => f.path));
	const missing: string[] = [];
	const changed: string[] = [];
	for (const f of manifest) {
		const a = actual.get(f.path);
		if (!a) missing.push(f.path);
		else if (a.sha256 !== f.sha256 || a.bytes !== f.bytes) changed.push(f.path);
	}
	return { missing, changed, unlisted: [...actual.keys()].filter((p) => !listed.has(p)) };
}
