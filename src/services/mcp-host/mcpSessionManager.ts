/**
 * StreamableHTTP session manager.
 *
 * The MCP SDK's `StreamableHTTPServerTransport` is session-stateful when
 * `sessionIdGenerator` is set — it rejects re-initialization on an already-
 * initialised transport with
 *   -32600 "Invalid Request: Server already initialized".
 *
 * The correct pattern is one transport per session: the first POST from a
 * client (no `mcp-session-id` header) creates a fresh transport+server,
 * captures the assigned session id, and subsequent requests with that
 * header are routed back to the same transport. When the client closes
 * the transport, we drop the entry.
 *
 * Used by both the per-window MCP server and the broker — same dance.
 */

import { randomUUID } from "node:crypto"
import type * as http from "node:http"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"

import { Logger } from "@/shared/services/Logger"

export interface SessionEntry {
	transport: StreamableHTTPServerTransport
	mcpServer: McpServer
}

/**
 * Build + connect a brand-new McpServer for one session.
 * The caller wires tool registrations, approval handlers, etc.
 */
export type BuildSession = () => McpServer

export class McpSessionManager {
	private readonly sessions = new Map<string, SessionEntry>()

	constructor(private readonly buildSession: BuildSession) {}

	async handle(req: http.IncomingMessage, res: http.ServerResponse, body: unknown): Promise<void> {
		const headerSessionId = req.headers["mcp-session-id"]
		const sessionId = typeof headerSessionId === "string" ? headerSessionId : undefined

		let entry = sessionId ? this.sessions.get(sessionId) : undefined

		if (!entry) {
			// We accept a missing session id only when the payload is an
			// initialize request. Every other method requires a valid session.
			if (req.method === "POST" && !isInitializeRequestBody(body)) {
				res.writeHead(400, { "Content-Type": "application/json" })
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						error: { code: -32000, message: "Bad Request: No valid session id provided" },
						id: null,
					}),
				)
				return
			}

			const mcpServer = this.buildSession()
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: () => randomUUID(),
				enableJsonResponse: false,
				onsessioninitialized: (sid) => {
					this.sessions.set(sid, { transport, mcpServer })
				},
			})
			transport.onclose = () => {
				if (transport.sessionId) this.sessions.delete(transport.sessionId)
				mcpServer.close().catch((err) => Logger.warn(`[McpSession] close failed: ${String(err)}`))
			}
			await mcpServer.connect(transport)
			entry = { transport, mcpServer }
		}

		await entry.transport.handleRequest(req, res, body)
	}

	async closeAll(): Promise<void> {
		const entries = [...this.sessions.values()]
		this.sessions.clear()
		await Promise.allSettled(
			entries.map(async (e) => {
				try {
					await e.transport.close()
				} catch {
					/* ignore */
				}
				try {
					await e.mcpServer.close()
				} catch {
					/* ignore */
				}
			}),
		)
	}
}

function isInitializeRequestBody(body: unknown): boolean {
	if (!body) return false
	if (Array.isArray(body)) return body.some((m) => isInitializeRequest(m))
	return isInitializeRequest(body)
}
