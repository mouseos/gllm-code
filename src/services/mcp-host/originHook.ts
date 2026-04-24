import type { TaskOrigin } from "@/shared/HistoryItem"

export interface PendingOrigin {
	origin: TaskOrigin
	clientName?: string
}

/**
 * One-shot slot consulted by Controller.initTask to stamp the originating
 * client onto the new HistoryItem. Tools call set() immediately before
 * invoking initTask and clear() immediately after, so there is no risk of
 * leaking the origin onto a subsequent webview-initiated task.
 */
class PendingOriginSlot {
	private value: PendingOrigin | undefined

	set(v: PendingOrigin): void {
		this.value = v
	}

	take(): PendingOrigin | undefined {
		const v = this.value
		this.value = undefined
		return v
	}

	clear(): void {
		this.value = undefined
	}
}

export const pendingOriginForNextInitTask = new PendingOriginSlot()
