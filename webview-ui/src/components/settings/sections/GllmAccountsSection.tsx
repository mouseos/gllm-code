import { EmptyRequest, StringRequest } from "@shared/proto/cline/common"
import {
	GllmReorderAccountsRequest,
	GllmUpdateModelRequest,
	GllmAccount as ProtoGllmAccount,
} from "@shared/proto/cline/gllm_account"
import { VSCodeButton, VSCodeDropdown, VSCodeOption, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import React, { useCallback, useEffect, useRef, useState } from "react"
import { GllmAccountServiceClient } from "../../../services/grpc-client"
import Section from "../Section"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GEMINI_FALLBACK_MODELS = [
	"auto pro",
	"auto flash",
	"auto",
	"gemini-2.5-pro",
	"gemini-2.5-flash",
	"gemini-2.5-flash-lite",
	"gemini-2.0-flash",
]
const GEMINI_CLI_MODELS = [
	"auto pro",
	"auto flash",
	"auto",
	"gemini-3.1-pro-preview",
	"gemini-3-pro-preview",
	"gemini-3-flash-preview",
	"gemini-2.5-pro",
	"gemini-2.5-flash",
	"gemini-2.5-flash-lite",
]
const GEMINI_CLI_FALLBACK_MODELS = [...GEMINI_CLI_MODELS]
const ANTIGRAVITY_FALLBACK_MODELS = [
	"auto pro",
	"auto flash",
	"auto",
	"gemini-3-pro-high",
	"gemini-3-pro-low",
	"gemini-3-flash",
	"gemini-2.5-pro",
	"gemini-2.5-flash",
]

type ProviderType = "gemini" | "gemini-cli" | "antigravity"

const PROVIDER_LABELS: Record<ProviderType, string> = {
	gemini: "Gemini API",
	"gemini-cli": "Gemini CLI",
	antigravity: "Antigravity",
}

const PROVIDER_COLORS: Record<ProviderType, string> = {
	gemini: "var(--vscode-terminal-ansiBlue)",
	"gemini-cli": "var(--vscode-terminal-ansiGreen)",
	antigravity: "var(--vscode-terminal-ansiMagenta)",
}

function uniqModels(models: Array<string | undefined | null>): string[] {
	return [...new Set(models.filter((model): model is string => !!model))]
}

function getProviderBadge(provider: string): string {
	if (provider === "antigravity") return "AN"
	if (provider === "gemini") return "AP"
	if (provider === "gemini-cli") return "CL"
	return provider.toUpperCase()
}

function getModelsForProvider(provider: string, account?: ProtoGllmAccount): string[] {
	if (provider === "gemini") {
		return uniqModels([
			...GEMINI_FALLBACK_MODELS.slice(0, 3),
			...(account?.availableModels ?? []),
			account?.model,
			...GEMINI_FALLBACK_MODELS.slice(3),
		])
	}
	if (provider === "gemini-cli") {
		return uniqModels([
			...GEMINI_CLI_FALLBACK_MODELS.slice(0, 3),
			...(account?.availableModels ?? []),
			account?.model,
			...GEMINI_CLI_FALLBACK_MODELS.slice(3),
		])
	}
	if (provider === "antigravity") {
		return uniqModels([
			...ANTIGRAVITY_FALLBACK_MODELS.slice(0, 3),
			...(account?.availableModels ?? []),
			account?.model,
			...ANTIGRAVITY_FALLBACK_MODELS.slice(3),
		])
	}
	return []
}

function providerLabel(provider: string): string {
	return PROVIDER_LABELS[provider as ProviderType] ?? provider
}

function providerColor(provider: string): string {
	return PROVIDER_COLORS[provider as ProviderType] ?? "var(--vscode-descriptionForeground)"
}

function isOAuthProvider(provider: string): boolean {
	return provider === "gemini-cli" || provider === "antigravity"
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface GllmAccountsSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

export const GllmAccountsSection: React.FC<GllmAccountsSectionProps> = ({ renderSectionHeader }) => {
	const [accounts, setAccounts] = useState<ProtoGllmAccount[]>([])
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const [isLoggingIn, setIsLoggingIn] = useState<string | null>(null)
	const [showAddMenu, setShowAddMenu] = useState(false)
	const [message, setMessage] = useState<{ text: string; success: boolean } | null>(null)
	const addMenuRef = useRef<HTMLDivElement>(null)

	// Auto-clear message after 8 seconds
	useEffect(() => {
		if (message) {
			const timer = setTimeout(() => setMessage(null), 8000)
			return () => clearTimeout(timer)
		}
	}, [message])

	// Close add-menu on outside click
	useEffect(() => {
		if (!showAddMenu) return
		const handler = (e: MouseEvent) => {
			if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
				setShowAddMenu(false)
			}
		}
		document.addEventListener("mousedown", handler)
		return () => document.removeEventListener("mousedown", handler)
	}, [showAddMenu])

	// Subscribe to account list
	useEffect(() => {
		const unsubscribe = GllmAccountServiceClient.gllmSubscribeToAccounts(EmptyRequest.create({}), {
			onResponse: (list) => setAccounts(list.accounts ?? []),
			onError: (err) => console.error("gllmSubscribeToAccounts error:", err),
			onComplete: () => {},
		})
		return unsubscribe
	}, [])

	const selectedAccount = accounts.find((a) => a.id === selectedId) ?? null

	// -----------------------------------------------------------------------
	// Handlers
	// -----------------------------------------------------------------------

	const handleAddAccount = useCallback(async (provider: ProviderType) => {
		setShowAddMenu(false)
		if (isOAuthProvider(provider)) {
			setIsLoggingIn(provider)
			try {
				await GllmAccountServiceClient.gllmLoginClicked(StringRequest.create({ value: provider }))
			} catch (err: any) {
				setMessage({ text: `ログイン失敗: ${err?.message ?? String(err)}`, success: false })
			} finally {
				setIsLoggingIn(null)
			}
		} else {
			// gemini (API key) - trigger login which creates a blank account on backend
			setIsLoggingIn(provider)
			try {
				await GllmAccountServiceClient.gllmLoginClicked(StringRequest.create({ value: provider }))
			} catch (err: any) {
				setMessage({ text: `追加失敗: ${err?.message ?? String(err)}`, success: false })
			} finally {
				setIsLoggingIn(null)
			}
		}
	}, [])

	const handleRemove = useCallback(
		async (id: string) => {
			try {
				await GllmAccountServiceClient.gllmRemoveAccount(StringRequest.create({ value: id }))
				if (selectedId === id) setSelectedId(null)
			} catch (err: any) {
				setMessage({ text: `削除失敗: ${err?.message ?? String(err)}`, success: false })
			}
		},
		[selectedId],
	)

	const handleModelChange = useCallback(async (accountId: string, model: string) => {
		try {
			await GllmAccountServiceClient.gllmUpdateAccountModel(GllmUpdateModelRequest.create({ accountId, model }))
		} catch (err: any) {
			setMessage({ text: `モデル更新失敗: ${err?.message ?? String(err)}`, success: false })
		}
	}, [])

	const handleApiKeyChange = useCallback(async (accountId: string, apiKey: string) => {
		try {
			await GllmAccountServiceClient.gllmUpdateAccountApiKey(GllmUpdateModelRequest.create({ accountId, model: apiKey }))
		} catch (err: any) {
			setMessage({ text: `API キー更新失敗: ${err?.message ?? String(err)}`, success: false })
		}
	}, [])

	const handleSetMain = useCallback(async (id: string) => {
		try {
			await GllmAccountServiceClient.gllmSetMainAccount(StringRequest.create({ value: id }))
		} catch (err: any) {
			setMessage({ text: `メイン設定失敗: ${err?.message ?? String(err)}`, success: false })
		}
	}, [])

	const handleMoveUp = useCallback(
		async (index: number) => {
			if (index <= 0) return
			const newAccounts = [...accounts]
			;[newAccounts[index - 1], newAccounts[index]] = [newAccounts[index], newAccounts[index - 1]]
			setAccounts(newAccounts)
			try {
				await GllmAccountServiceClient.gllmReorderAccounts(
					GllmReorderAccountsRequest.create({ accountIds: newAccounts.map((account) => account.id) }),
				)
			} catch (err: any) {
				setMessage({ text: `並び替え失敗: ${err?.message ?? String(err)}`, success: false })
			}
		},
		[accounts],
	)

	const handleMoveDown = useCallback(
		async (index: number) => {
			if (index >= accounts.length - 1) return
			const newAccounts = [...accounts]
			;[newAccounts[index], newAccounts[index + 1]] = [newAccounts[index + 1], newAccounts[index]]
			setAccounts(newAccounts)
			try {
				await GllmAccountServiceClient.gllmReorderAccounts(
					GllmReorderAccountsRequest.create({ accountIds: newAccounts.map((account) => account.id) }),
				)
			} catch (err: any) {
				setMessage({ text: `並び替え失敗: ${err?.message ?? String(err)}`, success: false })
			}
		},
		[accounts],
	)

	const handleOAuthLogin = useCallback(async (provider: string) => {
		setIsLoggingIn(provider)
		try {
			await GllmAccountServiceClient.gllmLoginClicked(StringRequest.create({ value: provider }))
		} catch (err: any) {
			setMessage({ text: `ログイン失敗: ${err?.message ?? String(err)}`, success: false })
		} finally {
			setIsLoggingIn(null)
		}
	}, [])

	// -----------------------------------------------------------------------
	// Render
	// -----------------------------------------------------------------------

	return (
		<div>
			{renderSectionHeader("gllm-accounts")}
			<Section>
				<div id="gllm-accounts-section">
					{/* ---- Header ---- */}
					<div
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							marginBottom: 8,
						}}>
						<span style={{ fontSize: 13, fontWeight: 600 }}>アカウント</span>
						<div ref={addMenuRef} style={{ position: "relative" }}>
							<VSCodeButton
								appearance="icon"
								disabled={isLoggingIn !== null}
								onClick={() => setShowAddMenu((v) => !v)}
								title="アカウントを追加">
								<span className="codicon codicon-add" />
							</VSCodeButton>
							{showAddMenu && (
								<div
									style={{
										position: "absolute",
										right: 0,
										top: "100%",
										zIndex: 100,
										minWidth: 180,
										backgroundColor: "var(--vscode-menu-background)",
										border: "1px solid var(--vscode-menu-border, var(--vscode-panel-border))",
										borderRadius: 4,
										boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
										overflow: "hidden",
									}}>
									{(["gemini", "gemini-cli", "antigravity"] as ProviderType[]).map((p) => (
										<div
											key={p}
											onClick={() => handleAddAccount(p)}
											onMouseEnter={(e) => {
												;(e.currentTarget as HTMLDivElement).style.backgroundColor =
													"var(--vscode-menu-selectionBackground)"
												;(e.currentTarget as HTMLDivElement).style.color =
													"var(--vscode-menu-selectionForeground)"
											}}
											onMouseLeave={(e) => {
												;(e.currentTarget as HTMLDivElement).style.backgroundColor = "transparent"
												;(e.currentTarget as HTMLDivElement).style.color = "var(--vscode-menu-foreground)"
											}}
											style={{
												padding: "6px 12px",
												fontSize: 12,
												cursor: "pointer",
												color: "var(--vscode-menu-foreground)",
												display: "flex",
												alignItems: "center",
												gap: 8,
											}}>
											<span
												style={{
													width: 8,
													height: 8,
													borderRadius: "50%",
													backgroundColor: providerColor(p),
													flexShrink: 0,
												}}
											/>
											{providerLabel(p)}
										</div>
									))}
								</div>
							)}
						</div>
					</div>

					{/* ---- Description ---- */}
					<p style={{ fontSize: 11, color: "var(--vscode-descriptionForeground)", margin: "0 0 8px 0" }}>
						上のアカウントほど優先度が高くなります。
					</p>

					{/* ---- Loading indicator ---- */}
					{isLoggingIn && (
						<div
							style={{
								padding: "6px 10px",
								marginBottom: 8,
								borderRadius: 3,
								fontSize: 12,
								backgroundColor: "rgba(0,128,255,0.08)",
								color: "var(--vscode-terminal-ansiBlue)",
							}}>
							{providerLabel(isLoggingIn)} にログイン中...
						</div>
					)}

					{/* ---- Message toast ---- */}
					{message && (
						<div
							style={{
								padding: "6px 10px",
								marginBottom: 8,
								borderRadius: 3,
								fontSize: 12,
								backgroundColor: message.success ? "rgba(0,128,0,0.1)" : "rgba(255,0,0,0.1)",
								color: message.success ? "var(--vscode-terminal-ansiGreen)" : "var(--vscode-terminal-ansiRed)",
							}}>
							{message.text}
						</div>
					)}

					{/* ---- Account list ---- */}
					{accounts.length === 0 ? (
						<p style={{ fontSize: 12, color: "var(--vscode-descriptionForeground)", margin: "12px 0" }}>
							アカウントが登録されていません。右上の + ボタンから追加してください。
						</p>
					) : (
						<div
							style={{
								border: "1px solid var(--vscode-panel-border)",
								borderRadius: 4,
								overflow: "hidden",
								marginBottom: 0,
							}}>
							{accounts.map((account, index) => {
								const isSelected = selectedId === account.id
								return (
									<div
										key={account.id}
										onClick={() => setSelectedId(isSelected ? null : account.id)}
										style={{
											display: "flex",
											alignItems: "center",
											padding: "6px 8px",
											cursor: "pointer",
											backgroundColor: isSelected
												? "var(--vscode-list-activeSelectionBackground)"
												: "transparent",
											color: isSelected ? "var(--vscode-list-activeSelectionForeground)" : "inherit",
											borderBottom:
												index < accounts.length - 1 ? "1px solid var(--vscode-panel-border)" : "none",
											gap: 4,
											userSelect: "none",
										}}>
										{/* Reorder buttons */}
										<div
											onClick={(e) => e.stopPropagation()}
											style={{
												display: "flex",
												flexDirection: "column",
												gap: 0,
												marginRight: 4,
												flexShrink: 0,
											}}>
											<button
												disabled={index === 0}
												onClick={() => handleMoveUp(index)}
												style={{
													background: "none",
													border: "none",
													padding: "0 2px",
													cursor: index === 0 ? "default" : "pointer",
													color: isSelected
														? "var(--vscode-list-activeSelectionForeground)"
														: "var(--vscode-foreground)",
													opacity: index === 0 ? 0.25 : 0.7,
													fontSize: 10,
													lineHeight: 1,
												}}
												title="上に移動">
												&#x25B2;
											</button>
											<button
												disabled={index === accounts.length - 1}
												onClick={() => handleMoveDown(index)}
												style={{
													background: "none",
													border: "none",
													padding: "0 2px",
													cursor: index === accounts.length - 1 ? "default" : "pointer",
													color: isSelected
														? "var(--vscode-list-activeSelectionForeground)"
														: "var(--vscode-foreground)",
													opacity: index === accounts.length - 1 ? 0.25 : 0.7,
													fontSize: 10,
													lineHeight: 1,
												}}
												title="下に移動">
												&#x25BC;
											</button>
										</div>

										{/* Provider badge */}
										<span
											style={{
												fontSize: 10,
												fontWeight: 600,
												padding: "1px 6px",
												borderRadius: 3,
												backgroundColor: "rgba(128,128,128,0.15)",
												color: isSelected
													? "var(--vscode-list-activeSelectionForeground)"
													: providerColor(account.provider),
												flexShrink: 0,
												whiteSpace: "nowrap",
											}}>
											{providerLabel(account.provider)}
										</span>

										{/* Label */}
										<span
											style={{
												flex: 1,
												fontSize: 12,
												overflow: "hidden",
												textOverflow: "ellipsis",
												whiteSpace: "nowrap",
												marginLeft: 4,
											}}>
											{account.label || "(unnamed)"}
											{account.isMain && (
												<span
													style={{
														marginLeft: 6,
														fontSize: 10,
														color: isSelected
															? "var(--vscode-list-activeSelectionForeground)"
															: "var(--vscode-terminal-ansiYellow)",
													}}>
													★
												</span>
											)}
										</span>

										{/* Model name */}
										<span
											style={{
												fontSize: 11,
												color: isSelected
													? "var(--vscode-list-activeSelectionForeground)"
													: "var(--vscode-descriptionForeground)",
												flexShrink: 0,
												whiteSpace: "nowrap",
												opacity: 0.8,
											}}>
											{account.model || "-"}
										</span>
									</div>
								)
							})}
						</div>
					)}

					{/* ---- Selected account settings panel ---- */}
					{selectedAccount && (
						<AccountSettingsPanel
							account={selectedAccount}
							isLoggingIn={isLoggingIn}
							onApiKeyChange={handleApiKeyChange}
							onLogin={handleOAuthLogin}
							onModelChange={handleModelChange}
							onRemove={handleRemove}
						/>
					)}
				</div>
			</Section>
		</div>
	)
}

// ---------------------------------------------------------------------------
// Account settings panel (shown below the list)
// ---------------------------------------------------------------------------

interface AccountSettingsPanelProps {
	account: ProtoGllmAccount
	onModelChange: (accountId: string, model: string) => void
	onApiKeyChange: (accountId: string, apiKey: string) => void
	onRemove: (id: string) => void
	onLogin: (provider: string) => void
	isLoggingIn: string | null
}

const AccountSettingsPanel: React.FC<AccountSettingsPanelProps> = ({
	account,
	onModelChange,
	onApiKeyChange,
	onRemove,
	onLogin,
	isLoggingIn,
}) => {
	const models = getModelsForProvider(account.provider, account)
	const isOAuth = isOAuthProvider(account.provider)
	const isGeminiApi = account.provider === "gemini"
	const isLoggedIn = !!account.email

	return (
		<div
			style={{
				marginTop: 12,
				border: "1px solid var(--vscode-panel-border)",
				borderRadius: 4,
				padding: 16,
			}}>
			{/* Header row */}
			<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
				<span
					style={{
						fontSize: 10,
						fontWeight: 600,
						padding: "1px 6px",
						borderRadius: 3,
						backgroundColor: "rgba(128,128,128,0.15)",
						color: providerColor(account.provider),
					}}>
					{providerLabel(account.provider)}
				</span>
				<span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{account.label || "(unnamed)"}</span>
			</div>

			{/* OAuth account info */}
			{isOAuth && isLoggedIn && (
				<div style={{ marginBottom: 12, fontSize: 12 }}>
					{account.email && (
						<div style={{ marginBottom: 4 }}>
							<span style={{ color: "var(--vscode-descriptionForeground)" }}>メール: </span>
							{account.email}
						</div>
					)}
					{account.projectId && (
						<div style={{ marginBottom: 4 }}>
							<span style={{ color: "var(--vscode-descriptionForeground)" }}>プロジェクトID: </span>
							<code style={{ fontSize: 11 }}>{account.projectId}</code>
						</div>
					)}
				</div>
			)}

			{/* OAuth login button */}
			{isOAuth && !isLoggedIn && (
				<div style={{ marginBottom: 12 }}>
					<VSCodeButton disabled={isLoggingIn === account.provider} onClick={() => onLogin(account.provider)}>
						{isLoggingIn === account.provider ? "ログイン中..." : "ログイン"}
					</VSCodeButton>
				</div>
			)}

			{/* Gemini API key input */}
			{isGeminiApi && (
				<div style={{ marginBottom: 12 }}>
					<label
						style={{
							display: "block",
							marginBottom: 4,
							fontSize: 12,
							fontWeight: 500,
						}}>
						API キー
					</label>
					<VSCodeTextField
						onInput={(e: any) => {
							const value = e.target?.value ?? ""
							if (value !== account.apiKey) {
								onApiKeyChange(account.id, value)
							}
						}}
						placeholder="Gemini API キーを入力"
						style={{ width: "100%" }}
						type="password"
						value={account.apiKey ?? ""}
					/>
				</div>
			)}

			{/* Model selector */}
			{models.length > 0 && (
				<div style={{ marginBottom: 12 }}>
					<label
						style={{
							display: "block",
							marginBottom: 4,
							fontSize: 12,
							fontWeight: 500,
						}}>
						モデル
					</label>
					<VSCodeDropdown
						onChange={(e) => {
							const v = (e.target as HTMLSelectElement).value
							if (v && v !== account.model) {
								onModelChange(account.id, v)
							}
						}}
						style={{ width: "100%" }}
						value={account.model}>
						{models.map((m) => (
							<VSCodeOption key={m} value={m}>
								[{getProviderBadge(account.provider)}] {m}
							</VSCodeOption>
						))}
					</VSCodeDropdown>
				</div>
			)}

			{/* Delete */}
			<div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
				<VSCodeButton appearance="secondary" onClick={() => onRemove(account.id)}>
					削除
				</VSCodeButton>
			</div>
		</div>
	)
}

export default GllmAccountsSection
