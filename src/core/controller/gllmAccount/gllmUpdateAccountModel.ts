import { Empty } from "@shared/proto/cline/common"
import { GllmUpdateModelRequest } from "@shared/proto/cline/gllm_account"
import { GllmAccountManager } from "@/services/auth/gllm/GllmAccountManager"
import { Controller } from ".."

export async function gllmUpdateAccountModel(_controller: Controller, request: GllmUpdateModelRequest): Promise<Empty> {
	await GllmAccountManager.getInstance().updateAccountModel(request.accountId, request.model)
	return Empty.create({})
}
