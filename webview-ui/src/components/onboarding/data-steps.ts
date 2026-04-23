export enum NEW_USER_TYPE {
	GEMINI_CLI = "gemini-cli",
	ANTIGRAVITY = "antigravity",
	BYOK = "byok",
}

type UserTypeSelection = {
	title: string
	description: string
	type: NEW_USER_TYPE
}

export const STEP_CONFIG = {
	0: {
		title: "How will you use GLLM Code?",
		description: "Select an option below to get started.",
		buttons: [{ text: "Continue", action: "next", variant: "default" }],
	},
	[NEW_USER_TYPE.GEMINI_CLI]: {
		title: "Gemini CLI Login",
		buttons: [
			{ text: "Continue", action: "done", variant: "default" },
			{ text: "Back", action: "back", variant: "secondary" },
		],
	},
	[NEW_USER_TYPE.ANTIGRAVITY]: {
		title: "Antigravity Login",
		buttons: [
			{ text: "Continue", action: "done", variant: "default" },
			{ text: "Back", action: "back", variant: "secondary" },
		],
	},
	[NEW_USER_TYPE.BYOK]: {
		title: "Gemini API Account",
		buttons: [
			{ text: "Continue", action: "done", variant: "default" },
			{ text: "Back", action: "back", variant: "secondary" },
		],
	},
} as const

export const USER_TYPE_SELECTIONS: UserTypeSelection[] = [
	{ title: "Gemini CLI", description: "Login with Gemini Code Assist credentials", type: NEW_USER_TYPE.GEMINI_CLI },
	{ title: "Antigravity", description: "Login with Antigravity credentials", type: NEW_USER_TYPE.ANTIGRAVITY },
	{ title: "Gemini API", description: "Add a Gemini API key account", type: NEW_USER_TYPE.BYOK },
]
