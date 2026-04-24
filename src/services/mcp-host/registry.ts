import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

/**
 * Discovery registry for the gllm-code MCP host server.
 *
 * Clients (e.g. Claude Code) read `~/.gllm-code/mcp/registry.json` to find an
 * active gllm-code instance for a given workspace. Each running extension host
 * writes one entry on startup and removes it on shutdown. Stale entries whose
 * `pid` no longer points to a live process are cleaned up lazily.
 *
 * Multiple VS Code windows opened on the same workspace are explicitly
 * supported — each one gets its own port and windowId.
 */

export interface RegistryEntry {
	/** Stable id unique per running extension host. */
	windowId: string
	/** Absolute path of workspace root (or "(no-workspace)" when empty). */
	workspaceRoot: string
	/** TCP port the MCP server listens on, 127.0.0.1-only. */
	port: number
	/** Bearer token required on the Authorization header. */
	token: string
	/** Extension host process id (for liveness checks). */
	pid: number
	/** ISO timestamp the entry was written. */
	startedAt: string
	/** Extension-version string (useful for debugging older installs). */
	version?: string
	/**
	 * ISO timestamp of the last time this window had keyboard/mouse focus.
	 * The broker uses `max(lastFocusedAt)` as the default target for
	 * tool calls that don't specify a `workspace` argument.
	 */
	lastFocusedAt?: string
}

const REGISTRY_DIR = path.join(os.homedir(), ".gllm-code", "mcp")
const REGISTRY_FILE = path.join(REGISTRY_DIR, "registry.json")

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code
		// EPERM means the process exists but we can't signal it — still alive.
		return code === "EPERM"
	}
}

async function readAll(): Promise<RegistryEntry[]> {
	try {
		const raw = await fs.readFile(REGISTRY_FILE, "utf8")
		const parsed = JSON.parse(raw) as unknown
		if (!Array.isArray(parsed)) return []
		return parsed.filter((e): e is RegistryEntry => {
			if (!e || typeof e !== "object") return false
			const o = e as Record<string, unknown>
			return (
				typeof o.windowId === "string" &&
				typeof o.workspaceRoot === "string" &&
				typeof o.port === "number" &&
				typeof o.token === "string" &&
				typeof o.pid === "number" &&
				typeof o.startedAt === "string" &&
				(o.lastFocusedAt === undefined || typeof o.lastFocusedAt === "string")
			)
		})
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
		// Corrupted registry — ignore and start fresh rather than crash activation.
		return []
	}
}

async function writeAll(entries: RegistryEntry[]): Promise<void> {
	await fs.mkdir(REGISTRY_DIR, { recursive: true, mode: 0o700 })
	const tmp = `${REGISTRY_FILE}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
	await fs.writeFile(tmp, JSON.stringify(entries, null, 2), { mode: 0o600 })
	await fs.rename(tmp, REGISTRY_FILE)
}

/**
 * Add the current window's entry and purge any stale peer entries.
 * Returns the full list as persisted (for diagnostics).
 */
export async function register(entry: RegistryEntry): Promise<RegistryEntry[]> {
	const all = await readAll()
	const next = all.filter((e) => e.windowId !== entry.windowId).filter((e) => isProcessAlive(e.pid))
	next.push(entry)
	await writeAll(next)
	return next
}

/** Remove this window's entry. Safe to call from deactivate(). */
export async function unregister(windowId: string): Promise<void> {
	const all = await readAll()
	const next = all.filter((e) => e.windowId !== windowId)
	// Also clean up any other stale peers while we're here.
	const alive = next.filter((e) => isProcessAlive(e.pid))
	await writeAll(alive)
}

/** Returns registry contents with stale entries filtered out. */
export async function list(): Promise<RegistryEntry[]> {
	const all = await readAll()
	return all.filter((e) => isProcessAlive(e.pid))
}

/**
 * Update `lastFocusedAt` for this window without rewriting the entry shape.
 * Called from a `vscode.window.onDidChangeWindowState` listener.
 */
export async function touchFocus(windowId: string): Promise<void> {
	const all = await readAll()
	let changed = false
	for (const entry of all) {
		if (entry.windowId === windowId) {
			entry.lastFocusedAt = new Date().toISOString()
			changed = true
			break
		}
	}
	if (!changed) return
	const alive = all.filter((e) => isProcessAlive(e.pid))
	await writeAll(alive)
}

export { REGISTRY_FILE }
