import { base } from "$app/paths";
import { goto } from "$app/navigation";
import { pendingChatInput } from "$lib/stores/pendingChatInput";

/** Transfer a draft within this tab, without including user text in URLs or submitting it. */
export async function openWorkspaceDraft(draft: string): Promise<void> {
	pendingChatInput.set(draft);
	try {
		await goto(`${base}/`);
	} catch (error) {
		pendingChatInput.set(undefined);
		throw error;
	}
}
