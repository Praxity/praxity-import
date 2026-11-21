import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { promisify } from "node:util";
import { insidePackage } from "./input.ts";


export type HlsSource = { video: string; audio?: string; resolution?: string };

const run = promisify(execFile);
let version: string | null | undefined;

export function ffmpegVersion(): string | undefined {
	if (version === undefined) {
		try {
			version = execFileSync("ffmpeg", ["-version"], { encoding: "utf8", timeout: 10_000 }).split("\n")[0]?.replace(/\s+Copyright.*$/, "").trim() || null;
		} catch {
			version = null;
		}
	}
	return version ?? undefined;
}

const lines = (root: string, rel: string): string[] | undefined => {
	const file = insidePackage(root, rel);
	return file ? readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : undefined;
};
const attr = (line: string, name: string): string | undefined => {
	const m = new RegExp(`(?:^|[:,])${name}=(?:"([^"]*)"|([^,]*))`).exec(line);
	return m ? (m[1] ?? m[2]) : undefined;
};

function uris(root: string, rel: string): string[] | undefined {
	const list = lines(root, rel);
	if (!list || list[0] !== "#EXTM3U") return undefined;
	const dir = posix.dirname(rel);
	const named = list.flatMap((l) => (l.startsWith("#") ? [...l.matchAll(/URI="([^"]*)"/g)].map((m) => m[1]!) : [l]));
	const out: string[] = [];
	for (const uri of named) {
		if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.startsWith("/")) return undefined;
		const path = posix.normalize(posix.join(dir, uri));
		if (!insidePackage(root, path)) return undefined;
		out.push(path);
	}
	return out;
}

export function hlsSource(root: string, rel: string): HlsSource | string {
	const master = lines(root, rel);
	if (!master || master[0] !== "#EXTM3U") return "the playlist is missing or not an HLS playlist";
	if (!uris(root, rel)) return "the playlist names files outside the package or remote addresses";
	const dir = posix.dirname(rel);
	const variants = master.flatMap((l, i) => (l.startsWith("#EXT-X-STREAM-INF") && master[i + 1] && !master[i + 1]!.startsWith("#") ? [{ inf: l, uri: posix.join(dir, master[i + 1]!) }] : []));
	if (!variants.length) return { video: rel };
	const best = variants.reduce((a, b) => (Number(attr(b.inf, "BANDWIDTH")) > Number(attr(a.inf, "BANDWIDTH")) ? b : a));
	const group = attr(best.inf, "AUDIO");
	const renditions = master.filter((l) => l.startsWith("#EXT-X-MEDIA") && attr(l, "TYPE") === "AUDIO" && attr(l, "GROUP-ID") === group && attr(l, "URI"));
	const audioLine = renditions.find((l) => attr(l, "DEFAULT") === "YES") ?? renditions[0];
	const audio = audioLine ? posix.join(dir, attr(audioLine, "URI")!) : undefined;
	for (const playlist of [best.uri, ...(audio ? [audio] : [])]) if (!uris(root, playlist)) return `${playlist} names files outside the package, remote addresses, or is missing`;
	const resolution = attr(best.inf, "RESOLUTION");
	return { video: best.uri, ...(audio ? { audio } : {}), ...(resolution ? { resolution } : {}) };
}

export async function convertHls(root: string, source: HlsSource, dest: string): Promise<void> {
	const input = (rel: string) => ["-protocol_whitelist", "file", "-i", insidePackage(root, rel)!];
	const args = ["-nostdin", "-v", "error", "-y", ...input(source.video), ...(source.audio ? input(source.audio) : []), "-map", "0:v:0", ...(source.audio ? ["-map", "1:a:0"] : ["-map", "0:a:0?"]), "-c", "copy", "-movflags", "+faststart", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact", "-map_metadata", "-1", "-map_chapters", "-1", dest];
	await run("ffmpeg", args, { timeout: 10 * 60_000, maxBuffer: 1 << 20 });
}
