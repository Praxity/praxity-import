import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importPackage } from "../src/import.ts";
import { ffmpegVersion, hlsSource } from "../src/media.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "praxity-import-media-"));

function hlsFolder(root: string, streams: Record<string, string>): void {
	mkdirSync(join(root, "v.hls"), { recursive: true });
	for (const [name, body] of Object.entries(streams)) writeFileSync(join(root, "v.hls", name), body);
}
const master = '﻿#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="x",DEFAULT=NO,URI="alt.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="y",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=300,RESOLUTION=640x360,AUDIO="a"\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900,RESOLUTION=1280x720,AUDIO="a"\nhigh.m3u8\n';
const media = (segment: string) => `#EXTM3U\n#EXTINF:4,\n${segment}\n#EXT-X-ENDLIST\n`;

test("HLS source is the highest-bandwidth variant with its default audio, read through a byte-order mark", () => {
	const root = tmp();
	hlsFolder(root, { "main.m3u8": master, "low.m3u8": media("l.ts"), "high.m3u8": media("h.ts"), "audio.m3u8": media("a.ts"), "alt.m3u8": media("x.ts"), "l.ts": "", "h.ts": "", "a.ts": "", "x.ts": "" });
	assert.deepEqual(hlsSource(root, "v.hls/main.m3u8"), { video: "v.hls/high.m3u8", audio: "v.hls/audio.m3u8", resolution: "1280x720" });
	assert.deepEqual(hlsSource(root, "v.hls/low.m3u8"), { video: "v.hls/low.m3u8" }, "a media playlist is its own video");
});

test("HLS playlists that name files outside the package, remote or absolute addresses are refused", () => {
	for (const bad of ["../../secret.ts", "https://example.com/s.ts", "/etc/hosts", "file:///etc/hosts", "missing.ts"]) {
		const root = tmp();
		hlsFolder(root, { "main.m3u8": master, "low.m3u8": media("l.ts"), "high.m3u8": media(bad), "audio.m3u8": media("a.ts"), "alt.m3u8": media("x.ts"), "l.ts": "", "a.ts": "", "x.ts": "" });
		assert.equal(typeof hlsSource(root, "v.hls/main.m3u8"), "string", bad);
	}
	const root = tmp();
	hlsFolder(root, { "main.m3u8": master.replace('URI="audio.m3u8"', 'URI="../../x.m3u8"'), "low.m3u8": media("l.ts"), "high.m3u8": media("h.ts"), "alt.m3u8": media("x.ts"), "l.ts": "", "h.ts": "", "x.ts": "" });
	assert.equal(typeof hlsSource(root, "v.hls/main.m3u8"), "string", "a tag URI is checked too");
});

/** A Rise package whose only block is a video at `key`. */
function riseVideo(key: string): string {
	const root = tmp();
	mkdirSync(join(root, "lib/rise"), { recursive: true });
	mkdirSync(join(root, "locales"));
	const course = { course: { id: "c", title: "Media", lessons: [{ id: "l", type: "blocks", title: "L", items: [{ id: "v", type: "multimedia", family: "multimedia", variant: "video", items: [{ media: { video: { key } } }] }] }], theme: { hideCoverPage: true } }, labelSet: { iso639Code: "en" } };
	writeFileSync(join(root, "index.html"), `<script>window.i18n = {"available":["und"],"default":"und"};</script>`);
	writeFileSync(join(root, "locales/und.js"), `window.__resolveJsonp("course:und", "${Buffer.from(JSON.stringify(course)).toString("base64")}")`);
	return root;
}

test("without --convert-media an HLS video is a media loss that names the option", async () => {
	const root = riseVideo("clip.hls/main.m3u8");
	mkdirSync(join(root, "assets/clip.hls"), { recursive: true });
	writeFileSync(join(root, "assets/clip.hls/main.m3u8"), media("s.ts"));
	const report = await importPackage(root, join(tmp(), "out"));
	const loss = report.losses.find((l) => l.source === "media:video");
	assert.match(loss?.detail ?? "", /--convert-media/);
});

test("--convert-media turns an HLS stream into a byte-identical MP4 the lesson plays", { skip: !ffmpegVersion() && "ffmpeg is not on PATH" }, async () => {
	const root = riseVideo("clip.hls/main.m3u8");
	const dir = join(root, "assets/clip.hls");
	mkdirSync(dir, { recursive: true });
	execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=10:duration=1", "-f", "lavfi", "-i", "sine=duration=1", "-c:v", "libx264", "-c:a", "aac", "-shortest", "-f", "hls", "-hls_segment_filename", join(dir, "s%d.ts"), join(dir, "main.m3u8")]);
	const outputs = [join(tmp(), "a"), join(tmp(), "b")];
	for (const out of outputs) {
		const report = await importPackage(root, out, { convertMedia: true });
		assert.ok(report.losses.some((l) => l.source === "media:converted"));
		assert.ok(!report.losses.some((l) => l.source === "media:video"));
		assert.match(report.mediaConverter ?? "", /^ffmpeg version /);
		assert.match(readFileSync(join(out, report.lessons[0]!.file), "utf8"), /^\/assets\/clip\.mp4$/m);
	}
	assert.ok(existsSync(join(outputs[0]!, "assets/clip.mp4")));
	assert.deepEqual(readFileSync(join(outputs[0]!, "assets/clip.mp4")), readFileSync(join(outputs[1]!, "assets/clip.mp4")));
});
