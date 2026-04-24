/**
 * Tool-call forwarding between MCP hosts.
 *
 * `ForwardFn` is what every registered tool calls with the raw client
 * args. Two implementations exist:
 *
 *  - `localForwarder`: used by the per-window MCP server. Runs every tool
 *    on the local Controller — matches the pre-broker behaviour.
 *
 *  - `brokerForwarder`: used by the broker. Resolves the target workspace
 *    (explicit `workspace` arg or most-recently-focused window from the
 *    registry), then either runs locally (leader == target) or HTTP-posts
 *    to the target window's `/internal/run-tool` endpoint.
 *
 * Network calls go through `@/shared/net`'s proxy-aware fetch per repo
 * guidelines (127.0.0.1 traffic is effectively unaffected, but we stay
 * consistent with the rest of the code base).
 */

import { fetch } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"

import { list as listRegistry, type RegistryEntry } from "./registry"
import { dispatchToolLocal } from "./toolDispatch"
import { type ToolReply } from "./toolImpl"

export interface ForwardRequest {
	name: string
	args: Record<string, unknown>
	clientName: string
	workspace?: string
}

export type ForwardFn = (req: ForwardRequest) => Promise<ToolReply>

export const localForwarder: ForwardFn = (req) =>
	dispatchToolLocal({ name: req.name, args: req.args, clientName: req.clientName })

/**
 * Resolve a registry entry for the given workspace hint.
 *
 * - If `workspace` is provided, exact match wins; otherwise fall back to
 *   suffix match (so the user can pass the basename instead of the full
 *   absolute path).
 * - If `workspace` is omitted, return the entry with the most recent
 *   `lastFocusedAt`. Ties are broken by `startedAt`.
 */
export async function resolveTarget(workspace: string | undefined): Promise<RegistryEntry | undefined> {
	const entries = await listRegistry()
	if (entries.length === 0) return undefined
	if (workspace) {
		const exact = entries.find((e) => e.workspaceRoot === workspace)
		if (exact) return exact
		const suffix = entries.find((e) => e.workspaceRoot.endsWith(workspace))
		if (suffix) return suffix
		return undefined
	}
	return [...entries].sort((a, b) => {
		const ta = a.lastFocusedAt ?? a.startedAt
		const tb = b.lastFocusedAt ?? b.startedAt
		return tb.localeCompare(ta)
	})[0]
}

export interface BrokerForwardOptions {
	/** The windowId of the leader (== this process). Target == leader runs in-process. */
	leaderWindowId: string
}

export function makeBrokerForwarder(opts: BrokerForwardOptions): ForwardFn {
	return async (req) => {
		const target = await resolveTarget(req.workspace)
		if (!target) {
			// No active gllm window at all. Start a local one (open sidebar).
			return dispatchToolLocal({ name: req.name, args: req.args, clientName: req.clientName })
		}
		if (target.windowId === opts.leaderWindowId) {
			return dispatchToolLocal({ name: req.name, args: req.args, clientName: req.clientName })
		}
		return forwardOverHttp(target, req)
	}
}

async function forwardOverHttp(target: RegistryEntry, req: ForwardRequest): Promise<ToolReply> {
	const url = `http://127.0.0.1:${target.port}/internal/run-tool`
	const body = JSON.stringify({ name: req.name, args: req.args, clientName: req.clientName })
	let res: Response
	try {
		res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${target.token}`,
			},
			body,
		})
	} catch (err) {
		Logger.warn(`[McpBroker] forward to ${target.windowId} failed: ${String(err)}`)
		throw new Error(
			JSON.stringify({
				error: "forward_failed",
				workspace: target.workspaceRoot,
				windowId: target.windowId,
				message: String(err),
			}),
		)
	}
	if (res.status === 401) {
		throw new Error(
			JSON.stringify({
				error: "forward_unauthorized",
				workspace: target.workspaceRoot,
				message: "Per-window token mismatch — registry.json may be stale.",
			}),
		)
	}
	const text = await res.text()
	if (!res.ok) {
		// Dispatcher serialised a ToolError as JSON in the body.
		try {
			const parsed = JSON.parse(text)
			throw new Error(JSON.stringify(parsed))
		} catch {
			throw new Error(text || `HTTP ${res.status}`)
		}
	}
	try {
		return JSON.parse(text) as ToolReply
	} catch (err) {
		throw new Error(`forward_malformed_reply: ${String(err)}`)
	}
}
