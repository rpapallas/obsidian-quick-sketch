import { ItemView, TFile, ViewStateResult, WorkspaceLeaf, setIcon } from "obsidian";
import {
	COLORS,
	CROP_PADDING,
	DEFAULT_COLOR,
	DEFAULT_STROKE_PX,
	DEFAULT_TOOL,
	EMPTY_EXPORT_HEIGHT,
	EMPTY_EXPORT_WIDTH,
	EMPTY_SVG,
	ERASE_RADIUS_PX,
	HIGHLIGHT_COLORS,
	HIGHLIGHT_OPACITY,
	HIGHLIGHT_SIZE_MULTIPLIER,
	MAX_ZOOM,
	MIN_ZOOM,
	SELECT_HIT_RADIUS_PX,
	SHAPE_TOOLS,
	STROKE_SIZES,
	TEXT_SIZE_MULTIPLIER,
	Tool,
	VIEW_TYPE_DRAWING,
	WORKSPACE_CENTER,
	WORKSPACE_SIZE,
} from "./constants";
import { ConfirmModal } from "./confirm";
import { ICON } from "./icons";
import type QuickSketchPlugin from "./main";

const SVG_NS = "http://www.w3.org/2000/svg";
// Autosave waits for a real pause: a save (serializing the SVG, writing the
// file -- possibly to iCloud -- and refreshing embeds in open notes) is main-
// thread work, and with a short debounce it lands in the natural gaps between
// words while handwriting, delaying the next stroke's ink.
const SAVE_DEBOUNCE_MS = 2000;

// Palm rejection: while handwriting, the resting hand reaches us as ordinary
// "touch" pointers, which would otherwise pan (one contact) or pinch-zoom
// (two) the canvas between strokes -- and a zoom change makes WebKit
// re-rasterize the whole huge SVG, stalling the next stroke's ink. Touches
// are ignored while the pen is down and for this long after it was last used.
const PALM_GUARD_MS = 1500;

/** Input-latency counters shown by the "Toggle input diagnostics" command. */
interface InputDiagnostics {
	el: HTMLElement;
	penDowns: number;
	lastDeliveryMs: number;
	maxDeliveryMs: number;
	lastLiftGapMs: number;
	lastDownToMoveMs: number;
	awaitingFirstMove: number | null;
	maxDownHandlerMs: number;
	maxUpHandlerMs: number;
	longFrames: number;
	maxFrameMs: number;
	lastFrameAt: number;
	rafId: number;
	touchesAccepted: number;
	touchesRejected: number;
	missedPointerUps: number;
	lastSaveMs: number;
	lastPenUpAt: number;
}

interface Point {
	x: number;
	y: number;
}

type ShapeKind = "rectangle" | "ellipse" | "triangle" | "arrow";
type ElementKind = "freehand" | ShapeKind | "text";

interface FreehandElement {
	id: string;
	kind: "freehand";
	el: SVGPathElement;
	color: string;
	size: number;
	points: Point[];
	highlight?: boolean;
}

interface ShapeElement {
	id: string;
	kind: ShapeKind;
	el: SVGGraphicsElement;
	color: string;
	size: number;
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

interface TextElement {
	id: string;
	kind: "text";
	el: SVGTextElement;
	color: string;
	size: number; // font size
	x: number;
	y: number;
	text: string;
}

type DrawnElement = FreehandElement | ShapeElement | TextElement;

type GeometrySnapshot =
	| { kind: "freehand"; points: Point[] }
	| { kind: "box"; x0: number; y0: number; x1: number; y1: number }
	| { kind: "text"; x: number; y: number };

/** Serialized form used for undo/redo snapshots -- geometry only, no live DOM refs. */
type SerializedElement =
	| { id: string; kind: "freehand"; color: string; size: number; points: Point[]; highlight?: boolean }
	| { id: string; kind: ShapeKind; color: string; size: number; x0: number; y0: number; x1: number; y1: number }
	| { id: string; kind: "text"; color: string; size: number; x: number; y: number; text: string };

interface ActiveDrawStroke {
	pathEl: SVGPathElement;
	points: Point[];
	pointerId: number;
	color: string;
	size: number;
	highlight: boolean;
}

interface ActiveShapeDraw {
	kind: ShapeKind;
	elem: ShapeElement;
	pointerId: number;
}

interface PanDrag {
	pointerId: number;
	startWrap: Point;
	startPanX: number;
	startPanY: number;
}

interface SelectionDrag {
	pointerId: number;
	startCanvas: Point;
	original: Map<string, GeometrySnapshot>;
	snapshotTaken: boolean;
}

interface SelectionBox {
	pointerId: number;
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

interface Bounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

function uid(): string {
	return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
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

/** Best-effort fallback for reading point data back out of a plain `d`
 * string -- used only for legacy files (or externally-edited SVGs) that lack
 * the `data-points` attribute this plugin now writes on save. */
function parseLegacyPathPoints(d: string): Point[] {
	const nums = d.match(/-?\d+(\.\d+)?/g);
	if (!nums) return [];
	const points: Point[] = [];
	for (let i = 0; i + 1 < nums.length; i += 2) {
		points.push({ x: parseFloat(nums[i]), y: parseFloat(nums[i + 1]) });
	}
	return points;
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax;
	const dy = by - ay;
	const len2 = dx * dx + dy * dy;
	let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
	if (t < 0) t = 0;
	else if (t > 1) t = 1;
	const cx = ax + t * dx;
	const cy = ay + t * dy;
	const ex = px - cx;
	const ey = py - cy;
	return Math.sqrt(ex * ex + ey * ey);
}

function freehandBounds(elem: Pick<FreehandElement, "points" | "size">): Bounds {
	let minX = Infinity,
		minY = Infinity,
		maxX = -Infinity,
		maxY = -Infinity;
	const pad = elem.size;
	for (const p of elem.points) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

function freehandHit(elem: Pick<FreehandElement, "points" | "size">, x: number, y: number, radius: number): boolean {
	const r = radius + elem.size;
	const b = freehandBounds(elem);
	if (x < b.minX - r || x > b.maxX + r || y < b.minY - r || y > b.maxY + r) return false;
	const pts = elem.points;
	if (pts.length === 0) return false;
	if (pts.length === 1) {
		const dx = pts[0].x - x;
		const dy = pts[0].y - y;
		return dx * dx + dy * dy <= r * r;
	}
	for (let i = 1; i < pts.length; i++) {
		if (distToSegment(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= r) return true;
	}
	return false;
}

/** Hit-test used by the eraser and select tools. Freehand strokes use precise
 * point-to-segment distance; every other kind uses its bounding box (padded
 * by the hit radius) -- clicking anywhere inside an unfilled rectangle still
 * selects it, which matches how most diagramming tools behave. */
function elementHit(elem: DrawnElement, x: number, y: number, radius: number): boolean {
	if (elem.kind === "freehand") return freehandHit(elem, x, y, radius);
	const b = elem.el.getBBox();
	return x >= b.x - radius && x <= b.x + b.width + radius && y >= b.y - radius && y <= b.y + b.height + radius;
}

export class DrawingView extends ItemView {
	private filePath: string | null = null;
	private svgEl!: SVGSVGElement;
	private elementsGroup!: SVGGElement;
	private overlayGroup!: SVGGElement;
	private toolbarEl!: HTMLElement;
	private inkColorGroup: HTMLElement | null = null;
	private highlightColorGroup: HTMLElement | null = null;
	private canvasWrapEl!: HTMLElement;
	private statusEl!: HTMLElement;

	private readonly plugin: QuickSketchPlugin;

	private tool: Tool = DEFAULT_TOOL;
	private currentColor = DEFAULT_COLOR;
	private currentHighlightColor = HIGHLIGHT_COLORS[0];
	private currentSize = DEFAULT_STROKE_PX;

	private elements: DrawnElement[] = [];
	private activeStroke: ActiveDrawStroke | null = null;
	private activeShapeDraw: ActiveShapeDraw | null = null;

	private textEditor: HTMLTextAreaElement | null = null;
	private textEditorCanvasPoint: Point | null = null;

	private erasing = false;
	private eraseDragPointerId: number | null = null;
	private eraseSnapshotTaken = false;

	private selectedIds: Set<string> = new Set();
	private selectionBox: SelectionBox | null = null;
	private selectionDrag: SelectionDrag | null = null;

	private panDrag: PanDrag | null = null;

	private undoStack: SerializedElement[][] = [];
	private redoStack: SerializedElement[][] = [];

	/** Active-state check functions for toolbar buttons/swatches, keyed by element. */
	private activeChecks: WeakMap<HTMLElement, () => boolean> = new WeakMap();

	// Pan/zoom is a CSS transform on svgEl, driven manually from pointer/wheel
	// events -- not native scroll -- so that touch-action can stay "none" and
	// a stylus never triggers the browser's own pan/zoom gesture handling.
	private panX = 0;
	private panY = 0;
	private zoom = 1;
	private touchPoints: Map<number, Point> = new Map();
	private lastPenActivity = 0;
	private diag: InputDiagnostics | null = null;

	private dirty = false;
	private saveTimer: number | null = null;

	private onWindowKeyDown: (e: KeyboardEvent) => void = () => {};

	constructor(leaf: WorkspaceLeaf, plugin: QuickSketchPlugin) {
		super(leaf);
		this.plugin = plugin;
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
		this.onWindowKeyDown = (e: KeyboardEvent) => this.handleKey(e);
		window.addEventListener("keydown", this.onWindowKeyDown);
		if (this.filePath) {
			await this.loadFromFile();
		}
		this.centerView();
	}

	async onClose(): Promise<void> {
		if (this.diag) this.toggleDiagnostics();
		window.removeEventListener("keydown", this.onWindowKeyDown);
		this.cancelTextEditor();
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

		const canvasWrap = container.createDiv({ cls: "quick-sketch-canvas-wrap" });
		this.canvasWrapEl = canvasWrap;

		this.svgEl = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
		this.svgEl.setAttribute("width", String(WORKSPACE_SIZE));
		this.svgEl.setAttribute("height", String(WORKSPACE_SIZE));
		this.svgEl.classList.add("quick-sketch-canvas");
		this.svgEl.style.transformOrigin = "0 0";

		this.elementsGroup = document.createElementNS(SVG_NS, "g") as SVGGElement;
		this.svgEl.appendChild(this.elementsGroup);

		this.overlayGroup = document.createElementNS(SVG_NS, "g") as SVGGElement;
		this.overlayGroup.classList.add("quick-sketch-overlay");
		this.svgEl.appendChild(this.overlayGroup);

		canvasWrap.appendChild(this.svgEl);

		this.statusEl = container.createDiv({ cls: "quick-sketch-status" });

		this.buildToolbar();
		this.applyToolClass();

		// Listeners live on the wrapper (not the svg) so panning/zooming still
		// works when zoomed out far enough that empty wrapper space is showing
		// around the canvas.
		canvasWrap.addEventListener("pointerdown", this.onPointerDown);
		canvasWrap.addEventListener("pointermove", this.onPointerMove);
		canvasWrap.addEventListener("pointerup", this.onPointerUp);
		canvasWrap.addEventListener("pointercancel", this.onPointerUp);
		canvasWrap.addEventListener("wheel", this.onWheel, { passive: false });

		// iPadOS/WebKit runs its own gesture recognizers (double-tap zoom, the
		// text-selection loupe, Scribble) on raw touch events, *independently*
		// of pointer events -- preventDefault() on pointerdown doesn't stop
		// them. A natural lift-and-retouch of the Apple Pencil looks like a
		// double tap, so WebKit holds the new contact while it decides, which
		// shows up as delayed ink. Cancelling the touch events themselves
		// (non-passive) opts the canvas out of those recognizers. Pointer
		// events are still delivered, so drawing/pan/pinch are unaffected.
		for (const type of ["touchstart", "touchmove", "touchend"] as const) {
			canvasWrap.addEventListener(type, this.onRawTouch, { passive: false });
		}
	}

	private onRawTouch = (evt: TouchEvent): void => {
		// Leave the inline text editor alone so it can still focus/select.
		const target = evt.target as HTMLElement | null;
		if (target?.closest("textarea, input")) return;
		if (evt.cancelable) evt.preventDefault();
	};

	private buildToolbar(): void {
		const tb = this.toolbarEl;
		tb.empty();

		const makeBtn = (
			parent: HTMLElement,
			label: string,
			icon: string,
			onClick: () => void,
			isActive?: () => boolean
		): HTMLButtonElement => {
			const btn = parent.createEl("button", {
				cls: "quick-sketch-btn",
				attr: { "aria-label": label, title: label },
			});
			setIcon(btn, icon);
			btn.onclick = (evt) => {
				evt.preventDefault();
				onClick();
				this.refreshToolbarState();
			};
			if (isActive) this.activeChecks.set(btn, isActive);
			return btn;
		};

		const toolGroup = tb.createDiv({ cls: "quick-sketch-group" });
		makeBtn(toolGroup, "Pencil", ICON.pencil, () => this.setTool("pencil"), () => this.tool === "pencil");
		makeBtn(
			toolGroup,
			"Highlighter",
			ICON.highlighter,
			() => this.setTool("highlighter"),
			() => this.tool === "highlighter"
		);
		makeBtn(toolGroup, "Eraser", ICON.eraser, () => this.setTool("eraser"), () => this.tool === "eraser");
		makeBtn(toolGroup, "Select", ICON.select, () => this.setTool("select"), () => this.tool === "select");
		makeBtn(toolGroup, "Pan", ICON.hand, () => this.setTool("pan"), () => this.tool === "pan");

		tb.createDiv({ cls: "quick-sketch-sep" });

		const shapeGroup = tb.createDiv({ cls: "quick-sketch-group" });
		makeBtn(
			shapeGroup,
			"Rectangle",
			ICON.rectangle,
			() => this.setTool("rectangle"),
			() => this.tool === "rectangle"
		);
		makeBtn(shapeGroup, "Ellipse", ICON.ellipse, () => this.setTool("ellipse"), () => this.tool === "ellipse");
		makeBtn(
			shapeGroup,
			"Triangle",
			ICON.triangle,
			() => this.setTool("triangle"),
			() => this.tool === "triangle"
		);
		makeBtn(shapeGroup, "Arrow", ICON.arrow, () => this.setTool("arrow"), () => this.tool === "arrow");
		makeBtn(shapeGroup, "Text", ICON.text, () => this.setTool("text"), () => this.tool === "text");

		tb.createDiv({ cls: "quick-sketch-sep" });

		// The highlighter has its own fixed palette; only one of the two color
		// groups is shown at a time (see updateColorGroupVisibility).
		const highlightGroup = tb.createDiv({ cls: "quick-sketch-group" });
		for (const color of HIGHLIGHT_COLORS) {
			const btn = highlightGroup.createEl("button", {
				cls: "quick-sketch-swatch",
				attr: { "aria-label": `Highlight ${color}`, title: color },
			});
			btn.style.setProperty("--qs-swatch-color", color);
			btn.onclick = (evt) => {
				evt.preventDefault();
				this.currentHighlightColor = color;
				this.refreshToolbarState();
			};
			this.activeChecks.set(btn, () => this.currentHighlightColor === color);
		}
		this.highlightColorGroup = highlightGroup;

		const colorGroup = tb.createDiv({ cls: "quick-sketch-group" });
		this.inkColorGroup = colorGroup;
		for (const color of this.allColors()) {
			const isCustom = !COLORS.includes(color);
			const btn = colorGroup.createEl("button", {
				cls: isCustom ? "quick-sketch-swatch quick-sketch-swatch-custom" : "quick-sketch-swatch",
				attr: { "aria-label": `Color ${color}`, title: isCustom ? `${color} (right-click to remove)` : color },
			});
			btn.style.setProperty("--qs-swatch-color", color);
			btn.onclick = (evt) => {
				evt.preventDefault();
				this.currentColor = color;
				this.refreshToolbarState();
			};
			if (isCustom) {
				btn.addEventListener("contextmenu", (evt) => {
					evt.preventDefault();
					new ConfirmModal(
						this.app,
						`Remove color ${color} from the palette?`,
						() => void this.removeCustomColor(color),
						"Remove"
					).open();
				});
			}
			this.activeChecks.set(btn, () => this.currentColor === color);
		}

		const addColorBtn = colorGroup.createDiv({
			cls: "quick-sketch-swatch quick-sketch-swatch-add",
			attr: { "aria-label": "Add color", title: "Add custom color" },
		});
		addColorBtn.setText("+");
		// A transparent native <input type="color"> overlaid on the "+" swatch
		// -- iOS/WKWebView won't open the color picker from a programmatic
		// .click() on a hidden input, but a real tap on a visible (if
		// zero-opacity) input opens the native picker on every platform.
		const colorInput = addColorBtn.createEl("input", { type: "color" });
		colorInput.addClass("quick-sketch-color-input");
		colorInput.value = this.currentColor;
		colorInput.addEventListener("change", () => {
			const value = colorInput.value;
			if (value) void this.addCustomColor(value);
		});

		tb.createDiv({ cls: "quick-sketch-sep" });

		const sizeGroup = tb.createDiv({ cls: "quick-sketch-group" });
		for (const size of STROKE_SIZES) {
			const btn = sizeGroup.createEl("button", {
				text: size.label,
				cls: "quick-sketch-size-btn",
			});
			btn.onclick = (evt) => {
				evt.preventDefault();
				this.currentSize = size.px;
				this.refreshToolbarState();
			};
			this.activeChecks.set(btn, () => this.currentSize === size.px);
		}

		tb.createDiv({ cls: "quick-sketch-sep" });

		const historyGroup = tb.createDiv({ cls: "quick-sketch-group" });
		makeBtn(historyGroup, "Undo", ICON.undo, () => this.undo());
		makeBtn(historyGroup, "Redo", ICON.redo, () => this.redo());

		tb.createDiv({ cls: "quick-sketch-sep" });

		const zoomGroup = tb.createDiv({ cls: "quick-sketch-group" });
		makeBtn(zoomGroup, "Zoom in", ICON.zoomIn, () => this.zoomAtCenter(1.2));
		makeBtn(zoomGroup, "Zoom out", ICON.zoomOut, () => this.zoomAtCenter(1 / 1.2));
		makeBtn(zoomGroup, "Fit to view", ICON.fit, () => this.zoomToFit());
		makeBtn(zoomGroup, "Reset view", ICON.reset, () => this.centerView());

		tb.createDiv({ cls: "quick-sketch-sep" });

		const actionGroup = tb.createDiv({ cls: "quick-sketch-group" });
		makeBtn(actionGroup, "Delete selection", ICON.trash, () => this.deleteSelection());
		makeBtn(actionGroup, "Clear all", ICON.clear, () => this.clearAllPrompt());

		const doneBtn = tb.createEl("button", { text: "Done", cls: "mod-cta quick-sketch-done" });
		doneBtn.onclick = () => this.done();

		this.updateColorGroupVisibility();
		this.refreshToolbarState();
	}

	private allColors(): string[] {
		return [...COLORS, ...this.plugin.settings.customColors];
	}

	private async addCustomColor(hex: string): Promise<void> {
		const normalized = hex.toLowerCase();
		const all = this.allColors().map((c) => c.toLowerCase());
		if (!all.includes(normalized)) {
			this.plugin.settings.customColors.push(normalized);
			await this.plugin.saveSettings();
		}
		this.currentColor = normalized;
		// Defer the rebuild: the color input lives inside the toolbar, and
		// emptying the toolbar synchronously inside the input's own `change`
		// handler destroys it while the native picker may still be closing,
		// which can crash on some mobile WebViews.
		window.setTimeout(() => this.buildToolbar(), 0);
	}

	private async removeCustomColor(hex: string): Promise<void> {
		const normalized = hex.toLowerCase();
		const list = this.plugin.settings.customColors;
		const idx = list.findIndex((c) => c.toLowerCase() === normalized);
		if (idx === -1) return;
		list.splice(idx, 1);
		await this.plugin.saveSettings();
		if (this.currentColor.toLowerCase() === normalized) this.currentColor = DEFAULT_COLOR;
		window.setTimeout(() => this.buildToolbar(), 0);
	}

	private setTool(tool: Tool): void {
		if (this.textEditor) this.commitTextEditor();
		this.tool = tool;
		this.applyToolClass();
	}

	private applyToolClass(): void {
		const wrap = this.canvasWrapEl;
		wrap.removeClass(
			"tool-pencil",
			"tool-highlighter",
			"tool-eraser",
			"tool-select",
			"tool-pan",
			"tool-rectangle",
			"tool-ellipse",
			"tool-triangle",
			"tool-arrow",
			"tool-text"
		);
		wrap.addClass(`tool-${this.tool}`);
		this.updateColorGroupVisibility();
	}

	private updateColorGroupVisibility(): void {
		const highlighting = this.tool === "highlighter";
		this.highlightColorGroup?.toggle(highlighting);
		this.inkColorGroup?.toggle(!highlighting);
	}

	/** Applies the shared freehand stroke attributes. Highlight strokes are
	 * semi-transparent and flagged with data-highlight so they round-trip
	 * through the saved SVG. */
	private styleFreehandPath(pathEl: SVGPathElement, color: string, size: number, highlight: boolean): void {
		pathEl.setAttribute("stroke", color);
		pathEl.setAttribute("stroke-width", String(size));
		pathEl.setAttribute("fill", "none");
		pathEl.setAttribute("stroke-linecap", "round");
		pathEl.setAttribute("stroke-linejoin", "round");
		if (highlight) {
			pathEl.setAttribute("stroke-opacity", String(HIGHLIGHT_OPACITY));
			pathEl.setAttribute("data-highlight", "true");
		}
	}

	/** Highlights always render beneath the ink: they're inserted after the
	 * last existing highlight but before every other element. Since the
	 * export copies elementsGroup's children in order, the saved file keeps
	 * the same layering. */
	private insertPath(pathEl: SVGPathElement, highlight: boolean): void {
		if (!highlight) {
			this.elementsGroup.appendChild(pathEl);
			return;
		}
		const firstInk = Array.from(this.elementsGroup.children).find((c) => !c.hasAttribute("data-highlight"));
		this.elementsGroup.insertBefore(pathEl, firstInk ?? null);
	}

	private refreshToolbarState(): void {
		const els = this.toolbarEl.querySelectorAll<HTMLElement>(
			"button.quick-sketch-btn, .quick-sketch-swatch, button.quick-sketch-size-btn"
		);
		els.forEach((el) => {
			const check = this.activeChecks.get(el);
			if (check) el.toggleClass("is-active", check());
		});
		this.updateStatus();
	}

	private updateStatus(): void {
		const zoomPct = Math.round(this.zoom * 100);
		const parts = [`${this.elements.length} elements`, `${zoomPct}%`];
		if (this.selectedIds.size > 0) parts.push(`${this.selectedIds.size} selected`);
		this.statusEl.setText(parts.join("  ·  "));
	}

	private toCanvasPoint(evt: { clientX: number; clientY: number }): Point {
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
		const t0 = performance.now();
		this.handlePointerDown(evt);
		if (this.diag && evt.pointerType !== "touch") {
			const d = this.diag;
			const now = performance.now();
			d.penDowns++;
			d.lastDeliveryMs = Math.max(0, t0 - evt.timeStamp);
			d.maxDeliveryMs = Math.max(d.maxDeliveryMs, d.lastDeliveryMs);
			d.lastLiftGapMs = d.lastPenUpAt ? evt.timeStamp - d.lastPenUpAt : 0;
			d.awaitingFirstMove = evt.timeStamp;
			d.maxDownHandlerMs = Math.max(d.maxDownHandlerMs, now - t0);
		}
	};

	private handlePointerDown(evt: PointerEvent): void {
		if (evt.pointerType === "touch") {
			this.onTouchStart(evt);
			return;
		}

		// Middle/right mouse button always pans, regardless of the active tool.
		if (evt.pointerType === "mouse" && (evt.button === 1 || evt.button === 2)) {
			evt.preventDefault();
			this.beginMousePan(evt);
			return;
		}
		if (evt.pointerType === "mouse" && evt.button !== 0) return;

		if (evt.pointerType === "pen") {
			this.lastPenActivity = performance.now();
			// A palm that landed just before the pen shouldn't keep panning.
			this.cancelTouchGesture();
		}

		// Never save in the middle of an interaction; onPointerUp reschedules.
		this.cancelScheduledSave();

		if (this.tool === "pan") {
			evt.preventDefault();
			this.beginMousePan(evt);
			return;
		}
		if (this.tool === "eraser") {
			evt.preventDefault();
			this.beginErase(evt);
			return;
		}
		if (this.tool === "select") {
			evt.preventDefault();
			this.beginSelectInteraction(evt);
			return;
		}
		if (SHAPE_TOOLS.has(this.tool)) {
			evt.preventDefault();
			this.beginShapeDraw(evt);
			return;
		}
		if (this.tool === "text") {
			evt.preventDefault();
			this.beginTextInput(evt);
			return;
		}

		// Pencil / highlighter tool: a stylus (Apple Pencil reports as "pen") or a mouse draws.
		if (this.activeStroke) {
			// A pointerup/pointercancel was missed for the previous stroke --
			// a real-world quirk on iPadOS/WebKit where lifting the Apple
			// Pencil (especially a quick lift-and-retouch, e.g. drawing the
			// dot of an "i") doesn't always deliver a clean pointerup. Finalize
			// whatever was drawn so far instead of getting stuck and silently
			// swallowing every stroke after it.
			if (this.diag) this.diag.missedPointerUps++;
			this.finishActiveStroke();
		}
		evt.preventDefault();
		this.canvasWrapEl.setPointerCapture(evt.pointerId);
		this.pushUndoSnapshot();

		const p = this.toCanvasPoint(evt);
		const highlight = this.tool === "highlighter";
		const color = highlight ? this.currentHighlightColor : this.currentColor;
		const size = highlight ? this.currentSize * HIGHLIGHT_SIZE_MULTIPLIER : this.currentSize;
		const pathEl = document.createElementNS(SVG_NS, "path") as SVGPathElement;
		this.styleFreehandPath(pathEl, color, size, highlight);
		pathEl.setAttribute("d", buildSmoothPath([p]));
		this.insertPath(pathEl, highlight);

		this.activeStroke = {
			pathEl,
			points: [p],
			pointerId: evt.pointerId,
			color,
			size,
			highlight,
		};
	}

	private onPointerMove = (evt: PointerEvent): void => {
		if (this.diag && this.diag.awaitingFirstMove !== null && evt.pointerType !== "touch") {
			this.diag.lastDownToMoveMs = evt.timeStamp - this.diag.awaitingFirstMove;
			this.diag.awaitingFirstMove = null;
		}
		if (evt.pointerType === "touch") {
			this.onTouchMove(evt);
			return;
		}

		if (this.panDrag && evt.pointerId === this.panDrag.pointerId) {
			const p = this.toWrapPoint(evt);
			this.panX = this.panDrag.startPanX + (p.x - this.panDrag.startWrap.x);
			this.panY = this.panDrag.startPanY + (p.y - this.panDrag.startWrap.y);
			this.applyTransform();
			return;
		}

		if (this.erasing && evt.pointerId === this.eraseDragPointerId) {
			this.eraseAt(evt);
			return;
		}

		if (this.selectionDrag && evt.pointerId === this.selectionDrag.pointerId) {
			this.continueSelectionDrag(evt);
			return;
		}

		if (this.selectionBox && evt.pointerId === this.selectionBox.pointerId) {
			const p = this.toCanvasPoint(evt);
			this.selectionBox.x1 = p.x;
			this.selectionBox.y1 = p.y;
			this.renderSelectionOverlay();
			return;
		}

		if (this.activeShapeDraw && evt.pointerId === this.activeShapeDraw.pointerId) {
			const p = this.toCanvasPoint(evt);
			const elem = this.activeShapeDraw.elem;
			elem.x1 = p.x;
			elem.y1 = p.y;
			this.applyGeometry(elem);
			return;
		}

		if (!this.activeStroke || evt.pointerId !== this.activeStroke.pointerId) return;
		if (evt.pointerType === "pen") this.lastPenActivity = performance.now();
		const p = this.toCanvasPoint(evt);
		const last = this.activeStroke.points[this.activeStroke.points.length - 1];
		const dx = p.x - last.x;
		const dy = p.y - last.y;
		if (dx * dx + dy * dy < 1.5) return;
		this.activeStroke.points.push(p);
		this.activeStroke.pathEl.setAttribute("d", buildSmoothPath(this.activeStroke.points));
	};

	private onPointerUp = (evt: PointerEvent): void => {
		const t0 = performance.now();
		this.handlePointerUp(evt);
		if (this.diag && evt.pointerType !== "touch") {
			this.diag.lastPenUpAt = evt.timeStamp;
			this.diag.maxUpHandlerMs = Math.max(this.diag.maxUpHandlerMs, performance.now() - t0);
		}
	};

	private handlePointerUp(evt: PointerEvent): void {
		if (evt.pointerType === "touch") {
			this.onTouchEnd(evt);
			return;
		}
		if (evt.pointerType === "pen") this.lastPenActivity = performance.now();

		// Restart the autosave countdown that pointerdown paused (handlers
		// below that change the drawing reschedule it again anyway).
		if (this.dirty && !this.saveTimer) this.scheduleSave();

		if (this.panDrag && evt.pointerId === this.panDrag.pointerId) {
			this.releaseCapture(evt.pointerId);
			this.panDrag = null;
			return;
		}

		if (this.erasing && evt.pointerId === this.eraseDragPointerId) {
			this.releaseCapture(evt.pointerId);
			this.erasing = false;
			this.eraseDragPointerId = null;
			return;
		}

		if (this.selectionDrag && evt.pointerId === this.selectionDrag.pointerId) {
			const moved = this.selectionDrag.snapshotTaken;
			if (moved) {
				for (const elem of this.elements) {
					if (this.selectedIds.has(elem.id) && elem.kind === "freehand") {
						elem.el.setAttribute("data-points", JSON.stringify(elem.points));
					}
				}
			}
			this.releaseCapture(evt.pointerId);
			this.selectionDrag = null;
			if (moved) this.markDirtyAndScheduleSave();
			this.renderSelectionOverlay();
			return;
		}

		if (this.selectionBox && evt.pointerId === this.selectionBox.pointerId) {
			this.commitSelectionBox();
			this.releaseCapture(evt.pointerId);
			return;
		}

		if (this.activeShapeDraw && evt.pointerId === this.activeShapeDraw.pointerId) {
			this.releaseCapture(evt.pointerId);
			const { elem } = this.activeShapeDraw;
			const b = elem.el.getBBox();
			const tooSmall = b.width < 2 && b.height < 2;
			this.activeShapeDraw = null;
			if (tooSmall) {
				elem.el.remove();
				this.undoStack.pop(); // discard the snapshot pushed for a no-op click
			} else {
				this.elements.push(elem);
				this.markDirtyAndScheduleSave();
			}
			return;
		}

		if (!this.activeStroke || evt.pointerId !== this.activeStroke.pointerId) return;
		this.finishActiveStroke();
	}

	private finishActiveStroke(): void {
		if (!this.activeStroke) return;
		this.releaseCapture(this.activeStroke.pointerId);
		this.activeStroke.pathEl.setAttribute("data-points", JSON.stringify(this.activeStroke.points));
		this.elements.push({
			id: uid(),
			kind: "freehand",
			el: this.activeStroke.pathEl,
			points: this.activeStroke.points,
			color: this.activeStroke.color,
			size: this.activeStroke.size,
			highlight: this.activeStroke.highlight,
		});
		this.activeStroke = null;
		this.markDirtyAndScheduleSave();
	}

	private releaseCapture(pointerId: number): void {
		if (this.canvasWrapEl.hasPointerCapture(pointerId)) {
			this.canvasWrapEl.releasePointerCapture(pointerId);
		}
	}

	// --- Pan tool / middle-click pan (mouse or pen) ---

	private beginMousePan(evt: PointerEvent): void {
		this.canvasWrapEl.setPointerCapture(evt.pointerId);
		this.panDrag = {
			pointerId: evt.pointerId,
			startWrap: this.toWrapPoint(evt),
			startPanX: this.panX,
			startPanY: this.panY,
		};
	}

	// --- Eraser tool ---

	private beginErase(evt: PointerEvent): void {
		this.canvasWrapEl.setPointerCapture(evt.pointerId);
		this.erasing = true;
		this.eraseDragPointerId = evt.pointerId;
		this.eraseSnapshotTaken = false;
		this.eraseAt(evt);
	}

	private eraseAt(evt: PointerEvent): void {
		const p = this.toCanvasPoint(evt);
		const radius = ERASE_RADIUS_PX / this.zoom;
		const hitIdx: number[] = [];
		for (let i = this.elements.length - 1; i >= 0; i--) {
			if (elementHit(this.elements[i], p.x, p.y, radius)) hitIdx.push(i);
		}
		if (hitIdx.length === 0) return;
		// Snapshot lazily, on the first element actually erased in this drag --
		// a drag that never touches anything shouldn't consume an undo slot.
		if (!this.eraseSnapshotTaken) {
			this.pushUndoSnapshot();
			this.eraseSnapshotTaken = true;
		}
		for (const i of hitIdx) {
			const elem = this.elements[i];
			elem.el.remove();
			this.elements.splice(i, 1);
			this.selectedIds.delete(elem.id);
		}
		this.markDirtyAndScheduleSave();
		this.renderSelectionOverlay();
	}

	// --- Shape tools (rectangle / ellipse / triangle / arrow) ---

	private beginShapeDraw(evt: PointerEvent): void {
		this.canvasWrapEl.setPointerCapture(evt.pointerId);
		this.pushUndoSnapshot();
		const p = this.toCanvasPoint(evt);
		const kind = this.tool as ShapeKind;
		const elem = this.createShapeElement(kind, this.currentColor, this.currentSize, p.x, p.y, p.x, p.y);
		this.activeShapeDraw = { kind, elem, pointerId: evt.pointerId };
	}

	// --- Text tool ---

	private beginTextInput(evt: PointerEvent): void {
		if (this.textEditor) this.commitTextEditor();
		const canvasPt = this.toCanvasPoint(evt);
		const wrapPt = this.toWrapPoint(evt);
		const fontSize = this.currentSize * TEXT_SIZE_MULTIPLIER;

		const ta = this.canvasWrapEl.createEl("textarea", { cls: "quick-sketch-text-input" });
		ta.rows = 1;
		ta.style.left = `${wrapPt.x}px`;
		ta.style.top = `${wrapPt.y}px`;
		ta.style.fontSize = `${fontSize * this.zoom}px`;
		ta.style.color = this.currentColor;

		this.textEditor = ta;
		this.textEditorCanvasPoint = canvasPt;

		const autoGrow = () => {
			ta.style.height = "auto";
			ta.style.height = `${ta.scrollHeight}px`;
		};
		ta.addEventListener("input", autoGrow);
		ta.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.commitTextEditor();
			} else if (e.key === "Escape") {
				e.preventDefault();
				this.cancelTextEditor();
			}
		});
		ta.addEventListener("blur", () => this.commitTextEditor());

		window.setTimeout(() => ta.focus(), 0);
	}

	private commitTextEditor(): void {
		const ta = this.textEditor;
		const canvasPt = this.textEditorCanvasPoint;
		if (!ta || !canvasPt) {
			this.cleanupTextEditor();
			return;
		}
		const value = ta.value.trim();
		this.cleanupTextEditor();
		if (!value) return;

		this.pushUndoSnapshot();
		const fontSize = this.currentSize * TEXT_SIZE_MULTIPLIER;
		// SVG text is anchored at its baseline, not its top-left corner; nudge
		// down roughly one line so the text visually starts near the click.
		const elem = this.createTextElement(this.currentColor, fontSize, canvasPt.x, canvasPt.y + fontSize * 0.8, value);
		this.elements.push(elem);
		this.markDirtyAndScheduleSave();
	}

	private cancelTextEditor(): void {
		this.cleanupTextEditor();
	}

	private cleanupTextEditor(): void {
		this.textEditor?.remove();
		this.textEditor = null;
		this.textEditorCanvasPoint = null;
	}

	// --- Select tool ---

	private beginSelectInteraction(evt: PointerEvent): void {
		this.canvasWrapEl.setPointerCapture(evt.pointerId);
		const p = this.toCanvasPoint(evt);
		const radius = SELECT_HIT_RADIUS_PX / this.zoom;

		let hit: DrawnElement | undefined;
		for (let i = this.elements.length - 1; i >= 0; i--) {
			if (elementHit(this.elements[i], p.x, p.y, radius)) {
				hit = this.elements[i];
				break;
			}
		}

		if (hit) {
			if (!this.selectedIds.has(hit.id)) {
				this.selectedIds.clear();
				this.selectedIds.add(hit.id);
			}
			this.beginSelectionDrag(evt, p);
			this.renderSelectionOverlay();
			return;
		}

		this.selectedIds.clear();
		this.selectionBox = { pointerId: evt.pointerId, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
		this.renderSelectionOverlay();
	}

	private beginSelectionDrag(evt: PointerEvent, startCanvas: Point): void {
		const original = new Map<string, GeometrySnapshot>();
		for (const elem of this.elements) {
			if (!this.selectedIds.has(elem.id)) continue;
			if (elem.kind === "freehand") {
				original.set(elem.id, { kind: "freehand", points: elem.points.map((p) => ({ x: p.x, y: p.y })) });
			} else if (elem.kind === "text") {
				original.set(elem.id, { kind: "text", x: elem.x, y: elem.y });
			} else {
				original.set(elem.id, { kind: "box", x0: elem.x0, y0: elem.y0, x1: elem.x1, y1: elem.y1 });
			}
		}
		this.selectionDrag = { pointerId: evt.pointerId, startCanvas, original, snapshotTaken: false };
	}

	private continueSelectionDrag(evt: PointerEvent): void {
		if (!this.selectionDrag) return;
		if (!this.selectionDrag.snapshotTaken) {
			this.pushUndoSnapshot();
			this.selectionDrag.snapshotTaken = true;
		}
		const p = this.toCanvasPoint(evt);
		const dx = p.x - this.selectionDrag.startCanvas.x;
		const dy = p.y - this.selectionDrag.startCanvas.y;
		for (const elem of this.elements) {
			const orig = this.selectionDrag.original.get(elem.id);
			if (!orig) continue;
			if (elem.kind === "freehand" && orig.kind === "freehand") {
				elem.points = orig.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy }));
			} else if (elem.kind === "text" && orig.kind === "text") {
				elem.x = orig.x + dx;
				elem.y = orig.y + dy;
			} else if (orig.kind === "box" && elem.kind !== "freehand" && elem.kind !== "text") {
				elem.x0 = orig.x0 + dx;
				elem.y0 = orig.y0 + dy;
				elem.x1 = orig.x1 + dx;
				elem.y1 = orig.y1 + dy;
			}
			this.applyGeometry(elem);
		}
		this.renderSelectionOverlay();
	}

	private commitSelectionBox(): void {
		if (!this.selectionBox) return;
		const { x0, y0, x1, y1 } = this.selectionBox;
		const minX = Math.min(x0, x1);
		const maxX = Math.max(x0, x1);
		const minY = Math.min(y0, y1);
		const maxY = Math.max(y0, y1);

		this.selectedIds.clear();
		if (maxX - minX > 2 && maxY - minY > 2) {
			for (const elem of this.elements) {
				const b = elem.el.getBBox();
				const intersects = !(b.x + b.width < minX || b.x > maxX || b.y + b.height < minY || b.y > maxY);
				if (intersects) this.selectedIds.add(elem.id);
			}
		}
		this.selectionBox = null;
		this.renderSelectionOverlay();
	}

	private renderSelectionOverlay(): void {
		this.overlayGroup.innerHTML = "";

		if (this.selectionBox) {
			const { x0, y0, x1, y1 } = this.selectionBox;
			const rect = document.createElementNS(SVG_NS, "rect");
			rect.setAttribute("x", String(Math.min(x0, x1)));
			rect.setAttribute("y", String(Math.min(y0, y1)));
			rect.setAttribute("width", String(Math.abs(x1 - x0)));
			rect.setAttribute("height", String(Math.abs(y1 - y0)));
			rect.classList.add("quick-sketch-rubberband");
			this.overlayGroup.appendChild(rect);
		}

		for (const id of this.selectedIds) {
			const elem = this.elements.find((e) => e.id === id);
			if (!elem) continue;
			const b = elem.el.getBBox();
			const pad = 4;
			const rect = document.createElementNS(SVG_NS, "rect");
			rect.setAttribute("x", String(b.x - pad));
			rect.setAttribute("y", String(b.y - pad));
			rect.setAttribute("width", String(b.width + pad * 2));
			rect.setAttribute("height", String(b.height + pad * 2));
			rect.classList.add("quick-sketch-selection-rect");
			this.overlayGroup.appendChild(rect);
		}

		this.updateStatus();
	}

	private deleteSelection(): void {
		if (this.selectedIds.size === 0) return;
		this.pushUndoSnapshot();
		for (const id of Array.from(this.selectedIds)) {
			const idx = this.elements.findIndex((e) => e.id === id);
			if (idx >= 0) {
				this.elements[idx].el.remove();
				this.elements.splice(idx, 1);
			}
		}
		this.selectedIds.clear();
		this.renderSelectionOverlay();
		this.markDirtyAndScheduleSave();
	}

	// --- Touch: pan with one finger, pinch-zoom with two. Never draws. ---

	private onTouchStart(evt: PointerEvent): void {
		evt.preventDefault();
		const penBusy =
			this.activeStroke !== null ||
			performance.now() - this.lastPenActivity < PALM_GUARD_MS;
		if (penBusy || this.touchPoints.size >= 2) {
			// Palm while writing (or a 3rd+ finger): ignore entirely.
			if (this.diag) this.diag.touchesRejected++;
			return;
		}
		if (this.diag) this.diag.touchesAccepted++;
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

	private cancelTouchGesture(): void {
		for (const id of this.touchPoints.keys()) this.releaseCapture(id);
		this.touchPoints.clear();
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

	private zoomAtCenter(factor: number): void {
		const wrap = this.canvasWrapEl;
		this.zoomAt(wrap.clientWidth / 2, wrap.clientHeight / 2, this.zoom * factor);
		this.applyTransform();
	}

	private zoomToFit(): void {
		if (this.elements.length === 0) {
			this.centerView();
			return;
		}
		const bbox = this.elementsGroup.getBBox();
		const wrap = this.canvasWrapEl;
		const pad = 40;
		const scaleX = (wrap.clientWidth - pad * 2) / Math.max(bbox.width, 1);
		const scaleY = (wrap.clientHeight - pad * 2) / Math.max(bbox.height, 1);
		const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(scaleX, scaleY)));
		this.zoom = scale;
		this.panX = wrap.clientWidth / 2 - (bbox.x + bbox.width / 2) * scale;
		this.panY = wrap.clientHeight / 2 - (bbox.y + bbox.height / 2) * scale;
		this.applyTransform();
	}

	private applyTransform(): void {
		this.svgEl.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
		this.updateStatus();
	}

	// --- Undo / redo ---

	private pushUndoSnapshot(): void {
		this.undoStack.push(this.cloneElements());
		if (this.undoStack.length > 200) this.undoStack.shift();
		this.redoStack = [];
	}

	private cloneElements(): SerializedElement[] {
		return this.elements.map((elem) => {
			if (elem.kind === "freehand") {
				// Points arrays are never mutated in place once an element is
				// finalized (a selection drag reassigns a brand-new array rather
				// than pushing into this one), so sharing the reference is safe
				// and avoids an O(total points ever drawn) deep clone on every
				// single pointerdown -- with a lot of handwritten strokes on
				// screen, that clone was slow enough to be felt as input lag
				// (e.g. the dot of an "i" not registering right after its stem).
				return {
					id: elem.id,
					kind: "freehand",
					color: elem.color,
					size: elem.size,
					points: elem.points,
					highlight: elem.highlight,
				};
			}
			if (elem.kind === "text") {
				return {
					id: elem.id,
					kind: "text",
					color: elem.color,
					size: elem.size,
					x: elem.x,
					y: elem.y,
					text: elem.text,
				};
			}
			return {
				id: elem.id,
				kind: elem.kind,
				color: elem.color,
				size: elem.size,
				x0: elem.x0,
				y0: elem.y0,
				x1: elem.x1,
				y1: elem.y1,
			};
		});
	}

	private restoreElements(snapshot: SerializedElement[]): void {
		this.elementsGroup.innerHTML = "";
		this.elements = snapshot.map((s) => {
			if (s.kind === "freehand") return this.createFreehandElement(s.color, s.size, s.points, s.id, s.highlight);
			if (s.kind === "text") return this.createTextElement(s.color, s.size, s.x, s.y, s.text, s.id);
			return this.createShapeElement(s.kind, s.color, s.size, s.x0, s.y0, s.x1, s.y1, s.id);
		});
	}

	private undo(): void {
		if (this.textEditor) this.cancelTextEditor();
		const prev = this.undoStack.pop();
		if (!prev) return;
		this.redoStack.push(this.cloneElements());
		this.restoreElements(prev);
		this.selectedIds.clear();
		this.renderSelectionOverlay();
		this.markDirtyAndScheduleSave();
	}

	private redo(): void {
		if (this.textEditor) this.cancelTextEditor();
		const next = this.redoStack.pop();
		if (!next) return;
		this.undoStack.push(this.cloneElements());
		this.restoreElements(next);
		this.selectedIds.clear();
		this.renderSelectionOverlay();
		this.markDirtyAndScheduleSave();
	}

	private clearAllPrompt(): void {
		if (this.elements.length === 0) return;
		new ConfirmModal(
			this.app,
			"Clear the whole drawing?",
			() => {
				this.pushUndoSnapshot();
				this.elementsGroup.innerHTML = "";
				this.elements = [];
				this.selectedIds.clear();
				this.renderSelectionOverlay();
				this.markDirtyAndScheduleSave();
			},
			"Clear"
		).open();
	}

	// --- Keyboard shortcuts (only while this view is the active leaf) ---

	private isActiveLeaf(): boolean {
		return this.app.workspace.getActiveViewOfType(DrawingView) === this;
	}

	private isEditableTarget(target: EventTarget | null): boolean {
		const el = target as HTMLElement | null;
		if (!el) return false;
		const tag = el.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
		if (el.isContentEditable) return true;
		return false;
	}

	private handleKey(e: KeyboardEvent): void {
		if (!this.isActiveLeaf()) return;
		if (this.isEditableTarget(e.target)) return;
		const mod = e.metaKey || e.ctrlKey;
		if (mod && !e.shiftKey && e.key.toLowerCase() === "z") {
			e.preventDefault();
			this.undo();
		} else if (mod && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
			e.preventDefault();
			this.redo();
		} else if (!mod && (e.key === "Delete" || e.key === "Backspace") && this.selectedIds.size > 0) {
			e.preventDefault();
			this.deleteSelection();
		} else if (!mod && e.key.toLowerCase() === "p") {
			this.setTool("pencil");
			this.refreshToolbarState();
		} else if (!mod && e.key.toLowerCase() === "m") {
			this.setTool("highlighter");
			this.refreshToolbarState();
		} else if (!mod && e.key.toLowerCase() === "e") {
			this.setTool("eraser");
			this.refreshToolbarState();
		} else if (!mod && e.key.toLowerCase() === "v") {
			this.setTool("select");
			this.refreshToolbarState();
		} else if (!mod && e.key.toLowerCase() === "h") {
			this.setTool("pan");
			this.refreshToolbarState();
		} else if (!mod && e.key.toLowerCase() === "r") {
			this.setTool("rectangle");
			this.refreshToolbarState();
		} else if (!mod && e.key.toLowerCase() === "o") {
			this.setTool("ellipse");
			this.refreshToolbarState();
		} else if (!mod && e.key.toLowerCase() === "t") {
			this.setTool("text");
			this.refreshToolbarState();
		} else if (!mod && e.key.toLowerCase() === "a") {
			this.setTool("arrow");
			this.refreshToolbarState();
		}
	}

	// --- Persistence ---

	private async done(): Promise<void> {
		if (this.textEditor) this.commitTextEditor();
		await this.flushSave();
		this.leaf.detach();
	}

	// --- Input diagnostics (debug HUD) ---

	toggleDiagnostics(): void {
		if (this.diag) {
			cancelAnimationFrame(this.diag.rafId);
			this.diag.el.remove();
			this.diag = null;
			return;
		}
		const el = this.canvasWrapEl.createDiv({ cls: "quick-sketch-diag" });
		this.diag = {
			el,
			penDowns: 0,
			lastDeliveryMs: 0,
			maxDeliveryMs: 0,
			lastLiftGapMs: 0,
			lastDownToMoveMs: 0,
			awaitingFirstMove: null,
			maxDownHandlerMs: 0,
			maxUpHandlerMs: 0,
			longFrames: 0,
			maxFrameMs: 0,
			lastFrameAt: performance.now(),
			rafId: 0,
			touchesAccepted: 0,
			touchesRejected: 0,
			missedPointerUps: 0,
			lastSaveMs: 0,
			lastPenUpAt: 0,
		};
		const tick = (now: number) => {
			const d = this.diag;
			if (!d) return;
			const frame = now - d.lastFrameAt;
			d.lastFrameAt = now;
			if (frame > 50) d.longFrames++;
			d.maxFrameMs = Math.max(d.maxFrameMs, frame);
			const f = (n: number) => n.toFixed(0).padStart(4);
			d.el.setText(
				[
					`pen downs        ${d.penDowns}`,
					`event delivery   last ${f(d.lastDeliveryMs)}ms  max ${f(d.maxDeliveryMs)}ms`,
					`lift gap         ${f(d.lastLiftGapMs)}ms`,
					`down→first move  ${f(d.lastDownToMoveMs)}ms`,
					`handler max      down ${f(d.maxDownHandlerMs)}ms  up ${f(d.maxUpHandlerMs)}ms`,
					`frames >50ms     ${d.longFrames}  worst ${f(d.maxFrameMs)}ms`,
					`touch (palm)     accepted ${d.touchesAccepted}  rejected ${d.touchesRejected}`,
					`missed pen-ups   ${d.missedPointerUps}`,
					`last save        ${f(d.lastSaveMs)}ms`,
					`elements ${this.elements.length}  zoom ${Math.round(this.zoom * 100)}%`,
				].join("\n")
			);
			d.rafId = requestAnimationFrame(tick);
		};
		this.diag.rafId = requestAnimationFrame(tick);
	}

	private markDirtyAndScheduleSave(): void {
		this.dirty = true;
		this.updateStatus();
		this.scheduleSave();
	}

	private scheduleSave(): void {
		this.cancelScheduledSave();
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			// Still mid-stroke/drag (e.g. a pointerup that never arrived)? Try later.
			if (this.isInteracting()) {
				this.scheduleSave();
				return;
			}
			void this.flushSave();
		}, SAVE_DEBOUNCE_MS);
	}

	private cancelScheduledSave(): void {
		if (this.saveTimer) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
	}

	private isInteracting(): boolean {
		return !!(
			this.activeStroke ||
			this.activeShapeDraw ||
			this.selectionDrag ||
			this.selectionBox ||
			this.erasing ||
			this.panDrag
		);
	}

	private async flushSave(): Promise<void> {
		if (this.saveTimer) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		if (!this.dirty || !this.filePath || !this.elementsGroup) return;
		const file = this.app.vault.getAbstractFileByPath(this.filePath);
		if (!(file instanceof TFile)) return;
		this.dirty = false;
		// Embeds of this file in open notes are refreshed by the plugin's
		// vault "modify" listener (see QuickSketchPlugin.refreshSvgEmbeds).
		const t0 = performance.now();
		await this.app.vault.modify(file, this.exportCroppedSvg());
		if (this.diag) this.diag.lastSaveMs = performance.now() - t0;
	}

	/** Serializes only the drawn elements, cropped to their bounding box --
	 * the huge editing workspace never gets saved, just what was actually
	 * drawn. Freehand paths also carry their raw point data in a
	 * `data-points` attribute so a future edit session doesn't need to
	 * reverse-engineer points out of the rendered `d` (needed for
	 * eraser/select hit-testing and moving); every other kind's geometry is
	 * fully recoverable from its native SVG attributes. */
	private exportCroppedSvg(): string {
		const bbox = this.elementsGroup.getBBox();
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
		exportSvg.innerHTML = this.elementsGroup.innerHTML;

		return new XMLSerializer().serializeToString(exportSvg);
	}

	/** Recomputes an element's rendered SVG attributes from its geometry
	 * fields. Called on creation, on every drag-resize frame while drawing a
	 * shape, and after moving a selection. */
	private applyGeometry(elem: DrawnElement): void {
		if (elem.kind === "freehand") {
			elem.el.setAttribute("d", buildSmoothPath(elem.points));
			return;
		}
		if (elem.kind === "text") {
			elem.el.setAttribute("x", String(elem.x));
			elem.el.setAttribute("y", String(elem.y));
			elem.el.querySelectorAll("tspan").forEach((t) => t.setAttribute("x", String(elem.x)));
			return;
		}

		const minX = Math.min(elem.x0, elem.x1);
		const maxX = Math.max(elem.x0, elem.x1);
		const minY = Math.min(elem.y0, elem.y1);
		const maxY = Math.max(elem.y0, elem.y1);

		if (elem.kind === "rectangle") {
			const rect = elem.el as SVGRectElement;
			rect.setAttribute("x", String(minX));
			rect.setAttribute("y", String(minY));
			rect.setAttribute("width", String(maxX - minX));
			rect.setAttribute("height", String(maxY - minY));
		} else if (elem.kind === "ellipse") {
			const ellipse = elem.el as SVGEllipseElement;
			ellipse.setAttribute("cx", String((minX + maxX) / 2));
			ellipse.setAttribute("cy", String((minY + maxY) / 2));
			ellipse.setAttribute("rx", String((maxX - minX) / 2));
			ellipse.setAttribute("ry", String((maxY - minY) / 2));
		} else if (elem.kind === "triangle") {
			const polygon = elem.el as SVGPolygonElement;
			const midX = (minX + maxX) / 2;
			polygon.setAttribute("points", `${midX},${minY} ${minX},${maxY} ${maxX},${maxY}`);
		} else if (elem.kind === "arrow") {
			this.applyArrowGeometry(elem);
		}
	}

	private applyArrowGeometry(elem: ShapeElement): void {
		const g = elem.el as SVGGElement;
		const line = g.querySelector("line");
		const head = g.querySelector("polygon");
		if (!line || !head) return;
		line.setAttribute("x1", String(elem.x0));
		line.setAttribute("y1", String(elem.y0));
		line.setAttribute("x2", String(elem.x1));
		line.setAttribute("y2", String(elem.y1));

		const angle = Math.atan2(elem.y1 - elem.y0, elem.x1 - elem.x0);
		const headLen = Math.max(10, elem.size * 4);
		const headAngle = Math.PI / 7; // ~25.7 degrees
		const p1x = elem.x1 - headLen * Math.cos(angle - headAngle);
		const p1y = elem.y1 - headLen * Math.sin(angle - headAngle);
		const p2x = elem.x1 - headLen * Math.cos(angle + headAngle);
		const p2y = elem.y1 - headLen * Math.sin(angle + headAngle);
		head.setAttribute("points", `${elem.x1},${elem.y1} ${p1x},${p1y} ${p2x},${p2y}`);
	}

	private createFreehandElement(
		color: string,
		size: number,
		points: Point[],
		id?: string,
		highlight = false
	): FreehandElement {
		const pathEl = document.createElementNS(SVG_NS, "path") as SVGPathElement;
		this.styleFreehandPath(pathEl, color, size, highlight);
		pathEl.setAttribute("d", buildSmoothPath(points));
		pathEl.setAttribute("data-points", JSON.stringify(points));
		this.insertPath(pathEl, highlight);
		return { id: id ?? uid(), kind: "freehand", el: pathEl, color, size, points, highlight };
	}

	private createShapeElement(
		kind: ShapeKind,
		color: string,
		size: number,
		x0: number,
		y0: number,
		x1: number,
		y1: number,
		id?: string
	): ShapeElement {
		let el: SVGGraphicsElement;
		if (kind === "rectangle") {
			el = document.createElementNS(SVG_NS, "rect") as SVGRectElement;
			el.setAttribute("stroke", color);
			el.setAttribute("stroke-width", String(size));
			el.setAttribute("fill", "none");
			el.setAttribute("stroke-linejoin", "round");
		} else if (kind === "ellipse") {
			el = document.createElementNS(SVG_NS, "ellipse") as SVGEllipseElement;
			el.setAttribute("stroke", color);
			el.setAttribute("stroke-width", String(size));
			el.setAttribute("fill", "none");
		} else if (kind === "triangle") {
			el = document.createElementNS(SVG_NS, "polygon") as SVGPolygonElement;
			el.setAttribute("stroke", color);
			el.setAttribute("stroke-width", String(size));
			el.setAttribute("fill", "none");
			el.setAttribute("stroke-linejoin", "round");
		} else {
			// Arrow: a <g> wrapping a shaft <line> and a solid-filled arrowhead
			// <polygon>, rather than an SVG <marker> -- avoids marker/defs
			// bookkeeping and keeps the arrowhead's angle trivially correct at
			// any orientation.
			const g = document.createElementNS(SVG_NS, "g") as SVGGElement;
			g.setAttribute("data-kind", "arrow");
			const line = document.createElementNS(SVG_NS, "line") as SVGLineElement;
			line.setAttribute("stroke", color);
			line.setAttribute("stroke-width", String(size));
			line.setAttribute("stroke-linecap", "round");
			const head = document.createElementNS(SVG_NS, "polygon") as SVGPolygonElement;
			head.setAttribute("fill", color);
			g.appendChild(line);
			g.appendChild(head);
			el = g;
		}
		this.elementsGroup.appendChild(el);
		const elem: ShapeElement = { id: id ?? uid(), kind, el, color, size, x0, y0, x1, y1 };
		this.applyGeometry(elem);
		return elem;
	}

	private createTextElement(color: string, fontSize: number, x: number, y: number, text: string, id?: string): TextElement {
		const textEl = document.createElementNS(SVG_NS, "text") as SVGTextElement;
		textEl.setAttribute("fill", color);
		textEl.setAttribute("font-size", String(fontSize));
		textEl.setAttribute("font-family", "sans-serif");
		for (const line of text.split("\n")) {
			const tspan = document.createElementNS(SVG_NS, "tspan");
			tspan.setAttribute("x", String(x));
			tspan.setAttribute("dy", textEl.childElementCount === 0 ? "0" : "1.2em");
			tspan.textContent = line;
			textEl.appendChild(tspan);
		}
		textEl.setAttribute("x", String(x));
		textEl.setAttribute("y", String(y));
		this.elementsGroup.appendChild(textEl);
		return { id: id ?? uid(), kind: "text", el: textEl, color, size: fontSize, x, y, text };
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

	/** Loads previously-cropped elements into the big workspace, recentered so
	 * there's equal room to keep drawing in any direction around them. */
	private applySvgContent(content: string): void {
		this.activeStroke = null;
		this.activeShapeDraw = null;
		this.cancelTextEditor();
		this.selectedIds.clear();
		this.selectionBox = null;
		this.selectionDrag = null;
		this.elementsGroup.innerHTML = "";
		if (this.overlayGroup) this.overlayGroup.innerHTML = "";
		this.elements = [];

		let root: Element | null = null;
		try {
			const parsed = new DOMParser().parseFromString(content, "image/svg+xml");
			root = parsed.documentElement;
			if (!root || root.tagName.toLowerCase() !== "svg" || parsed.querySelector("parsererror")) root = null;
		} catch {
			root = null;
		}
		if (!root) return;

		type RawElement =
			| { kind: "freehand"; color: string; size: number; points: Point[]; highlight: boolean }
			| { kind: ShapeKind; color: string; size: number; x0: number; y0: number; x1: number; y1: number }
			| { kind: "text"; color: string; size: number; x: number; y: number; text: string };

		const raw: RawElement[] = [];
		// Every element this plugin writes is a direct child of the exported
		// <svg> root (see exportCroppedSvg); a shallow scan -- rather than
		// querySelectorAll, which would also match the arrowhead <polygon>
		// nested inside an arrow's <g> -- keeps each top-level element counted
		// exactly once.
		for (const child of Array.from(root.children)) {
			const tag = child.tagName.toLowerCase();
			if (tag === "path") {
				const color = child.getAttribute("stroke") ?? DEFAULT_COLOR;
				const size = parseFloat(child.getAttribute("stroke-width") ?? "") || DEFAULT_STROKE_PX;
				let points: Point[] = [];
				const dataPoints = child.getAttribute("data-points");
				if (dataPoints) {
					try {
						const parsed = JSON.parse(dataPoints);
						if (Array.isArray(parsed)) points = parsed;
					} catch {
						points = [];
					}
				}
				if (points.length === 0) points = parseLegacyPathPoints(child.getAttribute("d") ?? "");
				const highlight = child.getAttribute("data-highlight") === "true";
				if (points.length > 0) raw.push({ kind: "freehand", color, size, points, highlight });
			} else if (tag === "rect") {
				const color = child.getAttribute("stroke") ?? DEFAULT_COLOR;
				const size = parseFloat(child.getAttribute("stroke-width") ?? "") || DEFAULT_STROKE_PX;
				const x = parseFloat(child.getAttribute("x") ?? "0");
				const y = parseFloat(child.getAttribute("y") ?? "0");
				const w = parseFloat(child.getAttribute("width") ?? "0");
				const h = parseFloat(child.getAttribute("height") ?? "0");
				raw.push({ kind: "rectangle", color, size, x0: x, y0: y, x1: x + w, y1: y + h });
			} else if (tag === "ellipse") {
				const color = child.getAttribute("stroke") ?? DEFAULT_COLOR;
				const size = parseFloat(child.getAttribute("stroke-width") ?? "") || DEFAULT_STROKE_PX;
				const cx = parseFloat(child.getAttribute("cx") ?? "0");
				const cy = parseFloat(child.getAttribute("cy") ?? "0");
				const rx = parseFloat(child.getAttribute("rx") ?? "0");
				const ry = parseFloat(child.getAttribute("ry") ?? "0");
				raw.push({ kind: "ellipse", color, size, x0: cx - rx, y0: cy - ry, x1: cx + rx, y1: cy + ry });
			} else if (tag === "polygon") {
				const color = child.getAttribute("stroke") ?? DEFAULT_COLOR;
				const size = parseFloat(child.getAttribute("stroke-width") ?? "") || DEFAULT_STROKE_PX;
				const pts = (child.getAttribute("points") ?? "")
					.trim()
					.split(/\s+/)
					.map((pair) => {
						const [px, py] = pair.split(",").map(Number);
						return { x: px, y: py };
					})
					.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
				if (pts.length > 0) {
					const minX = Math.min(...pts.map((p) => p.x));
					const maxX = Math.max(...pts.map((p) => p.x));
					const minY = Math.min(...pts.map((p) => p.y));
					const maxY = Math.max(...pts.map((p) => p.y));
					raw.push({ kind: "triangle", color, size, x0: minX, y0: minY, x1: maxX, y1: maxY });
				}
			} else if (tag === "g" && child.getAttribute("data-kind") === "arrow") {
				const line = child.querySelector("line");
				const head = child.querySelector("polygon");
				const color = line?.getAttribute("stroke") ?? head?.getAttribute("fill") ?? DEFAULT_COLOR;
				const size = parseFloat(line?.getAttribute("stroke-width") ?? "") || DEFAULT_STROKE_PX;
				const x0 = parseFloat(line?.getAttribute("x1") ?? "0");
				const y0 = parseFloat(line?.getAttribute("y1") ?? "0");
				const x1 = parseFloat(line?.getAttribute("x2") ?? "0");
				const y1 = parseFloat(line?.getAttribute("y2") ?? "0");
				raw.push({ kind: "arrow", color, size, x0, y0, x1, y1 });
			} else if (tag === "text") {
				const color = child.getAttribute("fill") ?? DEFAULT_COLOR;
				const fontSize = parseFloat(child.getAttribute("font-size") ?? "") || DEFAULT_STROKE_PX * TEXT_SIZE_MULTIPLIER;
				const x = parseFloat(child.getAttribute("x") ?? "0");
				const y = parseFloat(child.getAttribute("y") ?? "0");
				const tspans = Array.from(child.querySelectorAll("tspan"));
				const text = tspans.length > 0 ? tspans.map((t) => t.textContent ?? "").join("\n") : child.textContent ?? "";
				if (text) raw.push({ kind: "text", color, size: fontSize, x, y, text });
			}
		}
		if (raw.length === 0) return;

		let minX = Infinity,
			minY = Infinity,
			maxX = -Infinity,
			maxY = -Infinity;
		const consider = (x: number, y: number) => {
			if (x < minX) minX = x;
			if (y < minY) minY = y;
			if (x > maxX) maxX = x;
			if (y > maxY) maxY = y;
		};
		for (const r of raw) {
			if (r.kind === "freehand") {
				for (const p of r.points) consider(p.x, p.y);
			} else if (r.kind === "text") {
				consider(r.x, r.y);
			} else {
				consider(r.x0, r.y0);
				consider(r.x1, r.y1);
			}
		}
		const dx = WORKSPACE_CENTER - (minX + maxX) / 2;
		const dy = WORKSPACE_CENTER - (minY + maxY) / 2;

		this.elements = raw.map((r) => {
			if (r.kind === "freehand") {
				return this.createFreehandElement(
					r.color,
					r.size,
					r.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
					undefined,
					r.highlight
				);
			}
			if (r.kind === "text") {
				return this.createTextElement(r.color, r.size, r.x + dx, r.y + dy, r.text);
			}
			return this.createShapeElement(r.kind, r.color, r.size, r.x0 + dx, r.y0 + dy, r.x1 + dx, r.y1 + dy);
		});
	}

	/** Resets zoom to 100% and recenters the viewport on the drawing's actual
	 * content (its bounding box center), or the workspace's fixed center if
	 * there's nothing drawn yet. Centering on the fixed workspace center
	 * unconditionally would strand the viewport away from your work once the
	 * content has drifted from that point -- which reads as the drawing
	 * "moving away" and any new strokes landing in a big empty gap next to it. */
	private centerView(): void {
		requestAnimationFrame(() => {
			const wrap = this.canvasWrapEl;
			if (!wrap) return;
			this.zoom = 1;
			let centerX = WORKSPACE_CENTER;
			let centerY = WORKSPACE_CENTER;
			if (this.elements.length > 0) {
				const bbox = this.elementsGroup.getBBox();
				centerX = bbox.x + bbox.width / 2;
				centerY = bbox.y + bbox.height / 2;
			}
			this.panX = wrap.clientWidth / 2 - centerX * this.zoom;
			this.panY = wrap.clientHeight / 2 - centerY * this.zoom;
			this.applyTransform();
		});
	}
}
