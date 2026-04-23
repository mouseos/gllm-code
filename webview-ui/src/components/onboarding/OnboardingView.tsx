import { AlertCircleIcon, CircleCheckIcon, CircleIcon, KeyIcon, LogInIcon, UserIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import gllmLogo from "@/assets/gllm-logo.png"
import { Button } from "@/components/ui/button"
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { PLATFORM_CONFIG } from "@/config/platform.config"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { StateServiceClient } from "@/services/grpc-client"
import GllmAccountsSection from "../settings/sections/GllmAccountsSection"
import { NEW_USER_TYPE, STEP_CONFIG, USER_TYPE_SELECTIONS } from "./data-steps"

type GeminiCliCredentials = {
	email: string | null
	hasCredentials: boolean
}

const GeminiCliLoginStep = () => {
	const [credentials, setCredentials] = useState<GeminiCliCredentials>({ email: null, hasCredentials: false })
	const [selectedOption, setSelectedOption] = useState<"existing" | "new" | null>(null)

	useEffect(() => {
		// Request Gemini CLI credentials check from extension
		const handler = (event: MessageEvent) => {
			const msg = event.data
			if (msg.type === "geminiCliCredentials") {
				setCredentials({ email: msg.email, hasCredentials: msg.hasCredentials })
				if (msg.hasCredentials) {
					setSelectedOption("existing")
				}
			}
		}
		window.addEventListener("message", handler)

		// Ask extension to check for existing credentials
		PLATFORM_CONFIG.postMessage({ type: "checkGeminiCliCredentials" })

		return () => window.removeEventListener("message", handler)
	}, [])

	return (
		<div className="flex flex-col w-full items-center">
			<div className="flex w-full max-w-lg flex-col gap-3 my-2">
				{credentials.hasCredentials && credentials.email && (
					<Item
						className={cn("cursor-pointer hover:cursor-pointer w-full", {
							"bg-input-background/50 border border-input-foreground/30": selectedOption === "existing",
						})}
						onClick={() => setSelectedOption("existing")}>
						<ItemMedia className="[&_svg]:stroke-button-background" variant="icon">
							{selectedOption === "existing" ? (
								<CircleCheckIcon className="stroke-1.5" />
							) : (
								<CircleIcon className="stroke-1" />
							)}
						</ItemMedia>
						<ItemContent className="w-full">
							<ItemTitle>
								<UserIcon className="inline size-4 mr-1" />
								{credentials.email} でログイン
							</ItemTitle>
							<ItemDescription>既存のGemini CLI認証情報を使用</ItemDescription>
						</ItemContent>
					</Item>
				)}

				<Item
					className={cn("cursor-pointer hover:cursor-pointer w-full", {
						"bg-input-background/50 border border-input-foreground/30": selectedOption === "new",
					})}
					onClick={() => {
						setSelectedOption("new")
						PLATFORM_CONFIG.postMessage({ type: "geminiCliLogin" })
					}}>
					<ItemMedia className="[&_svg]:stroke-button-background" variant="icon">
						{selectedOption === "new" ? (
							<CircleCheckIcon className="stroke-1.5" />
						) : (
							<CircleIcon className="stroke-1" />
						)}
					</ItemMedia>
					<ItemContent className="w-full">
						<ItemTitle>
							<LogInIcon className="inline size-4 mr-1" />
							{credentials.hasCredentials ? "ほかのアカウントでログイン" : "Gemini CLI でログイン"}
						</ItemTitle>
						<ItemDescription>ブラウザでGoogleアカウント認証</ItemDescription>
					</ItemContent>
				</Item>
			</div>
		</div>
	)
}

const AntigravityLoginStep = () => {
	return (
		<div className="flex flex-col w-full items-center">
			<div className="flex w-full max-w-lg flex-col gap-3 my-2">
				<Item
					className="cursor-pointer hover:cursor-pointer w-full"
					onClick={() => PLATFORM_CONFIG.postMessage({ type: "antigravityLogin" })}>
					<ItemMedia className="[&_svg]:stroke-button-background" variant="icon">
						<LogInIcon className="stroke-1.5" />
					</ItemMedia>
					<ItemContent className="w-full">
						<ItemTitle>Antigravity でログイン</ItemTitle>
						<ItemDescription>ブラウザでGoogleアカウント認証</ItemDescription>
					</ItemContent>
				</Item>
			</div>
		</div>
	)
}

type UserTypeSelectionProps = {
	userType: NEW_USER_TYPE | undefined
	onSelectUserType: (type: NEW_USER_TYPE) => void
}

const UserTypeSelectionStep = ({ userType, onSelectUserType }: UserTypeSelectionProps) => (
	<div className="flex flex-col w-full items-center">
		<div className="flex w-full max-w-lg flex-col gap-3 my-2">
			{USER_TYPE_SELECTIONS.map((option) => {
				const isSelected = userType === option.type
				const Icon =
					option.type === NEW_USER_TYPE.BYOK
						? KeyIcon
						: option.type === NEW_USER_TYPE.GEMINI_CLI
							? LogInIcon
							: LogInIcon

				return (
					<Item
						className={cn("cursor-pointer hover:cursor-pointer w-full", {
							"bg-input-background/50 border border-input-foreground/30": isSelected,
						})}
						key={option.type}
						onClick={() => onSelectUserType(option.type)}>
						<ItemMedia className="[&_svg]:stroke-button-background" variant="icon">
							{isSelected ? <CircleCheckIcon className="stroke-1.5" /> : <CircleIcon className="stroke-1" />}
						</ItemMedia>
						<ItemContent className="w-full">
							<ItemTitle>{option.title}</ItemTitle>
							<ItemDescription>{option.description}</ItemDescription>
						</ItemContent>
					</Item>
				)
			})}
		</div>
	</div>
)

type OnboardingStepContentProps = {
	step: number
	userType: NEW_USER_TYPE | undefined
}

const OnboardingStepContent = ({ step, userType }: OnboardingStepContentProps) => {
	if (step === 0) {
		return <UserTypeSelectionStep onSelectUserType={() => {}} userType={userType} />
	}
	if (userType === NEW_USER_TYPE.GEMINI_CLI) {
		return <GeminiCliLoginStep />
	}
	if (userType === NEW_USER_TYPE.ANTIGRAVITY) {
		return <AntigravityLoginStep />
	}
	return <GllmAccountsSection renderSectionHeader={() => null} />
}

const OnboardingView = () => {
	const { hideSettings, hideAccount, setShowWelcome } = useExtensionState()

	const [stepNumber, setStepNumber] = useState(0)
	const [userType, setUserType] = useState<NEW_USER_TYPE>(NEW_USER_TYPE.GEMINI_CLI)

	const onUserTypeClick = useCallback((type: NEW_USER_TYPE) => {
		setUserType(type)
	}, [])

	const handleFooterAction = useCallback(
		async (action: string) => {
			switch (action) {
				case "next":
					setStepNumber(1)
					break
				case "back":
					setStepNumber(0)
					break
				case "done":
					await StateServiceClient.setWelcomeViewCompleted({ value: true }).catch(() => {})
					setShowWelcome(false)
					hideAccount()
					hideSettings()
					break
			}
		},
		[hideAccount, hideSettings, setShowWelcome],
	)

	const stepDisplayInfo = useMemo(() => {
		if (stepNumber === 0) {
			return STEP_CONFIG[0]
		}
		if (userType) {
			return STEP_CONFIG[userType]
		}
		return STEP_CONFIG[0]
	}, [stepNumber, userType])

	return (
		<div className="fixed inset-0 p-0 flex flex-col w-full">
			<div className="h-full px-5 xs:mx-10 overflow-auto flex flex-col gap-4 items-center justify-center">
				<img alt="GLLM Code" className="size-16 flex-shrink-0" src={gllmLogo} />
				<h2 className="text-lg font-semibold p-0 flex-shrink-0">{stepDisplayInfo.title}</h2>
				{"description" in stepDisplayInfo && stepDisplayInfo.description && (
					<p className="text-foreground text-sm text-center m-0 p-0 flex-shrink-0">{stepDisplayInfo.description}</p>
				)}

				<div className="flex-1 w-full flex max-w-lg overflow-y-auto min-h-0">
					{stepNumber === 0 ? (
						<UserTypeSelectionStep onSelectUserType={onUserTypeClick} userType={userType} />
					) : (
						<OnboardingStepContent step={stepNumber} userType={userType} />
					)}
				</div>

				<footer className="flex w-full max-w-lg flex-col gap-3 my-2 px-2 overflow-hidden flex-shrink-0">
					{stepDisplayInfo.buttons.map((btn) => (
						<Button
							className="w-full rounded-xs"
							key={btn.text}
							onClick={() => handleFooterAction(btn.action)}
							variant={btn.variant}>
							{btn.text}
						</Button>
					))}

					<div className="items-center justify-center flex text-sm text-foreground gap-2 mb-3 text-pretty">
						<AlertCircleIcon className="shrink-0 size-2" /> You can change this later in settings
					</div>
				</footer>
			</div>
		</div>
	)
}

export default OnboardingView
