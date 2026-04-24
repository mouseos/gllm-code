import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import debounce from "debounce"
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"

// Type definitions
interface ContextWindowInfoProps {
	tokensIn?: number
	tokensOut?: number
	cacheWrites?: number
	cacheReads?: number
	size?: number
}

interface ContextWindowProgressProps extends ContextWindowInfoProps {
	useAutoCondense: boolean
	lastApiReqTotalTokens?: number
	contextWindow?: number
	onSendMessage?: (command: string, files: string[], images: string[]) => void
}

const ConfirmationDialog = memo<{
	onConfirm: (e: React.MouseEvent) => void
	onCancel: (e: React.MouseEvent) => void
}>(({ onConfirm, onCancel }) => (
	<div className="text-sm my-2 flex items-center gap-0 justify-between">
		<span className="font-semibold text-sm">Compact the current task?</span>
		<span className="flex gap-1">
			<VSCodeButton
				appearance="secondary"
				className="text-sm"
				onClick={onCancel}
				title="No, keep the task as is"
				type="button">
				Cancel
			</VSCodeButton>
			<VSCodeButton
				appearance="primary"
				autoFocus={true}
				className="text-sm"
				onClick={onConfirm}
				title="Yes, compact the task"
				type="button">
				Yes
			</VSCodeButton>
		</span>
	</div>
))
ConfirmationDialog.displayName = "ConfirmationDialog"

const ContextWindow: React.FC<ContextWindowProgressProps> = ({
	contextWindow = 0,
	lastApiReqTotalTokens = 0,
	onSendMessage,
	useAutoCondense,
	tokensIn,
	tokensOut,
	cacheWrites,
	cacheReads,
}) => {
	const [isOpened, setIsOpened] = useState(false)
	const [confirmationNeeded, setConfirmationNeeded] = useState(false)
	const progressBarRef = useRef<HTMLDivElement>(null)

	const handleCompactClick = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault()
			e.stopPropagation()
			setConfirmationNeeded(!confirmationNeeded)
		},
		[confirmationNeeded],
	)

	const handleConfirm = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault()
			e.stopPropagation()
			onSendMessage?.("/compact", [], [])
			setConfirmationNeeded(false)
		},
		[onSendMessage],
	)

	const handleCancel = useCallback((e: React.MouseEvent) => {
		e.preventDefault()
		e.stopPropagation()
		setConfirmationNeeded(false)
	}, [])

	const tokenData = useMemo(() => {
		if (!contextWindow) {
			return null
		}
		return {
			percentage: (lastApiReqTotalTokens / contextWindow) * 100,
			max: contextWindow,
			used: lastApiReqTotalTokens,
		}
	}, [contextWindow, lastApiReqTotalTokens])

	const debounceCloseHover = useCallback((e: React.MouseEvent) => {
		e.preventDefault()
		e.stopPropagation()
		const showHover = debounce((open: boolean) => setIsOpened(open), 100)

		return showHover(false)
	}, [])

	const handleFocus = useCallback(() => {
		setIsOpened(true)
	}, [])

	// Close tooltip when clicking outside
	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			const target = event.target as Element
			const isInsideProgressBar = progressBarRef.current?.contains(target as Node)

			// Check if click is inside any tooltip content by looking for our custom class
			const isInsideTooltipContent = target.closest(".context-window-tooltip-content") !== null

			if (!isInsideProgressBar && !isInsideTooltipContent) {
				setIsOpened(false)
			}
		}

		if (isOpened) {
			document.addEventListener("mousedown", handleClickOutside)
			return () => document.removeEventListener("mousedown", handleClickOutside)
		}
	}, [isOpened])

	// Claude-style chat UI: hide the context-window bar in the task header.
	// Users can still invoke /compact from the input to condense context.
	// `tokenData` / hover handlers are kept to preserve hook order.
	void tokenData
	void debounceCloseHover
	void handleFocus
	void handleCompactClick
	void handleConfirm
	void handleCancel
	void progressBarRef
	void confirmationNeeded
	void isOpened
	return null
}

export default memo(ContextWindow)
