import type { Controller } from "@/core/controller"
import { WebviewProvider } from "@/core/webview"
import { HostProvider } from "@/hosts/host-provider"
import { Logger } from "@/shared/services/Logger"

/**
 * Returns the controller owned by the currently active webview, if any.
 * `WebviewProvider` is a singleton per extension host, so one lookup is enough.
 */
export function tryGetActiveController(): Controller | undefined {
	try {
		// getInstance() throws when no WebviewProvider has been registered yet
		// (sidebar closed without ever being opened). Treat that as "no
		// controller available" and let callers decide how to proceed.
		return WebviewProvider.getInstance().controller
	} catch {
		return undefined
	}
}

/**
 * Same as tryGetActiveController but opens the sidebar and waits briefly for
 * the provider to mount if no controller is currently available. Used by MCP
 * tools — clients should be able to spawn a task even when the sidebar has
 * been closed.
 */
export async function resolveActiveControllerOrOpen(timeoutMs = 5_000): Promise<Controller | undefined> {
	const existing = tryGetActiveController()
	if (existing) return existing

	// Focus/show the gllm-code sidebar via the host bridge.
	try {
		await HostProvider.workspace.openClineSidebarPanel({})
	} catch (err) {
		Logger.warn(`[McpHost] openClineSidebarPanel failed: ${String(err)}`)
	}

	const deadline = Date.now() + Math.max(100, timeoutMs)
	while (Date.now() < deadline) {
		const now = tryGetActiveController()
		if (now) return now
		await new Promise((r) => setTimeout(r, 150))
	}
	Logger.warn("[McpHost] timed out waiting for webview controller")
	return undefined
}
