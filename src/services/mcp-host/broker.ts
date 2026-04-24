/**
 * Broker MCP server — one per machine, owned by whichever VS Code window
 * won the leader election. External MCP clients (`claude mcp add ...`)
 * connect here with a single stable URL+token; the broker routes each
 * tool call to the right VS Code window by workspace.
 *
 * See `brokerElection.ts` for how leadership is acquired / handed off.
 *
 * The per-window MCP servers are still running — they are the forwarding
 * backends the broker calls over HTTP. Only the broker is advertised in
 * the settings UI.
 */

import * as http from "node:http"
import { AddressInfo } from "node:net"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import { Logger } from "@/shared/services/Logger"

import { approvalStoreFor } from "./ApprovalStore"
import { type BrokerCreds, updatePreferredPort } from "./brokerCreds"
import { releaseLock, tryClaim } from "./brokerElection"
import { tryGetActiveController } from "./currentController"
import { makeBrokerForwarder } from "./forwarding"
import { McpSessionManager } from "./mcpSessionManager"
import { listenWithPreferred } from "./portAllocator"
import { registerGllmTools, ToolContext } from "./tools"

export interface BrokerOptions {
	creds: BrokerCreds
	/**
	 * WindowId of the leader (== this process's per-window McpHost). Used to
	 * shortcut in-process dispatch when the resolved target is the leader
	 * itself.
	 */
	leaderWindowId: string
	version: string
	getRequireApproval: () => boolean
}

export interface RunningBroker {
	port: number
	stop(): Promise<void>
}

const BIND_HOST = "127.0.0.1"

function authorize(req: http.IncomingMessage, token: string): boolean {
	const header = req.headers.authorization
	if (typeof header !== "string") return false
	const expected = `Bearer ${token}`
	if (header.length !== expected.length) return false
	let diff = 0
	for (let i = 0; i < header.length; i++) {
		diff |= header.charCodeAt(i) ^ expected.charCodeAt(i)
	}
	return diff === 0
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let size = 0
		const chunks: Buffer[] = []
		req.on("data", (chunk: Buffer) => {
			size += chunk.length
			if (size > 4 * 1024 * 1024) {
				reject(new Error("body too large"))
				req.destroy()
				return
			}
			chunks.push(chunk)
		})
		req.on("end", () => {
			if (chunks.length === 0) {
				resolve(undefined)
				return
			}
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
			} catch (err) {
				reject(err)
			}
		})
		req.on("error", reject)
	})
}

function buildBrokerMcp(opts: BrokerOptions): McpServer {
	// Per-session client identity. Captured from the MCP `initialize`
	// message; defaults to "unknown-mcp-client" for tool calls that arrive
	// before the handshake completes (shouldn't happen with compliant clients
	// but guard anyway).
	let clientName = "unknown-mcp-client"

	const server = new McpServer({ name: "gllm-code-broker", version: opts.version }, { capabilities: { tools: {} } })
	server.server.oninitialized = () => {
		const info = server.server.getClientVersion()
		if (info?.name) clientName = info.name
	}

	const askUserForApproval = async (who: string): Promise<"allow" | "deny"> => {
		try {
			const res = await HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: `An MCP client identified as "${who}" is connecting to GLLM Code. It will be able to start new tasks, send follow-up messages, read your task history, and cancel running tasks across every open gllm-code window. Allow this client?`,
				options: { modal: true, items: ["Allow", "Deny"] },
			})
			return res.selectedOption === "Allow" ? "allow" : "deny"
		} catch (err) {
			Logger.warn(`[McpBroker] approval modal failed, defaulting to deny: ${err}`)
			return "deny"
		}
	}

	const ctx: ToolContext = {
		getClientName: () => clientName,
		// ApprovalStore is backed by globalState, which is shared across
		// windows, so reading it through the leader's controller is fine.
		getApprovalStore: () => approvalStoreFor(tryGetActiveController()),
		requireApproval: opts.getRequireApproval,
		askUserForApproval,
		forward: makeBrokerForwarder({ leaderWindowId: opts.leaderWindowId }),
		isBroker: true,
	}

	registerGllmTools(server, ctx)
	return server
}

/**
 * Start the broker server on the given creds. Fails if port bind fails in
 * an unexpected way; falls back to an OS-assigned port (and persists it as
 * the new preferred) if the preferred port is already in use.
 */
export async function startBroker(opts: BrokerOptions): Promise<RunningBroker> {
	const sessions = new McpSessionManager(() => buildBrokerMcp(opts))

	const token = opts.creds.token
	const httpServer = http.createServer(async (req, res) => {
		try {
			if (!req.url) {
				res.writeHead(404, { "Content-Type": "text/plain" })
				res.end("Not found")
				return
			}
			if (req.url.startsWith("/mcp/health")) {
				// Token-gated health check so followers can verify liveness.
				if (!authorize(req, token)) {
					res.writeHead(401)
					res.end()
					return
				}
				res.writeHead(200, { "Content-Type": "application/json" })
				res.end(JSON.stringify({ ok: true, leaderWindowId: opts.leaderWindowId, version: opts.version }))
				return
			}
			if (!req.url.startsWith("/mcp")) {
				res.writeHead(404, { "Content-Type": "text/plain" })
				res.end("Not found")
				return
			}
			if (!authorize(req, token)) {
				res.writeHead(401, { "Content-Type": "application/json" })
				res.end(JSON.stringify({ error: "unauthorized" }))
				return
			}
			let body: unknown
			if (req.method === "POST") {
				try {
					body = await readBody(req)
				} catch (err) {
					res.writeHead(400, { "Content-Type": "application/json" })
					res.end(JSON.stringify({ error: "invalid_body", message: String(err) }))
					return
				}
			}
			await sessions.handle(req, res, body)
		} catch (err) {
			Logger.error(`[McpBroker] request error: ${String(err)}`)
			if (!res.headersSent) {
				res.writeHead(500, { "Content-Type": "application/json" })
				res.end(JSON.stringify({ error: "internal_error" }))
			}
		}
	})

	await listenWithPreferred(httpServer, BIND_HOST, opts.creds.preferredPort)

	const address = httpServer.address() as AddressInfo

	const claimed = await tryClaim({
		port: address.port,
		pid: process.pid,
		leaderWindowId: opts.leaderWindowId,
		startedAt: new Date().toISOString(),
	})
	if (!claimed) {
		// Lost the race between probe and claim. Tear down quietly.
		await new Promise<void>((resolve) => httpServer.close(() => resolve()))
		await sessions.closeAll()
		throw new Error("broker_claim_lost_race")
	}

	if (address.port !== opts.creds.preferredPort) {
		// Preferred port was taken; persist the fallback so `claude mcp add`
		// against the advertised URL is self-consistent next restart.
		await updatePreferredPort(address.port).catch((err) =>
			Logger.warn(`[McpBroker] updatePreferredPort failed: ${String(err)}`),
		)
	}

	Logger.info(`[McpBroker] listening on ${BIND_HOST}:${address.port} (leader=${opts.leaderWindowId})`)

	return {
		port: address.port,
		async stop(): Promise<void> {
			await releaseLock(opts.leaderWindowId).catch((err) => Logger.warn(`[McpBroker] releaseLock failed: ${String(err)}`))
			await new Promise<void>((resolve) => httpServer.close(() => resolve()))
			await sessions.closeAll()
		},
	}
}
