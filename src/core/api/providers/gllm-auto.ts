import { GllmAccount } from "@shared/api"
import { GllmAccountManager } from "@/services/auth/gllm/GllmAccountManager"
import { ClineStorageMessage } from "@/shared/messages/content"
import { ClineTool } from "@/shared/tools"
import { ApiHandler, ApiHandlerModel, ApiRequestUsageContext, CommonApiHandlerOptions } from "../"
import { AntigravityHandler, ModelRetiredError } from "./antigravity"
import { GeminiHandler } from "./gemini"
import { GeminiCliHandler } from "./gemini-cli"

// In-memory blacklist: "provider::model" → retireUntil(ms). Survives the
// process but resets on extension reload. Used only for hard retirement
// (ModelRetiredError). 429/rate-limit errors do NOT blacklist here because
// the server's per-minute quota is transient; blacklisting turned a brief
// rate-limit into a minute-long "All available models are temporarily
// blacklisted" state visible to the user.
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
// Model names verified against `v1internal:retrieveUserQuota` for this account
// (2026-04-24 probe: the quota response lists these exact ids, including the
// `-preview` suffix). Don't speculate: probe with scripts/experiments/ if the
// server's advertised set changes.
const GEMINI_CLI_FALLBACK_MODELS = [
	"gemini-3.1-pro-preview",
	"gemini-3-pro-preview",
	"gemini-2.5-pro",
	"gemini-3-flash-preview",
	"gemini-3.1-flash-lite-preview",
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
			// Re-check blacklist inside the loop: a previous iteration may have
			// just blacklisted this (provider, model) tuple after a 429 on a
			// different account that shares the same model advertisement.
			if (isBlacklisted(candidate.account.provider, candidate.modelId)) {
				continue
			}
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
				// Quota / rate-limit / model-not-found: fall through without
				// blacklisting. Blacklisting rate-limit errors caused
				// legitimate transient 429s to lock out all candidates for
				// the TTL window. Rely on the inner candidate loop + the
				// ModelRetiredError path for hard retirement.
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
	// Only trust what the server advertises for this specific provider, plus
	// the hardcoded fallback set that survived a live probe. Do NOT include
	// `account.model` blindly: it carries over when a user switches the
	// account's provider (e.g. from gemini-cli to antigravity), leaving a
	// stale id like `gemini-3.1-pro-preview` that antigravity 404s on.
	const advertised = account.availableModels ?? []
	if (advertised.length > 0) {
		return advertised.includes(modelId)
	}
	// No advertisement loaded yet (first sign-in, transient fetch failure):
	// fall back to the probe-verified list for this provider so auto mode
	// isn't bricked until the next refresh.
	return getFallbackModelsForProvider(account.provider).includes(modelId)
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

// Per-tier candidate pools, by provider. Probe-verified — do not guess.
//   gemini-cli:  retrieveUserQuota (2026-04-24) returns `-preview` suffixes
//   antigravity: fetchAvailableModels (2026-04-24) returns `-high/-low`
// Keep these lists intersected with the account's live `availableModels`
// — we never want to fabricate a model id the server didn't advertise.
const TIER_PREFERENCE: Record<string, { pro: string[]; flash: string[] }> = {
	"gemini-cli": {
		pro: ["gemini-3.1-pro-preview", "gemini-3-pro-preview", "gemini-2.5-pro"],
		flash: ["gemini-3-flash-preview", "gemini-3.1-flash-lite-preview", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
	},
	antigravity: {
		pro: ["gemini-3.1-pro-high", "gemini-3.1-pro-low", "gemini-2.5-pro", "gemini-3-pro-high"],
		flash: ["gemini-3.1-flash-lite", "gemini-3-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
	},
	gemini: {
		pro: ["gemini-2.5-pro"],
		flash: ["gemini-2.5-flash", "gemini-2.5-flash-lite"],
	},
}

function getProviderAutoModels(account: GllmAccount, tier: "pro" | "flash"): string[] {
	const prefs = TIER_PREFERENCE[account.provider]
	if (!prefs) return []
	const preferred = prefs[tier]
	const available = accountAutoModels(account)
	// Intersection only. We never leak models the account didn't advertise,
	// and we never cross-pollinate flash↔pro when the preferred set misses —
	// the old "return all available" path meant `auto flash` could select a
	// pro model (or vice versa) just because the advertised list happened
	// to include it in some order.
	const intersection = preferred.filter((modelId) => available.includes(modelId))
	if (intersection.length > 0) return intersection
	// Advertisement not loaded yet (first sign-in / transient fetch
	// failure): fall back to the probe-verified preferred list so auto mode
	// stays functional until the next refresh.
	return available.length === 0 ? preferred : []
}

function accountAutoModels(account: GllmAccount): string[] {
	return account.availableModels ?? []
}

function isRetryableQuotaError(error: Error): boolean {
	const message = error.message.toLowerCase()
	// Transient rate limit / quota — safe to retry against the next
	// candidate. Narrowly scoped: `429` only matches when we actually saw
	// that status code word-adjacent, `resource_exhausted` matches Google's
	// protobuf enum, and `exhausted your capacity` matches the observed
	// Gemini CLI prose. We intentionally do NOT match broad tokens like
	// "quota" alone, "not available", "deprecated", or bare "404": those
	// surface as 400/404 schema/UA/payload bugs that need to fail loudly
	// instead of being papered over by silent model fallback. Hard model
	// retirement (200-OK with a retirement prose) is routed through
	// ModelRetiredError and handled by a separate arm of the loop.
	if (/\b429\b/.test(message)) return true
	if (message.includes("resource_exhausted")) return true
	if (message.includes("rate_limit_exceeded") || message.includes("rate limit exceeded")) return true
	if (message.includes("exhausted your capacity")) return true
	// `Retry-After` header echoed in an error message is also a strong
	// signal that the caller should retry later on a different candidate.
	if (/retry[- ]after/.test(message)) return true
	return false
}
