import { Notice, Plugin, TFile, TFolder, moment, normalizePath, setIcon } from "obsidian";
import { DrawingView } from "./DrawingView";
import { EMPTY_SVG, VIEW_TYPE_DRAWING } from "./constants";
import { ICON, addToolbarIcons } from "./icons";
import { DEFAULT_SETTINGS, QuickSketchSettingTab, QuickSketchSettings } from "./settings";

export type { QuickSketchSettings };

export default class QuickSketchPlugin extends Plugin {
	settings: QuickSketchSettings = { ...DEFAULT_SETTINGS };

	/** Latest saved content (as a data: URL) of every SVG modified this
	 * session, keyed by vault path. Re-applied to embeds whenever they are
	 * (re)built -- on iPad the note is usually hidden or torn down while the
	 * drawing is edited, so the one-shot refresh in refreshSvgEmbeds finds
	 * nothing, and the rebuilt embed then loads the stale image WKWebView
	 * cached for the file's resource URL. */
	private freshSvgs = new Map<string, string>();

	async onload(): Promise<void> {
		addToolbarIcons();
		await this.loadSettings();

		this.registerView(VIEW_TYPE_DRAWING, (leaf) => new DrawingView(leaf, this));

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

		const viewCommand = (id: string, name: string, run: (view: DrawingView) => void) =>
			this.addCommand({
				id,
				name,
				checkCallback: (checking) => {
					const view = this.app.workspace.getActiveViewOfType(DrawingView);
					if (!view) return false;
					if (!checking) run(view);
					return true;
				},
			});
		viewCommand("copy-as-png", "Copy drawing as PNG", (v) => v.copyAsPng());
		viewCommand("export-png", "Export drawing as PNG", (v) => void v.exportPng());
		viewCommand("export-svg", "Export drawing as SVG", (v) => void v.exportSvg());
		viewCommand("export-pdf", "Export drawing as PDF", (v) => void v.exportPdf());
		viewCommand("copy-as-svg", "Copy drawing as SVG", (v) => v.copyAsSvg());
		viewCommand("toggle-presentation", "Toggle presentation mode", (v) => v.togglePresentation());
		viewCommand("insert-image", "Insert image into drawing", (v) => v.pickImageFile());

		this.addSettingTab(new QuickSketchSettingTab(this.app, this));

		this.addCommand({
			id: "toggle-input-diagnostics",
			name: "Toggle input diagnostics",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(DrawingView);
				if (!view) return false;
				if (!checking) view.toggleDiagnostics();
				return true;
			},
		});

		// Edit buttons on embedded drawings: watched for continuously rather
		// than added from a markdown post processor -- post processors don't
		// run for Live Preview embeds, and embeds can be (re)built well after
		// the note renders (slow iCloud loads on iPad, CodeMirror recreating
		// widgets on scroll), which would wipe a one-shot button.
		this.app.workspace.onLayoutReady(() => {
			this.observeForEmbeds(this.app.workspace.containerEl.doc);
			this.scheduleEmbedScan();
		});
		this.registerEvent(this.app.workspace.on("window-open", (win) => this.observeForEmbeds(win.doc)));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleEmbedScan()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scheduleEmbedScan()));

		// Keep embedded drawings in open notes in sync whenever the SVG changes
		// (our own saves from the drawing view, or external edits).
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && file.extension.toLowerCase() === "svg") {
					void this.refreshSvgEmbeds(file);
				}
			})
		);
		this.registerEvent(this.app.vault.on("delete", (file) => this.freshSvgs.delete(file.path)));
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				const cached = this.freshSvgs.get(oldPath);
				if (cached === undefined) return;
				this.freshSvgs.delete(oldPath);
				this.freshSvgs.set(file.path, cached);
			})
		);
	}

	async loadSettings(): Promise<void> {
		// Saved values over the defaults; anything missing or of the wrong
		// shape (from an older version, or a hand-edited data.json) falls
		// back to its default.
		const saved = ((await this.loadData()) as Partial<QuickSketchSettings> | null) ?? {};
		const colors = saved.customColors;
		this.settings = {
			...DEFAULT_SETTINGS,
			...saved,
			customColors: Array.isArray(colors) ? colors.filter((c) => typeof c === "string") : [],
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private async createNewDrawing(): Promise<void> {
		const active = this.app.workspace.activeEditor;
		if (!active?.editor || !active.file) {
			new Notice("Open a note first to insert a drawing.");
			return;
		}
		const { editor, file: activeFile } = active;

		const format = this.settings.fileNameFormat || DEFAULT_SETTINGS.fileNameFormat;
		// Strip characters that aren't allowed in file names.
		const baseName = moment().format(format).replace(/[\\/:*?"<>|#^[\]]/g, "-").trim() || "Drawing";
		let path: string;
		if (this.settings.location === "folder" && this.settings.folder) {
			const folder = normalizePath(this.settings.folder);
			if (!(this.app.vault.getAbstractFileByPath(folder) instanceof TFolder)) {
				await this.app.vault.createFolder(folder).catch(() => undefined);
			}
			path = normalizePath(`${folder}/${baseName}.svg`);
			for (let i = 1; this.app.vault.getAbstractFileByPath(path); i++) {
				path = normalizePath(`${folder}/${baseName} ${i}.svg`);
			}
		} else {
			path = await this.app.fileManager.getAvailablePathForAttachment(`${baseName}.svg`, activeFile.path);
		}
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
		const leaf = existing ?? this.app.workspace.getLeaf("tab");
		await leaf.setViewState({
			type: VIEW_TYPE_DRAWING,
			active: true,
			state: { file: file.path },
		});
		await this.app.workspace.revealLeaf(leaf);
	}

	/**
	 * Obsidian's rendered <img> keeps the image it first loaded, so after the
	 * SVG is modified the old drawing stays on screen until the note is
	 * reopened. Swapping in a new resource URL isn't reliable (the mtime in
	 * the URL may not have changed yet, and the app:// resource can be served
	 * from cache), so instead we read the saved SVG and put it straight into
	 * each matching <img> as a data: URL -- guaranteed to show the new content.
	 *
	 * Embeds are matched two ways: by resolving the embed's link text against
	 * the note it lives in, and (as a fallback) by comparing resource URLs with
	 * the query string stripped. Obsidian may rebuild embed DOM shortly after
	 * a modify event, so we refresh again after a short delay.
	 */
	async refreshSvgEmbeds(file: TFile): Promise<void> {
		const content = await this.app.vault.read(file);
		const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`;
		this.freshSvgs.set(file.path, dataUrl);
		const apply = () => this.applySvgToEmbeds(file, dataUrl);
		apply();
		window.setTimeout(apply, 300);
		window.setTimeout(apply, 1000);
	}

	private applySvgToEmbeds(file: TFile, dataUrl: string): number {
		const base = this.app.vault.getResourcePath(file).split("?")[0];
		const targets = new Set<HTMLImageElement>();

		this.app.workspace.iterateAllLeaves((leaf) => {
			const container = leaf.view.containerEl;
			const sourcePath = (leaf.view as { file?: TFile | null }).file?.path ?? "";

			container.querySelectorAll<HTMLElement>(".internal-embed").forEach((embed) => {
				const link = embed.getAttribute("src");
				if (!link) return;
				const linkpath = link.split("#")[0].split("|")[0];
				const dest = this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
				if (dest?.path !== file.path) return;
				embed.querySelectorAll("img").forEach((img) => targets.add(img));
			});

			container.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
				const src = img.getAttribute("src");
				if (src && src.split("?")[0] === base) targets.add(img);
			});
		});

		targets.forEach((img) => {
			if (img.getAttribute("src") !== dataUrl) img.setAttribute("src", dataUrl);
		});
		return targets.size;
	}

	private embedScanQueued = false;

	private observeForEmbeds(doc: Document): void {
		const observer = new MutationObserver((records) => {
			// Ignore the drawing view's own churn (a new <path> per stroke)
			// so scans never compete with ink while writing.
			const relevant = records.some((r) => {
				const el = r.target.instanceOf(Element) ? r.target : r.target.parentElement;
				return !el?.closest(`[data-type="${VIEW_TYPE_DRAWING}"]`);
			});
			if (relevant) this.scheduleEmbedScan();
		});
		observer.observe(doc.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["src", "class"],
		});
		this.register(() => observer.disconnect());
	}

	/** Coalesces bursts of DOM mutations into one scan per animation frame. */
	private scheduleEmbedScan(): void {
		if (this.embedScanQueued) return;
		this.embedScanQueued = true;
		window.requestAnimationFrame(() => {
			this.embedScanQueued = false;
			this.scanEmbeds();
		});
	}

	/** Scans every markdown leaf (so popout windows are included) and makes
	 * sure each SVG embed has its edit button. Links are resolved relative to
	 * the note the embed lives in. */
	private scanEmbeds(): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view.getViewType() !== "markdown") return;
			const sourcePath = (leaf.view as { file?: TFile | null }).file?.path ?? "";
			leaf.view.containerEl.querySelectorAll<HTMLElement>(".internal-embed").forEach((embedEl) => {
				const linkPath = this.getSvgLinkPath(embedEl);
				if (!linkPath) return;
				this.attachEditButton(embedEl, linkPath, sourcePath);
				this.applyFreshSvg(embedEl, linkPath, sourcePath);
			});
		});
	}

	/** Swaps a (re)built embed's <img> to the content we last saw saved,
	 * if this session has modified that file. The equality guard keeps our
	 * own src mutation from retriggering the observer forever. */
	private applyFreshSvg(embedEl: HTMLElement, linkPath: string, sourcePath: string): void {
		if (this.freshSvgs.size === 0) return;
		const dest = this.app.metadataCache.getFirstLinkpathDest(linkPath.split("#")[0].split("|")[0], sourcePath);
		const dataUrl = dest ? this.freshSvgs.get(dest.path) : undefined;
		if (!dataUrl) return;
		embedEl.querySelectorAll("img").forEach((img) => {
			if (img.getAttribute("src") !== dataUrl) img.setAttribute("src", dataUrl);
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
		// Guarded: classList.add() of a present class still emits a mutation
		// record, which would retrigger the observer every frame.
		if (!anchor.hasClass("quick-sketch-embed")) anchor.addClass("quick-sketch-embed");

		let btn = embedEl.querySelector<HTMLButtonElement>(".quick-sketch-edit-btn");
		if (btn) {
			if (btn.parentElement !== anchor) anchor.appendChild(btn);
			return;
		}

		btn = anchor.createEl("button", { cls: "quick-sketch-edit-btn" });
		setIcon(btn.createSpan({ cls: "quick-sketch-edit-icon" }), ICON.pencil);
		btn.createSpan({ cls: "quick-sketch-edit-label", text: "Edit" });
		btn.setAttribute("aria-label", "Edit drawing");
		// In Live Preview a press on the embed lets CodeMirror move the cursor
		// into it (swapping the widget for its source text) before a click can
		// fire -- especially on touch. Swallow the press so the tap lands.
		const swallow = (evt: Event) => {
			evt.preventDefault();
			evt.stopPropagation();
		};
		btn.addEventListener("pointerdown", swallow);
		btn.addEventListener("mousedown", swallow);
		btn.addEventListener("touchstart", (evt) => evt.stopPropagation(), { passive: true });
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
