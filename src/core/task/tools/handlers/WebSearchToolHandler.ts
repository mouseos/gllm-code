import { ClineAsk, ClineSayTool } from "@shared/ExtensionMessage"
import { ClineDefaultTool } from "@shared/tools"
import axios from "axios"
import { ClineEnv } from "@/config"
import { AuthService } from "@/services/auth/AuthService"
import { GllmAccountManager } from "@/services/auth/gllm/GllmAccountManager"
import { buildClineExtraHeaders } from "@/services/EnvUtils"
import { featureFlagsService } from "@/services/feature-flags"
import { telemetryService } from "@/services/telemetry"
import { parsePartialArrayString } from "@/shared/array"
import { CLINE_ACCOUNT_AUTH_ERROR_MESSAGE } from "@/shared/ClineAccount"
import { fetch, getAxiosSettings } from "@/shared/net"
import { ToolUse } from "../../../assistant-message"
import { formatResponse } from "../../../prompts/responses"
import { ToolResponse } from "../.."
import { showNotificationForApproval } from "../../utils"
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { ToolResultUtils } from "../utils/ToolResultUtils"

const GLLM_PROVIDERS = new Set(["gemini-cli", "antigravity", "gemini"])

const CODE_ASSIST_ENDPOINTS: Record<string, string> = {
	"gemini-cli": "https://cloudcode-pa.googleapis.com/v1internal",
	antigravity: "https://daily-cloudcode-pa.googleapis.com/v1internal",
}

export class WebSearchToolHandler implements IFullyManagedTool {
	readonly name = ClineDefaultTool.WEB_SEARCH

	getDescription(block: ToolUse): string {
		return `[${block.name} for '${block.params.query}']`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const query = block.params.query || ""
		const sharedMessageProps: ClineSayTool = {
			tool: "webSearch",
			path: uiHelpers.removeClosingTag(block, "query", query),
			content: `Searching for: ${uiHelpers.removeClosingTag(block, "query", query)}`,
			operationIsLocatedInWorkspace: false,
		} satisfies ClineSayTool

		const partialMessage = JSON.stringify(sharedMessageProps)
		await uiHelpers.removeLastPartialMessageIfExistsWithType("say", "tool")
		await uiHelpers.ask("tool" as ClineAsk, partialMessage, block.partial).catch(() => {})
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		try {
			const query: string | undefined = block.params.query

			const apiConfig = config.services.stateManager.getApiConfiguration()
			const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")
			const provider = (currentMode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string

			// Determine if this is a gllm provider
			const gllmAccount = GllmAccountManager.getInstance().getPrimaryAccount()
			const isGllmProvider = !!gllmAccount && GLLM_PROVIDERS.has(gllmAccount.provider)

			if (!isGllmProvider) {
				// Original Cline web search path
				const clineWebToolsEnabled = config.services.stateManager.getGlobalSettingsKey("clineWebToolsEnabled")
				const featureFlagEnabled = featureFlagsService.getWebtoolsEnabled()
				if (provider !== "cline" || !clineWebToolsEnabled || !featureFlagEnabled) {
					return formatResponse.toolError("Cline web tools are currently disabled.")
				}
			}

			if (!query) {
				config.taskState.consecutiveMistakeCount++
				return await config.callbacks.sayAndCreateMissingParamError(this.name, "query")
			}
			config.taskState.consecutiveMistakeCount = 0

			const sharedMessageProps: ClineSayTool = {
				tool: "webSearch",
				path: query,
				content: `Searching for: ${query}`,
				operationIsLocatedInWorkspace: false,
			}
			const completeMessage = JSON.stringify(sharedMessageProps)

			if (config.callbacks.shouldAutoApproveTool(this.name)) {
				await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "tool")
				await config.callbacks.say("tool", completeMessage, undefined, undefined, false)
				telemetryService.captureToolUsage(
					config.ulid,
					"web_search",
					config.api.getModel().id,
					isGllmProvider ? gllmAccount!.provider : provider,
					true,
					true,
					undefined,
					block.isNativeToolCall,
				)
			} else {
				showNotificationForApproval(
					`Cline wants to search for: ${query}`,
					config.autoApprovalSettings.enableNotifications,
				)
				await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "tool")
				const didApprove = await ToolResultUtils.askApprovalAndPushFeedback("tool", completeMessage, config)
				if (!didApprove) {
					telemetryService.captureToolUsage(
						config.ulid,
						block.name,
						config.api.getModel().id,
						isGllmProvider ? gllmAccount!.provider : provider,
						false,
						false,
						undefined,
						block.isNativeToolCall,
					)
					return formatResponse.toolDenied()
				}
				telemetryService.captureToolUsage(
					config.ulid,
					block.name,
					config.api.getModel().id,
					isGllmProvider ? gllmAccount!.provider : provider,
					false,
					true,
					undefined,
					block.isNativeToolCall,
				)
			}

			// Run PreToolUse hook
			try {
				const { ToolHookUtils } = await import("../utils/ToolHookUtils")
				await ToolHookUtils.runPreToolUseIfEnabled(config, block)
			} catch (error) {
				const { PreToolUseHookCancellationError } = await import("@core/hooks/PreToolUseHookCancellationError")
				if (error instanceof PreToolUseHookCancellationError) {
					return formatResponse.toolDenied()
				}
				throw error
			}

			// Execute search
			if (isGllmProvider) {
				return await this.executeGllmSearch(query, gllmAccount!)
			}
			return await this.executeClineSearch(query, block, config)
		} catch (error) {
			return `Error performing web search: ${(error as Error).message}`
		}
	}

	private async executeGllmSearch(query: string, account: { id: string; provider: string }): Promise<ToolResponse> {
		const manager = GllmAccountManager.getInstance()
		const token = await manager.getAccessToken(account.id)

		let baseUrl: string
		if (account.provider === "gemini") {
			// For Gemini API, use the standard Gemini API with googleSearch grounding
			return await this.executeGeminiApiSearch(query, account)
		}

		baseUrl = CODE_ASSIST_ENDPOINTS[account.provider] ?? CODE_ASSIST_ENDPOINTS["gemini-cli"]

		const projectId = await manager.getProjectId(account.id)

		const requestBody = {
			model: "gemini-2.5-flash",
			project: projectId,
			request: {
				contents: [{ role: "user", parts: [{ text: query }] }],
				generationConfig: { maxOutputTokens: 4096 },
				tools: [{ googleSearch: {} }],
			},
		}

		const url = `${baseUrl}:generateContent`
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(requestBody),
		})

		if (!res.ok) {
			const errText = await res.text()
			throw new Error(`Google Search API error ${res.status}: ${errText}`)
		}

		const data = (await res.json()) as {
			response?: {
				candidates?: Array<{
					content?: { parts?: Array<{ text?: string }> }
					groundingMetadata?: {
						groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>
						groundingSupports?: Array<{
							segment?: { startIndex: number; endIndex: number }
							groundingChunkIndices?: number[]
						}>
					}
				}>
			}
		}

		return this.formatGroundingResponse(query, data.response)
	}

	private async executeGeminiApiSearch(query: string, account: { id: string }): Promise<ToolResponse> {
		const manager = GllmAccountManager.getInstance()
		const token = await manager.getAccessToken(account.id)

		const requestBody = {
			contents: [{ role: "user", parts: [{ text: query }] }],
			generationConfig: { maxOutputTokens: 4096 },
			tools: [{ googleSearch: {} }],
		}

		const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${token}`
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(requestBody),
		})

		if (!res.ok) {
			const errText = await res.text()
			throw new Error(`Gemini API Search error ${res.status}: ${errText}`)
		}

		const data = (await res.json()) as {
			candidates?: Array<{
				content?: { parts?: Array<{ text?: string }> }
				groundingMetadata?: {
					groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>
					groundingSupports?: Array<{
						segment?: { startIndex: number; endIndex: number }
						groundingChunkIndices?: number[]
					}>
				}
			}>
		}

		// Gemini API returns candidates directly (no response wrapper)
		return this.formatGroundingResponse(query, { candidates: data.candidates })
	}

	private formatGroundingResponse(
		query: string,
		response?: {
			candidates?: Array<{
				content?: { parts?: Array<{ text?: string }> }
				groundingMetadata?: {
					groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>
					groundingSupports?: Array<{
						segment?: { startIndex: number; endIndex: number }
						groundingChunkIndices?: number[]
					}>
				}
			}>
		},
	): ToolResponse {
		const candidate = response?.candidates?.[0]
		const text = candidate?.content?.parts?.map((p) => p.text).join("") ?? ""
		const chunks = candidate?.groundingMetadata?.groundingChunks ?? []

		if (!text.trim()) {
			return formatResponse.toolResult(`No search results found for: "${query}"`)
		}

		let resultText = `Web search results for "${query}":\n\n${text}`

		if (chunks.length > 0) {
			resultText += "\n\nSources:\n"
			chunks.forEach((chunk, i) => {
				const title = chunk.web?.title || "Untitled"
				const uri = chunk.web?.uri || ""
				resultText += `[${i + 1}] ${title} (${uri})\n`
			})
		}

		return formatResponse.toolResult(resultText)
	}

	private async executeClineSearch(query: string, block: ToolUse, config: TaskConfig): Promise<ToolResponse> {
		const allowedDomainsRaw: string | undefined = block.params.allowed_domains
		const blockedDomainsRaw: string | undefined = block.params.blocked_domains
		const allowedDomains = parsePartialArrayString(allowedDomainsRaw || "[]")
		const blockedDomains = parsePartialArrayString(blockedDomainsRaw || "[]")

		if (allowedDomains.length > 0 && blockedDomains.length > 0) {
			config.taskState.consecutiveMistakeCount++
			return formatResponse.toolError("Cannot specify both allowed_domains and blocked_domains")
		}

		const baseUrl = ClineEnv.config().apiBaseUrl
		const authToken = await AuthService.getInstance().getAuthToken()
		if (!authToken) {
			throw new Error(CLINE_ACCOUNT_AUTH_ERROR_MESSAGE)
		}

		const requestBody: { query: string; allowed_domains?: string[]; blocked_domains?: string[] } = { query }
		if (allowedDomains.length > 0) requestBody.allowed_domains = allowedDomains
		if (blockedDomains.length > 0) requestBody.blocked_domains = blockedDomains

		const response = await axios.post(`${baseUrl}/api/v1/search/websearch`, requestBody, {
			headers: {
				Authorization: `Bearer ${authToken}`,
				"Content-Type": "application/json",
				"X-Task-ID": config.ulid || "",
				...(await buildClineExtraHeaders()),
			},
			timeout: 15000,
			...getAxiosSettings(),
		})

		const data = response.data.data
		const results = data.results || []
		let resultText = `Search completed (${results.length} results found)`
		if (results.length > 0) {
			resultText += ":\n\n"
			results.forEach((result: { title: string; url: string }, index: number) => {
				resultText += `${index + 1}. ${result.title}\n   ${result.url}\n\n`
			})
		}
		return formatResponse.toolResult(resultText)
	}
}
