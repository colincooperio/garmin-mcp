// Helpers for running the tests on Windows as well as macOS and Linux.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const isWindows = process.platform === "win32";

/**
 * A repo text file with LF line endings. .gitattributes gives new clones LF,
 * but Git doesn't convert files an older Windows clone already has as CRLF.
 */
export const readText = (file: URL | string) => readFileSync(file, "utf8").replaceAll("\r\n", "\n");

/**
 * Runs npm. On Windows npm is a .cmd script, which Node can't start directly,
 * so run its JavaScript with Node: no shell, so no quoting of paths with spaces.
 */
export function npm(args: string[], cwd: string): string {
	const [cmd, pre] = isWindows ? [process.execPath, [npmCli()]] : ["npm", []];
	return execFileSync(cmd, [...pre, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** npm-cli.js: the npm running this script if there is one, else the one that ships with Node. */
function npmCli(): string {
	const running = process.env.npm_execpath;
	if (running && basename(running) === "npm-cli.js" && existsSync(running)) return running;
	return join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
}
