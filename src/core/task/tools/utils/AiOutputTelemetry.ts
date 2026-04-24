import { GllmAccountManager } from "@/services/auth/gllm/GllmAccountManager"
import { telemetryService } from "@/services/telemetry"
import type { TaskConfig } from "../types/TaskConfig"
import { computeLineDiffStats } from "./lineDiffStats"

/**
 * Shared utility for emitting AI output telemetry from file editing tools.
 * Centralizes the logic for capturing accepted/rejected edits with proper source attribution.
 */

/**
 * Extracts provider and model information from task config for telemetry.
 * When a gllm account is the primary credential, `buildApiHandler` has
 * already overridden the effective provider to that account's provider —
 * reflect the same override here so telemetry and the system-prompt tool
 * converter agree on the backend that actually serves the request.
 */
export function getModelInfo(config: TaskConfig): { providerId: string; modelId: string } {
	const apiConfig = config.services.stateManager.getApiConfiguration()
	const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")
	const primaryGllmAccount = GllmAccountManager.getInstance().getPrimaryAccount()
	const rawProviderId = (currentMode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string
	const providerId = primaryGllmAccount?.provider ?? rawProviderId
	const modelId = config.api.getModel().id
	return { providerId, modelId }
}

/**
 * Captures telemetry when a file edit is accepted.
 * Computes line diff stats and emits event with proper source attribution.
 */
export function captureAccepted(args: {
	ulid: string
	tool: string
	source: "agent" | "human"
	beforeContent: string
	afterContent: string
	providerId: string
	modelId: string
	filesCreated?: number
	filesDeleted?: number
	filesMoved?: number
}): void {
	const diffStats = computeLineDiffStats(args.beforeContent, args.afterContent)
	telemetryService.captureAiOutputAccepted({
		ulid: args.ulid,
		tool: args.tool,
		provider: args.providerId,
		model: args.modelId,
		source: args.source,
		...diffStats,
		filesCreated: args.filesCreated,
		filesDeleted: args.filesDeleted,
		filesMoved: args.filesMoved,
	})
}

/**
 * Captures telemetry when a file edit is rejected.
 * Computes line diff stats and emits event with proper source attribution.
 */
export function captureRejected(args: {
	ulid: string
	tool: string
	source: "agent" | "human"
	beforeContent: string
	afterContent: string
	providerId: string
	modelId: string
	filesCreated?: number
	filesDeleted?: number
	filesMoved?: number
}): void {
	const diffStats = computeLineDiffStats(args.beforeContent, args.afterContent)
	telemetryService.captureAiOutputRejected({
		ulid: args.ulid,
		tool: args.tool,
		provider: args.providerId,
		model: args.modelId,
		source: args.source,
		...diffStats,
		filesCreated: args.filesCreated,
		filesDeleted: args.filesDeleted,
		filesMoved: args.filesMoved,
	})
}
