/**
 * Public entry point for the MCP host feature. Kept intentionally small so
 * that `src/extension.ts` can start/stop the server without pulling the
 * implementation details.
 *
 * The feature toggle + approval requirement now live in gllm-code's own
 * Settings view (Settings > MCP Server) rather than VS Code's
 * settings.json. Runtime changes call `reconcileMcpHostFromSettings()` so
 * the server starts or stops in place, no window reload needed.
 */
import type { ExtensionContext } from "vscode"

import { StateManager } from "@/core/storage/StateManager"
import { WebviewProvider } from "@/core/webview"
import { HostProvider } from "@/hosts/host-provider"
import { Logger } from "@/shared/services/Logger"

import { RunningMcpHost, startMcpHostServer } from "./McpHostServer"

let current: RunningMcpHost | undefined
let cachedContext: ExtensionContext | undefined

async function currentWorkspaceRoot(): Promise<string> {
	try {
		const { paths } = await HostProvider.workspace.getWorkspacePaths({})
		if (paths && paths.length > 0 && paths[0]) {
			return paths[0]
		}
	} catch (err) {
		Logger.warn(`[McpHost] getWorkspacePaths failed, falling back: ${String(err)}`)
	}
	return "(no-workspace)"
}

function tryReadSettings(): { enabled: boolean; requireApproval: boolean } {
	try {
		const sm = StateManager.get()
		return {
			enabled: sm.getGlobalSettingsKey("mcpServerEnabled"),
			requireApproval: sm.getGlobalSettingsKey("mcpServerRequireApproval"),
		}
	} catch {
		// StateManager may not be initialized yet during early activation.
		return { enabled: false, requireApproval: true }
	}
}

function getRequireApproval(): boolean {
	return tryReadSettings().requireApproval
}

async function startServerNow(): Promise<void> {
	if (current) return
	try {
		current = await startMcpHostServer({
			workspaceRoot: await currentWorkspaceRoot(),
			version: cachedContext?.extension?.packageJSON?.version,
			getRequireApproval,
		})
	} catch (err) {
		Logger.error(`[McpHost] failed to start: ${String(err)}`)
	}
}

async function stopServerNow(): Promise<void> {
	if (!current) return
	const running = current
	current = undefined
	try {
		await running.stop()
	} catch (err) {
		Logger.warn(`[McpHost] stop failed: ${String(err)}`)
	}
}

/**
 * Called from extension activation. Captures the context so later settings
 * changes can resolve the extension version. Also kicks off the first
 * reconciliation once the webview / StateManager is ready.
 */
export async function bootstrapMcpHost(context: ExtensionContext): Promise<void> {
	cachedContext = context

	// Wait for StateManager to be up (it's populated during Controller
	// construction, which happens inside WebviewProvider creation). Poll
	// briefly; if the user never opens the sidebar, the server only starts
	// once they do — which is fine because the MCP tools need the
	// controller anyway.
	const deadline = Date.now() + 10_000
	while (Date.now() < deadline) {
		try {
			// Throws until a webview provider is registered.
			WebviewProvider.getInstance()
			break
		} catch {
			await new Promise((r) => setTimeout(r, 300))
		}
	}

	await reconcileMcpHostFromSettings()
}

/**
 * Called from settings updaters when mcpServerEnabled/requireApproval change.
 * Starts, stops, or leaves the server alone based on current settings.
 */
export async function reconcileMcpHostFromSettings(): Promise<void> {
	const { enabled } = tryReadSettings()
	if (enabled) {
		await startServerNow()
	} else {
		await stopServerNow()
	}
}

export async function stopMcpHost(): Promise<void> {
	await stopServerNow()
}

export function getRunningMcpHost(): RunningMcpHost | undefined {
	return current
}
