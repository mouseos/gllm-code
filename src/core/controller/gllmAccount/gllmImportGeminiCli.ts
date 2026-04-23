import { EmptyRequest } from "@shared/proto/cline/common"
import { GllmImportResult } from "@shared/proto/cline/gllm_account"
import { GllmAccountManager } from "@/services/auth/gllm/GllmAccountManager"
import { Controller } from ".."

export async function gllmImportGeminiCli(_controller: Controller, _request: EmptyRequest): Promise<GllmImportResult> {
	const result = await GllmAccountManager.getInstance().importGeminiCliCredentials()
	return GllmImportResult.create({ success: result.success, message: result.message })
}
