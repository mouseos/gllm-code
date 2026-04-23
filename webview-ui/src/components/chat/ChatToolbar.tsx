import { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import { getApiMetrics, getApiMetricsByGllmAccount } from "@shared/getApiMetrics"
import { EmptyRequest } from "@shared/proto/cline/common"
import { GllmUpdateModelRequest, GllmAccount as ProtoGllmAccount } from "@shared/proto/cline/gllm_account"
import { Mode } from "@shared/storage/types"
import { ArrowUp, Check, Plus, Slash } from "lucide-react"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useClickAway, useWindowSize } from "react-use"
import PopupModalContainer from "@/components/common/PopupModalContainer"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { GllmAccountServiceClient, StateServiceClient } from "@/services/grpc-client"
import { DEFAULT_SLASH_COMMANDS } from "@/utils/slash-commands"
import AutoApproveModal from "./auto-approve-menu/AutoApproveModal"
import { updateAutoApproveSettings } from "./auto-approve-menu/AutoApproveSettingsAPI"
import { ACTION_METADATA } from "./auto-approve-menu/constants"

export interface ChatToolbarProps {
	onContextButtonClick: () => void
	onSelectFilesAndImages: () => void
	shouldDisableFilesAndImages: boolean
	sendingDisabled: boolean
	onSend: () => void
	onModeToggle: () => void
	mode: Mode
	autoApprovalSettings: AutoApprovalSettings
	modelDisplayName: string
	navigateToSettings: (targetSection?: string) => void
	navigateToMcp: () => void
	onInsertSlashCommand: (command: string) => void
}

type MenuId = "plus" | "slash" | "mode" | "model" | "model-status" | "usage" | null

// ---------------------------------------------------------------------------
// Model definitions
// ---------------------------------------------------------------------------

interface ModelEntry {
	id: string
	label: string
	description?: string
	providers?: string[]
}

interface ModelSection {
	header: string
	models: ModelEntry[]
}

type QuotaBucket = NonNullable<ProtoGllmAccount["quotaBuckets"]>[number]

const AUTO_MODELS: ModelEntry[] = [
	{ id: "auto pro", label: "auto pro", description: "Best pro model with fallback" },
	{ id: "auto flash", label: "auto flash", description: "Best flash model with fallback" },
	{ id: "auto", label: "auto", description: "Smartest model first" },
]

const GEMINI_MODEL_ENTRIES: ModelEntry[] = [
	{ id: "gemini-2.5-pro", label: "gemini-2.5-pro", description: "AP" },
	{ id: "gemini-2.5-flash", label: "gemini-2.5-flash", description: "AP" },
	{ id: "gemini-2.5-flash-lite", label: "gemini-2.5-flash-lite", description: "AP" },
	{ id: "gemini-2.0-flash", label: "gemini-2.0-flash", description: "AP" },
]

const GEMINI_CLI_MODEL_ENTRIES: ModelEntry[] = [
	{ id: "gemini-3.1-pro-preview", label: "gemini-3.1-pro-preview", description: "CL" },
	{ id: "gemini-3-pro-preview", label: "gemini-3-pro-preview", description: "CL" },
	{ id: "gemini-2.5-pro", label: "gemini-2.5-pro", description: "CL" },
	{ id: "gemini-3-flash-preview", label: "gemini-3-flash-preview", description: "CL" },
	{ id: "gemini-2.5-flash", label: "gemini-2.5-flash", description: "CL" },
	{ id: "gemini-2.5-flash-lite", label: "gemini-2.5-flash-lite", description: "CL" },
]

const ANTIGRAVITY_FALLBACK_MODEL_ENTRIES: ModelEntry[] = [
	{ id: "gemini-3-pro-high", label: "gemini-3-pro-high", description: "AN" },
	{ id: "gemini-3-pro-low", label: "gemini-3-pro-low", description: "AN" },
	{ id: "gemini-3-flash", label: "gemini-3-flash", description: "AN" },
	{ id: "gemini-2.5-pro", label: "gemini-2.5-pro", description: "AN" },
	{ id: "gemini-2.5-flash", label: "gemini-2.5-flash", description: "AN" },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAutoApproveEnabled(s: AutoApprovalSettings): boolean {
	const a = s.actions
	return Boolean(a.editFiles && (a.executeSafeCommands || a.executeAllCommands))
}

function getModeLabel(mode: Mode, autoApprove: boolean): { label: string; icon: string } {
	if (mode === "plan") return { label: "Plan", icon: "\u{1F4CB}" }
	if (autoApprove) return { label: "自動実行", icon: "</>" }
	return { label: "確認モード", icon: "✋" }
}

function getProviderBadge(provider: string): string {
	if (provider === "antigravity") return "AN"
	if (provider === "gemini") return "AP"
	if (provider === "gemini-cli") return "CL"
	return provider.toUpperCase()
}

function getOrderedAccounts(accounts: ProtoGllmAccount[]): ProtoGllmAccount[] {
	const mainIndex = accounts.findIndex((account) => account.isMain)
	if (mainIndex <= 0) {
		return accounts
	}

	const ordered = [...accounts]
	const [main] = ordered.splice(mainIndex, 1)
	ordered.unshift(main)
	return ordered
}

function getFallbackEntriesForProvider(provider: string): ModelEntry[] {
	if (provider === "gemini") {
		return GEMINI_MODEL_ENTRIES
	}
	if (provider === "antigravity") {
		return ANTIGRAVITY_FALLBACK_MODEL_ENTRIES
	}
	return GEMINI_CLI_MODEL_ENTRIES
}

function accountSupportsModel(account: ProtoGllmAccount, modelId: string): boolean {
	if (modelId === "auto" || modelId === "auto pro" || modelId === "auto flash") {
		return true
	}

	const knownModels = new Set<string>(
		[
			...(account.availableModels ?? []),
			account.model,
			...getFallbackEntriesForProvider(account.provider).map((entry) => entry.id),
		].filter((value): value is string => !!value),
	)

	return knownModels.has(modelId)
}

function getQuotaBucketsForModel(account: ProtoGllmAccount, modelId: string): QuotaBucket[] {
	const buckets = account.quotaBuckets ?? []
	if (modelId === "auto") {
		return buckets
	}
	if (modelId === "auto pro") {
		return buckets.filter((bucket) => bucket.modelId.toLowerCase().includes("pro"))
	}
	if (modelId === "auto flash") {
		return buckets.filter((bucket) => bucket.modelId.toLowerCase().includes("flash"))
	}
	return buckets.filter((bucket) => bucket.modelId === modelId)
}

function pickWorstQuotaBucket(buckets: QuotaBucket[]): QuotaBucket | undefined {
	return [...buckets].sort((left, right) => {
		const leftRemaining = left.remainingFraction ?? Number.POSITIVE_INFINITY
		const rightRemaining = right.remainingFraction ?? Number.POSITIVE_INFINITY
		if (leftRemaining !== rightRemaining) {
			return leftRemaining - rightRemaining
		}
		const leftReset = Date.parse(left.resetTime ?? "")
		const rightReset = Date.parse(right.resetTime ?? "")
		return (
			(Number.isNaN(leftReset) ? Number.POSITIVE_INFINITY : leftReset) -
			(Number.isNaN(rightReset) ? Number.POSITIVE_INFINITY : rightReset)
		)
	})[0]
}

function quotaFractionToPercent(fraction: number): number {
	return fraction <= 1.05 ? fraction * 100 : fraction
}

function formatQuotaPercent(percent: number): string {
	if (percent >= 10) {
		return `${Math.round(percent)}%`
	}
	return `${Math.round(percent * 10) / 10}%`
}

function formatResetTime(resetTime?: string): string {
	if (!resetTime) {
		return ""
	}
	const resetAt = new Date(resetTime)
	if (Number.isNaN(resetAt.getTime())) {
		return ""
	}
	return `, reset ${resetAt.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
}

function getProviderQuotaLabel(accounts: ProtoGllmAccount[], modelId: string): string {
	const groups = new Map<string, { percent: number; hasQuota: boolean }>()

	for (const account of accounts) {
		if (!accountSupportsModel(account, modelId)) {
			continue
		}
		const badge = getProviderBadge(account.provider)
		const group = groups.get(badge) ?? { percent: 0, hasQuota: false }
		const bucket = pickWorstQuotaBucket(getQuotaBucketsForModel(account, modelId))
		if (bucket?.remainingFraction !== undefined) {
			group.percent += quotaFractionToPercent(bucket.remainingFraction)
			group.hasQuota = true
		}
		groups.set(badge, group)
	}

	return [...groups.entries()]
		.map(([badge, group]) => (group.hasQuota ? `${badge} ${formatQuotaPercent(group.percent)}` : badge))
		.join(" ")
}

function getAccountQuotaSummary(account: ProtoGllmAccount): string {
	switch (account.quotaStatus) {
		case "ok": {
			const bucket = pickWorstQuotaBucket(getQuotaBucketsForModel(account, account.model))
			if (!bucket) {
				return "Quota no bucket for selected model"
			}
			if (bucket.remainingFraction === undefined) {
				return `Quota bucket found${formatResetTime(bucket.resetTime)}`
			}
			return `Quota ${formatQuotaPercent(quotaFractionToPercent(bucket.remainingFraction))} left${formatResetTime(bucket.resetTime)}`
		}
		case "empty":
			return "Quota empty"
		case "unsupported":
			return "Quota unsupported for Gemini API"
		case "auth_error":
			return `Quota auth error${account.quotaError ? `: ${account.quotaError}` : ""}`
		case "fetch_error":
			return `Quota fetch failed${account.quotaError ? `: ${account.quotaError}` : ""}`
		default:
			return "Quota loading"
	}
}

function mergeModelEntries(entries: ModelEntry[]): ModelEntry[] {
	const merged = new Map<string, ModelEntry>()

	for (const entry of entries) {
		const existing = merged.get(entry.id)
		if (!existing) {
			merged.set(entry.id, {
				...entry,
				providers: entry.providers ? [...entry.providers] : [],
				description: entry.providers?.join(" ") ?? entry.description,
			})
			continue
		}

		for (const provider of entry.providers ?? []) {
			if (!existing.providers?.includes(provider)) {
				existing.providers = [...(existing.providers ?? []), provider]
			}
		}
		existing.description = existing.providers?.join(" ") ?? existing.description
	}

	return [...merged.values()]
}

function getModelSections(accounts: ProtoGllmAccount[]): ModelSection[] {
	if (accounts.length === 0) {
		return [{ header: "Models", models: GEMINI_CLI_MODEL_ENTRIES }]
	}

	const providerBadges = [...new Set(accounts.map((account) => getProviderBadge(account.provider)))]
	const autoSection: ModelSection = {
		header: "Auto",
		models: AUTO_MODELS.map((entry) => ({
			...entry,
			providers: providerBadges,
			description: getProviderQuotaLabel(accounts, entry.id) || providerBadges.join(" "),
		})),
	}

	const mergedEntries: ModelEntry[] = []
	for (const account of accounts) {
		const badge = getProviderBadge(account.provider)
		const dynamicEntries = (account.availableModels ?? []).map((id) => ({
			id,
			label: id,
			providers: [badge],
			description: badge,
		}))
		const selectedEntry = account.model
			? [
					{
						id: account.model,
						label: account.model,
						providers: [badge],
						description: badge,
					},
				]
			: []

		const fallbackEntries = getFallbackEntriesForProvider(account.provider).map((entry) => ({
			...entry,
			providers: [badge],
			description: badge,
		}))

		mergedEntries.push(...dynamicEntries, ...selectedEntry, ...fallbackEntries)
	}

	return [
		autoSection,
		{
			header: "Models",
			models: mergeModelEntries(mergedEntries).map((entry) => ({
				...entry,
				description: getProviderQuotaLabel(accounts, entry.id) || entry.description,
			})),
		},
	]
}

// ---------------------------------------------------------------------------
// Style constants
// ---------------------------------------------------------------------------

const MENU_BG = "var(--vscode-menu-background, var(--vscode-editorWidget-background))"
const MENU_FG = "var(--vscode-menu-foreground, var(--vscode-editor-foreground))"
const MENU_BORDER = "var(--vscode-menu-border, var(--vscode-widget-border))"
const MENU_HOVER = "var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground))"
const MENU_SEPARATOR = "var(--vscode-menu-separatorBackground, var(--vscode-widget-border))"
const SECTION_FG = "var(--vscode-descriptionForeground)"

const menuContainerStyle: React.CSSProperties = {
	position: "absolute",
	bottom: "calc(100% + 6px)",
	backgroundColor: MENU_BG,
	color: MENU_FG,
	border: `1px solid ${MENU_BORDER}`,
	borderRadius: 2,
	padding: "4px 0",
	minWidth: 220,
	boxShadow: "0 8px 20px rgba(0,0,0,0.24)",
	zIndex: 1000,
	fontSize: 12,
}

const menuItemBaseStyle: React.CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	padding: "6px 12px",
	cursor: "pointer",
	whiteSpace: "nowrap",
	gap: 8,
	border: "none",
	background: "transparent",
	color: "inherit",
	width: "100%",
	textAlign: "left",
	fontFamily: "inherit",
	fontSize: "inherit",
	lineHeight: "1.4",
}

const iconButtonStyle: React.CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	width: 26,
	height: 26,
	borderRadius: 2,
	border: "none",
	background: "transparent",
	color: "var(--vscode-descriptionForeground)",
	cursor: "pointer",
	padding: 0,
	flexShrink: 0,
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface MenuItemProps {
	label: string
	rightLabel?: string
	checked?: boolean
	onClick: () => void
}

const MenuItem: React.FC<MenuItemProps> = ({ label, rightLabel, checked, onClick }) => {
	const [hovered, setHovered] = useState(false)
	return (
		<button
			onClick={onClick}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			style={{ ...menuItemBaseStyle, backgroundColor: hovered ? MENU_HOVER : "transparent" }}
			type="button">
			<span style={{ display: "flex", alignItems: "center", gap: 6 }}>
				{checked !== undefined && (
					<span style={{ width: 16, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
						{checked && <Check size={14} />}
					</span>
				)}
				<span>{label}</span>
			</span>
			{rightLabel && <span style={{ color: SECTION_FG, fontSize: 12 }}>{rightLabel}</span>}
		</button>
	)
}

const MenuSeparator: React.FC = () => <div style={{ height: 1, backgroundColor: MENU_SEPARATOR, margin: "4px 0" }} />

const SectionHeader: React.FC<{ children: React.ReactNode }> = ({ children }) => (
	<div
		style={{
			padding: "6px 12px 2px",
			fontSize: 11,
			color: SECTION_FG,
			textTransform: "uppercase",
			letterSpacing: "0.05em",
			userSelect: "none",
		}}>
		{children}
	</div>
)

// ---------------------------------------------------------------------------
// Plus Menu
// ---------------------------------------------------------------------------

const PlusMenu: React.FC<{
	onSelectFilesAndImages: () => void
	onContextButtonClick: () => void
	onClose: () => void
}> = ({ onSelectFilesAndImages, onContextButtonClick, onClose }) => (
	<div style={{ ...menuContainerStyle, left: 0 }}>
		<MenuItem
			label="Upload from computer"
			onClick={() => {
				onSelectFilesAndImages()
				onClose()
			}}
		/>
		<MenuItem
			label="Add context (@)"
			onClick={() => {
				onContextButtonClick()
				onClose()
			}}
		/>
	</div>
)

// ---------------------------------------------------------------------------
// Slash Menu
// ---------------------------------------------------------------------------

const SlashMenu: React.FC<{
	modelDisplayName: string
	navigateToMcp: () => void
	onInsertSlashCommand: (command: string) => void
	onSwitchModel: () => void
	onOpenUsage: () => void
	onClose: () => void
}> = ({ modelDisplayName, navigateToMcp, onInsertSlashCommand, onSwitchModel, onOpenUsage, onClose }) => (
	<div style={{ ...menuContainerStyle, left: 0, maxHeight: 400, overflowY: "auto" }}>
		<SectionHeader>Slash Commands</SectionHeader>
		{DEFAULT_SLASH_COMMANDS.map((cmd) => (
			<MenuItem
				key={cmd.name}
				label={`/${cmd.name}`}
				onClick={() => {
					onInsertSlashCommand(`/${cmd.name}`)
					onClose()
				}}
				rightLabel={cmd.description}
			/>
		))}
		<MenuSeparator />
		<SectionHeader>Model</SectionHeader>
		<MenuItem
			label="Switch model..."
			onClick={() => {
				onSwitchModel()
			}}
			rightLabel={modelDisplayName}
		/>
		<MenuItem
			label="MCP Servers"
			onClick={() => {
				navigateToMcp()
				onClose()
			}}
		/>
		<MenuSeparator />
		<MenuItem
			label="Account & usage..."
			onClick={() => {
				onOpenUsage()
			}}
		/>
	</div>
)

// ---------------------------------------------------------------------------
// Model Picker Menu
// ---------------------------------------------------------------------------

const ModelPickerMenu: React.FC<{
	sections: ModelSection[]
	currentModel: string
	onSelectModel: (modelId: string) => void
	onClose: () => void
}> = ({ sections, currentModel, onSelectModel, onClose }) => (
	<div style={{ ...menuContainerStyle, left: 0, maxHeight: 400, overflowY: "auto" }}>
		{sections.map((section, sIdx) => (
			<React.Fragment key={section.header}>
				{sIdx > 0 && <MenuSeparator />}
				<SectionHeader>{section.header}</SectionHeader>
				{section.models.map((m) => (
					<MenuItem
						checked={currentModel === m.id}
						key={m.id}
						label={m.label}
						onClick={() => {
							onSelectModel(m.id)
							onClose()
						}}
						rightLabel={m.description}
					/>
				))}
			</React.Fragment>
		))}
	</div>
)

const UsageSummaryMenu: React.FC<{
	accounts: ProtoGllmAccount[]
	accountUsage: ReturnType<typeof getApiMetricsByGllmAccount>
	inputTokens: number
	outputTokens: number
	totalCost: number
	onClose: () => void
}> = ({ accounts, accountUsage, inputTokens, outputTokens, totalCost, onClose }) => (
	<div style={{ ...menuContainerStyle, left: 0, minWidth: 320, maxWidth: 380 }}>
		<SectionHeader>Session Usage</SectionHeader>
		<div style={{ padding: "8px 12px", fontSize: 12, display: "grid", gap: 6 }}>
			<div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
				<span>Input</span>
				<span>{inputTokens.toLocaleString()}</span>
			</div>
			<div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
				<span>Output</span>
				<span>{outputTokens.toLocaleString()}</span>
			</div>
			<div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
				<span>Cost</span>
				<span>${totalCost.toFixed(4)}</span>
			</div>
		</div>
		<MenuSeparator />
		<SectionHeader>Accounts</SectionHeader>
		<div style={{ padding: "4px 12px 8px", display: "grid", gap: 6 }}>
			{accounts.length === 0 ? (
				<div style={{ fontSize: 12, color: SECTION_FG }}>No GLLM accounts configured</div>
			) : (
				accounts.map((account) => {
					const usage = accountUsage.find((entry) => entry.accountId === account.id)
					return (
						<div key={account.id} style={{ display: "grid", gap: 2, fontSize: 12 }}>
							<div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
								<span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
									{account.isMain ? "★ " : ""}
									{account.label || account.id}
								</span>
								<span style={{ color: SECTION_FG, whiteSpace: "nowrap" }}>{usage?.modelId || account.model}</span>
							</div>
							<div style={{ display: "flex", justifyContent: "space-between", gap: 12, color: SECTION_FG }}>
								<span>
									{usage
										? `${usage.totalTokensIn.toLocaleString()} in / ${usage.totalTokensOut.toLocaleString()} out`
										: "No usage yet"}
								</span>
								<span>{usage ? `$${usage.totalCost.toFixed(4)}` : "$0.0000"}</span>
							</div>
							<div style={{ color: SECTION_FG }}>{getAccountQuotaSummary(account)}</div>
						</div>
					)
				})
			)}
		</div>
		<MenuSeparator />
		<button onClick={onClose} style={{ ...menuItemBaseStyle, padding: "6px 12px 8px" }} type="button">
			<span>Close</span>
		</button>
	</div>
)

// ---------------------------------------------------------------------------
// Mode Menu
// ---------------------------------------------------------------------------

const ModeMenu: React.FC<{
	mode: Mode
	autoApprove: boolean
	isYolo: boolean
	onModeToggle: () => void
	onSetConfirmMode: () => Promise<void>
	onSetAutoMode: () => Promise<void>
	onToggleYolo: () => Promise<void>
	onCustomClick: () => void
	onClose: () => void
}> = ({ mode, autoApprove, isYolo, onModeToggle, onSetConfirmMode, onSetAutoMode, onToggleYolo, onCustomClick, onClose }) => {
	const isConfirmMode = mode === "act" && !autoApprove
	const isAutoMode = mode === "act" && autoApprove
	const isPlanMode = mode === "plan"

	return (
		<div style={{ ...menuContainerStyle, right: 40 }}>
			<MenuItem
				checked={isConfirmMode}
				label="確認モード"
				onClick={async () => {
					if (mode === "plan") onModeToggle()
					await onSetConfirmMode()
					onClose()
				}}
			/>
			<MenuItem
				checked={isAutoMode}
				label="自動実行"
				onClick={async () => {
					if (mode === "plan") onModeToggle()
					await onSetAutoMode()
					onClose()
				}}
			/>
			<MenuItem
				checked={isPlanMode}
				label="Plan mode"
				onClick={() => {
					if (mode !== "plan") onModeToggle()
					onClose()
				}}
			/>
			<MenuSeparator />
			<MenuItem
				label="Custom..."
				onClick={() => {
					onCustomClick()
					onClose()
				}}
			/>
			<MenuSeparator />
			<MenuItem
				checked={isYolo}
				label="Bypass permissions"
				onClick={async () => {
					await onToggleYolo()
					onClose()
				}}
			/>
		</div>
	)
}

// ---------------------------------------------------------------------------
// Main Toolbar
// ---------------------------------------------------------------------------

const ChatToolbar: React.FC<ChatToolbarProps> = ({
	onContextButtonClick,
	onSelectFilesAndImages,
	shouldDisableFilesAndImages,
	sendingDisabled,
	onSend,
	onModeToggle,
	mode,
	autoApprovalSettings,
	modelDisplayName,
	navigateToMcp,
	onInsertSlashCommand,
}) => {
	const { clineMessages, yoloModeToggled } = useExtensionState()
	const [openMenu, setOpenMenu] = useState<MenuId>(null)
	const [showAutoApprovePanel, setShowAutoApprovePanel] = useState(false)
	const [gllmAccounts, setGllmAccounts] = useState<ProtoGllmAccount[]>([])

	const toolbarRef = useRef<HTMLDivElement>(null)
	const modeButtonRef = useRef<HTMLDivElement>(null)
	const modalRef = useRef<HTMLDivElement>(null)
	const { width: viewportWidth, height: viewportHeight } = useWindowSize()
	const [arrowPosition, setArrowPosition] = useState(0)
	const [menuPosition, setMenuPosition] = useState(0)

	const autoApprove = isAutoApproveEnabled(autoApprovalSettings)
	const isYolo = !!yoloModeToggled
	const { label: modeLabel, icon: modeIcon } = getModeLabel(mode, autoApprove)
	const apiMetrics = useMemo(() => getApiMetrics(clineMessages), [clineMessages])
	const accountUsage = useMemo(() => getApiMetricsByGllmAccount(clineMessages), [clineMessages])

	const orderedAccounts = useMemo(() => getOrderedAccounts(gllmAccounts), [gllmAccounts])
	const primaryAccount = orderedAccounts[0] ?? null
	const currentModel = primaryAccount?.model ?? ""
	const modelSections = useMemo(() => getModelSections(orderedAccounts), [orderedAccounts])

	// Subscribe to gllm accounts
	useEffect(() => {
		const unsub = GllmAccountServiceClient.gllmSubscribeToAccounts(EmptyRequest.create({}), {
			onResponse: (list) => setGllmAccounts(list.accounts ?? []),
			onError: () => {},
			onComplete: () => {},
		})
		return unsub
	}, [])

	// Close menus on outside click
	useEffect(() => {
		if (openMenu === null) return
		const handler = (e: MouseEvent) => {
			if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
				setOpenMenu(null)
			}
		}
		document.addEventListener("mousedown", handler)
		return () => document.removeEventListener("mousedown", handler)
	}, [openMenu])

	// Close menus on Escape
	useEffect(() => {
		if (openMenu === null) return
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpenMenu(null)
		}
		document.addEventListener("keydown", handler)
		return () => document.removeEventListener("keydown", handler)
	}, [openMenu])

	// Close AutoApproveModal on click away
	useClickAway(modalRef, () => {
		if (showAutoApprovePanel) {
			setShowAutoApprovePanel(false)
		}
	})

	useEffect(() => {
		if (!showAutoApprovePanel || !modeButtonRef.current) {
			return
		}
		const buttonRect = modeButtonRef.current.getBoundingClientRect()
		const buttonCenter = buttonRect.left + buttonRect.width / 2
		const rightPosition = document.documentElement.clientWidth - buttonCenter - 5
		setArrowPosition(rightPosition)
		setMenuPosition(buttonRect.top + 1)
	}, [showAutoApprovePanel, viewportWidth, viewportHeight])

	const toggleMenu = useCallback((id: MenuId) => {
		setShowAutoApprovePanel(false)
		setOpenMenu((prev) => (prev === id ? null : id))
	}, [])

	const closeMenu = useCallback(() => setOpenMenu(null), [])

	// Handle "Switch model..." click: close slash menu, open model picker
	const handleSwitchModelClick = useCallback(() => {
		setOpenMenu("model")
	}, [])

	// Handle model selection
	const handleSelectModel = useCallback(
		async (modelId: string) => {
			if (orderedAccounts.length === 0) return
			try {
				const targetAccounts = orderedAccounts.filter(
					(account) => account.id === primaryAccount?.id || accountSupportsModel(account, modelId),
				)
				await Promise.all(
					targetAccounts.map((account) =>
						GllmAccountServiceClient.gllmUpdateAccountModel(
							GllmUpdateModelRequest.create({ accountId: account.id, model: modelId }),
						),
					),
				)
			} catch (err) {
				console.error("Failed to update model:", err)
			}
		},
		[orderedAccounts, primaryAccount],
	)

	// 確認モード: disable all actions
	const handleSetConfirmMode = useCallback(async () => {
		const allOff: AutoApprovalSettings = {
			...autoApprovalSettings,
			enabled: false,
			version: (autoApprovalSettings.version ?? 0) + 1,
			actions: {
				readFiles: false,
				readFilesExternally: false,
				editFiles: false,
				editFilesExternally: false,
				executeSafeCommands: false,
				executeAllCommands: false,
				useBrowser: false,
				useMcp: false,
			},
		}
		await updateAutoApproveSettings(allOff)
	}, [autoApprovalSettings])

	// 自動実行: enable all actions
	const handleSetAutoMode = useCallback(async () => {
		const allOn: AutoApprovalSettings = {
			...autoApprovalSettings,
			enabled: true,
			version: (autoApprovalSettings.version ?? 0) + 1,
			actions: {
				readFiles: true,
				readFilesExternally: true,
				editFiles: true,
				editFilesExternally: true,
				executeSafeCommands: true,
				executeAllCommands: true,
				useBrowser: true,
				useMcp: true,
			},
		}
		await updateAutoApproveSettings(allOn)
	}, [autoApprovalSettings])

	// Bypass permissions toggle
	const handleToggleYolo = useCallback(async () => {
		await StateServiceClient.updateSettings({ metadata: {}, yoloModeToggled: !isYolo })
	}, [isYolo])

	const handleCustomClick = useCallback(() => {
		setOpenMenu(null)
		setShowAutoApprovePanel((prev) => !prev)
	}, [])

	return (
		<div ref={toolbarRef} style={{ position: "relative" }}>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					padding: "0 8px 4px 30px",
					gap: 8,
					color: "var(--vscode-descriptionForeground)",
					fontSize: 12,
					lineHeight: "18px",
				}}>
				{/* Left: + button and slash button */}
				<div style={{ display: "flex", alignItems: "center", gap: 2, minWidth: 0, position: "relative" }}>
					<button
						onClick={() => toggleMenu("plus")}
						style={{ ...iconButtonStyle, height: 22, opacity: shouldDisableFilesAndImages ? 0.4 : 1, width: 22 }}
						title="Add content"
						type="button">
						<Plus size={14} />
					</button>
					<button
						onClick={() => toggleMenu("slash")}
						style={{ ...iconButtonStyle, height: 22, width: 22 }}
						title="Commands & settings"
						type="button">
						<Slash size={14} />
					</button>
					<span
						style={{
							marginLeft: 4,
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
						}}>
						/ commands · @ files · ! shell
					</span>

					{openMenu === "plus" && (
						<PlusMenu
							onClose={closeMenu}
							onContextButtonClick={onContextButtonClick}
							onSelectFilesAndImages={onSelectFilesAndImages}
						/>
					)}
					{openMenu === "slash" && (
						<SlashMenu
							modelDisplayName={modelDisplayName}
							navigateToMcp={navigateToMcp}
							onClose={closeMenu}
							onInsertSlashCommand={onInsertSlashCommand}
							onOpenUsage={() => setOpenMenu("usage")}
							onSwitchModel={handleSwitchModelClick}
						/>
					)}
					{openMenu === "model" && (
						<ModelPickerMenu
							currentModel={currentModel}
							onClose={closeMenu}
							onSelectModel={handleSelectModel}
							sections={modelSections}
						/>
					)}
					{openMenu === "usage" && (
						<UsageSummaryMenu
							accounts={gllmAccounts}
							accountUsage={accountUsage}
							inputTokens={apiMetrics.totalTokensIn}
							onClose={closeMenu}
							outputTokens={apiMetrics.totalTokensOut}
							totalCost={apiMetrics.totalCost}
						/>
					)}
				</div>

				{/* Right: mode button and send button */}
				<div style={{ display: "flex", alignItems: "center", gap: 6, position: "relative" }}>
					<button
						onClick={() => toggleMenu("model-status")}
						style={{
							background: "transparent",
							border: "none",
							color: "var(--vscode-descriptionForeground)",
							cursor: "pointer",
							fontFamily: "inherit",
							fontSize: 12,
							maxWidth: 170,
							overflow: "hidden",
							padding: "1px 2px",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
						}}
						title="Switch model"
						type="button">
						{modelDisplayName}
					</button>
					{openMenu === "model-status" && (
						<ModelPickerMenu
							currentModel={currentModel}
							onClose={closeMenu}
							onSelectModel={handleSelectModel}
							sections={modelSections}
						/>
					)}
					<div ref={modeButtonRef} style={{ display: "inline-flex" }}>
						<button
							onClick={() => toggleMenu("mode")}
							style={{
								display: "flex",
								alignItems: "center",
								gap: 4,
								padding: "1px 4px",
								borderRadius: 2,
								border: "none",
								background: "transparent",
								color: "var(--vscode-descriptionForeground)",
								cursor: "pointer",
								fontSize: 12,
								fontFamily: "inherit",
								whiteSpace: "nowrap",
								lineHeight: "18px",
							}}
							title="Execution mode"
							type="button">
							<span style={{ fontSize: 12 }}>{modeIcon}</span>
							<span>{modeLabel}</span>
						</button>
					</div>

					{openMenu === "mode" && (
						<ModeMenu
							autoApprove={autoApprove}
							isYolo={isYolo}
							mode={mode}
							onClose={closeMenu}
							onCustomClick={handleCustomClick}
							onModeToggle={onModeToggle}
							onSetAutoMode={handleSetAutoMode}
							onSetConfirmMode={handleSetConfirmMode}
							onToggleYolo={handleToggleYolo}
						/>
					)}

					<button
						disabled={sendingDisabled}
						onClick={() => {
							if (!sendingDisabled) onSend()
						}}
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							width: 24,
							height: 24,
							borderRadius: 2,
							border: "none",
							backgroundColor: sendingDisabled ? "transparent" : "var(--vscode-button-background)",
							color: sendingDisabled ? "var(--vscode-disabledForeground)" : "var(--vscode-button-foreground)",
							cursor: sendingDisabled ? "not-allowed" : "pointer",
							opacity: sendingDisabled ? 0.5 : 1,
							padding: 0,
							flexShrink: 0,
						}}
						title="Send"
						type="button">
						<ArrowUp size={14} strokeWidth={2.5} />
					</button>
				</div>
			</div>

			{/* Floating AutoApproveModal */}
			{showAutoApprovePanel && (
				<PopupModalContainer
					$arrowPosition={arrowPosition}
					$bottomOffset={8}
					$maxHeight="min(60vh, 520px)"
					$menuPosition={menuPosition}>
					<div ref={modalRef}>
						<AutoApproveModal
							ACTION_METADATA={ACTION_METADATA}
							buttonRef={modeButtonRef}
							isVisible={showAutoApprovePanel}
							setIsVisible={setShowAutoApprovePanel}
						/>
					</div>
				</PopupModalContainer>
			)}
		</div>
	)
}

export default ChatToolbar
