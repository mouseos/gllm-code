import { GllmAccount } from "@shared/api"
import { GllmAccountManager } from "@/services/auth/gllm/GllmAccountManager"
import { ClineStorageMessage } from "@/shared/messages/content"
import { ClineTool } from "@/shared/tools"
import { ApiHandler, ApiHandlerModel, ApiRequestUsageContext, CommonApiHandlerOptions } from "../"
import { AntigravityHandler } from "./antigravity"
import { GeminiHandler } from "./gemini"
import { GeminiCliHandler } from "./gemini-cli"

interface GllmAutoHandlerOptions extends CommonApiHandlerOptions {
	apiModelId?: string
	thinkingBudgetTokens?: number
	reasoningEffort?: string
}

type Candidate = {
	account: GllmAccount
	modelId: string
}

const AUTO_MODEL_IDS = new Set(["auto pro", "auto flash", "auto"])
const GEMINI_FALLBACK_MODELS = ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"]
const GEMINI_CLI_FALLBACK_MODELS = [
	"gemini-3.1-pro-preview",
	"gemini-3-pro-preview",
	"gemini-2.5-pro",
	"gemini-3-flash-preview",
	"gemini-2.5-flash",
	"gemini-2.5-flash-lite",
]
const ANTIGRAVITY_FALLBACK_MODELS = [
	"gemini-3.1-pro-high",
	"gemini-3.1-pro-low",
	"gemini-3.1-flash",
	"gemini-2.5-pro",
	"gemini-2.5-flash",
]

export class GllmAutoHandler implements ApiHandler {
	private readonly options: GllmAutoHandlerOptions
	private readonly accountManager: GllmAccountManager
	private currentHandler?: ApiHandler
	private currentUsageContext?: ApiRequestUsageContext

	constructor(options: GllmAutoHandlerOptions) {
		this.options = options
		this.accountManager = GllmAccountManager.getInstance()
	}

	async *createMessage(
		systemPrompt: string,
		messages: ClineStorageMessage[],
		tools?: ClineTool[],
	): ReturnType<ApiHandler["createMessage"]> {
		const candidates = this.getCandidates()
		if (candidates.length === 0) {
			throw new Error("No account configured. Please add an account in settings.")
		}

		let lastError: Error | undefined
		for (const candidate of candidates) {
			const handler = this.createCandidateHandler(candidate)
			this.currentHandler = handler
			this.currentUsageContext = {
				providerId: candidate.account.provider,
				modelId: candidate.modelId,
				accountId: candidate.account.id,
				accountLabel: candidate.account.label || candidate.account.email || candidate.account.id,
			}
			let emittedOutput = false

			try {
				for await (const chunk of handler.createMessage(systemPrompt, messages, tools)) {
					if (chunk.type !== "usage") {
						emittedOutput = true
					}
					yield chunk
				}
				return
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error))
				if (emittedOutput || !isRetryableQuotaError(lastError)) {
					throw lastError
				}
			}
		}

		throw lastError ?? new Error("All GLLM auto model candidates failed")
	}

	getModel(): ApiHandlerModel {
		const firstCandidate = this.getCandidates()[0]
		if (!firstCandidate) {
			return {
				id: this.options.apiModelId ?? "auto",
				info: { supportsPromptCache: false },
			}
		}
		return this.createCandidateHandler(firstCandidate).getModel()
	}

	private getCandidates(): Candidate[] {
		return this.accountManager.getAccountsByPriority().flatMap((account) =>
			resolveModelsForAccount(account, this.options.apiModelId ?? account.model).map((modelId) => ({
				account,
				modelId,
			})),
		)
	}

	private createCandidateHandler(candidate: Candidate): ApiHandler {
		switch (candidate.account.provider) {
			case "gemini-cli":
				return new GeminiCliHandler({
					onRetryAttempt: this.options.onRetryAttempt,
					apiModelId: candidate.modelId,
					accountId: candidate.account.id,
				})
			case "antigravity":
				return new AntigravityHandler({
					onRetryAttempt: this.options.onRetryAttempt,
					apiModelId: candidate.modelId,
					accountId: candidate.account.id,
				})
			case "gemini":
				return new GeminiHandler({
					onRetryAttempt: this.options.onRetryAttempt,
					apiModelId: candidate.modelId,
					geminiApiKey: candidate.account.apiKey,
					accountId: candidate.account.id,
					accountLabel: candidate.account.label || candidate.account.email || candidate.account.id,
					thinkingBudgetTokens: this.options.thinkingBudgetTokens,
					reasoningEffort: this.options.reasoningEffort,
				})
		}

		throw new Error(`Unsupported GLLM provider: ${candidate.account.provider}`)
	}

	getRequestUsageContext(): ApiRequestUsageContext | undefined {
		return this.currentHandler?.getRequestUsageContext?.() ?? this.currentUsageContext
	}
}

function resolveModelsForAccount(account: GllmAccount, selectedModel: string): string[] {
	const model = selectedModel || account.model
	if (!AUTO_MODEL_IDS.has(model)) {
		return accountSupportsModel(account, model) ? [model] : []
	}

	const proModels = getProviderAutoModels(account, "pro")
	const flashModels = getProviderAutoModels(account, "flash")

	if (model === "auto pro") {
		return proModels
	}
	if (model === "auto flash") {
		return flashModels
	}
	return [...proModels, ...flashModels]
}

function accountSupportsModel(account: GllmAccount, modelId: string): boolean {
	const knownModels = new Set<string>(
		[...(account.availableModels ?? []), account.model, ...getFallbackModelsForProvider(account.provider)].filter(
			(value): value is string => !!value,
		),
	)

	return knownModels.has(modelId)
}

function getFallbackModelsForProvider(provider: GllmAccount["provider"]): string[] {
	switch (provider) {
		case "gemini":
			return GEMINI_FALLBACK_MODELS
		case "antigravity":
			return ANTIGRAVITY_FALLBACK_MODELS
		case "gemini-cli":
			return GEMINI_CLI_FALLBACK_MODELS
	}
}

function getProviderAutoModels(account: GllmAccount, tier: "pro" | "flash"): string[] {
	if (account.provider === "gemini-cli") {
		const preferred =
			tier === "pro"
				? ["gemini-3.1-pro-preview", "gemini-3-pro-preview", "gemini-2.5-pro"]
				: ["gemini-3-flash-preview", "gemini-3.1-flash-lite-preview", "gemini-2.5-flash", "gemini-2.5-flash-lite"]
		const available = accountAutoModels(account)
		const matchingPreferred = preferred.filter((modelId) => available.includes(modelId))
		return available.length > 0 ? (matchingPreferred.length > 0 ? matchingPreferred : available) : preferred
	}
	if (account.provider === "antigravity") {
		const preferred =
			tier === "pro"
				? ["gemini-3.1-pro-high", "gemini-3.1-pro-low", "gemini-2.5-pro"]
				: ["gemini-3.1-flash", "gemini-2.5-flash"]
		const available = accountAutoModels(account)
		const matchingPreferred = preferred.filter((modelId) => available.includes(modelId))
		return available.length > 0 ? (matchingPreferred.length > 0 ? matchingPreferred : available) : preferred
	}
	return tier === "pro" ? ["gemini-2.5-pro"] : ["gemini-2.5-flash", "gemini-2.5-flash-lite"]
}

function accountAutoModels(account: GllmAccount): string[] {
	return account.availableModels ?? []
}

function isRetryableQuotaError(error: Error): boolean {
	const message = error.message.toLowerCase()
	// Quota / rate limiting (original cases)
	if (message.includes("429") || message.includes("quota") || message.includes("rate limit")) {
		return true
	}
	// Model retired / unavailable / unknown — skip this candidate and try the next one.
	// Example: "Gemini 3 Pro is no longer available. Please switch to Gemini 3.1 Pro..."
	if (
		message.includes("no longer available") ||
		message.includes("not available") ||
		message.includes("is not supported") ||
		message.includes("unsupported model") ||
		message.includes("unknown model") ||
		message.includes("model not found") ||
		message.includes("please switch to") ||
		message.includes("deprecated")
	) {
		return true
	}
	// 404 on the model endpoint also indicates the model is gone.
	if (message.includes("404") && (message.includes("model") || message.includes("gemini"))) {
		return true
	}
	return false
}
