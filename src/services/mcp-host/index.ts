/**
 * Public entry point for the MCP host feature.
 *
 * Every VS Code window always runs a small per-window MCP server (internal
 * forwarding backend). Additionally, the first window to start also runs
 * the *broker* — a single HTTP+MCP server on a stable port+token that
 * external MCP clients connect to. The broker routes tool calls to the
 * right window based on workspace.
 *
 * If the broker-owning window closes, the lock file disappears and the
 * remaining windows race to claim leadership via a periodic poll.
 */
import type { ExtensionContext } from "vscode"

import { StateManager } from "@/core/storage/StateManager"
import { WebviewProvider } from "@/core/webview"
import { HostProvider } from "@/hosts/host-provider"
import { Logger } from "@/shared/services/Logger"

import { type RunningBroker, startBroker } from "./broker"
import { loadOrCreateCreds } from "./brokerCreds"
import { probe, readLock, releaseLock } from "./brokerElection"
import { RunningMcpHost, startMcpHostServer } from "./McpHostServer"
import { touchFocus } from "./registry"

let currentWindow: RunningMcpHost | undefined
let currentBroker: RunningBroker | undefined
let leaderRetryTimer: NodeJS.Timeout | undefined
let cachedContext: ExtensionContext | undefined

const LEADER_POLL_MS = 5_000

export interface BrokerInfoSnapshot {
	port: number
	token: string
	leaderWindowId: string
}

/**
 * Cached view of "where is the current broker?". Refreshed every poll tick
 * and whenever this window starts/stops its own broker. `peekBrokerInfo()`
 * is a cheap, sync read used by `Controller.getStateToPostToWebview()`.
 */
let cachedBrokerInfo: BrokerInfoSnapshot | undefined

export function peekBrokerInfo(): BrokerInfoSnapshot | undefined {
	return cachedBrokerInfo
}

async function refreshCachedBrokerInfo(): Promise<void> {
	// If we are the leader, trust the in-process object.
	if (currentBroker) {
		const creds = await loadOrCreateCreds()
		cachedBrokerInfo = {
			port: currentBroker.port,
			token: creds.token,
			leaderWindowId: currentWindow?.entry.windowId ?? "",
		}
		return
	}
	const info = await readLock()
	if (!info) {
		cachedBrokerInfo = undefined
		return
	}
	const creds = await loadOrCreateCreds()
	cachedBrokerInfo = {
		port: info.port,
		token: creds.token,
		leaderWindowId: info.leaderWindowId,
	}
}

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
		return { enabled: false, requireApproval: true }
	}
}

function getRequireApproval(): boolean {
	return tryReadSettings().requireApproval
}

function extensionVersion(): string {
	return cachedContext?.extension?.packageJSON?.version ?? "0.0.0"
}

async function startWindowServer(): Promise<void> {
	if (currentWindow) return
	try {
		currentWindow = await startMcpHostServer({
			workspaceRoot: await currentWorkspaceRoot(),
			version: extensionVersion(),
			getRequireApproval,
		})
	} catch (err) {
		Logger.error(`[McpHost] window server failed to start: ${String(err)}`)
	}
}

async function stopWindowServer(): Promise<void> {
	if (!currentWindow) return
	const running = currentWindow
	currentWindow = undefined
	try {
		await running.stop()
	} catch (err) {
		Logger.warn(`[McpHost] window stop failed: ${String(err)}`)
	}
}

async function attemptBrokerClaim(): Promise<void> {
	if (currentBroker) return
	if (!currentWindow) return // leader must have a local per-window entry

	const state = await probe()
	if (state.state === "alive") return

	const creds = await loadOrCreateCreds()
	try {
		currentBroker = await startBroker({
			creds,
			leaderWindowId: currentWindow.entry.windowId,
			version: extensionVersion(),
			getRequireApproval,
		})
	} catch (err) {
		if (String(err).includes("broker_claim_lost_race")) {
			// Lost the race — another window just grabbed it. Silently continue as follower.
			return
		}
		Logger.warn(`[McpHost] broker start failed: ${String(err)}`)
	}
}

function startLeaderRetryTimer(): void {
	if (leaderRetryTimer) return
	leaderRetryTimer = setInterval(() => {
		// Refresh the cached broker info every tick so followers pick up a
		// newly-elected leader (or notice the broker dying) without needing
		// a webview reload.
		refreshCachedBrokerInfo().catch(() => {})
		// Only followers need to retry; if we're broker, nothing to do.
		if (currentBroker) return
		attemptBrokerClaim().catch((err) => Logger.warn(`[McpHost] leader retry error: ${String(err)}`))
	}, LEADER_POLL_MS)
	// Don't keep the Node event loop alive solely for this.
	leaderRetryTimer.unref?.()
}

function stopLeaderRetryTimer(): void {
	if (leaderRetryTimer) {
		clearInterval(leaderRetryTimer)
		leaderRetryTimer = undefined
	}
}

async function stopBrokerServer(): Promise<void> {
	if (!currentBroker) return
	const running = currentBroker
	currentBroker = undefined
	try {
		await running.stop()
	} catch (err) {
		Logger.warn(`[McpHost] broker stop failed: ${String(err)}`)
	}
}

export async function bootstrapMcpHost(context: ExtensionContext): Promise<void> {
	cachedContext = context

	// Wait until the WebviewProvider (which initializes StateManager) is ready.
	const deadline = Date.now() + 10_000
	while (Date.now() < deadline) {
		try {
			WebviewProvider.getInstance()
			break
		} catch {
			await new Promise((r) => setTimeout(r, 300))
		}
	}

	await reconcileMcpHostFromSettings()
}

export async function reconcileMcpHostFromSettings(): Promise<void> {
	const { enabled } = tryReadSettings()
	if (enabled) {
		await startWindowServer()
		await attemptBrokerClaim()
		await refreshCachedBrokerInfo()
		startLeaderRetryTimer()
	} else {
		stopLeaderRetryTimer()
		await stopBrokerServer()
		await stopWindowServer()
		cachedBrokerInfo = undefined
	}
}

export async function stopMcpHost(): Promise<void> {
	stopLeaderRetryTimer()
	await stopBrokerServer()
	await stopWindowServer()
	// Extra safety: if we crashed before releasing, no-op.
	if (currentWindow) {
		await releaseLock(currentWindow.entry.windowId).catch(() => {})
	}
}

export function getRunningMcpHost(): RunningMcpHost | undefined {
	return currentWindow
}

export function getRunningBroker(): RunningBroker | undefined {
	return currentBroker
}

/**
 * Called by extension.ts when this VS Code window gains focus. Updates
 * `lastFocusedAt` in the shared registry so the broker's default target
 * selection (when the caller omits `workspace`) picks the window the user
 * just interacted with.
 */
export async function notifyWindowFocused(): Promise<void> {
	if (!currentWindow) return
	await touchFocus(currentWindow.entry.windowId).catch((err) => Logger.warn(`[McpHost] touchFocus failed: ${String(err)}`))
}
