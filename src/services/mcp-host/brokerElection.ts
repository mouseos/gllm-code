/**
 * Leader election for the MCP broker.
 *
 * The first VS Code window to start becomes the broker. All other windows
 * are followers — they keep running their own per-window MCP server (for
 * intra-host forwarding) but do not advertise it to external clients.
 *
 * The lock file `~/.gllm-code/mcp/broker.json` carries the current
 * leader's pid, port, and windowId. Claim is atomic via `fs.open(..., "wx")`.
 * Stale locks (pid no longer alive) are detected and replaced.
 *
 * On leader exit we delete the lock file; followers poll periodically and
 * race to claim it when it goes away.
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

const LOCK_DIR = path.join(os.homedir(), ".gllm-code", "mcp")
const LOCK_FILE = path.join(LOCK_DIR, "broker.json")

export interface BrokerLock {
	/** Port the broker HTTP server is actually listening on. */
	port: number
	/** Extension-host pid currently acting as leader. */
	pid: number
	/** WindowId from the registry; lets tools resolve "self" vs "remote". */
	leaderWindowId: string
	/** ISO timestamp the lock was written. */
	startedAt: string
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code
		// EPERM = process exists but we can't signal it; still alive.
		return code === "EPERM"
	}
}

export async function readLock(): Promise<BrokerLock | undefined> {
	try {
		const raw = await fs.readFile(LOCK_FILE, "utf8")
		const parsed = JSON.parse(raw) as unknown
		if (!parsed || typeof parsed !== "object") return undefined
		const o = parsed as Record<string, unknown>
		if (
			typeof o.port === "number" &&
			typeof o.pid === "number" &&
			typeof o.leaderWindowId === "string" &&
			typeof o.startedAt === "string"
		) {
			return { port: o.port, pid: o.pid, leaderWindowId: o.leaderWindowId, startedAt: o.startedAt }
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			// treat corrupted as absent
		}
	}
	return undefined
}

/**
 * Inspect the current lock. Returns:
 *  - "alive" when a live leader holds the lock,
 *  - "stale" when the lock file exists but the pid is dead,
 *  - "none" when no lock file is present.
 */
export async function probe(): Promise<{ state: "alive"; info: BrokerLock } | { state: "stale" | "none" }> {
	const info = await readLock()
	if (!info) return { state: "none" }
	return isProcessAlive(info.pid) ? { state: "alive", info } : { state: "stale" }
}

/**
 * Atomically attempt to become the leader. Returns true on success.
 * Clears stale lock files as a side-effect.
 */
export async function tryClaim(info: BrokerLock): Promise<boolean> {
	await fs.mkdir(LOCK_DIR, { recursive: true, mode: 0o700 })

	// Clean up a stale lock first so our `wx` open can succeed.
	const existing = await readLock()
	if (existing) {
		if (isProcessAlive(existing.pid)) return false
		try {
			await fs.unlink(LOCK_FILE)
		} catch {
			// Another window may have just cleaned/claimed it — fall through.
		}
	}

	try {
		const fh = await fs.open(LOCK_FILE, "wx", 0o600)
		try {
			await fh.writeFile(JSON.stringify(info, null, 2))
		} finally {
			await fh.close()
		}
		return true
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") return false
		throw err
	}
}

/**
 * Release our lock. No-op if the lock has moved on to another leader.
 */
export async function releaseLock(leaderWindowId: string): Promise<void> {
	const existing = await readLock()
	if (existing?.leaderWindowId === leaderWindowId) {
		try {
			await fs.unlink(LOCK_FILE)
		} catch {
			/* ignore */
		}
	}
}

export { LOCK_FILE }
