/**
 * MCP tool surface exposed by gllm-code to outside clients. Each tool is a
 * thin bridge onto the active Controller / Task.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import pWaitFor from "p-wait-for"
import { z } from "zod"

import type { Controller } from "@/core/controller"
import { Logger } from "@/shared/services/Logger"

import type { ApprovalStore } from "./ApprovalStore"
import { resolveActiveControllerOrOpen, tryGetActiveController } from "./currentController"
import { pendingOriginForNextInitTask } from "./originHook"

export interface ToolContext {
	/** Name reported by the MCP client during initialize(). */
	getClientName(): string
	getApprovalStore(): ApprovalStore | undefined
	requireApproval(): boolean
	/**
	 * Shows a modal dialog. Returns the user's decision. Implementation lives
	 * alongside McpHostServer so it can `await` a VS Code modal without
	 * pulling a UI dependency into tools.ts.
	 */
	askUserForApproval(clientName: string): Promise<"allow" | "deny">
}

/** JSON-serialise, default to empty object on undefined. */
function reply(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify(payload ?? {}, null, 2),
			},
		],
	}
}

function toolError(message: string, extra?: Record<string, unknown>): never {
	throw new Error(JSON.stringify({ error: message, ...extra }))
}

async function ensureApproved(ctx: ToolContext): Promise<void> {
	if (!ctx.requireApproval()) return
	const store = ctx.getApprovalStore()
	if (!store) return
	const clientName = ctx.getClientName()
	const prior = store.getDecision(clientName)
	if (prior === "allow") return
	if (prior === "deny") {
		toolError("client_denied", {
			clientName,
			message: `The user previously denied MCP access to gllm-code for ${clientName}.`,
		})
	}
	const decision = await ctx.askUserForApproval(clientName)
	await store.record(clientName, decision)
	if (decision === "deny") {
		toolError("client_denied", { clientName, message: "User denied the MCP connection." })
	}
}

async function getControllerOrOpen(): Promise<Controller> {
	const controller = await resolveActiveControllerOrOpen(5_000)
	if (!controller) {
		toolError("no_active_webview", {
			message: "gllm-code sidebar is not available. Open the sidebar and retry.",
		})
	}
	return controller
}

function lastMessageAsk(controller: Controller): string | undefined {
	const task = controller.task
	if (!task) return undefined
	const msgs = task.messageStateHandler?.getClineMessages?.() ?? []
	return msgs[msgs.length - 1]?.ask
}

export function registerGllmTools(server: McpServer, ctx: ToolContext): void {
	// ────────────────────────────────────────────────────────────────────────
	// ping — connectivity check, no approval required, no state change.
	// ────────────────────────────────────────────────────────────────────────
	server.registerTool(
		"gllm_ping",
		{
			description:
				"Connectivity probe for the gllm-code MCP host. Returns basic host info and echoes the client name/message. Safe to call without approval.",
			inputSchema: {
				message: z.string().optional().describe("Echoed back in the reply."),
			},
		},
		async (args) => {
			const hasController = !!tryGetActiveController()
			return reply({
				ok: true,
				echo: args.message ?? null,
				clientName: ctx.getClientName(),
				hasActiveController: hasController,
			})
		},
	)

	// ────────────────────────────────────────────────────────────────────────
	// start_task — new conversation
	// ────────────────────────────────────────────────────────────────────────
	server.registerTool(
		"gllm_start_task",
		{
			description:
				"Start a new gllm-code task with the given prompt. Opens the sidebar if it is not already visible. Returns the new task id.",
			inputSchema: {
				prompt: z.string().describe("Initial user message for the new task."),
				images: z.array(z.string()).optional().describe("Optional array of image data URLs (data:image/...;base64,...)."),
				files: z.array(z.string()).optional().describe("Optional array of absolute file paths to attach."),
			},
		},
		async (args) => {
			await ensureApproved(ctx)
			const controller = await getControllerOrOpen()
			// Tell the next initTask which origin to stamp onto the HistoryItem.
			pendingOriginForNextInitTask.set({ origin: "mcp", clientName: ctx.getClientName() })
			try {
				await controller.initTask(args.prompt, args.images, args.files)
			} finally {
				pendingOriginForNextInitTask.clear()
			}
			const task = controller.task
			return reply({
				ok: true,
				taskId: task?.taskId ?? null,
				ulid: task?.ulid ?? null,
				origin: "mcp",
				clientName: ctx.getClientName(),
			})
		},
	)

	// ────────────────────────────────────────────────────────────────────────
	// send_message — follow-up to the active task (including after completion)
	// ────────────────────────────────────────────────────────────────────────
	server.registerTool(
		"gllm_send_message",
		{
			description:
				"Send a follow-up message to the currently active task. Works for pending asks (e.g. followup questions) and for continuing the conversation after attempt_completion.",
			inputSchema: {
				text: z.string().describe("The message to send."),
				images: z.array(z.string()).optional(),
			},
		},
		async (args) => {
			await ensureApproved(ctx)
			const controller = tryGetActiveController()
			if (!controller) toolError("no_active_webview")
			const task = controller.task
			if (!task) toolError("no_active_task", { message: "No task is currently active. Call gllm_start_task first." })
			if (task.taskState.isStreaming) {
				toolError("task_busy", {
					message: "The task is currently streaming a response. Wait for it to finish or call gllm_cancel_task.",
				})
			}
			const ask = lastMessageAsk(controller)
			await task.handleWebviewAskResponse("messageResponse", args.text, args.images ?? [], [])
			return reply({ ok: true, taskId: task.taskId, matchedAsk: ask ?? null })
		},
	)

	// ────────────────────────────────────────────────────────────────────────
	// get_status — read-only; no approval required
	// ────────────────────────────────────────────────────────────────────────
	server.registerTool(
		"gllm_get_status",
		{
			description: "Snapshot of the active task: id, streaming state, last pending ask, token/cost counters.",
			inputSchema: {},
		},
		async () => {
			const controller = tryGetActiveController()
			if (!controller) return reply({ hasTask: false, reason: "no_active_webview" })
			const task = controller.task
			if (!task) return reply({ hasTask: false })
			const msgs = task.messageStateHandler?.getClineMessages?.() ?? []
			const last = msgs[msgs.length - 1]
			return reply({
				hasTask: true,
				taskId: task.taskId,
				ulid: task.ulid,
				isStreaming: task.taskState.isStreaming,
				abort: task.taskState.abort,
				lastAsk: last?.ask ?? null,
				lastSay: last?.say ?? null,
				lastText: last?.text ?? null,
				lastTs: last?.ts ?? null,
			})
		},
	)

	// ────────────────────────────────────────────────────────────────────────
	// wait_for_completion — polling wait; no approval required
	// ────────────────────────────────────────────────────────────────────────
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
			},
		},
		async (args) => {
			const controller = tryGetActiveController()
			if (!controller) toolError("no_active_webview")
			try {
				await pWaitFor(
					() => {
						const t = controller.task
						return !t || !t.taskState.isStreaming
					},
					{ interval: 500, timeout: args.timeoutMs ?? 60_000 },
				)
			} catch (err) {
				return reply({ ok: false, timedOut: true, message: String(err) })
			}
			const task = controller.task
			return reply({
				ok: true,
				taskId: task?.taskId ?? null,
				hasTask: !!task,
				isStreaming: task?.taskState.isStreaming ?? false,
			})
		},
	)

	// ────────────────────────────────────────────────────────────────────────
	// list_tasks — reads persisted history (all origins)
	// ────────────────────────────────────────────────────────────────────────
	server.registerTool(
		"gllm_list_tasks",
		{
			description: "Returns the persisted gllm-code task history (all origins). Requires one-time user approval.",
			inputSchema: {
				limit: z.number().int().min(1).max(500).optional().describe("Maximum number of tasks to return (default 50)."),
				favoritesOnly: z.boolean().optional(),
			},
		},
		async (args) => {
			await ensureApproved(ctx)
			const controller = tryGetActiveController()
			if (!controller) toolError("no_active_webview")
			const taskHistory = controller.stateManager.getGlobalStateKey("taskHistory") ?? []
			let items = [...taskHistory]
			if (args.favoritesOnly) items = items.filter((i) => i.isFavorited)
			items.sort((a, b) => b.ts - a.ts)
			const limit = args.limit ?? 50
			items = items.slice(0, limit)
			return reply({
				ok: true,
				count: items.length,
				tasks: items.map((i) => ({
					id: i.id,
					ts: i.ts,
					task: i.task,
					totalCost: i.totalCost ?? 0,
					tokensIn: i.tokensIn ?? 0,
					tokensOut: i.tokensOut ?? 0,
					modelId: i.modelId ?? null,
					origin: i.origin ?? "webview",
					originClientName: i.originClientName ?? null,
					isFavorited: !!i.isFavorited,
				})),
			})
		},
	)

	// ────────────────────────────────────────────────────────────────────────
	// cancel_task
	// ────────────────────────────────────────────────────────────────────────
	server.registerTool(
		"gllm_cancel_task",
		{
			description: "Cancel the currently active task, if any.",
			inputSchema: {},
		},
		async () => {
			await ensureApproved(ctx)
			const controller = tryGetActiveController()
			if (!controller) toolError("no_active_webview")
			if (!controller.task) return reply({ ok: true, hadTask: false })
			try {
				await controller.cancelTask()
			} catch (err) {
				Logger.warn(`[McpHost] cancelTask failed: ${String(err)}`)
			}
			return reply({ ok: true, hadTask: true })
		},
	)
}
