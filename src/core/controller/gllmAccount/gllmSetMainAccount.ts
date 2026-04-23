import { Empty, StringRequest } from "@shared/proto/cline/common"
import { GllmAccountManager } from "@/services/auth/gllm/GllmAccountManager"
import { Controller } from ".."

export async function gllmSetMainAccount(_controller: Controller, request: StringRequest): Promise<Empty> {
	await GllmAccountManager.getInstance().setMainAccount(request.value)
	return Empty.create({})
}
