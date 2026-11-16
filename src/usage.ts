/**
 * Anonymous usage pings. Alongside the daily update check (update.ts), an
 * install downloads one more tiny static file from the latest GitHub release:
 *
 * - weekly-<mcpb|npx|cloud>.json: on the first start or tool call of each ISO
 *   week (UTC);
 * - monthly-<mcpb|npx|cloud>.json: the same, once per calendar month (UTC);
 * - install-<mcpb|npx|cloud>.json: once, ever, the first time it runs.
 *
 * GitHub counts downloads per file, so the counts are weekly and monthly
 * active installs and new installs, by type. Nothing else is sent: no ID, no
 * query string, no extra header, nothing about the user or their Garmin data.
 *
 * What's been sent is remembered under garmin:usage:* (locally in the state
 * folder on disk, see file-kv.ts; in the cloud in KV, so every Worker instance
 * shares it). The marker is written before the download, so a failed download
 * is never retried for that period: the counts can only err low.
 *
 * Off whenever the update check is off. Shared by the Worker and the local
 * server, so no Node-only imports. Never blocks a tool call and never throws.
 */

import type { KVLike } from "./garmin.ts";
import { assetFor, CHECK_TIMEOUT_MS, type Install, periodKey, RELEASES } from "./update.ts";

export { type Period, periodKey } from "./update.ts";

const USER_AGENT = "garmin-mcp-update-check";
const MARKER = "garmin:usage:";

export type Ping = "install" | "weekly" | "monthly";

export const pingUrl = (ping: Ping, install: Install) => `${RELEASES}/latest/download/${ping}-${assetFor(install)}.json`;

export interface UsageOptions {
	install: Install;
	/** Where the markers live: must survive restarts (local state folder, or cloud KV). */
	kv: KVLike;
	fetch?: (input: string, init?: RequestInit) => Promise<Response>;
	/** Seconds since epoch. */
	now?: () => number;
	/** Turned off with the update check (see updateCheckDisabled). */
	disabled?: boolean;
	/**
	 * False when the markers can't be kept across restarts (the disk failed
	 * and the store fell back to memory). Then nothing is sent, rather than
	 * counting every restart as a new install. Checked after the store is used.
	 */
	persistent?: () => boolean;
}

export class UsagePings {
	private readonly o: UsageOptions;
	private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
	private readonly now: () => number;
	/** Per ping, the period already handled by this process: skips the store on later calls. */
	private readonly handled = new Map<Ping, string>();
	private ticking?: Promise<void>;

	constructor(o: UsageOptions) {
		this.o = o;
		this.fetchImpl = o.fetch ?? ((input, init) => fetch(input, init));
		this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
	}

	/**
	 * Sends whichever pings are due. Call on start and on each tool call
	 * without awaiting; after the first call of a period it does nothing but
	 * compare two strings. Never throws.
	 */
	tick(): Promise<void> {
		if (this.o.disabled) return Promise.resolve();
		this.ticking ??= this.run()
			.catch(() => {})
			.finally(() => (this.ticking = undefined));
		return this.ticking;
	}

	private async run(): Promise<void> {
		const t = this.now();
		const due: [Ping, string][] = [
			["install", "installed"],
			["weekly", periodKey("week", t)],
			["monthly", periodKey("month", t)],
		];
		await Promise.all(due.filter(([ping, key]) => this.handled.get(ping) !== key).map(([ping, key]) => this.maybeSend(ping, key)));
	}

	private async maybeSend(ping: Ping, key: string): Promise<void> {
		// At most one attempt per period per process, whatever happens below.
		this.handled.set(ping, key);
		// Per install type: the Desktop extension and npx on one computer share the state folder.
		const name = `${MARKER}${assetFor(this.o.install)}:${ping}`;
		let stored: string | null;
		try {
			stored = await this.o.kv.get(name);
		} catch {
			return; // can't tell whether it was sent: don't risk counting twice
		}
		if (stored === key) return;
		if (this.o.persistent && !this.o.persistent()) return;
		try {
			await this.o.kv.put(name, key); // no expiry: replaced by the next period's key
		} catch {
			return;
		}
		try {
			const res = await this.fetchImpl(pingUrl(ping, this.o.install), {
				headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
				redirect: "follow",
				signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
			});
			await res.body?.cancel().catch(() => {});
		} catch {
			// Offline, timed out or blocked: this period goes uncounted.
		}
	}
}
