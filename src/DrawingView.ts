import { ItemView, TFile, ViewStateResult, WorkspaceLeaf } from "obsidian";
import {
	COLORS,
	CROP_PADDING,
	DEFAULT_COLOR,
	DEFAULT_STROKE_PX,
	EMPTY_EXPORT_HEIGHT,
	EMPTY_EXPORT_WIDTH,
	EMPTY_SVG,
	MAX_ZOOM,
	MIN_ZOOM,
	STROKE_SIZES,
	VIEW_TYPE_DRAWING,
	WORKSPACE_CENTER,
	WORKSPACE_SIZE,
} from "./constants";

const SVG_NS = "http://www.w3.org/2000/svg";
const SAVE_DEBOUNCE_MS = 800;

interface Point {
	x: number;
	y: number;
}

interface ActiveStroke {
	pathEl: SVGPathElement;
	points: Point[];
	pointerId: number;
}

function buildSmoothPath(points: Point[]): string {
	if (points.length === 1) {
		const p = points[0];
		return `M ${p.x} ${p.y} L ${p.x} ${p.y}`;
	}
	if (points.length === 2) {
		return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
	}
	let d = `M ${points[0].x} ${points[0].y} `;
	for (let i = 1; i < points.length - 1; i++) {
		const midX = (points[i].x + points[i + 1].x) / 2;
		const midY = (points[i].y + points[i + 1].y) / 2;
		d += `Q ${points[i].x} ${points[i].y} ${midX} ${midY} `;
	}
	const last = points[points.length - 1];
	d += `L ${last.x} ${last.y}`;
	return d;
}

export class DrawingView extends ItemView {
	private filePath: string | null = null;
	private svgEl!: SVGSVGElement;
	private strokesGroup!: SVGGElement;
	private toolbarEl!: HTMLElement;
	private canvasWrapEl!: HTMLElement;

	private currentColor = DEFAULT_COLOR;
	private currentSize = DEFAULT_STROKE_PX;

	private strokeEls: SVGPathElement[] = [];
	private activeStroke: ActiveStroke | null = null;

	// Pan/zoom is a CSS transform on svgEl, driven manually from pointer/wheel
	// events -- not native scroll -- so that touch-action can stay "none" and
	// a stylus never triggers the browser's own pan/zoom gesture handling.
	private panX = 0;
	private panY = 0;
	private zoom = 1;
	private touchPoints: Map<number, Point> = new Map();

	private dirty = false;
	private saveTimer: number | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_DRAWING;
	}

	getDisplayText(): string {
		if (!this.filePath) return "Drawing";
		const name = this.filePath.split("/").pop() ?? "Drawing";
		return name.replace(/\.svg$/i, "");
	}

	getIcon(): string {
		return "pencil";
	}

	async onOpen(): Promise<void> {
		this.buildUI();
		if (this.filePath) {
			await this.loadFromFile();
		}
		this.centerView();
	}

	async onClose(): Promise<void> {
		if (this.canvasWrapEl) {
			this.canvasWrapEl.removeEventListener("pointerdown", this.onPointerDown);
			this.canvasWrapEl.removeEventListener("pointermove", this.onPointerMove);
			this.canvasWrapEl.removeEventListener("pointerup", this.onPointerUp);
			this.canvasWrapEl.removeEventListener("pointercancel", this.onPointerUp);
			this.canvasWrapEl.removeEventListener("wheel", this.onWheel);
		}
		await this.flushSave();
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const file = (state as { file?: string } | undefined)?.file;
		if (file) {
			this.filePath = file;
			if (this.svgEl) {
				await this.loadFromFile();
				this.centerView();
			}
		}
		await super.setState(state, result);
	}

	getState(): Record<string, unknown> {
		return { file: this.filePath };
	}

	private buildUI(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("quick-sketch-view");

		this.toolbarEl = container.createDiv({ cls: "quick-sketch-toolbar" });
		this.renderToolbar();

		const canvasWrap = container.createDiv({ cls: "quick-sketch-canvas-wrap" });
		this.canvasWrapEl = canvasWrap;

		this.svgEl = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
		this.svgEl.setAttribute("width", String(WORKSPACE_SIZE));
		this.svgEl.setAttribute("height", String(WORKSPACE_SIZE));
		this.svgEl.classList.add("quick-sketch-canvas");
		this.svgEl.style.transformOrigin = "0 0";

		this.strokesGroup = document.createElementNS(SVG_NS, "g") as SVGGElement;
		this.svgEl.appendChild(this.strokesGroup);

		canvasWrap.appendChild(this.svgEl);

		// Listeners live on the wrapper (not the svg) so panning/zooming still
		// works when zoomed out far enough that empty wrapper space is showing
		// around the canvas.
		canvasWrap.addEventListener("pointerdown", this.onPointerDown);
		canvasWrap.addEventListener("pointermove", this.onPointerMove);
		canvasWrap.addEventListener("pointerup", this.onPointerUp);
		canvasWrap.addEventListener("pointercancel", this.onPointerUp);
		canvasWrap.addEventListener("wheel", this.onWheel, { passive: false });
	}

	private renderToolbar(): void {
		this.toolbarEl.empty();

		const sizeGroup = this.toolbarEl.createDiv({ cls: "quick-sketch-group" });
		for (const size of STROKE_SIZES) {
			const btn = sizeGroup.createEl("button", {
				text: size.label,
				cls: "quick-sketch-size-btn",
			});
			if (size.px === this.currentSize) btn.addClass("is-active");
			btn.onclick = () => {
				this.currentSize = size.px;
				this.renderToolbar();
			};
		}

		const colorGroup = this.toolbarEl.createDiv({ cls: "quick-sketch-group" });
		for (const color of COLORS) {
			const btn = colorGroup.createEl("button", { cls: "quick-sketch-swatch" });
			btn.style.backgroundColor = color;
			if (color === this.currentColor) btn.addClass("is-active");
			btn.onclick = () => {
				this.currentColor = color;
				this.renderToolbar();
			};
		}

		const actionGroup = this.toolbarEl.createDiv({ cls: "quick-sketch-group" });
		const undoBtn = actionGroup.createEl("button", { text: "Undo" });
		undoBtn.onclick = () => this.undo();

		const clearBtn = actionGroup.createEl("button", { text: "Clear" });
		clearBtn.onclick = () => this.clear();

		const doneBtn = actionGroup.createEl("button", { text: "Done", cls: "mod-cta" });
		doneBtn.onclick = () => this.done();
	}

	private toCanvasPoint(evt: PointerEvent): Point {
		const pt = this.svgEl.createSVGPoint();
		pt.x = evt.clientX;
		pt.y = evt.clientY;
		const ctm = this.svgEl.getScreenCTM();
		if (!ctm) return { x: 0, y: 0 };
		const transformed = pt.matrixTransform(ctm.inverse());
		return { x: transformed.x, y: transformed.y };
	}

	/** Screen-space point relative to the wrapper's own top-left corner --
	 * the frame all our pan/zoom math is done in. */
	private toWrapPoint(evt: { clientX: number; clientY: number }): Point {
		const rect = this.canvasWrapEl.getBoundingClientRect();
		return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
	}

	private onPointerDown = (evt: PointerEvent): void => {
		if (evt.pointerType === "touch") {
			this.onTouchStart(evt);
			return;
		}
		// A stylus (Apple Pencil reports as "pen") or a mouse draws.
		if (evt.pointerType === "mouse" && evt.button !== 0) return;
		if (this.activeStroke) return;
		evt.preventDefault();
		this.canvasWrapEl.setPointerCapture(evt.pointerId);

		const p = this.toCanvasPoint(evt);
		const pathEl = document.createElementNS(SVG_NS, "path") as SVGPathElement;
		pathEl.setAttribute("stroke", this.currentColor);
		pathEl.setAttribute("stroke-width", String(this.currentSize));
		pathEl.setAttribute("fill", "none");
		pathEl.setAttribute("stroke-linecap", "round");
		pathEl.setAttribute("stroke-linejoin", "round");
		pathEl.setAttribute("d", buildSmoothPath([p]));
		this.strokesGroup.appendChild(pathEl);

		this.activeStroke = { pathEl, points: [p], pointerId: evt.pointerId };
	};

	private onPointerMove = (evt: PointerEvent): void => {
		if (evt.pointerType === "touch") {
			this.onTouchMove(evt);
			return;
		}
		if (!this.activeStroke || evt.pointerId !== this.activeStroke.pointerId) return;
		const p = this.toCanvasPoint(evt);
		const last = this.activeStroke.points[this.activeStroke.points.length - 1];
		const dx = p.x - last.x;
		const dy = p.y - last.y;
		if (dx * dx + dy * dy < 1.5) return;
		this.activeStroke.points.push(p);
		this.activeStroke.pathEl.setAttribute("d", buildSmoothPath(this.activeStroke.points));
	};

	private onPointerUp = (evt: PointerEvent): void => {
		if (evt.pointerType === "touch") {
			this.onTouchEnd(evt);
			return;
		}
		if (!this.activeStroke || evt.pointerId !== this.activeStroke.pointerId) return;
		if (this.canvasWrapEl.hasPointerCapture(evt.pointerId)) {
			this.canvasWrapEl.releasePointerCapture(evt.pointerId);
		}
		this.strokeEls.push(this.activeStroke.pathEl);
		this.activeStroke = null;
		this.markDirtyAndScheduleSave();
	};

	// --- Touch: pan with one finger, pinch-zoom with two. Never draws. ---

	private onTouchStart(evt: PointerEvent): void {
		if (this.touchPoints.size >= 2) return; // ignore a 3rd+ finger
		evt.preventDefault();
		this.canvasWrapEl.setPointerCapture(evt.pointerId);
		this.touchPoints.set(evt.pointerId, this.toWrapPoint(evt));
	}

	private onTouchMove(evt: PointerEvent): void {
		const prev = this.touchPoints.get(evt.pointerId);
		if (!prev) return;
		evt.preventDefault();
		const next = this.toWrapPoint(evt);

		const otherEntry = Array.from(this.touchPoints.entries()).find(([id]) => id !== evt.pointerId);
		if (!otherEntry) {
			// One finger: pan (pan is applied post-scale, so screen deltas map 1:1).
			this.panX += next.x - prev.x;
			this.panY += next.y - prev.y;
		} else {
			// Two fingers: pinch-zoom anchored at the previous midpoint, then
			// carry the midpoint's own movement as an additional pan.
			const other = otherEntry[1];
			const prevMid = { x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 };
			const prevDist = Math.hypot(prev.x - other.x, prev.y - other.y);
			const nextMid = { x: (next.x + other.x) / 2, y: (next.y + other.y) / 2 };
			const nextDist = Math.hypot(next.x - other.x, next.y - other.y);

			if (prevDist > 0) this.zoomAt(prevMid.x, prevMid.y, this.zoom * (nextDist / prevDist));
			this.panX += nextMid.x - prevMid.x;
			this.panY += nextMid.y - prevMid.y;
		}

		this.touchPoints.set(evt.pointerId, next);
		this.applyTransform();
	}

	private onTouchEnd(evt: PointerEvent): void {
		this.touchPoints.delete(evt.pointerId);
		if (this.canvasWrapEl.hasPointerCapture(evt.pointerId)) {
			this.canvasWrapEl.releasePointerCapture(evt.pointerId);
		}
	}

	// --- Desktop trackpad/wheel: plain scroll pans, ctrl/cmd+scroll (pinch) zooms. ---

	private onWheel = (evt: WheelEvent): void => {
		evt.preventDefault();
		if (evt.ctrlKey || evt.metaKey) {
			const { x, y } = this.toWrapPoint(evt);
			this.zoomAt(x, y, this.zoom * Math.exp(-evt.deltaY * 0.01));
		} else {
			this.panX -= evt.deltaX;
			this.panY -= evt.deltaY;
		}
		this.applyTransform();
	};

	/** Rescales, keeping the content under the given wrapper-relative screen
	 * point (e.g. a pinch midpoint or the cursor) visually fixed in place. */
	private zoomAt(screenX: number, screenY: number, newZoom: number): void {
		const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoom));
		const localX = (screenX - this.panX) / this.zoom;
		const localY = (screenY - this.panY) / this.zoom;
		this.zoom = clamped;
		this.panX = screenX - localX * clamped;
		this.panY = screenY - localY * clamped;
	}

	private applyTransform(): void {
		this.svgEl.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
	}

	private undo(): void {
		const last = this.strokeEls.pop();
		if (!last) return;
		last.remove();
		this.markDirtyAndScheduleSave();
	}

	private clear(): void {
		if (this.strokeEls.length === 0) return;
		if (!window.confirm("Clear the whole drawing?")) return;
		for (const el of this.strokeEls) el.remove();
		this.strokeEls = [];
		this.markDirtyAndScheduleSave();
	}

	private async done(): Promise<void> {
		await this.flushSave();
		this.leaf.detach();
	}

	private markDirtyAndScheduleSave(): void {
		this.dirty = true;
		if (this.saveTimer) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.flushSave();
		}, SAVE_DEBOUNCE_MS);
	}

	private async flushSave(): Promise<void> {
		if (this.saveTimer) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		if (!this.dirty || !this.filePath || !this.strokesGroup) return;
		const file = this.app.vault.getAbstractFileByPath(this.filePath);
		if (!(file instanceof TFile)) return;
		this.dirty = false;
		await this.app.vault.modify(file, this.exportCroppedSvg());
		this.refreshEmbedsForFile(file);
	}

	/** Obsidian's rendered <img> keeps pointing at the resource URL it first
	 * loaded, so a plain vault.modify() leaves the old drawing on screen
	 * anywhere it's embedded until the note is reopened. getResourcePath()
	 * includes the file's mtime in the URL, so re-reading it after the save
	 * and pushing it onto every matching embed's <img> forces a refetch. */
	private refreshEmbedsForFile(file: TFile): void {
		const resourcePath = this.app.vault.getResourcePath(file);
		document.querySelectorAll<HTMLElement>(".internal-embed").forEach((embedEl) => {
			const src = embedEl.getAttribute("src");
			if (!src) return;
			const target = this.app.metadataCache.getFirstLinkpathDest(src, "");
			if (!target || target.path !== file.path) return;
			embedEl.querySelector("img")?.setAttribute("src", resourcePath);
		});
	}

	/** Serializes only the drawn strokes, cropped to their bounding box -- the
	 * huge editing workspace never gets saved, just what was actually drawn. */
	private exportCroppedSvg(): string {
		const bbox = this.strokesGroup.getBBox();
		const hasContent = bbox.width > 0 || bbox.height > 0;

		const x = hasContent ? bbox.x - CROP_PADDING : 0;
		const y = hasContent ? bbox.y - CROP_PADDING : 0;
		const width = hasContent ? bbox.width + CROP_PADDING * 2 : EMPTY_EXPORT_WIDTH;
		const height = hasContent ? bbox.height + CROP_PADDING * 2 : EMPTY_EXPORT_HEIGHT;

		const exportSvg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
		exportSvg.setAttribute("xmlns", SVG_NS);
		exportSvg.setAttribute("viewBox", `${x} ${y} ${width} ${height}`);
		exportSvg.setAttribute("width", String(Math.round(width)));
		exportSvg.setAttribute("height", String(Math.round(height)));
		exportSvg.innerHTML = this.strokesGroup.innerHTML;

		return new XMLSerializer().serializeToString(exportSvg);
	}

	private async loadFromFile(): Promise<void> {
		if (!this.filePath) return;
		const file = this.app.vault.getAbstractFileByPath(this.filePath);
		let content = EMPTY_SVG;
		if (file instanceof TFile) {
			try {
				content = await this.app.vault.read(file);
			} catch {
				content = EMPTY_SVG;
			}
		}
		this.applySvgContent(content);
	}

	/** Loads previously-cropped strokes into the big workspace, recentered so
	 * there's equal room to keep drawing in any direction around them. */
	private applySvgContent(content: string): void {
		this.activeStroke = null;
		this.strokesGroup.innerHTML = "";

		let legacyPaths: Element[] = [];
		try {
			const parsed = new DOMParser().parseFromString(content, "image/svg+xml");
			const root = parsed.documentElement;
			if (root && root.tagName.toLowerCase() === "svg" && !parsed.querySelector("parsererror")) {
				legacyPaths = Array.from(root.querySelectorAll("path"));
			}
		} catch {
			legacyPaths = [];
		}

		if (legacyPaths.length > 0) {
			const legacyGroup = document.createElementNS(SVG_NS, "g") as SVGGElement;
			for (const p of legacyPaths) {
				legacyGroup.appendChild(document.importNode(p, true));
			}
			this.strokesGroup.appendChild(legacyGroup);

			const bbox = legacyGroup.getBBox();
			const dx = WORKSPACE_CENTER - (bbox.x + bbox.width / 2);
			const dy = WORKSPACE_CENTER - (bbox.y + bbox.height / 2);
			legacyGroup.setAttribute("transform", `translate(${dx} ${dy})`);
		}

		this.strokeEls = Array.from(this.strokesGroup.querySelectorAll("path"));
	}

	/** Resets pan/zoom so the drawing (or its center, if empty) is in view. */
	private centerView(): void {
		requestAnimationFrame(() => {
			const wrap = this.canvasWrapEl;
			if (!wrap) return;
			this.zoom = 1;
			this.panX = wrap.clientWidth / 2 - WORKSPACE_CENTER * this.zoom;
			this.panY = wrap.clientHeight / 2 - WORKSPACE_CENTER * this.zoom;
			this.applyTransform();
		});
	}
}
