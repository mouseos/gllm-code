import { randomUUID } from "node:crypto"
import { Content, FunctionDeclaration as GoogleTool } from "@google/genai"
import { AntigravityModelId, antigravityDefaultModelId, antigravityModels, ModelInfo } from "@shared/api"
import { GllmAccountManager } from "@/services/auth/gllm/GllmAccountManager"
import { ClineStorageMessage } from "@/shared/messages/content"
import { fetch } from "@/shared/net"
import { ApiHandler, ApiHandlerModel, CommonApiHandlerOptions } from "../"
import { convertAnthropicMessageToGemini } from "../transform/gemini-format"
import { ApiStream } from "../transform/stream"

const ANTIGRAVITY_BASE = "https://daily-cloudcode-pa.googleapis.com"
const CODE_ASSIST_VERSION = "v1internal"
const ANTIGRAVITY_USER_AGENT = "antigravity/1.20.0 linux/x64"

const ANTIGRAVITY_SAFETY_SETTINGS = [
	{ category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
	{ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
	{ category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
	{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
	{ category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "OFF" },
]

interface AntigravityHandlerOptions extends CommonApiHandlerOptions {
	apiModelId?: string
}

interface AntigravityResponse {
	response?: {
		candidates?: Array<{
			content?: {
				role: string
				parts: Array<{ text?: string; functionCall?: { name: string; args: Record<string, unknown> }; thought?: boolean }>
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

	constructor(options: AntigravityHandlerOptions) {
		this.options = options
		this.accountManager = GllmAccountManager.getInstance()
	}

	async *createMessage(systemPrompt: string, messages: ClineStorageMessage[], tools?: GoogleTool[]): ApiStream {
		const { id: modelId, info } = this.getModel()
		const mainAccount = this.accountManager.getMainAccount()
		if (!mainAccount || mainAccount.provider !== "antigravity") {
			throw new Error("No Antigravity account configured as main. Please add an Antigravity account in settings.")
		}

		const token = await this.accountManager.getAccessToken(mainAccount.id)
		const projectId = await this.accountManager.getProjectId(mainAccount.id)
		const contents: Content[] = messages.map(convertAnthropicMessageToGemini)

		const sessionId = generateSessionId(contents)

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
				systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
				generationConfig: {
					maxOutputTokens: info.maxTokens ?? 65536,
				},
				...(tools && tools.length > 0
					? {
							tools: [{ functionDeclarations: tools }],
							toolConfig: { functionCallingConfig: { mode: "ANY" } },
						}
					: {}),
			},
		}

		const url = `${ANTIGRAVITY_BASE}/${CODE_ASSIST_VERSION}:streamGenerateContent?alt=sse`
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				"User-Agent": ANTIGRAVITY_USER_AGENT,
				Accept: "text/event-stream",
			},
			body: JSON.stringify(requestBody),
		})

		if (!response.ok) {
			const errText = await response.text()
			throw new Error(`Antigravity API error ${response.status}: ${errText}`)
		}

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
									call_id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
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
		const mainAccount = this.accountManager.getMainAccount()
		const modelId = (mainAccount?.model ?? this.options.apiModelId ?? antigravityDefaultModelId) as AntigravityModelId
		const info = (antigravityModels[modelId as keyof typeof antigravityModels] ??
			antigravityModels[antigravityDefaultModelId]) as ModelInfo
		return { id: modelId, info }
	}
}

function generateSessionId(contents: Content[]): string {
	const firstUser = contents.find((c) => c.role === "user")
	const text = firstUser?.parts?.[0]?.text || ""
	let hash = 0
	for (let i = 0; i < text.length; i++) {
		hash = (hash << 5) - hash + text.charCodeAt(i)
		hash = hash & hash
	}
	return `-${Math.abs(hash) * 1000000000000}`
}
