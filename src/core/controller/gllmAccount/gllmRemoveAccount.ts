import { Empty, StringRequest } from "@shared/proto/cline/common"
import { GllmAccountManager } from "@/services/auth/gllm/GllmAccountManager"
import { Controller } from ".."

export async function gllmRemoveAccount(_controller: Controller, request: StringRequest): Promise<Empty> {
	await GllmAccountManager.getInstance().removeAccount(request.value)
	return Empty.create({})
}
