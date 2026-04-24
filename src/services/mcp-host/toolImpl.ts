/**
 * Pure tool implementations: each takes an explicit Controller and raw args,
 * returns the JSON-serialised reply payload. Shared by:
 *
 *  - the per-window MCP server's tools.ts (legacy direct `/mcp` path)
 *  - the per-window `/internal/run-tool` HTTP endpoint (broker forwarding)
 *  - the broker server (when the target workspace is the leader's own window)
 *
 * Kept free of MCP SDK / approval concerns so callers can wrap with whatever
 * policy they need.
 */

import pWaitFor from "p-wait-for"

import type { Controller } from "@/core/controller"
import { Logger } from "@/shared/services/Logger"

import { pendingOriginForNextInitTask } from "./originHook"

export type ToolReply = { content: Array<{ type: "text"; text: string }> }

export function reply(payload: unknown): ToolReply {
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify(payload ?? {}, null, 2),
			},
		],
	}
}

export class ToolError extends Error {
	constructor(
		public readonly code: string,
		public readonly extra: Record<string, unknown> = {},
	) {
		super(JSON.stringify({ error: code, ...extra }))
		this.name = "ToolError"
	}
}

function lastMessageAsk(controller: Controller): string | undefined {
	const task = controller.task
	if (!task) return undefined
	const msgs = task.messageStateHandler?.getClineMessages?.() ?? []
	return msgs[msgs.length - 1]?.ask
}

export interface StartTaskArgs {
	prompt: string
	images?: string[]
	files?: string[]
	clientName: string
}

export async function doStartTask(controller: Controller, args: StartTaskArgs): Promise<ToolReply> {
	pendingOriginForNextInitTask.set({ origin: "mcp", clientName: args.clientName })
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
		clientName: args.clientName,
	})
}

export interface SendMessageArgs {
	text: string
	images?: string[]
}

export async function doSendMessage(controller: Controller, args: SendMessageArgs): Promise<ToolReply> {
	const task = controller.task
	if (!task) throw new ToolError("no_active_task", { message: "No task is currently active. Call gllm_start_task first." })
	if (task.taskState.isStreaming) {
		throw new ToolError("task_busy", {
			message: "The task is currently streaming a response. Wait for it to finish or call gllm_cancel_task.",
		})
	}
	const ask = lastMessageAsk(controller)
	await task.handleWebviewAskResponse("messageResponse", args.text, args.images ?? [], [])
	return reply({ ok: true, taskId: task.taskId, matchedAsk: ask ?? null })
}

/**
 * Find the most recent assistant-visible reply body. Observed message
 * flow (gllm_get_messages probe, 2026-04-24): the model's answer is
 * emitted as `say: "completion_result"` with the body in `text`, then a
 * `say: "task_progress"` update, then a terminal `ask: "completion_result"`
 * whose `text` is empty (it's just the completion marker). Earlier turns
 * stream `say: "text"` deltas. Walk backwards, prefer whichever of those
 * surfaces a non-empty body.
 */
function extractAssistantReply(
	msgs: Array<{ ask?: string; say?: string; text?: string; reasoning?: string; ts: number }>,
): { text: string; ts: number } | undefined {
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i]
		const text = m.text
		if (typeof text !== "string" || text.trim().length === 0) continue
		if (m.say === "completion_result" || m.say === "text") {
			return { text, ts: m.ts }
		}
		if (m.ask === "completion_result") {
			return { text, ts: m.ts }
		}
	}
	return undefined
}

export function doGetStatus(controller: Controller | undefined): ToolReply {
	if (!controller) return reply({ hasTask: false, reason: "no_active_webview" })
	const task = controller.task
	if (!task) return reply({ hasTask: false })
	const msgs = task.messageStateHandler?.getClineMessages?.() ?? []
	const last = msgs[msgs.length - 1]
	const assistantReply = extractAssistantReply(msgs)
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
		assistantText: assistantReply?.text ?? null,
		assistantTextTs: assistantReply?.ts ?? null,
	})
}

export interface GetMessagesArgs {
	limit?: number
	/** When true, include reasoning deltas (thinking stream) in the output. */
	includeReasoning?: boolean
}

export function doGetMessages(controller: Controller, args: GetMessagesArgs): ToolReply {
	const task = controller.task
	if (!task) return reply({ hasTask: false })
	const msgs = task.messageStateHandler?.getClineMessages?.() ?? []
	const filtered = msgs.filter((m) => {
		if (m.say === "reasoning" && !args.includeReasoning) return false
		// Skip internal API chatter that would swamp the reply; keep user/
		// assistant visible message types only by default.
		if (m.say === "api_req_started" || m.say === "api_req_finished") return false
		return true
	})
	const limit = Math.max(1, Math.min(args.limit ?? 50, 500))
	const tail = filtered.slice(-limit)
	return reply({
		hasTask: true,
		taskId: task.taskId,
		totalCount: filtered.length,
		returned: tail.length,
		messages: tail.map((m) => ({
			ts: m.ts,
			type: m.type,
			ask: m.ask ?? null,
			say: m.say ?? null,
			text: m.text ?? null,
			reasoning: m.reasoning ?? null,
		})),
	})
}

export async function doWaitForCompletion(controller: Controller, timeoutMs?: number): Promise<ToolReply> {
	try {
		await pWaitFor(
			() => {
				const t = controller.task
				return !t || !t.taskState.isStreaming
			},
			{ interval: 500, timeout: timeoutMs ?? 60_000 },
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
}

export interface ListTasksArgs {
	limit?: number
	favoritesOnly?: boolean
}

export function doListTasks(controller: Controller, args: ListTasksArgs): ToolReply {
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
}

export async function doCancelTask(controller: Controller): Promise<ToolReply> {
	if (!controller.task) return reply({ ok: true, hadTask: false })
	try {
		await controller.cancelTask()
	} catch (err) {
		Logger.warn(`[McpHost] cancelTask failed: ${String(err)}`)
	}
	return reply({ ok: true, hadTask: true })
}
