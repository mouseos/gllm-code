/**
 * Per-workspace port allocator for the MCP host.
 *
 * Binding a random port every time the server starts forces clients
 * (`claude mcp add ...`) to re-register after every reload. To avoid that,
 * we persist a `workspaceRoot → preferred port` map in
 * `~/.gllm-code/mcp/ports.json` and try to reuse the saved port on the next
 * start. If the preferred port is already in use — typically because the
 * user has the same workspace open in a second VS Code window — we fall
 * back to an OS-assigned port for that run and leave the mapping alone.
 */
import * as fs from "node:fs/promises"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"

import { Logger } from "@/shared/services/Logger"

const PORTS_DIR = path.join(os.homedir(), ".gllm-code", "mcp")
const PORTS_FILE = path.join(PORTS_DIR, "ports.json")

type PortMap = Record<string, number>

async function readMap(): Promise<PortMap> {
	try {
		const raw = await fs.readFile(PORTS_FILE, "utf8")
		const parsed = JSON.parse(raw) as unknown
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
		const out: PortMap = {}
		for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof k === "string" && typeof v === "number" && Number.isInteger(v) && v > 0 && v < 65_536) {
				out[k] = v
			}
		}
		return out
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {}
		Logger.warn(`[McpHost] ports.json read failed, treating as empty: ${String(err)}`)
		return {}
	}
}

async function writeMap(map: PortMap): Promise<void> {
	await fs.mkdir(PORTS_DIR, { recursive: true, mode: 0o700 })
	const tmp = `${PORTS_FILE}.${process.pid}.tmp`
	await fs.writeFile(tmp, JSON.stringify(map, null, 2), { mode: 0o600 })
	await fs.rename(tmp, PORTS_FILE)
}

/** Returns the saved preferred port for this workspace, if any. */
export async function getPreferredPort(workspaceRoot: string): Promise<number | undefined> {
	const map = await readMap()
	return map[workspaceRoot]
}

/** Persist the actual bound port as the preferred port for this workspace. */
export async function rememberPort(workspaceRoot: string, port: number): Promise<void> {
	if (!workspaceRoot || workspaceRoot === "(no-workspace)") return
	const map = await readMap()
	if (map[workspaceRoot] === port) return // no-op, avoid disk churn
	map[workspaceRoot] = port
	await writeMap(map).catch((err) => Logger.warn(`[McpHost] ports.json write failed: ${String(err)}`))
}

/**
 * Try to bind the HTTP server to `preferredPort` first. If that fails with
 * EADDRINUSE / EACCES (common when a sibling window already owns the port)
 * fall back to an OS-assigned random port. Resolves once the server is
 * actually listening.
 */
export async function listenWithPreferred(server: http.Server, host: string, preferredPort: number | undefined): Promise<void> {
	if (preferredPort && preferredPort > 0) {
		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (err: NodeJS.ErrnoException) => {
					server.off("listening", onListening)
					reject(err)
				}
				const onListening = () => {
					server.off("error", onError)
					resolve()
				}
				server.once("error", onError)
				server.once("listening", onListening)
				server.listen(preferredPort, host)
			})
			return
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code
			if (code === "EADDRINUSE" || code === "EACCES") {
				Logger.info(`[McpHost] preferred port ${preferredPort} unavailable (${code}), falling back to random`)
			} else {
				throw err
			}
		}
	}
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, host, () => {
			server.off("error", reject)
			resolve()
		})
	})
}
