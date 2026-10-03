/**
 * Where the test corpus lives and how to check it. The corpus is third-party
 * material kept only on the machines that test with it: $PRAXITY_IMPORT_CORPUS,
 * or corpus/local/ in this checkout (Git ignores both).
 *
 *   <corpus>/<clone>/          public git sources (corpus/sources.json)
 *   <corpus>/zips/             public zip sources
 *   <corpus>/sources.local.json  private sources; `file` is relative to <corpus> or absolute
 *   <corpus>/manifest.json     SHA-256 of every file, written by `pnpm corpus --lock`
 */
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

/** Public sources always; private ones when the corpus has a sources.local.json. */
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

/** Every corpus file with its hash, sorted by path. Clone metadata and Finder litter are not corpus content. */
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
