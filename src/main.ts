import { MarkdownPostProcessorContext, Notice, Plugin, TFile, moment, setIcon } from "obsidian";
import { DrawingView } from "./DrawingView";
import { EMPTY_SVG, VIEW_TYPE_DRAWING } from "./constants";

export default class QuickSketchPlugin extends Plugin {
	async onload(): Promise<void> {
		this.registerView(VIEW_TYPE_DRAWING, (leaf) => new DrawingView(leaf));

		this.addRibbonIcon("pencil", "New drawing", () => {
			void this.createNewDrawing();
		});

		this.addCommand({
			id: "new-drawing",
			name: "New drawing",
			callback: () => {
				void this.createNewDrawing();
			},
		});

		this.registerMarkdownPostProcessor((el, ctx) => {
			this.decorateSvgEmbeds(el, ctx);
		});
	}

	onunload(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_DRAWING)) {
			leaf.detach();
		}
	}

	private async createNewDrawing(): Promise<void> {
		const active = this.app.workspace.activeEditor;
		if (!active?.editor || !active.file) {
			new Notice("Open a note first to insert a drawing.");
			return;
		}
		const { editor, file: activeFile } = active;

		const baseName = `Drawing ${moment().format("YYYY-MM-DD HH.mm.ss")}`;
		const path = await this.app.fileManager.getAvailablePathForAttachment(
			`${baseName}.svg`,
			activeFile.path
		);
		const file = await this.app.vault.create(path, EMPTY_SVG);

		const rawLink = this.app.fileManager.generateMarkdownLink(file, activeFile.path);
		const link = rawLink.startsWith("!") ? rawLink : `!${rawLink}`;
		editor.replaceSelection(`${link}\n`);

		await this.openDrawingLeaf(file);
	}

	private async openDrawingLeaf(file: TFile): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_DRAWING).find((leaf) => {
			const state = leaf.view.getState() as { file?: string };
			return state?.file === file.path;
		});
		const leaf = existing ?? this.app.workspace.getLeaf("split", "vertical");
		await leaf.setViewState({
			type: VIEW_TYPE_DRAWING,
			active: true,
			state: { file: file.path },
		});
		this.app.workspace.revealLeaf(leaf);
	}

	/**
	 * Obsidian loads embed content (fetching the image, wrapping it, etc.)
	 * asynchronously *after* markdown post processors run, and can rebuild the
	 * embed's DOM while doing so -- so a one-shot scan can miss the embed, or
	 * a button we already added can get wiped out by that later rebuild. A
	 * MutationObserver rescans and re-adds the button until things settle.
	 */
	private decorateSvgEmbeds(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
		const scan = () => {
			const candidates = new Set<HTMLElement>();
			if (el.matches?.(".internal-embed")) candidates.add(el);
			el.querySelectorAll<HTMLElement>(".internal-embed").forEach((e) => candidates.add(e));

			candidates.forEach((embedEl) => {
				const linkPath = this.getSvgLinkPath(embedEl);
				if (linkPath) this.attachEditButton(embedEl, linkPath, ctx.sourcePath);
			});
		};

		scan();
		if (!el.matches?.(".internal-embed") && !el.querySelector(".internal-embed")) return;

		let idleTimer: number;
		const observer = new MutationObserver(() => {
			scan();
			window.clearTimeout(idleTimer);
			idleTimer = window.setTimeout(() => observer.disconnect(), 2000);
		});
		observer.observe(el, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["src"],
		});
		idleTimer = window.setTimeout(() => observer.disconnect(), 2000);
		this.register(() => {
			window.clearTimeout(idleTimer);
			observer.disconnect();
		});
	}

	private getSvgLinkPath(embedEl: HTMLElement): string | null {
		const src = embedEl.getAttribute("src");
		if (src && /\.svg($|\?)/i.test(src)) return src;

		const alt = embedEl.getAttribute("alt");
		if (alt && /\.svg$/i.test(alt)) return alt;

		const img = embedEl.querySelector("img");
		const imgSrc = img?.getAttribute("src");
		if (imgSrc && /\.svg(\?|$)/i.test(imgSrc)) return src ?? alt ?? imgSrc;

		return null;
	}

	/**
	 * Anchors the button to the img's own wrapper (tight around the actual
	 * rendered image) rather than the outer `.internal-embed`, which can be a
	 * taller/wider box than the image itself and pushes a corner-anchored
	 * button away from the image's real corner. The wrapper only exists once
	 * Obsidian finishes loading the embed, so on an early rescan we fall back
	 * to embedEl and migrate the button once the wrapper shows up.
	 */
	private attachEditButton(embedEl: HTMLElement, linkPath: string, sourcePath: string): void {
		const img = embedEl.querySelector("img");
		const anchor = (img?.parentElement as HTMLElement | null) ?? embedEl;
		anchor.addClass("quick-sketch-embed");

		let btn = embedEl.querySelector<HTMLButtonElement>(".quick-sketch-edit-btn");
		if (btn) {
			if (btn.parentElement !== anchor) anchor.appendChild(btn);
			return;
		}

		btn = anchor.createEl("button", { cls: "quick-sketch-edit-btn" });
		setIcon(btn, "pencil");
		btn.setAttribute("aria-label", "Edit drawing");
		btn.onclick = (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			const target = this.app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath);
			if (!(target instanceof TFile)) {
				new Notice("Couldn't find that drawing file.");
				return;
			}
			void this.openDrawingLeaf(target);
		};
	}
}
