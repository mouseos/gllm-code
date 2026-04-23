import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { GllmAccount, GllmAccountToken, GllmProviderType } from "@shared/api"
import { StateManager } from "@/core/storage/StateManager"
import { fetch } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { openExternal } from "@/utils/env"

// ─── OAuth Config ────────────────────────────────────────────────────────────

interface GoogleOAuthConfig {
	clientId: string
	clientSecret: string
	scopes: string[]
	ideType: string
}

const PROVIDER_OAUTH: Partial<Record<GllmProviderType, GoogleOAuthConfig>> = {
	"gemini-cli": {
		clientId: "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
		clientSecret: "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",
		scopes: [
			"https://www.googleapis.com/auth/cloud-platform",
			"https://www.googleapis.com/auth/userinfo.email",
			"https://www.googleapis.com/auth/userinfo.profile",
		],
		ideType: "IDE_UNSPECIFIED",
	},
	antigravity: {
		clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
		clientSecret: "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",
		scopes: [
			"https://www.googleapis.com/auth/cloud-platform",
			"https://www.googleapis.com/auth/userinfo.email",
			"https://www.googleapis.com/auth/userinfo.profile",
			"https://www.googleapis.com/auth/cclog",
			"https://www.googleapis.com/auth/experimentsandconfigs",
		],
		ideType: "ANTIGRAVITY",
	},
}

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000
const CALLBACK_PORT_START = 51121
const CALLBACK_PORT_RANGE = 10
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000

// ─── API Endpoints ───────────────────────────────────────────────────────────

const LOAD_CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
const FETCH_AVAILABLE_MODELS_URL = "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels"
const GEMINI_LIST_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models"
const RETRIEVE_USER_QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota"
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"
const DYNAMIC_MODELS_REFRESH_INTERVAL_MS = 5 * 60 * 1000
const GEMINI_MODEL_PREFERENCE = ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"]
const GEMINI_CLI_MODEL_PREFERENCE = [
	"gemini-3.1-pro-preview",
	"gemini-3-pro-preview",
	"gemini-2.5-pro",
	"gemini-3-flash-preview",
	"gemini-3.1-flash-lite-preview",
	"gemini-2.5-flash",
	"gemini-2.5-flash-lite",
]
const ANTIGRAVITY_MODEL_PREFERENCE = [
	"gemini-3-pro-high",
	"gemini-3-pro-low",
	"gemini-3-flash",
	"gemini-2.5-pro",
	"gemini-2.5-flash",
]

// ─── GllmAccountManager ──────────────────────────────────────────────────────

export class GllmAccountManager {
	private static instance: GllmAccountManager | null = null
	private tokenCache = new Map<string, { token: string; expiresAt: number }>()
	private accountUpdateListeners = new Set<() => void>()
	private dynamicModelRefreshAt = new Map<string, number>()
	private dynamicModelRefreshPromises = new Map<string, Promise<string[]>>()

	static getInstance(): GllmAccountManager {
		if (!GllmAccountManager.instance) {
			GllmAccountManager.instance = new GllmAccountManager()
		}
		return GllmAccountManager.instance
	}

	onAccountsChanged(listener: () => void): () => void {
		this.accountUpdateListeners.add(listener)
		return () => this.accountUpdateListeners.delete(listener)
	}

	private notifyListeners(): void {
		for (const listener of this.accountUpdateListeners) {
			listener()
		}
	}

	// ─── CRUD ────────────────────────────────────────────────────────────────

	getAccounts(): GllmAccount[] {
		const stateManager = StateManager.get()
		return stateManager.getGlobalStateKey("gllmAccounts") ?? []
	}

	private async saveAccounts(accounts: GllmAccount[]): Promise<void> {
		const stateManager = StateManager.get()
		stateManager.setGlobalState("gllmAccounts", accounts)
		await stateManager.flushPendingState()
		this.notifyListeners()
	}

	getAccountsByPriority(provider?: GllmProviderType): GllmAccount[] {
		const accounts = this.getAccounts()
		const filtered = provider ? accounts.filter((account) => account.provider === provider) : accounts
		const mainIndex = filtered.findIndex((account) => account.isMain)
		if (mainIndex <= 0) {
			return filtered
		}

		const prioritized = [...filtered]
		const [main] = prioritized.splice(mainIndex, 1)
		prioritized.unshift(main)
		return prioritized
	}

	private getTokens(): Record<string, GllmAccountToken> {
		const stateManager = StateManager.get()
		const raw = stateManager.getSecretKey("gllmAccountTokens")
		if (!raw) return {}
		try {
			return JSON.parse(raw) as Record<string, GllmAccountToken>
		} catch {
			return {}
		}
	}

	private async saveTokens(tokens: Record<string, GllmAccountToken>): Promise<void> {
		const stateManager = StateManager.get()
		stateManager.setSecret("gllmAccountTokens", JSON.stringify(tokens))
		await stateManager.flushPendingState()
	}

	getTokenForAccount(accountId: string): GllmAccountToken | undefined {
		return this.getTokens()[accountId]
	}

	// ─── Access Token (with refresh) ─────────────────────────────────────────

	async getAccessToken(accountId: string): Promise<string> {
		const accounts = this.getAccounts()
		const account = accounts.find((a) => a.id === accountId)
		if (!account) throw new Error(`Account not found: ${accountId}`)

		if (account.authType === "apikey" && account.apiKey) {
			return account.apiKey
		}

		// Check memory cache
		const cached = this.tokenCache.get(accountId)
		if (cached && cached.expiresAt > Date.now() + TOKEN_REFRESH_BUFFER_MS) {
			return cached.token
		}

		const storedToken = this.getTokenForAccount(accountId)
		if (!storedToken) throw new Error(`No token stored for account: ${accountId}`)

		// Check if stored access token is still valid
		if (storedToken.accessToken && storedToken.expiresAt && storedToken.expiresAt > Date.now() + TOKEN_REFRESH_BUFFER_MS) {
			this.tokenCache.set(accountId, { token: storedToken.accessToken, expiresAt: storedToken.expiresAt })
			return storedToken.accessToken
		}

		// Refresh token
		if (!storedToken.refreshToken) throw new Error(`No refresh token for account: ${accountId}`)

		const refreshed = await this.refreshToken(storedToken)
		const updatedToken = { ...storedToken, ...refreshed }

		const tokens = this.getTokens()
		tokens[accountId] = updatedToken
		await this.saveTokens(tokens)

		this.tokenCache.set(accountId, { token: refreshed.accessToken!, expiresAt: refreshed.expiresAt! })
		return refreshed.accessToken!
	}

	private async refreshToken(token: GllmAccountToken): Promise<Partial<GllmAccountToken>> {
		const params = new URLSearchParams({
			grant_type: "refresh_token",
			client_id: token.clientId,
			client_secret: token.clientSecret,
			refresh_token: token.refreshToken!,
		})

		const res = await fetch(GOOGLE_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: params.toString(),
		})

		if (!res.ok) {
			const body = await res.text()
			throw new Error(`Token refresh failed: ${res.status} ${body}`)
		}

		const data = (await res.json()) as {
			access_token: string
			expires_in: number
			refresh_token?: string
		}

		return {
			accessToken: data.access_token,
			expiresAt: Date.now() + data.expires_in * 1000,
			...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
		}
	}

	private async loadProjectId(account: GllmAccount, accessToken?: string): Promise<string> {
		const config = PROVIDER_OAUTH[account.provider]
		if (!config) throw new Error(`No OAuth config for provider: ${account.provider}`)
		const token = accessToken ?? (await this.getAccessToken(account.id))

		const res = await fetch(LOAD_CODE_ASSIST_URL, {
			method: "POST",
			headers: getProjectHeaders(account.provider, token),
			body: JSON.stringify({ metadata: { ideType: config.ideType } }),
		})

		if (!res.ok) throw new Error(`loadCodeAssist failed: ${res.status}`)
		const data = (await res.json()) as { cloudaicompanionProject?: string }
		if (!data.cloudaicompanionProject) throw new Error(`No project ID returned for account: ${account.id}`)
		return data.cloudaicompanionProject
	}

	// ─── Project ID ──────────────────────────────────────────────────────────

	async getProjectId(accountId: string): Promise<string> {
		const accounts = this.getAccounts()
		const account = accounts.find((a) => a.id === accountId)
		if (!account) throw new Error(`Account not found: ${accountId}`)

		if (account.projectId) return account.projectId

		return this.refreshProjectId(accountId)
	}

	async refreshProjectId(accountId: string, accessToken?: string): Promise<string> {
		const accounts = this.getAccounts()
		const account = accounts.find((a) => a.id === accountId)
		if (!account) throw new Error(`Account not found: ${accountId}`)
		if (account.provider === "gemini") throw new Error("Gemini API accounts don't have a project ID")

		const projectId = await this.loadProjectId(account, accessToken)
		const updated = accounts.map((existingAccount) =>
			existingAccount.id === accountId ? { ...existingAccount, projectId } : existingAccount,
		)
		await this.saveAccounts(updated)
		return projectId
	}

	async refreshDynamicModelMetadata(): Promise<void> {
		const accounts = this.getAccounts().filter(
			(account) => account.provider === "antigravity" || account.provider === "gemini" || account.provider === "gemini-cli",
		)
		await Promise.allSettled(accounts.map((account) => this.refreshAvailableModels(account.id)))
	}

	async refreshAvailableModels(accountId: string, accessToken?: string, force = false): Promise<string[]> {
		const accounts = this.getAccounts()
		const account = accounts.find((candidate) => candidate.id === accountId)
		if (!account) {
			throw new Error(`Account not found: ${accountId}`)
		}
		if (account.provider !== "antigravity" && account.provider !== "gemini" && account.provider !== "gemini-cli") {
			return account.availableModels ?? []
		}

		const lastRefreshAt = this.dynamicModelRefreshAt.get(accountId) ?? 0
		if (!force && lastRefreshAt > Date.now() - DYNAMIC_MODELS_REFRESH_INTERVAL_MS) {
			return account.availableModels ?? []
		}

		const inFlight = this.dynamicModelRefreshPromises.get(accountId)
		if (inFlight) {
			return inFlight
		}

		const refreshPromise = this.loadAvailableModels(account, accessToken)
			.then(async (availableModels) => {
				this.dynamicModelRefreshAt.set(accountId, Date.now())

				const latestAccounts = this.getAccounts()
				const latestAccount = latestAccounts.find((candidate) => candidate.id === accountId)
				if (!latestAccount) {
					return availableModels
				}

				const nextModel = pickBestAvailableModel(latestAccount.provider, latestAccount.model, availableModels)
				const hasChanged =
					!sameStringArray(latestAccount.availableModels, availableModels) || latestAccount.model !== nextModel

				if (hasChanged) {
					const updatedAccounts = latestAccounts.map((candidate) =>
						candidate.id === accountId ? { ...candidate, availableModels, model: nextModel } : candidate,
					)
					await this.saveAccounts(updatedAccounts)
				}

				return availableModels
			})
			.finally(() => {
				this.dynamicModelRefreshPromises.delete(accountId)
			})

		this.dynamicModelRefreshPromises.set(accountId, refreshPromise)
		return refreshPromise
	}

	private async loadAvailableModels(account: GllmAccount, accessToken?: string): Promise<string[]> {
		if (account.provider === "gemini") {
			if (!account.apiKey) {
				return []
			}
			const models = await loadGeminiApiModelsRequest(account.apiKey)
			return orderModels(models, GEMINI_MODEL_PREFERENCE)
		}

		if (account.provider === "gemini-cli") {
			const token = accessToken ?? (await this.getAccessToken(account.id))
			const projectId = account.projectId ?? (await this.refreshProjectId(account.id, token))
			const models = await loadCodeAssistQuotaModelsRequest(projectId, token)
			return orderModels(models, GEMINI_CLI_MODEL_PREFERENCE)
		}

		const token = accessToken ?? (await this.getAccessToken(account.id))
		const projectId = account.projectId ?? (await this.refreshProjectId(account.id, token))
		const models = await loadAvailableModelsRequest(projectId, token)
		return orderModels(Object.keys(models), ANTIGRAVITY_MODEL_PREFERENCE)
	}

	// ─── Primary Account (first in list) ─────────────────────────────────────

	getPrimaryAccount(): GllmAccount | undefined {
		const accounts = this.getAccountsByPriority()
		return accounts.length > 0 ? accounts[0] : undefined
	}

	getMainAccount(): GllmAccount | undefined {
		return this.getPrimaryAccount()
	}

	async setMainAccount(accountId: string): Promise<void> {
		const accounts = this.getAccounts()
		const currentIndex = accounts.findIndex((account) => account.id === accountId)
		if (currentIndex === -1) {
			throw new Error(`Account not found: ${accountId}`)
		}

		const reordered = [...accounts]
		const [selected] = reordered.splice(currentIndex, 1)
		reordered.unshift(selected)
		const updated = reordered.map((account, index) => ({ ...account, isMain: index === 0 }))
		await this.saveAccounts(updated)
	}

	async reorderAccounts(accountIds: string[]): Promise<void> {
		const accounts = this.getAccounts()
		const accountMap = new Map(accounts.map((account) => [account.id, account]))
		const reordered = accountIds
			.map((accountId) => accountMap.get(accountId))
			.filter((account): account is GllmAccount => !!account)
		const remaining = accounts.filter((account) => !accountIds.includes(account.id))
		const updated = [...reordered, ...remaining].map((account, index) => ({ ...account, isMain: index === 0 }))
		await this.saveAccounts(updated)
	}

	async updateAccountModel(accountId: string, model: string): Promise<void> {
		const accounts = this.getAccounts()
		const updated = accounts.map((a) => (a.id === accountId ? { ...a, model } : a))
		await this.saveAccounts(updated)
	}

	async removeAccount(accountId: string): Promise<void> {
		const accounts = this.getAccounts().filter((a) => a.id !== accountId)

		// If removed account was main, set first remaining as main
		if (!accounts.some((a) => a.isMain) && accounts.length > 0) {
			accounts[0].isMain = true
		}

		const tokens = this.getTokens()
		delete tokens[accountId]
		this.tokenCache.delete(accountId)

		await this.saveAccounts(accounts)
		await this.saveTokens(tokens)
	}

	async updateAccountApiKey(accountId: string, apiKey: string): Promise<void> {
		const accounts = this.getAccounts()
		const updated = accounts.map((a) => (a.id === accountId ? { ...a, apiKey } : a))
		await this.saveAccounts(updated)
		try {
			await this.refreshAvailableModels(accountId, undefined, true)
		} catch (error) {
			Logger.warn(
				`[GllmAccountManager] Failed to fetch Gemini API models for ${accountId}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}
	}

	private async createApiKeyAccount(): Promise<void> {
		const accounts = this.getAccounts()
		const id = `gemini-${randomUUID().slice(0, 8)}`
		const newAccount: GllmAccount = {
			id,
			provider: "gemini",
			authType: "apikey",
			label: "Gemini API",
			model: "gemini-2.5-pro",
			isMain: accounts.length === 0,
		}
		await this.saveAccounts([...accounts, newAccount])
		Logger.log(`[GllmAccountManager] Created Gemini API account: ${id}`)
	}

	// ─── OAuth Login ─────────────────────────────────────────────────────────

	async startOAuthLogin(provider: GllmProviderType): Promise<void> {
		if (provider === "gemini") {
			return this.createApiKeyAccount()
		}
		const config = PROVIDER_OAUTH[provider]
		if (!config) throw new Error(`No OAuth config for provider: ${provider}`)
		const { port, server, waitForCode } = await this.startCallbackServer()
		const redirectUri = `http://localhost:${port}/oauth-callback`

		const params = new URLSearchParams({
			client_id: config.clientId,
			redirect_uri: redirectUri,
			response_type: "code",
			scope: config.scopes.join(" "),
			access_type: "offline",
			prompt: "consent",
		})

		const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`
		await openExternal(authUrl)

		Logger.log(`[GllmAccountManager] OAuth login started for ${provider}, waiting for callback...`)

		let code: string
		try {
			code = await Promise.race([
				waitForCode(),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("OAuth timeout")), OAUTH_TIMEOUT_MS)),
			])
		} finally {
			server.close()
		}

		const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: redirectUri,
				client_id: config.clientId,
				client_secret: config.clientSecret,
			}).toString(),
		})

		if (!tokenRes.ok) {
			const body = await tokenRes.text()
			throw new Error(`Token exchange failed: ${tokenRes.status} ${body}`)
		}

		const tokens = (await tokenRes.json()) as {
			access_token: string
			refresh_token?: string
			expires_in: number
		}

		// Get user info
		const userInfoRes = await fetch(GOOGLE_USERINFO_URL, {
			headers: { Authorization: `Bearer ${tokens.access_token}` },
		})
		const userInfo = (await userInfoRes.json()) as { email?: string }

		// Get project ID
		let projectId: string | undefined
		try {
			const projectRes = await fetch(LOAD_CODE_ASSIST_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokens.access_token}` },
				body: JSON.stringify({ metadata: { ideType: config.ideType } }),
			})
			if (projectRes.ok) {
				const d = (await projectRes.json()) as { cloudaicompanionProject?: string }
				projectId = d.cloudaicompanionProject
			}
		} catch {
			// project ID can be resolved lazily later
		}

		await this.saveNewAccount(provider, config, tokens, userInfo.email, projectId)
		Logger.log(`[GllmAccountManager] OAuth login completed for ${provider}: ${userInfo.email}`)
	}

	private async saveNewAccount(
		provider: GllmProviderType,
		config: GoogleOAuthConfig,
		tokens: { access_token: string; refresh_token?: string; expires_in: number },
		email: string | undefined,
		projectId: string | undefined,
	): Promise<void> {
		const accounts = this.getAccounts()
		const id = `${provider}-${randomUUID().slice(0, 8)}`
		const isMain = accounts.length === 0 || !accounts.some((a) => a.isMain)

		const defaultModel = provider === "gemini-cli" ? "gemini-3.1-pro-preview" : "gemini-3-pro-high"

		const newAccount: GllmAccount = {
			id,
			provider,
			authType: "oauth",
			label: email ?? id,
			email,
			projectId,
			model: defaultModel,
			isMain,
		}

		const storedTokens = this.getTokens()
		storedTokens[id] = {
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token,
			expiresAt: Date.now() + tokens.expires_in * 1000,
			clientId: config.clientId,
			clientSecret: config.clientSecret,
		}

		await this.saveAccounts([...accounts, newAccount])
		await this.saveTokens(storedTokens)

		this.tokenCache.set(id, { token: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 })

		if (provider === "antigravity") {
			try {
				await this.refreshAvailableModels(id, tokens.access_token, true)
			} catch (error) {
				Logger.warn(
					`[GllmAccountManager] Failed to fetch Antigravity models for ${id}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				)
			}
		}
	}

	// ─── Import from ~/.gemini/oauth_creds.json ──────────────────────────────

	async importGeminiCliCredentials(): Promise<{ success: boolean; message: string }> {
		const geminiPath = path.join(os.homedir(), ".gemini", "oauth_creds.json")

		if (!fs.existsSync(geminiPath)) {
			return { success: false, message: `File not found: ${geminiPath}` }
		}

		const accounts = this.getAccounts()
		if (accounts.some((a) => a.provider === "gemini-cli" && a.authType === "oauth")) {
			return { success: false, message: "Gemini CLI credentials already imported" }
		}

		try {
			const raw = JSON.parse(fs.readFileSync(geminiPath, "utf-8")) as {
				access_token?: string
				refresh_token?: string
				expiry_date?: number
			}

			const config = PROVIDER_OAUTH["gemini-cli"]!
			const id = "gemini-cli-imported"
			const isMain = accounts.length === 0 || !accounts.some((a) => a.isMain)

			const newAccount: GllmAccount = {
				id,
				provider: "gemini-cli",
				authType: "oauth",
				label: "Gemini CLI (imported)",
				model: "gemini-3.1-pro-preview",
				isMain,
			}

			const storedTokens = this.getTokens()
			storedTokens[id] = {
				accessToken: raw.access_token,
				refreshToken: raw.refresh_token,
				expiresAt: raw.expiry_date,
				clientId: config.clientId,
				clientSecret: config.clientSecret,
			}

			await this.saveAccounts([...accounts, newAccount])
			await this.saveTokens(storedTokens)

			return { success: true, message: `Imported Gemini CLI credentials from ${geminiPath}` }
		} catch (err) {
			return { success: false, message: `Failed to import: ${err instanceof Error ? err.message : String(err)}` }
		}
	}

	// ─── Local HTTP callback server ───────────────────────────────────────────

	private async startCallbackServer(): Promise<{
		port: number
		server: http.Server
		waitForCode: () => Promise<string>
	}> {
		let codeResolve: ((code: string) => void) | null = null
		const codePromise = new Promise<string>((resolve) => {
			codeResolve = resolve
		})

		for (let offset = 0; offset < CALLBACK_PORT_RANGE; offset++) {
			const port = CALLBACK_PORT_START + offset
			try {
				const server = http.createServer((req, res) => {
					const url = new URL(req.url || "/", `http://localhost:${port}`)
					if (url.pathname === "/oauth-callback") {
						const code = url.searchParams.get("code")
						if (code && codeResolve) codeResolve(code)
						res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
						res.end("<h1>Login successful!</h1><p>You can close this tab.</p>")
					} else {
						res.writeHead(404)
						res.end()
					}
				})

				await new Promise<void>((resolve, reject) => {
					server.listen(port, () => resolve())
					server.on("error", reject)
				})

				return { port, server, waitForCode: () => codePromise }
			} catch {
				if (offset === CALLBACK_PORT_RANGE - 1) throw new Error("No available OAuth callback port")
			}
		}

		throw new Error("No available OAuth callback port")
	}
}

function getProjectHeaders(provider: GllmProviderType, token: string): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${token}`,
	}

	if (provider === "antigravity") {
		headers["User-Agent"] = getAntigravityUserAgent()
	}

	return headers
}

async function loadAvailableModelsRequest(
	projectId: string,
	accessToken: string,
): Promise<Record<string, { quotaInfo?: { remainingFraction?: number; resetTime?: string } }>> {
	const response = await fetch(FETCH_AVAILABLE_MODELS_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
			"User-Agent": getAntigravityUserAgent(),
		},
		body: JSON.stringify({ project: projectId }),
	})

	if (!response.ok) {
		const body = await response.text()
		throw new Error(`fetchAvailableModels failed: ${response.status} ${body}`)
	}

	const data = (await response.json()) as {
		models?: Record<string, { quotaInfo?: { remainingFraction?: number; resetTime?: string } }>
	}
	return data.models ?? {}
}

function pickBestAvailableModel(provider: GllmProviderType, currentModel: string | undefined, availableModels: string[]): string {
	if (currentModel && availableModels.includes(currentModel)) {
		return currentModel
	}

	const preferredModels =
		provider === "gemini"
			? GEMINI_MODEL_PREFERENCE
			: provider === "gemini-cli"
				? GEMINI_CLI_MODEL_PREFERENCE
				: ANTIGRAVITY_MODEL_PREFERENCE
	for (const preferredModel of preferredModels) {
		if (availableModels.includes(preferredModel)) {
			return preferredModel
		}
	}

	return (
		availableModels[0] ??
		currentModel ??
		(provider === "gemini" ? "gemini-2.5-pro" : provider === "gemini-cli" ? "gemini-3.1-pro-preview" : "gemini-3-pro-high")
	)
}

function sameStringArray(left?: string[], right?: string[]): boolean {
	if ((left?.length ?? 0) !== (right?.length ?? 0)) {
		return false
	}
	return (left ?? []).every((value, index) => value === right?.[index])
}

function orderModels(models: string[], preference: string[]): string[] {
	const seen = new Set<string>()
	const ordered: string[] = []

	for (const model of preference) {
		if (models.includes(model) && !seen.has(model)) {
			ordered.push(model)
			seen.add(model)
		}
	}

	for (const model of models) {
		if (!seen.has(model)) {
			ordered.push(model)
			seen.add(model)
		}
	}

	return ordered
}

async function loadGeminiApiModelsRequest(apiKey: string): Promise<string[]> {
	const models: string[] = []
	let pageToken: string | undefined

	while (true) {
		const params = new URLSearchParams({ key: apiKey, pageSize: "1000" })
		if (pageToken) {
			params.set("pageToken", pageToken)
		}

		const response = await fetch(`${GEMINI_LIST_MODELS_URL}?${params.toString()}`)
		if (!response.ok) {
			const body = await response.text()
			throw new Error(`Gemini models.list failed: ${response.status} ${body}`)
		}

		const data = (await response.json()) as {
			models?: Array<{
				name?: string
				baseModelId?: string
				supportedGenerationMethods?: string[]
			}>
			nextPageToken?: string
		}

		for (const model of data.models ?? []) {
			const supportsGenerateContent = model.supportedGenerationMethods?.includes("generateContent")
			const modelId = model.baseModelId ?? model.name?.replace(/^models\//, "")
			if (!supportsGenerateContent || !modelId || !modelId.startsWith("gemini-")) {
				continue
			}
			models.push(modelId)
		}

		if (!data.nextPageToken) {
			break
		}
		pageToken = data.nextPageToken
	}

	return [...new Set(models)]
}

async function loadCodeAssistQuotaModelsRequest(projectId: string, accessToken: string): Promise<string[]> {
	const response = await fetch(RETRIEVE_USER_QUOTA_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify({ project: projectId }),
	})

	if (!response.ok) {
		const body = await response.text()
		throw new Error(`retrieveUserQuota failed: ${response.status} ${body}`)
	}

	const data = (await response.json()) as {
		buckets?: Array<{
			modelId?: string
		}>
	}

	return [...new Set((data.buckets ?? []).map((bucket) => bucket.modelId).filter((modelId): modelId is string => !!modelId))]
}

function getAntigravityUserAgent(): string {
	const version = "1.15.8"
	const platform = process.platform === "darwin" ? "macos" : process.platform
	return `antigravity/${version} ${platform}/${process.arch}`
}
