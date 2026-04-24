import { randomUUID } from "node:crypto"
import { Content, FunctionDeclaration as GoogleTool } from "@google/genai"
import { GeminiCliModelId, geminiCliDefaultModelId, geminiCliModels, ModelInfo } from "@shared/api"
import { GllmAccountManager } from "@/services/auth/gllm/GllmAccountManager"
import { ClineStorageMessage } from "@/shared/messages/content"
import { fetch } from "@/shared/net"
import { ApiHandler, ApiHandlerModel, ApiRequestUsageContext, CommonApiHandlerOptions } from "../"
import { convertAnthropicMessageToGemini } from "../transform/gemini-format"
import { iterSseEvents } from "../transform/sse-stream"
import { ApiStream } from "../transform/stream"

const CODE_ASSIST_BASE = "https://cloudcode-pa.googleapis.com"
const CODE_ASSIST_VERSION = "v1internal"

interface GeminiCliHandlerOptions extends CommonApiHandlerOptions {
	apiModelId?: string
	accountId?: string
}

interface CodeAssistResponse {
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
		responseId?: string
		modelVersion?: string
	}
}

export class GeminiCliHandler implements ApiHandler {
	private options: GeminiCliHandlerOptions
	private accountManager: GllmAccountManager
	private currentUsageContext?: ApiRequestUsageContext

	constructor(options: GeminiCliHandlerOptions) {
		this.options = options
		this.accountManager = GllmAccountManager.getInstance()
	}

	async *createMessage(systemPrompt: string, messages: ClineStorageMessage[], tools?: GoogleTool[]): ApiStream {
		const { id: modelId, info } = this.getModel()
		const account = this.options.accountId
			? this.accountManager.getAccounts().find((candidate) => candidate.id === this.options.accountId)
			: this.accountManager.getAccountsByPriority().find((candidate) => candidate.provider === "gemini-cli")
		if (!account) {
			throw new Error("No Gemini CLI account configured. Please add one in settings.")
		}
		this.currentUsageContext = {
			providerId: "gemini-cli",
			modelId,
			accountId: account.id,
			accountLabel: account.label || account.email || account.id,
		}

		const token = await this.accountManager.getAccessToken(account.id)
		const projectId = await this.accountManager.getProjectId(account.id)
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
				Accept: "text/event-stream",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(requestBody),
		})

		if (!response.ok) {
			const errText = await response.text()
			throw new Error(`Gemini CLI API error ${response.status}: ${errText}`)
		}

		let promptTokens = 0
		let outputTokens = 0

		for await (const payload of iterSseEvents(response.body)) {
			let chunk: CodeAssistResponse
			try {
				chunk = JSON.parse(payload) as CodeAssistResponse
			} catch {
				continue
			}

			const inner = chunk.response
			if (!inner) continue

			if (inner.usageMetadata) {
				promptTokens = inner.usageMetadata.promptTokenCount ?? 0
				outputTokens = inner.usageMetadata.candidatesTokenCount ?? 0
			}

			const parts = inner.candidates?.[0]?.content?.parts ?? []
			for (const part of parts) {
				// `thought: true` parts carry reasoning deltas — surface them as
				// reasoning chunks so the UI shows the thinking stream.
				if (part.thought) {
					if (part.text !== undefined && part.text !== "") {
						yield { type: "reasoning", reasoning: part.text }
					}
					continue
				}
				if (part.text !== undefined && part.text !== "") {
					yield { type: "text", text: part.text }
				}
				if (part.functionCall) {
					const fn = part.functionCall
					const args = fn.args ?? {}
					const toolCallId = fn.id?.trim() || `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`
					yield {
						type: "tool_calls",
						id: inner.responseId,
						tool_call: {
							call_id: toolCallId,
							function: {
								id: toolCallId,
								name: fn.name,
								// Downstream parses this with JSON.parse — must be a
								// string, not an object.
								arguments: JSON.stringify(args),
							},
						},
					}
				}
			}
		}

		yield {
			type: "usage",
			inputTokens: promptTokens,
			outputTokens,
		}
	}

	getModel(): ApiHandlerModel {
		const modelId = (this.options.apiModelId ?? geminiCliDefaultModelId) as GeminiCliModelId
		const info = (geminiCliModels[modelId as keyof typeof geminiCliModels] ??
			geminiCliModels[geminiCliDefaultModelId]) as ModelInfo
		return { id: modelId, info }
	}

	getRequestUsageContext(): ApiRequestUsageContext | undefined {
		return this.currentUsageContext
	}
}
