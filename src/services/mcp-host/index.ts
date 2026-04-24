/**
 * Public entry point for the MCP host feature. Kept intentionally small so
 * that `src/extension.ts` can start/stop the server without pulling the
 * implementation details.
 */
import * as vscode from "vscode"

import { HostProvider } from "@/hosts/host-provider"
import { Logger } from "@/shared/services/Logger"

import { RunningMcpHost, startMcpHostServer } from "./McpHostServer"

let current: RunningMcpHost | undefined

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

function isEnabled(): boolean {
	return vscode.workspace.getConfiguration("claudeCode").get<boolean>("mcpHost.enabled", false)
}

function getRequireApproval(): boolean {
	return vscode.workspace.getConfiguration("claudeCode").get<boolean>("mcpHost.requireApproval", true)
}

export async function startMcpHostIfEnabled(context: vscode.ExtensionContext): Promise<void> {
	if (!isEnabled()) return
	if (current) return
	try {
		current = await startMcpHostServer({
			workspaceRoot: await currentWorkspaceRoot(),
			version: context.extension.packageJSON.version,
			getRequireApproval,
		})
	} catch (err) {
		Logger.error(`[McpHost] failed to start: ${String(err)}`)
	}
}

export async function stopMcpHost(): Promise<void> {
	if (!current) return
	const running = current
	current = undefined
	try {
		await running.stop()
	} catch (err) {
		Logger.warn(`[McpHost] stop failed: ${String(err)}`)
	}
}

export function getRunningMcpHost(): RunningMcpHost | undefined {
	return current
}
