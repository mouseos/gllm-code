/**
 * MCP host server: exposes gllm-code's task surface to outside MCP clients
 * (e.g. Claude Code, Claude Desktop) over a per-window loopback HTTP port.
 *
 * Transport: StreamableHTTP (the MCP SDK's modern transport that multiplexes
 * POST JSON-RPC + SSE on a single endpoint `/mcp`).
 *
 * Security: bound to 127.0.0.1 only, random port, Bearer token required on
 * every request. The token + port is advertised via the registry file that
 * clients read; nothing goes on the network.
 *
 * Phase 1 exposes only a `ping` tool so we can verify the handshake + auth
 * path end-to-end. Real tools are wired in Phase 2.
 */

import { randomBytes, randomUUID } from "node:crypto"
import * as http from "node:http"
import { AddressInfo } from "node:net"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import { Logger } from "@/shared/services/Logger"

import { approvalStoreFor } from "./ApprovalStore"
import { tryGetActiveController } from "./currentController"
import { RegistryEntry, register, unregister } from "./registry"
import { registerGllmTools, ToolContext } from "./tools"

export interface McpHostServerOptions {
	workspaceRoot: string
	version?: string
	/** Runtime-resolved: when false, approval modal is skipped (dev only). */
	getRequireApproval: () => boolean
}

export interface RunningMcpHost {
	entry: RegistryEntry
	stop(): Promise<void>
}

const BIND_HOST = "127.0.0.1"

function newToken(): string {
	return randomBytes(24).toString("hex")
}

function authorize(req: http.IncomingMessage, token: string): boolean {
	const header = req.headers.authorization
	if (typeof header !== "string") return false
	const expected = `Bearer ${token}`
	// constant-time-ish comparison
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

function buildMcpServer(version: string, getClientName: () => string, getRequireApproval: () => boolean): McpServer {
	const server = new McpServer(
		{
			name: "gllm-code",
			version,
		},
		{
			capabilities: {
				tools: {},
			},
		},
	)

	// Ask the user the first time a given client attempts a state-changing
	// tool. Both the approval record and the modal are mediated via the host
	// bridge so unit tests can stub the window API.
	const askUserForApproval = async (clientName: string): Promise<"allow" | "deny"> => {
		try {
			const res = await HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: `An MCP client identified as "${clientName}" is connecting to GLLM Code. It will be able to start new tasks, send follow-up messages, read your task history, and cancel running tasks. Allow this client?`,
				options: { modal: true, items: ["Allow", "Deny"] },
			})
			return res.selectedOption === "Allow" ? "allow" : "deny"
		} catch (err) {
			Logger.warn(`[McpHost] approval modal failed, defaulting to deny: ${err}`)
			return "deny"
		}
	}

	const ctx: ToolContext = {
		getClientName,
		getApprovalStore: () => approvalStoreFor(tryGetActiveController()),
		requireApproval: getRequireApproval,
		askUserForApproval,
	}

	registerGllmTools(server, ctx)

	// Kept separate from registerGllmTools so the toolkit can't disable it —
	// this is the smoke-test entry point for diagnostics.
	server.registerTool(
		"gllm_host_info",
		{
			description: "Diagnostic: returns the host version and whether a controller is currently available.",
			inputSchema: { message: z.string().optional() },
		},
		async (args) => {
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								ok: true,
								version,
								echo: args.message ?? null,
								hasController: !!tryGetActiveController(),
							},
							null,
							2,
						),
					},
				],
			}
		},
	)

	return server
}

export async function startMcpHostServer(options: McpHostServerOptions): Promise<RunningMcpHost> {
	const windowId = `win-${process.pid}-${randomUUID().slice(0, 8)}`
	const token = newToken()

	// Captured client identity from the initialize handshake. Falls back to
	// "unknown-mcp-client" if a tool is invoked before initialize resolves
	// (shouldn't happen with compliant clients but guard anyway).
	let clientName = "unknown-mcp-client"
	const mcpServer = buildMcpServer(options.version ?? "0.0.0", () => clientName, options.getRequireApproval)
	mcpServer.server.oninitialized = () => {
		const info = mcpServer.server.getClientVersion()
		if (info?.name) clientName = info.name
	}

	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: () => randomUUID(),
		enableJsonResponse: false,
	})

	await mcpServer.connect(transport)

	const httpServer = http.createServer(async (req, res) => {
		try {
			// Only `/mcp` is public. Everything else gets a 404 so we don't
			// accidentally advertise other routes.
			if (!req.url || !req.url.startsWith("/mcp")) {
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
			await transport.handleRequest(req, res, body)
		} catch (err) {
			Logger.error(`[McpHost] request error: ${String(err)}`)
			if (!res.headersSent) {
				res.writeHead(500, { "Content-Type": "application/json" })
				res.end(JSON.stringify({ error: "internal_error" }))
			}
		}
	})

	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", reject)
		httpServer.listen(0, BIND_HOST, () => {
			httpServer.off("error", reject)
			resolve()
		})
	})

	const address = httpServer.address() as AddressInfo
	const entry: RegistryEntry = {
		windowId,
		workspaceRoot: options.workspaceRoot,
		port: address.port,
		token,
		pid: process.pid,
		startedAt: new Date().toISOString(),
		version: options.version,
	}
	await register(entry)
	Logger.info(`[McpHost] listening on ${BIND_HOST}:${entry.port} (workspace=${entry.workspaceRoot})`)

	return {
		entry,
		async stop() {
			await unregister(windowId).catch((err) => Logger.warn(`[McpHost] unregister failed: ${err}`))
			await new Promise<void>((resolve) => httpServer.close(() => resolve()))
			await mcpServer.close().catch((err) => Logger.warn(`[McpHost] mcpServer.close failed: ${err}`))
		},
	}
}
