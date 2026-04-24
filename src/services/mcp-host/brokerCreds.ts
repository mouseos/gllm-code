/**
 * Stable credentials for the MCP broker.
 *
 * The broker token and preferred port are persisted to
 * `~/.gllm-code/mcp/broker-creds.json` and **never regenerated** for the
 * life of the install. That way a user only has to run
 * `claude mcp add ...` once — every subsequent VS Code restart (leader
 * election, port fallback, etc.) keeps the same URL+token.
 *
 * This file is separate from `broker.json` (the runtime lock) so that a
 * crashed leader does not erase the long-lived credentials.
 */

import { randomBytes } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

const DEFAULT_PREFERRED_PORT = 39999
const CREDS_DIR = path.join(os.homedir(), ".gllm-code", "mcp")
const CREDS_FILE = path.join(CREDS_DIR, "broker-creds.json")

export interface BrokerCreds {
	token: string
	preferredPort: number
}

function isValid(parsed: unknown): parsed is BrokerCreds {
	if (!parsed || typeof parsed !== "object") return false
	const o = parsed as Record<string, unknown>
	return typeof o.token === "string" && o.token.length >= 32 && typeof o.preferredPort === "number"
}

async function writeCreds(creds: BrokerCreds): Promise<void> {
	await fs.mkdir(CREDS_DIR, { recursive: true, mode: 0o700 })
	const tmp = `${CREDS_FILE}.${process.pid}.tmp`
	await fs.writeFile(tmp, JSON.stringify(creds, null, 2), { mode: 0o600 })
	await fs.rename(tmp, CREDS_FILE)
}

/** Read existing creds or mint new ones on first use. */
export async function loadOrCreateCreds(): Promise<BrokerCreds> {
	try {
		const raw = await fs.readFile(CREDS_FILE, "utf8")
		const parsed = JSON.parse(raw) as unknown
		if (isValid(parsed)) return parsed
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			// Corrupted file — fall through and overwrite.
		}
	}
	const creds: BrokerCreds = {
		token: randomBytes(24).toString("hex"),
		preferredPort: DEFAULT_PREFERRED_PORT,
	}
	await writeCreds(creds)
	return creds
}

/** Persist a new preferred port (called after a fallback bind). */
export async function updatePreferredPort(port: number): Promise<void> {
	const creds = await loadOrCreateCreds()
	if (creds.preferredPort === port) return
	await writeCreds({ ...creds, preferredPort: port })
}
