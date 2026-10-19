import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { isFileName, text } from "./html.ts";

const run = promisify(execFile);

/**
 * Studio's CLI: $PRAXITY_CLI, then `praxity` on PATH, then the macOS app. A
 * `.mjs` path is the standalone package and runs under this Node.
 */
export function studioCli(): string[] | undefined {
	const candidates = [
		process.env.PRAXITY_CLI,
		...(process.env.PATH ?? "").split(delimiter).map((d) => join(d, "praxity")),
		"/Applications/Praxity Studio.app/Contents/Resources/bin/praxity",
	].filter((p): p is string => !!p && existsSync(p));
	const cli = candidates[0];
	if (!cli) return undefined;
	return cli.endsWith(".mjs") ? [process.execPath, cli] : [cli];
}

async function studio(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const cli = studioCli();
	if (!cli) throw new Error("Praxity Studio CLI not found: set PRAXITY_CLI to the praxity launcher or praxity.mjs");
	const [cmd, ...pre] = cli as [string, ...string[]];
	try {
		const r = await run(cmd, [...pre, ...args], { maxBuffer: 512 * 1024 * 1024, timeout: 10 * 60_000 });
		return { code: 0, stdout: r.stdout, stderr: r.stderr };
	} catch (e) {
		const err = e as { code?: number; stdout?: string; stderr?: string; message: string };
		return { code: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message };
	}
}

/** Undo `neutralize` and fold case/width so words compare across the round trip. */
export function words(s: string): string[] {
	return (
		s
			.normalize("NFKC")
			.replace(/[​∗ˋ＿＃∣]/g, " ")
			.toLowerCase()
			.match(/[\p{L}\p{N}]+/gu) ?? []
	);
}

/** Share of source words (with multiplicity) that reappear in the output. */
export function coverage(source: string[], output: string[]): { sourceWords: number; matched: number; ratio: number; missing: string[] } {
	const have = new Map<string, number>();
	for (const w of output.flatMap(words)) have.set(w, (have.get(w) ?? 0) + 1);
	let total = 0;
	let matched = 0;
	const missing = new Map<string, number>();
	// File names that tools store as alt text or titles are not course text, and the writer leaves them out.
	for (const w of source.filter((s) => !isFileName(s)).flatMap(words)) {
		total++;
		const n = have.get(w) ?? 0;
		if (n > 0) {
			matched++;
			have.set(w, n - 1);
		} else missing.set(w, (missing.get(w) ?? 0) + 1);
	}
	const top = [...missing].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 20).map(([w, n]) => `${w}×${n}`);
	return { sourceWords: total, matched, ratio: total ? Math.round((matched / total) * 1000) / 1000 : 1, missing: top };
}

/** Every string Studio parsed, with HTML reduced to text. */
function strings(node: unknown, out: string[]): string[] {
	if (typeof node === "string") out.push(/[<&]/.test(node) ? text(node) : node);
	else if (Array.isArray(node)) node.forEach((n) => strings(n, out));
	else if (node && typeof node === "object")
		for (const [k, v] of Object.entries(node)) if (!["id", "sha256", "file", "type", "src", "line", "schema", "studioVersion"].includes(k)) strings(v, out);
	return out;
}

export type Verification = {
	studioVersion?: string;
	parse: { ok: boolean; error?: string; blockTypes?: Record<string, number> };
	coverage?: ReturnType<typeof coverage>;
	export?: { ok: boolean; accessibility?: string; criticalIssues?: number; error?: string };
};

export async function verify(project: string, sourceText: string[]): Promise<Verification> {
	// Studio before 0.2.0 has no `inspect` and would open the desktop app instead;
	// 0.2.0 shows the writer's backslash escapes and dropdown/word-bank blanks as literal text.
	const version = (await studio(["--version"])).stdout.trim();
	const [major = 0, minor = 0] = version.split(".").map(Number);
	if (major === 0 && minor < 3) return { parse: { ok: false, error: `Studio CLI ${version || "(unknown version)"} cannot read inline escapes or dropdown and word-bank blanks; 0.3.0 or later is required. Set PRAXITY_CLI.` } };
	const inspected = await studio(["inspect", project]);
	let parsed: { ok?: boolean; studioVersion?: string; lessons?: Array<{ pages?: Array<{ blocks?: Array<{ type: string }> }> }>; error?: { message?: string } };
	try {
		parsed = JSON.parse(inspected.stdout);
	} catch {
		return { parse: { ok: false, error: (inspected.stderr || inspected.stdout).trim().slice(0, 500) } };
	}
	if (!parsed.ok) return { parse: { ok: false, error: parsed.error?.message ?? "inspect failed" } };
	const blockTypes: Record<string, number> = {};
	for (const l of parsed.lessons ?? []) for (const p of l.pages ?? []) for (const b of p.blocks ?? []) blockTypes[b.type] = (blockTypes[b.type] ?? 0) + 1;
	const result: Verification = {
		...(parsed.studioVersion ? { studioVersion: parsed.studioVersion } : {}),
		parse: { ok: true, blockTypes: Object.fromEntries(Object.entries(blockTypes).sort()) },
		coverage: coverage(sourceText, strings(parsed, [])),
	};

	// Export writes identity sidecars into the project, so it runs on a copy.
	const scratch = await mkdtemp(join(tmpdir(), "praxity-import-verify-"));
	try {
		await cp(project, join(scratch, "course"), { recursive: true });
		const exported = await studio(["export", join(scratch, "course"), "--format", "html", "--output", join(scratch, "out.zip"), "--allow-critical-a11y-issues"]);
		try {
			const r = JSON.parse(exported.stdout) as { ok: boolean; accessibility?: { status?: string; criticalCount?: number; issues?: unknown[] }; error?: { message?: string } };
			result.export = r.ok
				? { ok: true, ...(r.accessibility?.status ? { accessibility: r.accessibility.status } : {}), ...(r.accessibility?.status === "overridden" ? { criticalIssues: r.accessibility.criticalCount ?? r.accessibility.issues?.length ?? 0 } : {}) }
				: { ok: false, error: r.error?.message ?? "export failed" };
		} catch {
			result.export = { ok: false, error: (exported.stderr || exported.stdout).trim().slice(0, 500) };
		}
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
	return result;
}
