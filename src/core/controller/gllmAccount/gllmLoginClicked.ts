import { GllmProviderType } from "@shared/api"
import { Empty, StringRequest } from "@shared/proto/cline/common"
import { GllmAccountManager } from "@/services/auth/gllm/GllmAccountManager"
import { Controller } from ".."

export async function gllmLoginClicked(_controller: Controller, request: StringRequest): Promise<Empty> {
	const provider = request.value as GllmProviderType
	await GllmAccountManager.getInstance().startOAuthLogin(provider)
	return Empty.create({})
}
