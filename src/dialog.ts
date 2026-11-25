import { App, ButtonComponent, Modal } from "obsidian";

/**
 * Shows `message` with Cancel and an action button in an Obsidian dialog
 * (the browser's own confirm() blocks, and isn't available on mobile).
 * Resolves true only if the action button was pressed; closing the dialog
 * any other way counts as "no".
 */
export function askToConfirm(app: App, message: string, action: string): Promise<boolean> {
	return new Promise((resolve) => {
		let confirmed = false;
		const dialog = new Modal(app);
		dialog.contentEl.createEl("p", { text: message });
		const row = dialog.contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(row).setButtonText("Cancel").onClick(() => dialog.close());
		new ButtonComponent(row)
			.setButtonText(action)
			.setWarning()
			.onClick(() => {
				confirmed = true;
				dialog.close();
			});
		dialog.onClose = () => resolve(confirmed);
		dialog.open();
	});
}
