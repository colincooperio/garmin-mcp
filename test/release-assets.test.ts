import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { checkUrl } from "../src/update.ts";
import { pingUrl } from "../src/usage.ts";

describe("release workflow", () => {
	const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
	const upload = release.slice(release.indexOf(`gh release upload "$TAG"`), release.indexOf("--clobber"));
	const attached = new Set(upload.match(/[\w.-]+\.(?:json|mcpb)/g));

	it("attaches every file a client downloads: latest-, weekly-, monthly- and install- for mcpb, npx and cloud", () => {
		const expected = ["garmin-mcp.mcpb"];
		for (const type of ["mcpb", "npx", "cloud"] as const) {
			const install = type === "npx" ? { type, pinned: false as const } : { type };
			for (const url of [checkUrl(install), pingUrl("weekly", install), pingUrl("monthly", install), pingUrl("install", install)]) {
				expected.push(url.split("/").at(-1)!);
			}
		}
		assert.deepEqual([...attached].sort(), expected.sort());
		assert.equal(attached.size, 13, "the .mcpb, three latest- files and nine usage-ping files");
	});

	it("writes each usage-ping file as tiny static JSON", () => {
		assert.match(release, /for ping in weekly monthly install; do\s+echo '\{"ok":true\}' > "\$ping-\$type\.json"/);
	});
});
