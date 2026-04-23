import { Controller } from "@core/controller"
import { Empty } from "@shared/proto/cline/common"
import { GllmUpdateModelRequest } from "@shared/proto/cline/gllm_account"
import { GllmAccountManager } from "@/services/auth/gllm/GllmAccountManager"

export async function gllmUpdateAccountApiKey(_controller: Controller, request: GllmUpdateModelRequest): Promise<Empty> {
	await GllmAccountManager.getInstance().updateAccountApiKey(request.accountId, request.model)
	return Empty.create({})
}
