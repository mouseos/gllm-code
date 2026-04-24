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

const CopyButton: React.FC<{ value: string; label?: string }> = ({ value, label = "コピー" }) => {
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
			{copied ? "コピーしました" : label}
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
	const broker = mcpServerStatus?.broker
	const brokerRunning = !!broker
	const connectUrl = broker ? `http://127.0.0.1:${broker.port}/mcp` : ""
	const token = broker?.token ?? ""
	const maskedToken = token ? `${token.slice(0, 6)}…${token.slice(-4)}` : ""
	const isBroker = !!mcpServerStatus?.isBroker

	const connectCommand = useMemo(() => {
		if (!brokerRunning || !connectUrl) return ""
		// Claude Code ≥ 2.x: `claude mcp add [options] <name> <url> [args...]`
		// and `--header` is variadic — placing it BEFORE the positional name
		// makes the parser swallow the name as another header value and fail
		// with "missing required argument 'name'". So flags go at the end.
		return [`claude mcp add --transport http gllm-code ${connectUrl} \\`, `  --header "Authorization: Bearer ${token}"`].join(
			"\n",
		)
	}, [brokerRunning, connectUrl, token])

	return (
		<div>
			{renderSectionHeader("mcp-server")}
			<Section>
				<div className="space-y-3">
					<p className="text-sm text-description leading-relaxed">
						この GLLM Code インスタンスをローカルの MCP サーバーとして公開します。Claude Code、Claude
						Desktop、Codex、独自スクリプトなど任意の MCP
						クライアントからタスクを開始・継続できます。最初に起動したウィンドウが固定 URL+token の broker
						として動き、以降のウィンドウは転送用 backend になります。<code>claude mcp add</code> で broker URL を 1
						度だけ登録すれば、リロードやワークスペース切替え後もそのまま使えます。
					</p>

					<div className="border border-input-border rounded-md p-3 space-y-1">
						<Toggle
							checked={!!mcpServerEnabled}
							description="ウィンドウリロード不要。切り替えた瞬間にサーバーを起動／停止します。"
							label="MCP サーバーを有効化"
							onChange={(v) => setFlag({ mcpServerEnabled: v })}
						/>
						<Toggle
							checked={!!mcpServerRequireApproval}
							description="新しい MCP クライアントが初めてタスクを開始または履歴を読もうとしたとき、1 度だけ確認モーダルを表示します。"
							label="新規クライアントに承認を要求"
							onChange={(v) => setFlag({ mcpServerRequireApproval: v })}
						/>
					</div>

					<div className="border border-input-border rounded-md p-3">
						<div className="flex items-center justify-between mb-2">
							<span className="text-xs uppercase tracking-wider text-description font-semibold">状態</span>
							<span className="flex items-center gap-1.5">
								{running && (
									<span className="text-[10px] px-1.5 py-0.5 rounded-full border border-input-border/60 text-description">
										{isBroker ? "このウィンドウが broker" : "follower"}
									</span>
								)}
								<span
									className={
										brokerRunning
											? "text-[11px] px-2 py-0.5 rounded-full bg-[var(--color-claude-clay)]/20 text-[var(--color-claude-orange)] font-semibold"
											: "text-[11px] px-2 py-0.5 rounded-full bg-description/20 text-description"
									}>
									{brokerRunning ? "Broker 稼働中" : running ? "Follower のみ" : "停止中"}
								</span>
							</span>
						</div>
						{brokerRunning ? (
							<div className="space-y-2 text-xs">
								<div className="flex items-center justify-between gap-2">
									<span className="text-description">エンドポイント</span>
									<span className="flex items-center gap-2 font-mono">
										<span>{connectUrl}</span>
										<CopyButton value={connectUrl} />
									</span>
								</div>
								<div className="flex items-center justify-between gap-2">
									<span className="text-description">トークン</span>
									<span className="flex items-center gap-2 font-mono">
										<span>{maskedToken}</span>
										<CopyButton label="トークンをコピー" value={token} />
									</span>
								</div>
								<div className="flex items-center justify-between gap-2">
									<span className="text-description">ワークスペース</span>
									<span className="font-mono text-description truncate max-w-[60%]">
										{mcpServerStatus?.workspaceRoot ?? "—"}
									</span>
								</div>
								<div className="pt-2 border-t border-input-border/40">
									<div className="text-description mb-1">Claude Code からの接続コマンド:</div>
									<pre className="text-[11px] bg-code/40 rounded-xs p-2 overflow-x-auto">{connectCommand}</pre>
									<div className="pt-1 flex justify-end">
										<CopyButton label="コマンドをコピー" value={connectCommand} />
									</div>
								</div>
								<div className="pt-1 text-description text-[10px] leading-relaxed">
									特定のワークスペースへ向けたい場合は、ツール引数に{" "}
									<code>workspace: "/abs/path/to/project"</code>{" "}
									を指定してください。省略時は、直近にフォーカスされた GLLM ウィンドウへ broker
									がルーティングします。
								</div>
							</div>
						) : running ? (
							<div className="text-xs text-description">
								このウィンドウは転送 backend として動作中です (別の GLLM ウィンドウが broker を保持)。broker
								ウィンドウを閉じるか、数秒待つと自動でリーダー切替が起きます。
							</div>
						) : (
							<div className="text-xs text-description">
								サーバーは停止中です。上の <em>MCP サーバーを有効化</em> をオンにすると起動します。
							</div>
						)}
					</div>

					<div className="text-[11px] text-description leading-relaxed">
						<RefreshCw aria-hidden className="size-3 inline mr-1" />
						broker の URL と token は <code>~/.gllm-code/mcp/broker-creds.json</code> に保存され、再起動後も
						再利用されます。<code>claude mcp add</code> は 1 回だけで OK です。承認結果はクライアント名ごとに global
						state に保存されます — 取り消すにはエントリーを手動で削除してください。
					</div>
				</div>
			</Section>
		</div>
	)
}
