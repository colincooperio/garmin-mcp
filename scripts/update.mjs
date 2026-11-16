#!/usr/bin/env node
// npm run update: brings an existing cloud deployment up to date. Pulls the
// latest code, reinstalls, checks your wrangler.jsonc against the example,
// runs the tests and deploys. Never edits your wrangler.jsonc, never pushes.
//
// Works on forks too: when origin isn't colincooperio/garmin-mcp, it adds that
// as "upstream" (if missing), fetches it and fast-forwards from upstream/main.
import { fileURLToPath } from "node:url";
import { CONFIG, confirm, describeFailure, EXAMPLE, makeFiles, makeIO, makeRunner, missingSettings, readPackageVersion, StepError, wrangler } from "./lib.mjs";

export const OLD_REMOTE = /github\.com[:/]cacooper16\/garmin-cloud-mcp(\.git)?\/?$/i;
export const NEW_REMOTE = "https://github.com/colincooperio/garmin-mcp.git";
/** The project's own repo, by any GitHub URL form. */
export const UPSTREAM_REMOTE = /github\.com[:/]colincooperio\/garmin-mcp(\.git)?\/?$/i;
/** Origin points at the project itself (the old address redirects there), not a fork. */
const isProject = (url) => UPSTREAM_REMOTE.test(url) || OLD_REMOTE.test(url);

/** The current commit, or undefined if git can't say. */
async function head(run) {
	const r = await run("git", ["rev-parse", "HEAD"]);
	return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

/** ctx: { run, io, files }. Returns { from, to } versions. Throws StepError when a step fails. */
export async function runUpdate(ctx) {
	const { io, files, run } = ctx;
	const step = (n, title) => io.print(`\n${n}. ${title}`);
	if (!files.exists(CONFIG)) {
		throw new StepError("settings", `there's no ${CONFIG} here, so this copy isn't set up for the cloud yet.`, "run npm run setup instead.", 1);
	}

	// 1. Repo moved, or a fork
	step(1, "Checking where updates come from");
	const remote = await run("git", ["remote", "get-url", "origin"]);
	const url = remote.code === 0 ? remote.stdout.trim() : "";
	const fork = !isProject(url);
	if (OLD_REMOTE.test(url)) {
		io.print(`   This copy still pulls from ${url}; the project now lives at ${NEW_REMOTE}.`);
		if (await confirm(io, "   Switch to the new address?")) {
			const set = await run("git", ["remote", "set-url", "origin", NEW_REMOTE]);
			if (set.code !== 0) throw new StepError("git remote", `couldn't change the remote: ${set.stderr.trim()}`, `run git remote set-url origin ${NEW_REMOTE}, then npm run update again.`, 1);
			io.print("   Switched.");
		}
	} else if (!fork) io.print(`   ${url}`);
	else {
		io.print(`   ${url ? `${url} is a fork` : "There's no origin remote"}; updates come from ${NEW_REMOTE}, as the remote "upstream".`);
		const up = await run("git", ["remote", "get-url", "upstream"]);
		const upUrl = up.code === 0 ? up.stdout.trim() : "";
		if (!upUrl) {
			const add = await run("git", ["remote", "add", "upstream", NEW_REMOTE]);
			if (add.code !== 0) throw new StepError("git remote", `couldn't add the upstream remote: ${add.stderr.trim()}`, `run git remote add upstream ${NEW_REMOTE}, then npm run update again.`, 1);
			io.print("   Added it as upstream.");
		} else if (!isProject(upUrl)) {
			throw new StepError(
				"git remote",
				`this copy already has a remote called upstream, pointing at ${upUrl} rather than ${NEW_REMOTE}.`,
				`run git remote set-url upstream ${NEW_REMOTE} (or rename yours with git remote rename upstream <name>), then npm run update again.`,
				1,
			);
		}
	}

	// 2. Local changes
	step(2, "Checking for local changes");
	const status = await run("git", ["status", "--porcelain", "--untracked-files=no"]);
	if (status.code !== 0) throw new StepError("local changes", `git status failed: ${status.stderr.trim()}`, "cd into the garmin-mcp repo folder, then run npm run update again.", 2);
	if (status.stdout.trim()) {
		throw new StepError(
			"local changes",
			`you have uncommitted changes to tracked files:\n${status.stdout.trimEnd()}`,
			"set them aside with git stash (or commit them), then run npm run update again. Your wrangler.jsonc isn't tracked, so it's not affected.",
			2,
		);
	}
	io.print("   None.");

	// 3. Pull and install
	const from = readPackageVersion(files);
	const before = await head(run);
	step(3, "Downloading the latest version");
	if (url) {
		// From origin: the project itself, or for a fork, whatever "Sync fork" on GitHub brought in.
		const pull = await run("git", ["pull", "--ff-only"], { inherit: true });
		if (pull.code !== 0) {
			throw new StepError(
				"git pull",
				"git pull --ff-only failed (its output is above), usually because this copy has commits of its own.",
				fork ? "merge the changes from your fork yourself (git pull), then run npm run update again." : "run git pull --rebase, then npm run update again.",
				3,
			);
		}
	}
	if (fork) {
		const fetched = await run("git", ["fetch", "upstream"], { inherit: true });
		if (fetched.code !== 0) throw new StepError("git fetch", `couldn't download the latest version from ${NEW_REMOTE} (git's output is above).`, "check your connection, then run npm run update again.", 3);
		const ff = await run("git", ["merge", "--ff-only", "upstream/main"], { inherit: true });
		if (ff.code !== 0) {
			throw new StepError(
				"update from upstream",
				"your copy has changes of its own that aren't in colincooperio/garmin-mcp, so it can't simply move forward to the latest version. Stopped before deploying; nothing was changed in Cloudflare.",
				"sync your fork on GitHub (Sync fork on your fork's page), or merge upstream/main yourself (git merge upstream/main), then run npm run update again.",
				3,
			);
		}
	}
	const ci = await run("npm", ["ci"], { inherit: true });
	if (ci.code !== 0) throw new StepError("npm ci", "npm ci failed (its output is above).", "run npm ci again (it often succeeds the second time after a network hiccup), then npm run update again.", 3);
	const to = readPackageVersion(files);
	const after = await head(run);
	const unchanged = before !== undefined && before === after;

	// 4. Settings
	step(4, `Comparing your ${CONFIG} with ${EXAMPLE}`);
	let missing;
	try {
		missing = missingSettings(files.read(EXAMPLE), files.read(CONFIG));
	} catch (err) {
		throw new StepError("settings", `couldn't read ${CONFIG}: ${err.message}`, `fix the syntax error in ${CONFIG} (compare it with ${EXAMPLE}), then run npm run update again.`, 4);
	}
	if (!missing.length) io.print("   Nothing missing.");
	else {
		io.print(`   ${EXAMPLE} has settings your ${CONFIG} doesn't. Copy them across by hand (this never edits your file):`);
		for (const m of missing) io.print(`   - ${m.what}: ${m.required ? "required" : "optional"}`);
		if (missing.some((m) => m.required) && !(await confirm(io, "   Some are required, so the deploy may fail or misbehave. Deploy anyway?", false))) {
			throw new StepError("settings", "stopped before deploying, as asked; nothing was changed in Cloudflare.", `copy the required settings listed above from ${EXAMPLE} into ${CONFIG}, then run npm run update again.`, 4);
		}
	}

	// 5. Test and deploy
	step(5, "Running the tests");
	const check = await run("npm", ["run", "check"], { inherit: true });
	if (check.code !== 0) throw new StepError("tests", "npm run check failed (its output is above). Nothing was deployed.", "run npm run check to see the failure; if it isn't something you changed, open an issue with its output.", 5);
	step(6, "Deploying");
	const deploy = await wrangler(ctx, ["deploy"], { inherit: true });
	if (deploy.code !== 0) {
		throw new StepError(
			"deploy",
			"wrangler deploy failed (its output is above). Your previous version may still be running, or may be partly replaced.",
			"run npx wrangler rollback to go back to the previous version, then fix what wrangler reported and run npm run update again.",
			6,
		);
	}

	if (unchanged) io.print(`\nAlready up to date: redeployed ${to ?? "unknown"}.`);
	else io.print(`\nUpdated: ${from ?? "unknown"} -> ${to ?? "unknown"}.`);
	io.print("If anything misbehaves, npx wrangler rollback returns to the previous deployment.");
	return { from, to };
}

async function main() {
	const cwd = process.cwd();
	const files = makeFiles(cwd);
	if (!files.exists(EXAMPLE)) {
		console.error(`Run this from the garmin-mcp repo folder (there's no ${EXAMPLE} here): cd garmin-mcp, then npm run update.`);
		process.exit(1);
	}
	const io = makeIO();
	try {
		await runUpdate({ run: makeRunner(cwd), io, files });
	} catch (err) {
		if (err instanceof StepError) console.error(describeFailure(err));
		else {
			console.error(`\nUpdate stopped: ${err instanceof Error ? err.message : String(err)}`);
			console.error("To fix it: run npm run update again; if it stops at the same place, open an issue with this message.");
		}
		process.exitCode = 1;
	} finally {
		io.close();
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
