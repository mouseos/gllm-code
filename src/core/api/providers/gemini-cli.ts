import { randomUUID } from "node:crypto"
import { Content, FunctionDeclaration as GoogleTool } from "@google/genai"
import { GeminiCliModelId, geminiCliDefaultModelId, geminiCliModels, ModelInfo } from "@shared/api"
import { GllmAccountManager } from "@/services/auth/gllm/GllmAccountManager"
import { ClineStorageMessage } from "@/shared/messages/content"
import { fetch } from "@/shared/net"
import { ApiHandler, ApiHandlerModel, CommonApiHandlerOptions } from "../"
import { convertAnthropicMessageToGemini } from "../transform/gemini-format"
import { ApiStream } from "../transform/stream"

const CODE_ASSIST_BASE = "https://cloudcode-pa.googleapis.com"
const CODE_ASSIST_VERSION = "v1internal"

interface GeminiCliHandlerOptions extends CommonApiHandlerOptions {
	apiModelId?: string
}

interface CodeAssistResponse {
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

export class GeminiCliHandler implements ApiHandler {
	private options: GeminiCliHandlerOptions
	private accountManager: GllmAccountManager

	constructor(options: GeminiCliHandlerOptions) {
		this.options = options
		this.accountManager = GllmAccountManager.getInstance()
	}

	async *createMessage(systemPrompt: string, messages: ClineStorageMessage[], tools?: GoogleTool[]): ApiStream {
		const { id: modelId, info } = this.getModel()
		const mainAccount = this.accountManager.getMainAccount()
		if (!mainAccount || mainAccount.provider !== "gemini-cli") {
			throw new Error("No Gemini CLI account configured as main. Please add a Gemini CLI account in settings.")
		}

		const token = await this.accountManager.getAccessToken(mainAccount.id)
		const projectId = await this.accountManager.getProjectId(mainAccount.id)
		const contents: Content[] = messages.map(convertAnthropicMessageToGemini)

		const requestBody: Record<string, unknown> = {
			model: modelId,
			project: projectId,
			request: {
				contents,
				systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
				generationConfig: {
					maxOutputTokens: info.maxTokens,
				},
				...(tools && tools.length > 0
					? {
							tools: [{ functionDeclarations: tools }],
							toolConfig: { functionCallingConfig: { mode: "ANY" } },
						}
					: {}),
			},
		}

		const url = `${CODE_ASSIST_BASE}/${CODE_ASSIST_VERSION}:streamGenerateContent?alt=sse`
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(requestBody),
		})

		if (!response.ok) {
			const errText = await response.text()
			throw new Error(`Gemini CLI API error ${response.status}: ${errText}`)
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

					let chunk: CodeAssistResponse
					try {
						chunk = JSON.parse(jsonStr) as CodeAssistResponse
					} catch {
						continue
					}

					const response = chunk.response
					if (!response) continue

					if (response.usageMetadata) {
						promptTokens = response.usageMetadata.promptTokenCount ?? 0
						outputTokens = response.usageMetadata.candidatesTokenCount ?? 0
					}

					const parts = response.candidates?.[0]?.content?.parts ?? []
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
		const modelId = (mainAccount?.model ?? this.options.apiModelId ?? geminiCliDefaultModelId) as GeminiCliModelId
		const info = (geminiCliModels[modelId as keyof typeof geminiCliModels] ??
			geminiCliModels[geminiCliDefaultModelId]) as ModelInfo
		return { id: modelId, info }
	}
}
