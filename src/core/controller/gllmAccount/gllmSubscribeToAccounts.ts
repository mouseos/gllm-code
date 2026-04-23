import { GllmAccount } from "@shared/api"
import { EmptyRequest } from "@shared/proto/cline/common"
import { GllmAccountList, GllmAccount as ProtoGllmAccount } from "@shared/proto/cline/gllm_account"
import { GllmAccountManager } from "@/services/auth/gllm/GllmAccountManager"
import { Controller } from ".."
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"

function toProtoAccount(account: GllmAccount): ProtoGllmAccount {
	return ProtoGllmAccount.create({
		id: account.id,
		provider: account.provider,
		authType: account.authType,
		label: account.label,
		email: account.email,
		projectId: account.projectId,
		model: account.model,
		isMain: account.isMain,
		apiKey: account.apiKey,
		availableModels: account.availableModels ?? [],
		quotaBuckets: account.quotaBuckets ?? [],
		quotaStatus: account.quotaStatus,
		quotaError: account.quotaError,
		quotaUpdatedAt: account.quotaUpdatedAt,
	})
}

export async function gllmSubscribeToAccounts(
	_controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<GllmAccountList>,
	requestId?: string,
): Promise<void> {
	const manager = GllmAccountManager.getInstance()

	const sendAccounts = async () => {
		const accounts = manager.getAccounts()
		await responseStream(GllmAccountList.create({ accounts: accounts.map(toProtoAccount) }), false)
	}

	const unsubscribe = manager.onAccountsChanged(sendAccounts)

	if (requestId) {
		getRequestRegistry().registerRequest(requestId, unsubscribe, { type: "gllm_accounts_subscription" }, responseStream)
	}

	// Send initial state
	await sendAccounts()
	void manager.refreshDynamicModelMetadata()
}
