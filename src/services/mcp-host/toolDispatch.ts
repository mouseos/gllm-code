/**
 * Name-based dispatcher for MCP tools. Used by:
 *   - per-window `/internal/run-tool` endpoint (broker → window forwarding)
 *   - the broker itself when the target window is the leader
 *
 * The dispatcher does NOT run approval — callers decide that. It DOES
 * resolve the active Controller (opening the sidebar if needed for
 * start_task, but never for read-only tools).
 */

import type { Controller } from "@/core/controller"

import { resolveActiveControllerOrOpen, tryGetActiveController } from "./currentController"
import {
	doCancelTask,
	doGetMessages,
	doGetStatus,
	doListTasks,
	doSendMessage,
	doStartTask,
	doWaitForCompletion,
	reply,
	ToolError,
	type ToolReply,
} from "./toolImpl"

export interface DispatchArgs {
	name: string
	args: Record<string, unknown>
	/** Forwarded to origin-stamping / approval trail. */
	clientName: string
}

function needController(c: Controller | undefined): asserts c is Controller {
	if (!c) throw new ToolError("no_active_webview")
}

export async function dispatchToolLocal(d: DispatchArgs): Promise<ToolReply> {
	switch (d.name) {
		case "gllm_ping": {
			const has = !!tryGetActiveController()
			return reply({
				ok: true,
				echo: typeof d.args.message === "string" ? d.args.message : null,
				clientName: d.clientName,
				hasActiveController: has,
			})
		}

		case "gllm_start_task": {
			const controller = await resolveActiveControllerOrOpen(5_000)
			if (!controller) {
				throw new ToolError("no_active_webview", {
					message: "gllm-code sidebar is not available. Open the sidebar and retry.",
				})
			}
			return doStartTask(controller, {
				prompt: String(d.args.prompt ?? ""),
				images: Array.isArray(d.args.images) ? (d.args.images as string[]) : undefined,
				files: Array.isArray(d.args.files) ? (d.args.files as string[]) : undefined,
				clientName: d.clientName,
			})
		}

		case "gllm_send_message": {
			const controller = tryGetActiveController()
			needController(controller)
			return doSendMessage(controller, {
				text: String(d.args.text ?? ""),
				images: Array.isArray(d.args.images) ? (d.args.images as string[]) : undefined,
			})
		}

		case "gllm_get_status": {
			return doGetStatus(tryGetActiveController())
		}

		case "gllm_wait_for_completion": {
			const controller = tryGetActiveController()
			needController(controller)
			const timeoutMs = typeof d.args.timeoutMs === "number" ? d.args.timeoutMs : undefined
			return doWaitForCompletion(controller, timeoutMs)
		}

		case "gllm_get_messages": {
			const controller = tryGetActiveController()
			needController(controller)
			return doGetMessages(controller, {
				limit: typeof d.args.limit === "number" ? d.args.limit : undefined,
				includeReasoning: typeof d.args.includeReasoning === "boolean" ? d.args.includeReasoning : undefined,
			})
		}

		case "gllm_list_tasks": {
			const controller = tryGetActiveController()
			needController(controller)
			return doListTasks(controller, {
				limit: typeof d.args.limit === "number" ? d.args.limit : undefined,
				favoritesOnly: typeof d.args.favoritesOnly === "boolean" ? d.args.favoritesOnly : undefined,
			})
		}

		case "gllm_cancel_task": {
			const controller = tryGetActiveController()
			needController(controller)
			return doCancelTask(controller)
		}

		default:
			throw new ToolError("unknown_tool", { name: d.name })
	}
}
