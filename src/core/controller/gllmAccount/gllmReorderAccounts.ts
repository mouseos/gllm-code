import { Controller } from "@core/controller"
import { Empty } from "@shared/proto/cline/common"
import { GllmReorderAccountsRequest } from "@shared/proto/cline/gllm_account"
import { GllmAccountManager } from "@/services/auth/gllm/GllmAccountManager"

export async function gllmReorderAccounts(_controller: Controller, request: GllmReorderAccountsRequest): Promise<Empty> {
	await GllmAccountManager.getInstance().reorderAccounts(request.accountIds)
	return Empty.create({})
}
