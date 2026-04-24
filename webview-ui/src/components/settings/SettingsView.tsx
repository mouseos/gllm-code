import type { ExtensionMessage } from "@shared/ExtensionMessage"
import { ResetStateRequest } from "@shared/proto/cline/state"
import { UserOrganization } from "@shared/proto/index.cline"
import {
	CheckCheck,
	FlaskConical,
	HardDriveDownload,
	Info,
	type LucideIcon,
	Plug,
	SquareMousePointer,
	UserRound,
	Wrench,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useEvent } from "react-use"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useClineAuth } from "@/context/ClineAuthContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { StateServiceClient } from "@/services/grpc-client"
import { isAdminOrOwner } from "../account/helpers"
import { Tab, TabContent, TabList, TabTrigger } from "../common/Tab"
import ViewHeader from "../common/ViewHeader"
import SectionHeader from "./SectionHeader"
import AboutSection from "./sections/AboutSection"
import BrowserSettingsSection from "./sections/BrowserSettingsSection"
import DebugSection from "./sections/DebugSection"
import FeatureSettingsSection from "./sections/FeatureSettingsSection"
import GeneralSettingsSection from "./sections/GeneralSettingsSection"
import GllmAccountsSection from "./sections/GllmAccountsSection"
import McpServerSettingsSection from "./sections/McpServerSettingsSection"
import { RemoteConfigSection } from "./sections/RemoteConfigSection"

const IS_DEV = process.env.IS_DEV

// Tab definitions
type SettingsTabID = "accounts" | "features" | "browser" | "general" | "mcp-server" | "about" | "debug" | "remote-config"
interface SettingsTab {
	id: SettingsTabID
	name: string
	tooltipText: string
	headerText: string
	icon: LucideIcon
	hidden?: (params?: { activeOrganization: UserOrganization | null }) => boolean
}

export const SETTINGS_TABS: SettingsTab[] = [
	{
		id: "accounts",
		name: "Accounts",
		tooltipText: "Accounts",
		headerText: "Accounts",
		icon: UserRound,
	},
	{
		id: "features",
		name: "Features",
		tooltipText: "Feature Settings",
		headerText: "Feature Settings",
		icon: CheckCheck,
	},
	{
		id: "browser",
		name: "Browser",
		tooltipText: "Browser Settings",
		headerText: "Browser Settings",
		icon: SquareMousePointer,
	},
	{
		id: "general",
		name: "General",
		tooltipText: "General Settings",
		headerText: "General Settings",
		icon: Wrench,
	},
	{
		id: "mcp-server",
		name: "MCP Server",
		tooltipText: "Local MCP Server",
		headerText: "MCP Server",
		icon: Plug,
	},
	{
		id: "remote-config",
		name: "Remote Config",
		tooltipText: "Remotely configured fields",
		headerText: "Remote Config",
		icon: HardDriveDownload,
		hidden: ({ activeOrganization } = { activeOrganization: null }) =>
			!activeOrganization || !isAdminOrOwner(activeOrganization),
	},
	{
		id: "about",
		name: "About",
		tooltipText: "About Cline",
		headerText: "About",
		icon: Info,
	},
	// Only show in dev mode
	{
		id: "debug",
		name: "Debug",
		tooltipText: "Debug Tools",
		headerText: "Debug",
		icon: FlaskConical,
		hidden: () => !IS_DEV,
	},
]

type SettingsViewProps = {
	onDone: () => void
	targetSection?: string
}

const TAB_TRANSLATION_KEYS: Record<string, { name: string; tooltip: string; header: string }> = {
	accounts: {
		name: "settings.tabs.accounts",
		tooltip: "settings.tabs.accounts",
		header: "settings.tabs.accounts",
	},
	features: {
		name: "settings.tabs.features",
		tooltip: "settings.tabs.feature_settings",
		header: "settings.tabs.feature_settings",
	},
	browser: {
		name: "settings.tabs.browser",
		tooltip: "settings.tabs.browser_settings",
		header: "settings.tabs.browser_settings",
	},
	general: {
		name: "settings.tabs.general",
		tooltip: "settings.tabs.general_settings",
		header: "settings.tabs.general_settings",
	},
	"mcp-server": {
		name: "settings.tabs.mcp_server",
		tooltip: "settings.tabs.local_mcp_server",
		header: "settings.tabs.mcp_server",
	},
	"remote-config": {
		name: "settings.tabs.remote_config",
		tooltip: "settings.tabs.remotely_configured",
		header: "settings.tabs.remote_config",
	},
	about: { name: "settings.tabs.about", tooltip: "settings.tabs.about_cline", header: "settings.tabs.about" },
	debug: { name: "settings.tabs.debug", tooltip: "settings.tabs.debug_tools", header: "settings.tabs.debug" },
}

const SettingsView = ({ onDone, targetSection }: SettingsViewProps) => {
	// Memoize to avoid recreation
	const TAB_CONTENT_MAP: Record<SettingsTabID, React.FC<any>> = useMemo(
		() => ({
			accounts: GllmAccountsSection,
			general: GeneralSettingsSection,
			features: FeatureSettingsSection,
			browser: BrowserSettingsSection,
			"mcp-server": McpServerSettingsSection,
			"remote-config": RemoteConfigSection,
			about: AboutSection,
			debug: DebugSection,
		}),
		[],
	) // Empty deps - these imports never change

	const { t } = useTranslation()
	const { version, environment } = useExtensionState()
	const { activeOrganization } = useClineAuth()

	const normalizeTabId = useCallback((tabId?: string) => {
		if (tabId === "api-config" || tabId === "gllm-accounts") {
			return "accounts"
		}
		return tabId
	}, [])

	const renderSectionHeader = useCallback(
		(tabId: string) => {
			const tab = SETTINGS_TABS.find((tb) => tb.id === tabId)
			if (!tab) return null
			const keys = TAB_TRANSLATION_KEYS[tabId]
			return (
				<SectionHeader>
					<div className="flex items-center gap-2">
						<tab.icon className="w-4" />
						<div>{keys ? t(keys.header) : tab.headerText}</div>
					</div>
				</SectionHeader>
			)
		},
		[t],
	)

	const [activeTab, setActiveTab] = useState<string>(normalizeTabId(targetSection) || SETTINGS_TABS[0].id)

	// Optimized message handler with early returns
	const handleMessage = useCallback(
		(event: MessageEvent) => {
			const message: ExtensionMessage = event.data
			if (message.type !== "grpc_response") {
				return
			}

			const grpcMessage = message.grpc_response?.message
			if (grpcMessage?.key !== "scrollToSettings") {
				return
			}

			const tabId = normalizeTabId(grpcMessage.value)
			if (!tabId) {
				return
			}

			// Check if valid tab ID
			if (SETTINGS_TABS.some((tab) => tab.id === tabId)) {
				setActiveTab(tabId)
				return
			}

			// Fallback to element scrolling
			requestAnimationFrame(() => {
				const element = document.getElementById(tabId)
				if (!element) {
					return
				}

				element.scrollIntoView({ behavior: "smooth" })
				element.style.transition = "background-color 0.5s ease"
				element.style.backgroundColor = "var(--vscode-textPreformat-background)"

				setTimeout(() => {
					element.style.backgroundColor = "transparent"
				}, 1200)
			})
		},
		[normalizeTabId],
	)

	useEvent("message", handleMessage)

	// Memoized reset state handler
	const handleResetState = useCallback(async (resetGlobalState?: boolean) => {
		try {
			await StateServiceClient.resetState(ResetStateRequest.create({ global: resetGlobalState }))
		} catch (error) {
			console.error("Failed to reset state:", error)
		}
	}, [])

	// Update active tab when targetSection changes
	useEffect(() => {
		if (targetSection) {
			setActiveTab(normalizeTabId(targetSection) ?? targetSection)
		}
	}, [normalizeTabId, targetSection])

	// Memoized tab item renderer
	const renderTabItem = useCallback(
		(tab: (typeof SETTINGS_TABS)[0]) => {
			return (
				<TabTrigger className="flex justify-baseline" data-testid={`tab-${tab.id}`} key={tab.id} value={tab.id}>
					<Tooltip key={tab.id}>
						<TooltipTrigger>
							<div
								className={cn(
									"whitespace-nowrap overflow-hidden h-12 sm:py-3 box-border flex items-center border-l-2 border-transparent text-foreground opacity-70 bg-transparent hover:bg-list-hover p-4 cursor-pointer gap-2",
									{
										"opacity-100 border-l-2 border-l-foreground border-t-0 border-r-0 border-b-0 bg-selection":
											activeTab === tab.id,
									},
								)}>
								<tab.icon className="w-4 h-4" />
								<span className="hidden sm:block">
									{TAB_TRANSLATION_KEYS[tab.id] ? t(TAB_TRANSLATION_KEYS[tab.id].name) : tab.name}
								</span>
							</div>
						</TooltipTrigger>
						<TooltipContent side="right">
							{TAB_TRANSLATION_KEYS[tab.id] ? t(TAB_TRANSLATION_KEYS[tab.id].tooltip) : tab.tooltipText}
						</TooltipContent>
					</Tooltip>
				</TabTrigger>
			)
		},
		[activeTab],
	)

	// Memoized active content component
	const ActiveContent = useMemo(() => {
		const Component = TAB_CONTENT_MAP[activeTab as keyof typeof TAB_CONTENT_MAP]
		if (!Component) {
			return null
		}

		// Special props for specific components
		const props: any = { renderSectionHeader }
		if (activeTab === "debug") {
			props.onResetState = handleResetState
		} else if (activeTab === "about") {
			props.version = version
		}

		return <Component {...props} />
	}, [activeTab, handleResetState, version])

	return (
		<Tab>
			<ViewHeader environment={environment} onDone={onDone} title={t("settings.title")} />

			<div className="flex flex-1 overflow-hidden">
				<TabList
					className="shrink-0 flex flex-col overflow-y-auto border-r border-sidebar-background"
					onValueChange={setActiveTab}
					value={activeTab}>
					{SETTINGS_TABS.filter((tab) => !tab.hidden?.({ activeOrganization })).map(renderTabItem)}
				</TabList>

				<TabContent className="flex-1 overflow-auto">{ActiveContent}</TabContent>
			</div>
		</Tab>
	)
}

export default SettingsView
