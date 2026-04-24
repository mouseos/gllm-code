export type TaskOrigin = "webview" | "mcp" | "cli"

export type HistoryItem = {
	id: string
	ulid?: string // ULID for better tracking and metrics
	ts: number
	task: string
	tokensIn: number
	tokensOut: number
	cacheWrites?: number
	cacheReads?: number
	totalCost: number

	size?: number
	shadowGitConfigWorkTree?: string
	cwdOnTaskInitialization?: string
	conversationHistoryDeletedRange?: [number, number]
	isFavorited?: boolean
	checkpointManagerErrorMessage?: string

	modelId?: string

	// Who spawned this task. Absent for historical entries predating the field
	// — treat as "webview" on read.
	origin?: TaskOrigin
	// For MCP-sourced tasks, the name reported by the connecting client
	// (e.g. "claude-code"). Empty for other origins.
	originClientName?: string
}
