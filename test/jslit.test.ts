import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLiteral } from "../src/jslit.ts";

test("reads a vendor object literal as data", () => {
	const src = `cp.model.data = {a:1, 'b':"x\\u0041" + 'y', c:[true,null,-2.5e1], d:cp.fd, e:{f:undefined}, 12:'n', __proto__:{polluted:1}};`;
	assert.deepEqual(parseLiteral(src, src.indexOf("{")), { a: 1, b: "xAy", c: [true, null, -25], d: undefined, e: { f: undefined }, 12: "n" });
	assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("never executes code inside the literal", () => {
	(globalThis as Record<string, unknown>).ran = false;
	const src = `{x:(function(){ globalThis.ran = true; return 1 })(), y:function(){ globalThis.ran = true }, z:2}`;
	assert.deepEqual(parseLiteral(src), { x: undefined, y: undefined, z: 2 });
	assert.equal((globalThis as Record<string, unknown>).ran, false);
});

test("malformed literals fail instead of looping", () => {
	for (const bad of ["{x:[}", "{x:1", "[", "{a:{b:[1,}"]) assert.throws(() => parseLiteral(bad), bad);
});
