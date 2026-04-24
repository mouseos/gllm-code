import { GllmAccount } from "@shared/api"
import { GllmAccountManager } from "@/services/auth/gllm/GllmAccountManager"
import { ClineStorageMessage } from "@/shared/messages/content"
import { ClineTool } from "@/shared/tools"
import { ApiHandler, ApiHandlerModel, ApiRequestUsageContext, CommonApiHandlerOptions } from "../"
import { AntigravityHandler, ModelRetiredError } from "./antigravity"
import { GeminiHandler } from "./gemini"
import { GeminiCliHandler } from "./gemini-cli"

// In-memory blacklist: "provider::model" → retireUntil(ms). Survives the
// process but resets on extension reload, which is what we want — the server
// may bring a model back.
const MODEL_BLACKLIST = new Map<string, number>()
const RETIREMENT_TTL_MS = 24 * 60 * 60 * 1000

function blacklistKey(provider: string, modelId: string): string {
	return `${provider}::${modelId}`
}

function isBlacklisted(provider: string, modelId: string): boolean {
	const until = MODEL_BLACKLIST.get(blacklistKey(provider, modelId))
	if (!until) return false
	if (Date.now() > until) {
		MODEL_BLACKLIST.delete(blacklistKey(provider, modelId))
		return false
	}
	return true
}

function blacklistModel(provider: string, modelId: string, ttlMs: number = RETIREMENT_TTL_MS): void {
	MODEL_BLACKLIST.set(blacklistKey(provider, modelId), Date.now() + ttlMs)
}

function providerDisplayName(provider: string): string {
	if (provider === "antigravity") return "Antigravity"
	if (provider === "gemini") return "Gemini API"
	if (provider === "gemini-cli") return "Gemini CLI"
	return provider
}

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
	"gemini-3.1-flash-lite",
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
		const allCandidates = this.getCandidates()
		const candidates = allCandidates.filter((c) => !isBlacklisted(c.account.provider, c.modelId))
		if (candidates.length === 0) {
			throw new Error(
				allCandidates.length === 0
					? "No account configured. Please add an account in settings."
					: "All available models are temporarily blacklisted (retired or quota-exhausted). Try again later.",
			)
		}

		let lastError: Error | undefined
		for (let i = 0; i < candidates.length; i++) {
			const candidate = candidates[i]
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
				if (emittedOutput) {
					throw lastError
				}
				if (error instanceof ModelRetiredError) {
					blacklistModel(error.providerId, error.modelId)
					const next = candidates[i + 1]
					const display = `${providerDisplayName(candidate.account.provider)}: ${candidate.modelId}`
					const nextDisplay = next ? `${providerDisplayName(next.account.provider)}: ${next.modelId}` : "（次候補なし）"
					yield {
						type: "reasoning",
						reasoning: `🔄 ${display} は廃止されました。${nextDisplay} に切替します。`,
					}
					continue
				}
				if (!isRetryableQuotaError(lastError)) {
					throw lastError
				}
				// For quota / rate / model-not-found we quietly fall through. Still
				// emit a short notice so the user knows the router is switching.
				const next = candidates[i + 1]
				if (next) {
					yield {
						type: "reasoning",
						reasoning: `🔄 ${providerDisplayName(candidate.account.provider)}: ${candidate.modelId} → ${providerDisplayName(next.account.provider)}: ${next.modelId} にフォールバック。`,
					}
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
				: ["gemini-3.1-flash-lite", "gemini-2.5-flash"]
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
		message.includes("please upgrade") ||
		message.includes("upgrade to the latest") ||
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
