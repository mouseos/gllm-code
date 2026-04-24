import type { Controller } from "@/core/controller"
import type { StateManager } from "@/core/storage/StateManager"

export type ApprovalDecision = "allow" | "deny"

export interface ApprovalRecord {
	decision: ApprovalDecision
	ts: number
}

export type ApprovalMap = Record<string, ApprovalRecord>

/**
 * Thin wrapper around StateManager that persists first-time approval
 * decisions made by the user when an external MCP client connects. Deny is
 * permanent per user request; the only way to reset is editing the global
 * state or clearing it from a future settings UI.
 */
export class ApprovalStore {
	private readonly stateManager: StateManager

	constructor(stateManager: StateManager) {
		this.stateManager = stateManager
	}

	getDecision(clientName: string): ApprovalDecision | undefined {
		const map = this.readMap()
		return map[clientName]?.decision
	}

	async record(clientName: string, decision: ApprovalDecision): Promise<void> {
		const map = { ...this.readMap() }
		map[clientName] = { decision, ts: Date.now() }
		this.stateManager.setGlobalState("mcpHostApprovedClients", map)
		await this.stateManager.flushPendingState()
	}

	private readMap(): ApprovalMap {
		return this.stateManager.getGlobalStateKey("mcpHostApprovedClients") ?? {}
	}
}

/**
 * Resolve an ApprovalStore tied to the active controller's StateManager.
 * Returns undefined if the controller isn't ready yet; callers should treat
 * "no store" as "don't enforce approval" (matches the fail-open behaviour of
 * `claudeCode.mcpHost.requireApproval=false`).
 */
export function approvalStoreFor(controller: Controller | undefined): ApprovalStore | undefined {
	if (!controller?.stateManager) return undefined
	return new ApprovalStore(controller.stateManager)
}
