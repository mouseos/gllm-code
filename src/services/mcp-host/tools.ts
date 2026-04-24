/**
 * MCP tool registration for the per-window and broker MCP servers. The
 * actual tool behaviour lives in `toolImpl.ts` + `toolDispatch.ts`; this
 * file just wires the Zod schemas and the approval gate.
 *
 * When registered on the broker, each tool also accepts an optional
 * `workspace` argument that the broker uses to select a target window.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

import type { ApprovalStore } from "./ApprovalStore"
import { type ForwardFn } from "./forwarding"
import { ToolError } from "./toolImpl"

export interface ToolContext {
	/** Name reported by the MCP client during initialize(). */
	getClientName(): string
	getApprovalStore(): ApprovalStore | undefined
	requireApproval(): boolean
	/** Modal approval prompt. Implementation lives alongside the server. */
	askUserForApproval(clientName: string): Promise<"allow" | "deny">
	/**
	 * Tool executor — either a direct-to-local dispatcher (per-window server
	 * default) or a broker router that picks a target window from the
	 * `workspace` arg and may HTTP-forward. Returns the raw MCP reply.
	 */
	forward: ForwardFn
	/** True when this server is the broker (adds the `workspace` arg to every tool). */
	isBroker?: boolean
}

async function ensureApproved(ctx: ToolContext): Promise<void> {
	if (!ctx.requireApproval()) return
	const store = ctx.getApprovalStore()
	if (!store) return
	const clientName = ctx.getClientName()
	const prior = store.getDecision(clientName)
	if (prior === "allow") return
	if (prior === "deny") {
		throw new ToolError("client_denied", {
			clientName,
			message: `The user previously denied MCP access to gllm-code for ${clientName}.`,
		})
	}
	const decision = await ctx.askUserForApproval(clientName)
	await store.record(clientName, decision)
	if (decision === "deny") {
		throw new ToolError("client_denied", { clientName, message: "User denied the MCP connection." })
	}
}

/**
 * Convert a ToolError thrown by the dispatcher/forwarder into an MCP error
 * that the SDK will serialise as JSON-RPC error. Other throws propagate.
 */
async function run<T extends Record<string, unknown>>(
	ctx: ToolContext,
	name: string,
	args: T,
	opts: { approvalRequired: boolean },
) {
	if (opts.approvalRequired) await ensureApproved(ctx)
	const workspace = ctx.isBroker ? (typeof args.workspace === "string" ? args.workspace : undefined) : undefined
	const forwardArgs = { ...args }
	delete (forwardArgs as Record<string, unknown>).workspace
	return ctx.forward({ name, args: forwardArgs as Record<string, unknown>, clientName: ctx.getClientName(), workspace })
}

export function registerGllmTools(server: McpServer, ctx: ToolContext): void {
	// The `workspace` arg only influences routing on the broker. Per-window
	// servers accept and ignore it so the wire schemas match across hosts.
	const workspaceArg = {
		workspace: z
			.string()
			.optional()
			.describe(
				"Absolute path of the workspace root to target. Only meaningful on the broker — omit to target the most recently focused window.",
			),
	}

	server.registerTool(
		"gllm_ping",
		{
			description:
				"Connectivity probe for the gllm-code MCP host. Returns basic host info and echoes the client name/message. Safe to call without approval.",
			inputSchema: {
				message: z.string().optional().describe("Echoed back in the reply."),
				...workspaceArg,
			},
		},
		async (args) => run(ctx, "gllm_ping", args, { approvalRequired: false }),
	)

	server.registerTool(
		"gllm_start_task",
		{
			description:
				"Start a new gllm-code task with the given prompt. Opens the sidebar if it is not already visible. Returns the new task id.",
			inputSchema: {
				prompt: z.string().describe("Initial user message for the new task."),
				images: z.array(z.string()).optional().describe("Optional array of image data URLs (data:image/...;base64,...)."),
				files: z.array(z.string()).optional().describe("Optional array of absolute file paths to attach."),
				...workspaceArg,
			},
		},
		async (args) => run(ctx, "gllm_start_task", args, { approvalRequired: true }),
	)

	server.registerTool(
		"gllm_send_message",
		{
			description:
				"Send a follow-up message to the currently active task. Works for pending asks (e.g. followup questions) and for continuing the conversation after attempt_completion.",
			inputSchema: {
				text: z.string().describe("The message to send."),
				images: z.array(z.string()).optional(),
				...workspaceArg,
			},
		},
		async (args) => run(ctx, "gllm_send_message", args, { approvalRequired: true }),
	)

	server.registerTool(
		"gllm_get_status",
		{
			description: "Snapshot of the active task: id, streaming state, last pending ask, token/cost counters.",
			inputSchema: {
				...workspaceArg,
			},
		},
		async (args) => run(ctx, "gllm_get_status", args, { approvalRequired: false }),
	)

	server.registerTool(
		"gllm_get_messages",
		{
			description:
				"Return recent messages from the active task (user prompts, assistant text, attempt_completion). By default hides reasoning deltas and API-request noise.",
			inputSchema: {
				limit: z.number().int().min(1).max(500).optional().describe("Max messages to return from the tail (default 50)."),
				includeReasoning: z.boolean().optional().describe("Include `say: reasoning` thinking deltas. Default false."),
				...workspaceArg,
			},
		},
		async (args) => run(ctx, "gllm_get_messages", args, { approvalRequired: false }),
	)

	server.registerTool(
		"gllm_wait_for_completion",
		{
			description: "Block until the active task stops streaming or the task is cleared. Returns the final status snapshot.",
			inputSchema: {
				timeoutMs: z
					.number()
					.int()
					.min(500)
					.max(300_000)
					.optional()
					.describe("Maximum wait in milliseconds (default 60000, hard cap 300000)."),
				...workspaceArg,
			},
		},
		async (args) => run(ctx, "gllm_wait_for_completion", args, { approvalRequired: false }),
	)

	server.registerTool(
		"gllm_list_tasks",
		{
			description: "Returns the persisted gllm-code task history (all origins). Requires one-time user approval.",
			inputSchema: {
				limit: z.number().int().min(1).max(500).optional().describe("Maximum number of tasks to return (default 50)."),
				favoritesOnly: z.boolean().optional(),
				...workspaceArg,
			},
		},
		async (args) => run(ctx, "gllm_list_tasks", args, { approvalRequired: true }),
	)

	server.registerTool(
		"gllm_cancel_task",
		{
			description: "Cancel the currently active task, if any.",
			inputSchema: {
				...workspaceArg,
			},
		},
		async (args) => run(ctx, "gllm_cancel_task", args, { approvalRequired: true }),
	)
}
