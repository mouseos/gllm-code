import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { Check, Copy, RefreshCw } from "lucide-react"
import React, { useCallback, useMemo, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient } from "@/services/grpc-client"
import Section from "../Section"

const Toggle: React.FC<{
	label: string
	description?: string
	checked: boolean
	onChange: (v: boolean) => void
}> = ({ label, description, checked, onChange }) => (
	<label className="flex items-start gap-3 py-2 cursor-pointer select-none">
		<input
			checked={checked}
			className="mt-1 size-4 cursor-pointer accent-[var(--color-claude-clay)]"
			onChange={(e) => onChange(e.target.checked)}
			type="checkbox"
		/>
		<span className="flex-1 min-w-0">
			<span className="block text-sm text-foreground">{label}</span>
			{description && <span className="block text-xs text-description mt-0.5">{description}</span>}
		</span>
	</label>
)

const CopyButton: React.FC<{ value: string; label?: string }> = ({ value, label = "Copy" }) => {
	const [copied, setCopied] = useState(false)
	return (
		<button
			className="inline-flex items-center gap-1 text-xs text-description hover:text-foreground transition-colors px-1.5 py-0.5 rounded-xs border border-input-border/50"
			onClick={() => {
				void navigator.clipboard.writeText(value)
				setCopied(true)
				setTimeout(() => setCopied(false), 1500)
			}}
			type="button">
			{copied ? <Check className="size-3" /> : <Copy className="size-3" />}
			{copied ? "Copied" : label}
		</button>
	)
}

export default function McpServerSettingsSection({
	renderSectionHeader,
}: {
	renderSectionHeader: (id: string) => React.ReactNode
}) {
	const { mcpServerEnabled, mcpServerRequireApproval, mcpServerStatus } = useExtensionState()

	const setFlag = useCallback(async (partial: Partial<UpdateSettingsRequest>) => {
		try {
			await StateServiceClient.updateSettings(UpdateSettingsRequest.create({ metadata: {}, ...partial }))
		} catch (err) {
			console.error("[McpServerSettings] updateSettings failed", err)
		}
	}, [])

	const running = !!mcpServerStatus?.running
	const connectUrl = running && mcpServerStatus?.port ? `http://127.0.0.1:${mcpServerStatus.port}/mcp` : ""
	const token = running ? (mcpServerStatus?.token ?? "") : ""
	const maskedToken = token ? `${token.slice(0, 6)}…${token.slice(-4)}` : ""

	const connectCommand = useMemo(() => {
		if (!running || !connectUrl) return ""
		return [
			"claude mcp add gllm-code \\",
			"  --transport http \\",
			`  --url ${connectUrl} \\`,
			`  --header "Authorization: Bearer ${token}"`,
		].join("\n")
	}, [running, connectUrl, token])

	return (
		<div>
			{renderSectionHeader("mcp-server")}
			<Section>
				<div className="space-y-3">
					<p className="text-sm text-description leading-relaxed">
						Expose this GLLM Code instance as a local MCP server so any MCP client (Claude Code, Claude Desktop,
						Codex, custom scripts, …) can start and continue tasks. Bound to <code>127.0.0.1</code> with a Bearer
						token.
					</p>

					<div className="border border-input-border rounded-md p-3 space-y-1">
						<Toggle
							checked={!!mcpServerEnabled}
							description="Starts/stops the server immediately — no window reload required."
							label="Enable MCP server"
							onChange={(v) => setFlag({ mcpServerEnabled: v })}
						/>
						<Toggle
							checked={!!mcpServerRequireApproval}
							description="Show a one-time modal the first time each new MCP client tries to start a task or read history."
							label="Require approval for new clients"
							onChange={(v) => setFlag({ mcpServerRequireApproval: v })}
						/>
					</div>

					<div className="border border-input-border rounded-md p-3">
						<div className="flex items-center justify-between mb-2">
							<span className="text-xs uppercase tracking-wider text-description font-semibold">Status</span>
							<span
								className={
									running
										? "text-[11px] px-2 py-0.5 rounded-full bg-[var(--color-claude-clay)]/20 text-[var(--color-claude-orange)] font-semibold"
										: "text-[11px] px-2 py-0.5 rounded-full bg-description/20 text-description"
								}>
								{running ? "Running" : "Stopped"}
							</span>
						</div>
						{running ? (
							<div className="space-y-2 text-xs">
								<div className="flex items-center justify-between gap-2">
									<span className="text-description">Endpoint</span>
									<span className="flex items-center gap-2 font-mono">
										<span>{connectUrl}</span>
										<CopyButton value={connectUrl} />
									</span>
								</div>
								<div className="flex items-center justify-between gap-2">
									<span className="text-description">Token</span>
									<span className="flex items-center gap-2 font-mono">
										<span>{maskedToken}</span>
										<CopyButton label="Copy token" value={token} />
									</span>
								</div>
								<div className="flex items-center justify-between gap-2">
									<span className="text-description">Workspace</span>
									<span className="font-mono text-description truncate max-w-[60%]">
										{mcpServerStatus?.workspaceRoot ?? "—"}
									</span>
								</div>
								<div className="pt-2 border-t border-input-border/40">
									<div className="text-description mb-1">Connect from Claude Code:</div>
									<pre className="text-[11px] bg-code/40 rounded-xs p-2 overflow-x-auto">{connectCommand}</pre>
									<div className="pt-1 flex justify-end">
										<CopyButton label="Copy command" value={connectCommand} />
									</div>
								</div>
							</div>
						) : (
							<div className="text-xs text-description">
								The server is not running. Toggle <em>Enable MCP server</em> above to start it.
							</div>
						)}
					</div>

					<div className="text-[11px] text-description leading-relaxed">
						<RefreshCw aria-hidden className="size-3 inline mr-1" />
						The port is assigned at start-up and persists for the lifetime of this window. Approval decisions are
						saved per client name in global state and are currently permanent — to reset them, clear them manually
						from the extension state.
					</div>
				</div>
			</Section>
		</div>
	)
}
