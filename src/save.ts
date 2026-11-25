import { App, Modal, Notice, Platform, Setting } from "obsidian";

/** What an export produces, and how to describe it to the save dialog. */
export interface ExportFile {
	name: string;
	mime: string;
	/** "PNG image" etc., shown in the save dialog's type list. */
	description: string;
	/** Renders the file. Called after the destination is chosen where
	 * possible, so cancelling the dialog skips the work. */
	make: () => Promise<Blob>;
}

interface SaveFilePickerWindow {
	showSaveFilePicker?: (options: {
		suggestedName: string;
		types: { description: string; accept: Record<string, string[]> }[];
	}) => Promise<{ name: string; createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }> }>;
}

/**
 * Lets the user choose where an export goes:
 * - desktop: the system Save dialog (folder and file name);
 * - iPad/iPhone: the share sheet, whose "Save to Files" picks a folder;
 * - otherwise (or if those fail): `fallback`, which saves into the vault.
 * Must be called straight from a click/tap -- both dialogs need it.
 */
export async function saveExport(app: App, file: ExportFile, fallback: (blob: Blob) => Promise<void>): Promise<void> {
	const ext = file.name.slice(file.name.lastIndexOf("."));
	const picker = (window as unknown as SaveFilePickerWindow).showSaveFilePicker;

	if (Platform.isDesktopApp && picker) {
		let handle;
		try {
			handle = await picker({ suggestedName: file.name, types: [{ description: file.description, accept: { [file.mime]: [ext] } }] });
		} catch (err) {
			if ((err as Error).name === "AbortError") return; // cancelled
			handle = null; // picker unavailable here: fall back below
		}
		if (handle) {
			const writable = await handle.createWritable();
			await writable.write(await file.make());
			await writable.close();
			new Notice(`Exported ${handle.name}`);
			return;
		}
	}

	const blob = await file.make();
	const shared = new File([blob], file.name, { type: file.mime });
	if (!Platform.isDesktopApp && navigator.canShare?.({ files: [shared] })) {
		try {
			await navigator.share({ files: [shared] });
			return;
		} catch (err) {
			const name = (err as Error).name;
			if (name === "AbortError") return; // share sheet dismissed
			// Rendering took long enough that the tap no longer counts as
			// the user's request to share: ask for one more tap.
			if (name === "NotAllowedError") {
				new ShareModal(app, shared).open();
				return;
			}
		}
	}

	await fallback(blob);
}

/** "Your export is ready" with a button, so the share sheet opens from a
 * fresh tap. */
class ShareModal extends Modal {
	constructor(
		app: App,
		private readonly file: File
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("p", { text: `${this.file.name} is ready.` });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Save…")
					.setCta()
					.onClick(() => {
						this.close();
						navigator.share({ files: [this.file] }).catch((err: Error) => {
							if (err.name !== "AbortError") new Notice(`Couldn't share the file: ${err.message}`);
						});
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
