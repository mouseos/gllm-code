import { randomUUID } from "node:crypto"
import { Content, FunctionDeclaration as GoogleTool } from "@google/genai"
import { AntigravityModelId, antigravityDefaultModelId, antigravityModels, ModelInfo } from "@shared/api"
import { GllmAccountManager } from "@/services/auth/gllm/GllmAccountManager"
import { ClineStorageMessage } from "@/shared/messages/content"
import { fetch } from "@/shared/net"
import { ApiHandler, ApiHandlerModel, ApiRequestUsageContext, CommonApiHandlerOptions } from "../"
import { convertAnthropicMessageToGemini } from "../transform/gemini-format"
import { ApiStream } from "../transform/stream"

const CODE_ASSIST_VERSION = "v1internal"
const ANTIGRAVITY_BASE_URLS = [
	"https://daily-cloudcode-pa.googleapis.com",
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
	"https://cloudcode-pa.googleapis.com",
]
const ANTIGRAVITY_USER_AGENT = getAntigravityUserAgent()

const ANTIGRAVITY_SAFETY_SETTINGS = [
	{ category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
	{ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
	{ category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
	{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
	{ category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "OFF" },
]

interface AntigravityHandlerOptions extends CommonApiHandlerOptions {
	apiModelId?: string
	accountId?: string
}

interface AntigravityResponse {
	response?: {
		candidates?: Array<{
			content?: {
				role: string
				parts: Array<{
					text?: string
					functionCall?: { id?: string; name: string; args: Record<string, unknown> }
					thought?: boolean
				}>
			}
			finishReason?: string
		}>
		usageMetadata?: {
			promptTokenCount?: number
			candidatesTokenCount?: number
			totalTokenCount?: number
		}
	}
}

export class AntigravityHandler implements ApiHandler {
	private options: AntigravityHandlerOptions
	private accountManager: GllmAccountManager
	private currentUsageContext?: ApiRequestUsageContext

	constructor(options: AntigravityHandlerOptions) {
		this.options = options
		this.accountManager = GllmAccountManager.getInstance()
	}

	private async sendRequest(requestBody: Record<string, unknown>, accessToken: string, accountId: string): Promise<Response> {
		let lastStatus = 0
		let lastErrorText = ""
		let refreshedProject = false

		for (const baseUrl of ANTIGRAVITY_BASE_URLS) {
			const url = `${baseUrl}/${CODE_ASSIST_VERSION}:streamGenerateContent?alt=sse`
			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${accessToken}`,
					"User-Agent": ANTIGRAVITY_USER_AGENT,
					Accept: "text/event-stream",
				},
				body: JSON.stringify(requestBody),
			})

			if (response.ok) {
				return response
			}

			lastStatus = response.status
			lastErrorText = await response.text()

			if (response.status === 404 && !refreshedProject) {
				const missingProjectId = extractMissingProjectId(lastErrorText)
				if (missingProjectId) {
					const refreshedProjectId = await this.accountManager.refreshProjectId(accountId, accessToken)
					requestBody.project = refreshedProjectId
					refreshedProject = true
					return this.sendRequest(requestBody, accessToken, accountId)
				}
			}

			if (![403, 404, 408].includes(response.status) && response.status < 500) {
				break
			}
		}

		throw new Error(`Antigravity API error ${lastStatus}: ${lastErrorText}`)
	}

	async *createMessage(systemPrompt: string, messages: ClineStorageMessage[], tools?: GoogleTool[]): ApiStream {
		const { id: modelId } = this.getModel()
		const account = this.options.accountId
			? this.accountManager.getAccounts().find((candidate) => candidate.id === this.options.accountId)
			: this.accountManager.getPrimaryAccount()
		if (!account) {
			throw new Error("No account configured. Please add an account in settings.")
		}
		this.currentUsageContext = {
			providerId: "antigravity",
			modelId,
			accountId: account.id,
			accountLabel: account.label || account.email || account.id,
		}

		const token = await this.accountManager.getAccessToken(account.id)
		const projectId = await this.accountManager.getProjectId(account.id)
		const contents: Content[] = messages.map(convertAnthropicMessageToGemini)

		const sessionId = generateSessionId(contents)
		const toolDeclarations = tools && tools.length > 0 ? [{ functionDeclarations: tools }] : undefined

		const requestBody: Record<string, unknown> = {
			model: modelId,
			userAgent: ANTIGRAVITY_USER_AGENT,
			requestType: "agent",
			project: projectId,
			requestId: `agent-${randomUUID()}`,
			request: {
				contents,
				sessionId,
				safetySettings: ANTIGRAVITY_SAFETY_SETTINGS,
				systemInstruction: systemPrompt ? { role: "user", parts: [{ text: systemPrompt }] } : undefined,
				generationConfig: {
					maxOutputTokens: 64000,
					stopSequences: ["\n\nHuman:", "[DONE]"],
				},
				...(toolDeclarations
					? {
							tools: toolDeclarations,
							toolConfig: { functionCallingConfig: { mode: "VALIDATED" } },
						}
					: {}),
			},
		}

		const response = await this.sendRequest(requestBody, token, account.id)

		const reader = response.body?.getReader()
		if (!reader) throw new Error("No response body")

		const decoder = new TextDecoder()
		let buffer = ""
		let promptTokens = 0
		let outputTokens = 0

		try {
			while (true) {
				const { done, value } = await reader.read()
				if (done) break
				buffer += decoder.decode(value, { stream: true })
				const lines = buffer.split("\n")
				buffer = lines.pop() || ""

				for (const line of lines) {
					const trimmed = line.trim()
					if (!trimmed.startsWith("data: ")) continue
					const jsonStr = trimmed.slice(6)
					if (jsonStr === "[DONE]") continue

					let chunk: AntigravityResponse
					try {
						chunk = JSON.parse(jsonStr) as AntigravityResponse
					} catch {
						continue
					}

					const resp = chunk.response
					if (!resp) continue

					if (resp.usageMetadata) {
						promptTokens = resp.usageMetadata.promptTokenCount ?? 0
						outputTokens = resp.usageMetadata.candidatesTokenCount ?? 0
					}

					const parts = resp.candidates?.[0]?.content?.parts ?? []
					for (const part of parts) {
						if (part.thought) continue
						if (part.text !== undefined && part.text !== "") {
							yield { type: "text", text: part.text }
						}
						if (part.functionCall) {
							yield {
								type: "tool_calls",
								tool_call: {
									call_id: part.functionCall.id || `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
									function: {
										name: part.functionCall.name,
										arguments: part.functionCall.args,
									},
								},
							}
						}
					}
				}
			}
		} finally {
			reader.releaseLock()
		}

		yield {
			type: "usage",
			inputTokens: promptTokens,
			outputTokens,
		}
	}

	getModel(): ApiHandlerModel {
		const modelId = (this.options.apiModelId ?? antigravityDefaultModelId) as AntigravityModelId
		const info = (antigravityModels[modelId as keyof typeof antigravityModels] ??
			antigravityModels[antigravityDefaultModelId]) as ModelInfo
		return { id: modelId, info }
	}

	getRequestUsageContext(): ApiRequestUsageContext | undefined {
		return this.currentUsageContext
	}
}

function generateSessionId(messages: Content[]): string {
	const firstUserMsg = messages.find((m) => m.role === "user")
	const text =
		firstUserMsg?.parts
			?.map((p) => (p as any).text)
			.filter(Boolean)
			.join("") ?? ""
	if (!text) {
		return `-${Math.floor(Math.random() * 9e18).toString()}`
	}

	let hash = 0
	for (let index = 0; index < text.length; index++) {
		hash = (hash << 5) - hash + text.charCodeAt(index)
		hash |= 0
	}
	return `-${(Math.abs(hash) * 1000000000000).toString()}`
}

// NOTE: Antigravity gates certain models (e.g. Gemini 3.1 Pro) on the client
// user-agent version. Bump this when new models arrive and the server rejects
// us with "not available on this version".
function getAntigravityUserAgent(): string {
	const version = "1.20.0"
	const platform = process.platform === "darwin" ? "macos" : process.platform
	return `antigravity/${version} ${platform}/${process.arch}`
}

function extractMissingProjectId(errorText: string): string | null {
	const body = errorText.trim()
	if (!(body.startsWith("{") || body.startsWith("["))) {
		return null
	}

	try {
		const parsed = JSON.parse(body)
		const details = parsed?.error?.details
		if (!Array.isArray(details)) {
			return null
		}

		for (const detail of details) {
			const resourceName = String(detail?.resourceName || "")
			const match = resourceName.match(/^projects\/([^/]+)$/)
			if (match?.[1]) {
				return match[1]
			}
		}
	} catch {
		return null
	}

	return null
}
