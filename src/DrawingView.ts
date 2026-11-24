import { ItemView, Menu, Notice, TFile, ViewStateResult, WorkspaceLeaf, normalizePath, setIcon } from "obsidian";
import {
	ArrowHeads,
	BIND_DISTANCE_PX,
	CLOSED_SHAPE_TOOLS,
	COLORS,
	CROP_PADDING,
	DEFAULT_COLOR,
	DEFAULT_STROKE_PX,
	DEFAULT_TOOL,
	DOUBLE_TAP_MS,
	EMPTY_EXPORT_HEIGHT,
	EMPTY_EXPORT_WIDTH,
	EMPTY_SVG,
	ERASE_RADIUS_PX,
	FillStyle,
	HANDLE_HIT_PX,
	HANDLE_SIZE_PX,
	HIGHLIGHT_COLORS,
	HIGHLIGHT_OPACITY,
	HIGHLIGHT_SIZE_MULTIPLIER,
	MAX_ZOOM,
	LIGHT_FILL_OPACITY,
	MIN_ZOOM,
	NUDGE_BIG_PX,
	NUDGE_PX,
	PASTE_OFFSET,
	SELECT_HIT_RADIUS_PX,
	SELECT_TOOLS,
	SHAPE_TOOLS,
	STROKE_SIZES,
	TEXT_SIZE_MULTIPLIER,
	Tool,
	VIEW_TYPE_DRAWING,
	WORKSPACE_CENTER,
	WORKSPACE_SIZE,
	SIMPLIFY_TOLERANCE,
} from "./constants";
import { ConfirmModal } from "./confirm";
import { copyPngToClipboard, svgToPng } from "./export";
import { decodePressure, encodePressure, pressureOutline } from "./freehand";
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
	/** Pen pressure (0..1), only on points of pressure strokes. */
	p?: number;
}

/** "triangle" is no longer drawable (the toolbar offers a diamond instead)
 * but is kept so triangles in older files still load and render. */
type ShapeKind = "rectangle" | "ellipse" | "diamond" | "triangle" | "arrow";
type ElementKind = "freehand" | ShapeKind | "text";

interface FreehandElement {
	id: string;
	kind: "freehand";
	el: SVGPathElement;
	color: string;
	size: number;
	points: Point[];
	highlight?: boolean;
	/** Points carry pen pressure; rendered as a filled variable-width outline. */
	pressure?: boolean;
}

/** A shape's geometry and style -- everything but its id and live DOM. */
interface ShapeData {
	kind: ShapeKind;
	color: string;
	size: number;
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	label?: string;
	labelSize?: number;
	/** Closed shapes only; missing means "none". */
	fill?: FillStyle;
	/** Arrows only; missing means "end" (what older files have). A line is
	 * an arrow with no heads. */
	heads?: ArrowHeads;
	/** Arrows only: ids of the elements the start/end is attached to. */
	startBind?: string;
	endBind?: string;
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
	fill?: FillStyle;
	heads?: ArrowHeads;
	startBind?: string;
	endBind?: string;
	/** Optional text centered inside the shape (or above an arrow's line). */
	label?: string;
	labelSize?: number; // font size
	labelEl?: SVGTextElement;
	/** While labeled, the <g data-kind="labeled"> holding the shape and its
	 * label, so they form one unit in the DOM and in the saved file. */
	labelGroup?: SVGGElement;
	/** Inputs of the last label fit, to skip re-wrapping when only moved. */
	labelFitKey?: string;
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
	| { kind: "text"; x: number; y: number; size: number };

/** Serialized form used for undo/redo snapshots -- geometry only, no live DOM refs. */
type SerializedElement =
	| { id: string; kind: "freehand"; color: string; size: number; points: Point[]; highlight?: boolean; pressure?: boolean }
	| ({ id: string } & ShapeData)
	| { id: string; kind: "text"; color: string; size: number; x: number; y: number; text: string };

/** Elements copied with Cmd/Ctrl+C -- shared by all open drawings, so you
 * can copy from one and paste into another. */
let clipboard: SerializedElement[] = [];

interface ActiveDrawStroke {
	pathEl: SVGPathElement;
	points: Point[];
	pointerId: number;
	color: string;
	size: number;
	highlight: boolean;
	pressure: boolean;
}

interface ActiveShapeDraw {
	kind: ShapeKind;
	elem: ShapeElement;
	pointerId: number;
	/** Where the press started (before any snapping to a bound shape). */
	start: Point;
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
	/** Set on the first move (a press alone doesn't move anything). */
	moved?: boolean;
}

interface SelectionBox {
	pointerId: number;
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	/** Shift held: add to the selection that existed before (`base`). */
	base: string[];
}

interface Lasso {
	pointerId: number;
	points: Point[];
	base: string[];
}

/** The eight box handles, and the two endpoint handles of a lone arrow. */
type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "start" | "end";

interface SelectionResize {
	pointerId: number;
	handle: HandleId;
	box0: Rect;
	original: Map<string, GeometrySnapshot>;
	snapshotTaken: boolean;
}

interface EndpointDrag {
	pointerId: number;
	elem: ShapeElement;
	end: "start" | "end";
	snapshotTaken: boolean;
}

interface Bounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

const LABEL_LINE_HEIGHT = 1.2; // em
const LABEL_MIN_FONT = 4;

let measureCtx: CanvasRenderingContext2D | null = null;
function measureText(text: string, fontSize: number): number {
	if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
	if (!measureCtx) return text.length * fontSize * 0.55;
	measureCtx.font = `${fontSize}px sans-serif`;
	return measureCtx.measureText(text).width;
}

/** Greedy word wrap of `text` (explicit newlines kept) to `maxWidth`. */
function wrapText(text: string, fontSize: number, maxWidth: number): string[] {
	const lines: string[] = [];
	for (const para of text.split("\n")) {
		let line = "";
		for (const word of para.split(/\s+/).filter(Boolean)) {
			const candidate = line ? `${line} ${word}` : word;
			if (line && measureText(candidate, fontSize) > maxWidth) {
				lines.push(line);
				line = word;
			} else {
				line = candidate;
			}
		}
		lines.push(line);
	}
	return lines;
}

/** Picks the largest font size, up to `baseSize`, at which `text` wraps to
 * fit inside a `maxWidth` x `maxHeight` box, and returns the wrapped lines. */
function fitLabel(text: string, baseSize: number, maxWidth: number, maxHeight: number): { lines: string[]; fontSize: number } {
	let fontSize = baseSize;
	for (;;) {
		const lines = wrapText(text, fontSize, maxWidth);
		const widest = Math.max(...lines.map((l) => measureText(l, fontSize)));
		const height = lines.length * fontSize * LABEL_LINE_HEIGHT;
		if ((widest <= maxWidth && height <= maxHeight) || fontSize <= LABEL_MIN_FONT) return { lines, fontSize };
		fontSize = Math.max(LABEL_MIN_FONT, fontSize * 0.9);
	}
}

/** Single-key shortcuts (no modifiers) for switching tools. */
const KEY_TOOLS: Record<string, Tool> = {
	p: "pencil",
	h: "highlighter",
	e: "eraser",
	t: "text",
	s: "rectangle",
	c: "ellipse",
	d: "diamond",
	a: "arrow",
	l: "line",
	v: "select",
	f: "lasso",
};

/** Single-key shortcuts for the ink color. */
const KEY_COLORS: Record<string, string> = {
	b: COLORS[0], // black
	r: COLORS[2], // red
	o: COLORS[3], // orange
	g: COLORS[4], // green
};

function uid(): string {
	return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Rounds to 0.1 canvas units -- far below anything visible, and it keeps
 * saved coordinates short instead of 17-digit floats from getScreenCTM(). */
function round1(n: number): number {
	return Math.round(n * 10) / 10;
}

/** Formats a number for an SVG attribute at 0.1 precision, without float
 * noise like "12.299999999". */
function fmt(n: number): string {
	return String(round1(n));
}

/** Formats integer tenths compactly: 15 -> "1.5", 5 -> ".5", -5 -> "-.5". */
function fmtTenths(n: number): string {
	const s = (Math.abs(n) / 10).toString().replace(/^0\./, ".");
	return n < 0 ? "-" + s : s;
}

/** Joins numbers the way SVG path data allows: a minus sign doubles as a
 * separator, so a space is only needed before non-negative values. */
function joinTenths(nums: number[]): string {
	let out = "";
	for (const n of nums) {
		const v = fmtTenths(n);
		if (out && v[0] !== "-") out += " ";
		out += v;
	}
	return out;
}

/** Smooth path through `points` using quadratic segments whose control
 * points are the raw input points and whose endpoints are the midpoints
 * between them. Written with relative commands in integer tenths so the
 * numbers stay short and exact (no rounding drift), and so the raw points
 * can be recovered exactly from `d` by parseSmoothPath -- no separate copy of
 * the point data needs saving. */
function buildSmoothPath(points: Point[]): string {
	const t = points.map((p) => ({ x: Math.round(p.x * 10), y: Math.round(p.y * 10) }));
	let cx = t[0].x;
	let cy = t[0].y;
	let d = "M" + joinTenths([cx, cy]);
	if (t.length === 1) return d + "l0 0";
	for (let i = 1; i < t.length - 1; i++) {
		const mx = Math.round((t[i].x + t[i + 1].x) / 2);
		const my = Math.round((t[i].y + t[i + 1].y) / 2);
		d += "q" + joinTenths([t[i].x - cx, t[i].y - cy, mx - cx, my - cy]);
		cx = mx;
		cy = my;
	}
	const last = t[t.length - 1];
	return d + "l" + joinTenths([last.x - cx, last.y - cy]);
}

/** Inverse of buildSmoothPath: recovers the raw points from its compact
 * relative `d`. Returns null for anything not in that exact format (legacy
 * absolute paths, externally-edited files). */
function parseSmoothPath(d: string): Point[] | null {
	const m = /^M([^a-zA-Z]*)((?:q[^a-zA-Z]*)*)l([^a-zA-Z]*)$/.exec(d.trim());
	if (!m) return null;
	const nums = (str: string) => (str.match(/-?(?:\d+\.?\d*|\.\d+)/g) ?? []).map(Number);
	const start = nums(m[1]);
	const end = nums(m[3]);
	if (start.length !== 2 || end.length !== 2) return null;
	let cx = start[0];
	let cy = start[1];
	const points: Point[] = [{ x: cx, y: cy }];
	for (const seg of m[2].split("q").slice(1)) {
		const n = nums(seg);
		if (n.length !== 4) return null;
		points.push({ x: round1(cx + n[0]), y: round1(cy + n[1]) });
		cx = round1(cx + n[2]);
		cy = round1(cy + n[3]);
	}
	const last = { x: round1(cx + end[0]), y: round1(cy + end[1]) };
	// A single dot is written as "M x y l0 0" -- don't double its point.
	if (points.length > 1 || last.x !== points[0].x || last.y !== points[0].y) points.push(last);
	return points;
}

/** Best-effort fallback for reading point data back out of a plain `d`
 * string -- used only for externally-edited SVGs whose `d` isn't in the
 * format buildSmoothPath writes (and that predate `data-points`). */
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

/** Ramer-Douglas-Peucker: keeps only the points that deviate from the
 * straight line between their neighbours by more than `tolerance`. Always
 * keeps the endpoints. Iterative (explicit stack) so very long strokes
 * can't blow the call stack. */
function simplifyPoints(points: Point[], tolerance: number): Point[] {
	if (points.length < 3) return points;
	const keep = new Uint8Array(points.length);
	keep[0] = 1;
	keep[points.length - 1] = 1;
	const stack: [number, number][] = [[0, points.length - 1]];
	while (stack.length > 0) {
		const [first, last] = stack.pop()!;
		const a = points[first];
		const b = points[last];
		let maxDist = 0;
		let index = -1;
		for (let i = first + 1; i < last; i++) {
			const dist = distToSegment(points[i].x, points[i].y, a.x, a.y, b.x, b.y);
			if (dist > maxDist) {
				maxDist = dist;
				index = i;
			}
		}
		if (index !== -1 && maxDist > tolerance) {
			keep[index] = 1;
			stack.push([first, index], [index, last]);
		}
	}
	return points.filter((_, i) => keep[i] === 1);
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

interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

function unionRect(rects: Rect[]): Rect | null {
	if (rects.length === 0) return null;
	let minX = Infinity,
		minY = Infinity,
		maxX = -Infinity,
		maxY = -Infinity;
	for (const r of rects) {
		minX = Math.min(minX, r.x);
		minY = Math.min(minY, r.y);
		maxX = Math.max(maxX, r.x + r.width);
		maxY = Math.max(maxY, r.y + r.height);
	}
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Even-odd ray cast. */
function pointInPolygon(x: number, y: number, poly: Point[]): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const a = poly[i];
		const b = poly[j];
		if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
	}
	return inside;
}

/** Black or white, whichever reads better on `hex`. */
function contrastColor(hex: string): string {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return "#ffffff";
	const n = parseInt(m[1], 16);
	const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
	return lum > 0.6 ? "#1e1e1e" : "#ffffff";
}

/** Snaps the direction from `from` to `to` to a multiple of 15 degrees,
 * keeping the distance. */
function snapAngle(from: Point, to: Point): Point {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const len = Math.hypot(dx, dy);
	const step = Math.PI / 12;
	const a = Math.round(Math.atan2(dy, dx) / step) * step;
	return { x: round1(from.x + Math.cos(a) * len), y: round1(from.y + Math.sin(a) * len) };
}

/** Bounding box of an element's rendered SVG, including a shape's label. */
function elementBBox(elem: DrawnElement): Rect {
	const b = elem.el.getBBox();
	const box = { x: b.x, y: b.y, width: b.width, height: b.height };
	if (elem.kind !== "freehand" && elem.kind !== "text" && elem.labelEl) {
		const l = elem.labelEl.getBBox();
		const minX = Math.min(box.x, l.x);
		const minY = Math.min(box.y, l.y);
		box.width = Math.max(box.x + box.width, l.x + l.width) - minX;
		box.height = Math.max(box.y + box.height, l.y + l.height) - minY;
		box.x = minX;
		box.y = minY;
	}
	return box;
}

/** Hit-test used by the eraser and select tools. Freehand strokes use precise
 * point-to-segment distance; every other kind uses its bounding box (padded
 * by the hit radius) -- clicking anywhere inside an unfilled rectangle still
 * selects it, which matches how most diagramming tools behave. */
function elementHit(elem: DrawnElement, x: number, y: number, radius: number): boolean {
	if (elem.kind === "freehand") return freehandHit(elem, x, y, radius);
	const b = elementBBox(elem);
	return x >= b.x - radius && x <= b.x + b.width + radius && y >= b.y - radius && y <= b.y + b.height + radius;
}

function isBindable(e: DrawnElement): e is ShapeElement | TextElement {
	return e.kind === "text" || isClosedShape(e);
}

/** The element's outermost DOM node (a labeled shape's wrapping group). */
function rootNode(e: DrawnElement): Element {
	return (e.kind !== "freehand" && e.kind !== "text" && e.labelGroup) || e.el;
}

function offsetSerialized(s: SerializedElement, dx: number, dy: number): SerializedElement {
	if (s.kind === "freehand") return { ...s, points: s.points.map((p) => ({ x: round1(p.x + dx), y: round1(p.y + dy), p: p.p })) };
	if (s.kind === "text") return { ...s, x: s.x + dx, y: s.y + dy };
	return { ...s, x0: s.x0 + dx, y0: s.y0 + dy, x1: s.x1 + dx, y1: s.y1 + dy };
}

/** `d` for a freehand stroke: its centerline, or for a pressure stroke the
 * filled outline. */
function freehandPathData(points: Point[], size: number, pressure: boolean): string {
	return pressure ? pressureOutline(points, size) : buildSmoothPath(points);
}

/** Some pens report 0 on the first event of a stroke; treat that as normal. */
function penPressure(evt: PointerEvent): number {
	return evt.pressure > 0 ? Math.min(1, evt.pressure) : 0.5;
}

function isClosedShape(e: DrawnElement): e is ShapeElement {
	return e.kind === "rectangle" || e.kind === "ellipse" || e.kind === "diamond" || e.kind === "triangle";
}

/** Toolbar glyphs drawn from numbers only (safe for innerHTML). */
function glyph(inner: string): string {
	return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}
function lineIcon(width: number): string {
	return glyph(`<line x1="5" y1="12" x2="19" y2="12" stroke-width="${width}"/>`);
}
function fillIcon(opacity: number): string {
	return glyph(`<rect x="4" y="4" width="16" height="16" rx="3" stroke-width="2" fill="currentColor" fill-opacity="${opacity}"/>`);
}
function headsIcon(start: boolean, end: boolean): string {
	let inner = `<line x1="4" y1="12" x2="20" y2="12" stroke-width="2"/>`;
	if (end) inner += `<path d="M14 7l6 5-6 5" stroke-width="2"/>`;
	if (start) inner += `<path d="M10 7l-6 5 6 5" stroke-width="2"/>`;
	return glyph(inner);
}

export class DrawingView extends ItemView {
	private filePath: string | null = null;
	private svgEl!: SVGSVGElement;
	private elementsGroup!: SVGGElement;
	private overlayGroup!: SVGGElement;
	private toolbarEl!: HTMLElement;
	private actionsEl!: HTMLElement;
	private stylePanelEl!: HTMLElement;
	private zoomEl!: HTMLElement;
	private zoomLabelEl: HTMLElement | null = null;
	/** What the style panel was last built for; rebuilt only when it changes. */
	private stylePanelKey = "";
	private canvasWrapEl!: HTMLElement;

	private readonly plugin: QuickSketchPlugin;

	private tool: Tool = DEFAULT_TOOL;
	private currentColor = DEFAULT_COLOR;
	private currentHighlightColor = HIGHLIGHT_COLORS[0];
	private currentSize = DEFAULT_STROKE_PX;
	/** The highlighter keeps its own S/M/L choice, independent of the pen's. */
	private currentHighlightSize = DEFAULT_STROKE_PX;
	private currentFill: FillStyle = "none";
	private currentArrowHeads: ArrowHeads = "end";
	/** The variant each grouped toolbar button switches to. */
	private lastShapeTool: Tool = "rectangle";
	private lastSelectTool: Tool = "select";

	private elements: DrawnElement[] = [];
	private activeStroke: ActiveDrawStroke | null = null;
	private activeShapeDraw: ActiveShapeDraw | null = null;

	private textEditor: HTMLTextAreaElement | null = null;
	private textEditorCanvasPoint: Point | null = null;
	/** Set when the open text editor is editing a shape's label rather than
	 * placing a new text element, or an existing text element. */
	private textEditorTarget: ShapeElement | TextElement | null = null;
	/** Last select-tool tap on an element, for double-tap detection. */
	private lastSelectTap: { id: string; time: number } | null = null;

	private erasing = false;
	private eraseDragPointerId: number | null = null;
	private eraseSnapshotTaken = false;

	private selectedIds: Set<string> = new Set();
	private selectionBox: SelectionBox | null = null;
	private selectionDrag: SelectionDrag | null = null;
	private selectionResize: SelectionResize | null = null;
	private endpointDrag: EndpointDrag | null = null;
	private lasso: Lasso | null = null;
	/** Handles as last drawn, in canvas coordinates, for hit-testing. */
	private handles: { id: HandleId; x: number; y: number }[] = [];
	/** Shape an arrow end being drawn/dragged would attach to, outlined. */
	private bindHighlightId: string | null = null;
	/** Space held (desktop): any drag pans. */
	private spaceHeld = false;
	private pasteCount = 0;
	private lastNudgeAt = 0;

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
	private onWindowKeyUp: (e: KeyboardEvent) => void = () => {};

	constructor(leaf: WorkspaceLeaf, plugin: QuickSketchPlugin) {
		super(leaf);
		this.plugin = plugin;
		const s = plugin.settings;
		this.tool = s.defaultTool;
		this.currentColor = s.defaultColor;
		this.currentSize = s.defaultSize;
		if (SHAPE_TOOLS.has(this.tool)) this.lastShapeTool = this.tool;
		if (SELECT_TOOLS.has(this.tool)) this.lastSelectTool = this.tool;
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
		this.onWindowKeyUp = (e: KeyboardEvent) => {
			if (e.key === " " && this.spaceHeld) {
				this.spaceHeld = false;
				this.applyToolClass();
			}
		};
		window.addEventListener("keydown", this.onWindowKeyDown);
		window.addEventListener("keyup", this.onWindowKeyUp);
		if (this.filePath) {
			await this.loadFromFile();
		}
		this.centerView();
	}

	async onClose(): Promise<void> {
		if (this.diag) this.toggleDiagnostics();
		window.removeEventListener("keydown", this.onWindowKeyDown);
		window.removeEventListener("keyup", this.onWindowKeyUp);
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

		// Floating controls over the canvas. They're siblings of the canvas
		// wrapper, not children, so presses on them never reach its pointer
		// handlers.
		const topbar = container.createDiv({ cls: "qs-topbar" });
		topbar.createDiv({ cls: "qs-topbar-spacer" });
		this.toolbarEl = topbar.createDiv({ cls: "qs-island qs-tools" });
		const right = topbar.createDiv({ cls: "qs-topbar-right" });
		this.actionsEl = right.createDiv({ cls: "qs-island qs-actions" });
		this.stylePanelEl = container.createDiv({ cls: "qs-island qs-style-panel" });
		this.zoomEl = container.createDiv({ cls: "qs-island qs-zoom" });

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
		this.groupSyncs = [];

		this.groupButton(
			tb,
			[
				{ tool: "select", name: "Select", key: "V", icon: ICON.pointer },
				{ tool: "lasso", name: "Lasso select", key: "F", icon: ICON.lasso },
			],
			() => this.lastSelectTool
		);
		this.btn(tb, "Pan (or hold Space / drag with two fingers)", ICON.hand, () => this.setTool("pan"), () => this.tool === "pan");
		tb.createDiv({ cls: "qs-sep" });
		this.btn(tb, "Pen (P)", ICON.pencil, () => this.setTool("pencil"), () => this.tool === "pencil");
		this.btn(tb, "Highlighter (H)", ICON.highlighter, () => this.setTool("highlighter"), () => this.tool === "highlighter");
		this.btn(tb, "Eraser (E)", ICON.eraser, () => this.setTool("eraser"), () => this.tool === "eraser");
		tb.createDiv({ cls: "qs-sep" });
		this.groupButton(
			tb,
			[
				{ tool: "rectangle", name: "Rectangle", key: "S", icon: ICON.rectangle },
				{ tool: "ellipse", name: "Ellipse", key: "C", icon: ICON.ellipse },
				{ tool: "diamond", name: "Diamond", key: "D", icon: ICON.diamond },
				{ tool: "line", name: "Line", key: "L", icon: ICON.line },
				{ tool: "arrow", name: "Arrow", key: "A", icon: ICON.arrow },
			],
			() => this.lastShapeTool
		);
		this.btn(tb, "Text (T)", ICON.text, () => this.setTool("text"), () => this.tool === "text");

		const actions = this.actionsEl;
		actions.empty();
		this.btn(actions, "Undo (Cmd/Ctrl+Z)", ICON.undo, () => this.undo());
		this.btn(actions, "Redo (Cmd/Ctrl+Shift+Z)", ICON.redo, () => this.redo());
		const moreBtn = this.btn(actions, "More", ICON.more, () => this.openMoreMenu(moreBtn));
		const doneBtn = actions.createEl("button", { text: "Done", cls: "mod-cta qs-done" });
		doneBtn.onclick = () => void this.done();

		const zoom = this.zoomEl;
		zoom.empty();
		this.btn(zoom, "Zoom out", ICON.minus, () => this.zoomAtCenter(1 / 1.2));
		const label = zoom.createEl("button", { cls: "qs-zoom-label", attr: { "aria-label": "Reset zoom to 100%", title: "Reset zoom to 100%" } });
		label.onclick = (evt) => {
			evt.preventDefault();
			this.zoomAtCenter(1 / this.zoom);
		};
		this.zoomLabelEl = label;
		this.btn(zoom, "Zoom in", ICON.plus, () => this.zoomAtCenter(1.2));
		this.btn(zoom, "Zoom to fit", ICON.fit, () => this.zoomToFit());

		this.stylePanelKey = "";
		this.refreshToolbarState();
	}

	/** Functions that refresh each grouped tool button's icon/label. */
	private groupSyncs: (() => void)[] = [];

	private btn(parent: HTMLElement, label: string, icon: string, onClick: () => void, isActive?: () => boolean): HTMLButtonElement {
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
	}

	/** One button standing for several related tools: it shows (and picks)
	 * the last one used; pressing it while one of them is active opens a menu
	 * of all of them. */
	private groupButton(parent: HTMLElement, variants: { tool: Tool; name: string; key: string; icon: string }[], last: () => Tool): void {
		const btn = parent.createEl("button", { cls: "quick-sketch-btn qs-group-btn" });
		const isActive = () => variants.some((v) => v.tool === this.tool);
		const sync = () => {
			const v = variants.find((x) => x.tool === last()) ?? variants[0];
			if (btn.dataset.icon !== v.icon) {
				btn.empty();
				setIcon(btn, v.icon);
				btn.dataset.icon = v.icon;
			}
			const label = `${v.name} (${v.key}) - press again for ${variants.length > 2 ? "more" : variants.filter((x) => x !== v).map((x) => x.name.toLowerCase()).join("")}`;
			btn.setAttribute("aria-label", label);
			btn.setAttribute("title", label);
		};
		sync();
		this.groupSyncs.push(sync);
		btn.onclick = (evt) => {
			evt.preventDefault();
			if (!isActive()) {
				this.setTool(last());
				return;
			}
			const menu = new Menu();
			for (const v of variants) {
				menu.addItem((item) =>
					item
						.setTitle(`${v.name}  (${v.key})`)
						.setIcon(v.icon)
						.setChecked(v.tool === this.tool)
						.onClick(() => this.setTool(v.tool))
				);
			}
			const r = btn.getBoundingClientRect();
			menu.showAtPosition({ x: r.left, y: r.bottom + 6 });
		};
		this.activeChecks.set(btn, isActive);
	}

	private openMoreMenu(anchor: HTMLElement): void {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("Copy as PNG").setIcon(ICON.image).onClick(() => this.copyAsPng()));
		menu.addItem((i) => i.setTitle("Export PNG to vault").setIcon(ICON.download).onClick(() => void this.exportPng()));
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("Select all (Cmd/Ctrl+A)").setIcon(ICON.pointer).onClick(() => this.selectAll()));
		menu.addItem((i) => i.setTitle("Zoom to fit").setIcon(ICON.fit).onClick(() => this.zoomToFit()));
		menu.addItem((i) => i.setTitle("Center drawing at 100%").setIcon(ICON.reset).onClick(() => this.centerView()));
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("Clear drawing").setIcon(ICON.clear).onClick(() => this.clearAllPrompt()));
		menu.addItem((i) =>
			i
				.setTitle("Settings")
				.setIcon(ICON.settings)
				.onClick(() => {
					const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
					setting?.open();
					setting?.openTabById(this.plugin.manifest.id);
				})
		);
		const r = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: r.left, y: r.bottom + 6 });
	}

	// --- Style panel: only the options that apply to the current tool or
	// --- selection (color, size, fill, arrowheads, selection actions).

	private selectedElements(): DrawnElement[] {
		return this.elements.filter((e) => this.selectedIds.has(e.id));
	}

	/** Whether the panel acts on the selection rather than the next thing drawn. */
	private editingSelection(): boolean {
		return SELECT_TOOLS.has(this.tool) && this.selectedIds.size > 0;
	}

	private styleContext(): { highlight: boolean; fill: boolean; heads: boolean; actions: boolean } | null {
		if (SELECT_TOOLS.has(this.tool)) {
			const sel = this.selectedElements();
			if (sel.length === 0) return null;
			return {
				highlight: sel.every((e) => e.kind === "freehand" && e.highlight),
				fill: sel.some((e) => isClosedShape(e)),
				heads: sel.some((e) => e.kind === "arrow"),
				actions: true,
			};
		}
		if (this.tool === "pan" || this.tool === "eraser") return null;
		return {
			highlight: this.tool === "highlighter",
			fill: CLOSED_SHAPE_TOOLS.has(this.tool),
			heads: this.tool === "arrow",
			actions: false,
		};
	}

	/** The element whose style the panel shows while editing a selection. */
	private styleSample(): DrawnElement | undefined {
		return this.editingSelection() ? this.selectedElements()[0] : undefined;
	}

	private shownColor(): string {
		const s = this.styleSample();
		if (s) return s.color;
		return this.tool === "highlighter" ? this.currentHighlightColor : this.currentColor;
	}

	private shownSize(): number {
		const s = this.styleSample();
		if (s) {
			if (s.kind === "freehand") return s.highlight ? s.size / HIGHLIGHT_SIZE_MULTIPLIER : s.size;
			if (s.kind === "text") return s.size / TEXT_SIZE_MULTIPLIER;
			return s.size;
		}
		return this.tool === "highlighter" ? this.currentHighlightSize : this.currentSize;
	}

	private shownFill(): FillStyle {
		const s = this.selectedElements().find((e) => isClosedShape(e)) as ShapeElement | undefined;
		if (this.editingSelection()) return s?.fill ?? "none";
		return this.currentFill;
	}

	private shownHeads(): ArrowHeads {
		const s = this.selectedElements().find((e) => e.kind === "arrow") as ShapeElement | undefined;
		if (this.editingSelection()) return s?.heads ?? "end";
		return this.currentArrowHeads;
	}

	private buildStylePanel(): void {
		const panel = this.stylePanelEl;
		panel.empty();
		const ctx = this.styleContext();
		panel.toggle(!!ctx);
		if (!ctx) return;

		const section = (title: string): HTMLElement => {
			const sec = panel.createDiv({ cls: "qs-section" });
			sec.createDiv({ cls: "qs-section-title", text: title });
			return sec.createDiv({ cls: "qs-section-body" });
		};

		// Colors.
		const colors = section("Color");
		colors.addClass("qs-swatches");
		const palette = ctx.highlight ? HIGHLIGHT_COLORS : this.allColors();
		for (const color of palette) {
			const isCustom = !ctx.highlight && !COLORS.includes(color);
			const sw = colors.createEl("button", {
				cls: isCustom ? "quick-sketch-swatch quick-sketch-swatch-custom" : "quick-sketch-swatch",
				attr: { "aria-label": color, title: isCustom ? `${color} (right-click to remove)` : color },
			});
			sw.style.setProperty("--qs-swatch-color", color);
			sw.onclick = (evt) => {
				evt.preventDefault();
				this.pickColor(color);
			};
			if (isCustom) {
				sw.addEventListener("contextmenu", (evt) => {
					evt.preventDefault();
					new ConfirmModal(this.app, `Remove color ${color} from the palette?`, () => void this.removeCustomColor(color), "Remove").open();
				});
			}
			this.activeChecks.set(sw, () => this.shownColor().toLowerCase() === color.toLowerCase());
		}
		if (!ctx.highlight) {
			const add = colors.createDiv({
				cls: "quick-sketch-swatch quick-sketch-swatch-add",
				attr: { "aria-label": "Add color", title: "Add custom color" },
			});
			add.setText("+");
			// A transparent native <input type="color"> overlaid on the "+"
			// swatch -- iOS/WKWebView won't open the color picker from a
			// programmatic .click() on a hidden input, but a real tap on a
			// visible (if zero-opacity) input opens it on every platform.
			const input = add.createEl("input", { type: "color" });
			input.addClass("quick-sketch-color-input");
			input.value = this.shownColor();
			input.addEventListener("change", () => {
				if (input.value) void this.addCustomColor(input.value);
			});
		}

		// Stroke width / text size.
		const sizes = section(this.tool === "text" ? "Text size" : "Size");
		const lineWidths = [1.5, 3.5, 6];
		STROKE_SIZES.forEach((size, i) => {
			const b = this.optionButton(sizes, size.label === "S" ? "Small" : size.label === "M" ? "Medium" : "Large", lineIcon(lineWidths[i]), () =>
				this.pickSize(size.px)
			);
			this.activeChecks.set(b, () => this.shownSize() === size.px);
		});

		if (ctx.fill) {
			const fills = section("Fill");
			const options: [FillStyle, string, string][] = [
				["none", "No fill", fillIcon(0)],
				["light", "Light fill", fillIcon(0.3)],
				["solid", "Solid fill", fillIcon(1)],
			];
			for (const [value, name, svg] of options) {
				const b = this.optionButton(fills, name, svg, () => this.pickFill(value));
				this.activeChecks.set(b, () => this.shownFill() === value);
			}
		}

		if (ctx.heads) {
			const ends = section("Arrowheads");
			const options: [ArrowHeads, string, string][] = [
				["none", "No arrowheads", headsIcon(false, false)],
				["end", "Arrowhead at end", headsIcon(false, true)],
				["both", "Arrowheads at both ends", headsIcon(true, true)],
			];
			for (const [value, name, svg] of options) {
				const b = this.optionButton(ends, name, svg, () => this.pickHeads(value));
				this.activeChecks.set(b, () => this.shownHeads() === value);
			}
		}

		if (ctx.actions) {
			const acts = section("Selection");
			this.btn(acts, "Duplicate (Cmd/Ctrl+D)", ICON.duplicate, () => this.duplicateSelection());
			this.btn(acts, "Copy (Cmd/Ctrl+C)", ICON.copy, () => this.copySelection());
			this.btn(acts, "Delete (Delete)", ICON.trash, () => this.deleteSelection());
		}
	}

	private optionButton(parent: HTMLElement, label: string, svg: string, onClick: () => void): HTMLButtonElement {
		const b = parent.createEl("button", { cls: "quick-sketch-btn qs-opt-btn", attr: { "aria-label": label, title: label } });
		// Static markup built from numbers only (see lineIcon etc.).
		b.innerHTML = svg;
		b.onclick = (evt) => {
			evt.preventDefault();
			onClick();
			this.refreshToolbarState();
		};
		return b;
	}

	private pickColor(color: string): void {
		const highlightPalette = HIGHLIGHT_COLORS.includes(color) && (this.tool === "highlighter" || this.styleContext()?.highlight);
		if (highlightPalette) this.currentHighlightColor = color;
		else this.currentColor = color;
		if (this.editingSelection()) this.applyStyle({ color });
		this.refreshToolbarState();
	}

	private pickSize(px: number): void {
		if (this.tool === "highlighter" || this.styleContext()?.highlight) this.currentHighlightSize = px;
		else this.currentSize = px;
		if (this.editingSelection()) this.applyStyle({ sizePx: px });
		this.refreshToolbarState();
	}

	private pickFill(fill: FillStyle): void {
		this.currentFill = fill;
		if (this.editingSelection()) this.applyStyle({ fill });
		this.refreshToolbarState();
	}

	private pickHeads(heads: ArrowHeads): void {
		this.currentArrowHeads = heads;
		if (this.editingSelection()) this.applyStyle({ heads });
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
		if (this.editingSelection()) this.applyStyle({ color: normalized });
		// Defer the rebuild: the color input lives inside the style panel,
		// and emptying the panel synchronously inside the input's own
		// `change` handler destroys it while the native picker may still be
		// closing, which can crash on some mobile WebViews.
		window.setTimeout(() => {
			this.stylePanelKey = "";
			this.refreshToolbarState();
		}, 0);
	}

	private async removeCustomColor(hex: string): Promise<void> {
		const normalized = hex.toLowerCase();
		const list = this.plugin.settings.customColors;
		const idx = list.findIndex((c) => c.toLowerCase() === normalized);
		if (idx === -1) return;
		list.splice(idx, 1);
		await this.plugin.saveSettings();
		if (this.currentColor.toLowerCase() === normalized) this.currentColor = DEFAULT_COLOR;
		window.setTimeout(() => {
			this.stylePanelKey = "";
			this.refreshToolbarState();
		}, 0);
	}

	private setTool(tool: Tool): void {
		if (this.textEditor) this.commitTextEditor();
		this.tool = tool;
		if (SHAPE_TOOLS.has(tool)) this.lastShapeTool = tool;
		if (SELECT_TOOLS.has(tool)) this.lastSelectTool = tool;
		// A selection only lives in the select tools; elsewhere the style
		// panel is about what you draw next.
		if (!SELECT_TOOLS.has(tool) && this.selectedIds.size > 0) {
			this.selectedIds.clear();
			this.renderSelectionOverlay();
		}
		this.applyToolClass();
		this.refreshToolbarState();
	}

	private applyToolClass(): void {
		const wrap = this.canvasWrapEl;
		for (const cls of Array.from(wrap.classList)) if (cls.startsWith("tool-")) wrap.removeClass(cls);
		wrap.addClass(`tool-${this.spaceHeld ? "pan" : this.tool}`);
	}

	/** Applies the shared freehand stroke attributes. Highlight strokes are
	 * semi-transparent and flagged with data-highlight so they round-trip
	 * through the saved SVG. */
	private styleFreehandPath(pathEl: SVGPathElement, color: string, size: number, highlight: boolean, pressure = false): void {
		if (pressure) {
			pathEl.setAttribute("fill", color);
			pathEl.setAttribute("data-size", String(size));
			return;
		}
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
		if (!this.stylePanelEl) return;
		for (const sync of this.groupSyncs) sync();
		const ctx = this.styleContext();
		const key = JSON.stringify([ctx, this.tool === "text", this.allColors().length]);
		if (key !== this.stylePanelKey) {
			this.stylePanelKey = key;
			this.buildStylePanel();
		}
		this.contentEl.querySelectorAll<HTMLElement>(".quick-sketch-btn, .quick-sketch-swatch").forEach((el) => {
			const check = this.activeChecks.get(el);
			if (check) el.toggleClass("is-active", check());
		});
		this.updateStatus();
	}

	private updateStatus(): void {
		this.zoomLabelEl?.setText(`${Math.round(this.zoom * 100)}%`);
	}

	private toCanvasPoint(evt: { clientX: number; clientY: number }): Point {
		const pt = this.svgEl.createSVGPoint();
		pt.x = evt.clientX;
		pt.y = evt.clientY;
		const ctm = this.svgEl.getScreenCTM();
		if (!ctm) return { x: 0, y: 0 };
		const transformed = pt.matrixTransform(ctm.inverse());
		return { x: round1(transformed.x), y: round1(transformed.y) };
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

		if (this.tool === "pan" || this.spaceHeld) {
			evt.preventDefault();
			this.beginMousePan(evt);
			return;
		}
		if (this.tool === "eraser") {
			evt.preventDefault();
			this.beginErase(evt);
			return;
		}
		if (SELECT_TOOLS.has(this.tool)) {
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
		const pressure = !highlight && evt.pointerType === "pen" && this.plugin.settings.pressure;
		if (pressure) p.p = penPressure(evt);
		const color = highlight ? this.currentHighlightColor : this.currentColor;
		const size = highlight ? this.currentHighlightSize * HIGHLIGHT_SIZE_MULTIPLIER : this.currentSize;
		const pathEl = document.createElementNS(SVG_NS, "path") as SVGPathElement;
		this.styleFreehandPath(pathEl, color, size, highlight, pressure);
		pathEl.setAttribute("d", freehandPathData([p], size, pressure));
		this.insertPath(pathEl, highlight);

		this.activeStroke = {
			pathEl,
			points: [p],
			pointerId: evt.pointerId,
			color,
			size,
			highlight,
			pressure,
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

		if (evt.pointerType === "mouse" && evt.buttons === 0) this.updateHoverCursor(evt);

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

		if (this.selectionResize && evt.pointerId === this.selectionResize.pointerId) {
			this.continueResize(evt);
			return;
		}

		if (this.endpointDrag && evt.pointerId === this.endpointDrag.pointerId) {
			this.continueEndpointDrag(evt);
			return;
		}

		if (this.lasso && evt.pointerId === this.lasso.pointerId) {
			this.lasso.points.push(this.toCanvasPoint(evt));
			this.renderSelectionOverlay();
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
			this.updateShapeDraw(evt);
			return;
		}

		if (!this.activeStroke || evt.pointerId !== this.activeStroke.pointerId) return;
		if (evt.pointerType === "pen") this.lastPenActivity = performance.now();
		const stroke = this.activeStroke;
		const p = this.toCanvasPoint(evt);
		const last = stroke.points[stroke.points.length - 1];
		const dx = p.x - last.x;
		const dy = p.y - last.y;
		if (dx * dx + dy * dy < 1.5) {
			// Pressing harder in place still changes the width.
			if (stroke.pressure) last.p = Math.max(last.p ?? 0, penPressure(evt));
			return;
		}
		if (stroke.pressure) p.p = penPressure(evt);
		stroke.points.push(p);
		stroke.pathEl.setAttribute("d", freehandPathData(stroke.points, stroke.size, stroke.pressure));
	};

	/** Resize cursors over the selection handles (mouse only). */
	private updateHoverCursor(evt: PointerEvent): void {
		const handle = SELECT_TOOLS.has(this.tool) && this.handles.length > 0 ? this.handleAt(this.toCanvasPoint(evt)) : null;
		const cursors: Record<HandleId, string> = {
			nw: "nwse-resize",
			se: "nwse-resize",
			ne: "nesw-resize",
			sw: "nesw-resize",
			n: "ns-resize",
			s: "ns-resize",
			e: "ew-resize",
			w: "ew-resize",
			start: "move",
			end: "move",
		};
		const cursor = handle ? cursors[handle] : "";
		if (this.svgEl.style.cursor !== cursor) this.svgEl.style.cursor = cursor;
	}

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

		if (this.selectionResize && evt.pointerId === this.selectionResize.pointerId) {
			const moved = this.selectionResize.snapshotTaken;
			this.releaseCapture(evt.pointerId);
			this.selectionResize = null;
			if (moved) this.markDirtyAndScheduleSave();
			this.renderSelectionOverlay();
			return;
		}

		if (this.endpointDrag && evt.pointerId === this.endpointDrag.pointerId) {
			const moved = this.endpointDrag.snapshotTaken;
			this.releaseCapture(evt.pointerId);
			this.endpointDrag = null;
			this.bindHighlightId = null;
			if (moved) this.markDirtyAndScheduleSave();
			this.renderSelectionOverlay();
			return;
		}

		if (this.lasso && evt.pointerId === this.lasso.pointerId) {
			this.commitLasso();
			this.releaseCapture(evt.pointerId);
			return;
		}

		if (this.activeShapeDraw && evt.pointerId === this.activeShapeDraw.pointerId) {
			this.releaseCapture(evt.pointerId);
			const { elem, start } = this.activeShapeDraw;
			const end = this.toCanvasPoint(evt);
			const tooSmall = Math.hypot(end.x - start.x, end.y - start.y) < 3 / this.zoom;
			this.activeShapeDraw = null;
			this.bindHighlightId = null;
			this.renderSelectionOverlay();
			if (tooSmall) {
				this.removeElementDom(elem);
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
		// Simplify once at the end rather than live, so the ink under the pen
		// behaves exactly as before while drawing.
		const stroke = this.activeStroke;
		const points = simplifyPoints(stroke.points, SIMPLIFY_TOLERANCE);
		const elem: FreehandElement = {
			id: uid(),
			kind: "freehand",
			el: stroke.pathEl,
			points,
			color: stroke.color,
			size: stroke.size,
			highlight: stroke.highlight,
			pressure: stroke.pressure || undefined,
		};
		this.applyGeometry(elem);
		this.elements.push(elem);
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
			this.removeElementDom(elem);
			this.elements.splice(i, 1);
			this.selectedIds.delete(elem.id);
		}
		this.updateAllBindings();
		this.markDirtyAndScheduleSave();
		this.renderSelectionOverlay();
	}

	// --- Shape tools (rectangle / ellipse / diamond / arrow) ---

	private beginShapeDraw(evt: PointerEvent): void {
		this.canvasWrapEl.setPointerCapture(evt.pointerId);
		this.pushUndoSnapshot();
		const p = this.toCanvasPoint(evt);
		const isLine = this.tool === "line" || this.tool === "arrow";
		const kind: ShapeKind = isLine ? "arrow" : (this.tool as ShapeKind);
		const data: ShapeData = { kind, color: this.currentColor, size: this.currentSize, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
		if (CLOSED_SHAPE_TOOLS.has(this.tool) && this.currentFill !== "none") data.fill = this.currentFill;
		if (isLine) {
			data.heads = this.tool === "line" ? "none" : this.currentArrowHeads;
			data.startBind = this.bindTargetAt(p)?.id;
		}
		const elem = this.createShapeElement(data);
		this.activeShapeDraw = { kind, elem, pointerId: evt.pointerId, start: p };
	}

	/** Drag-to-size for a shape being drawn. Shift makes squares/circles and
	 * snaps lines to 15-degree steps; a line's end attaches to a shape it's
	 * dropped on. */
	private updateShapeDraw(evt: PointerEvent): void {
		const draw = this.activeShapeDraw;
		if (!draw) return;
		const { elem, start } = draw;
		const p = this.toCanvasPoint(evt);
		if (elem.kind === "arrow") {
			const end = evt.shiftKey ? snapAngle(start, p) : p;
			const target = this.bindTargetAt(end, elem.startBind);
			elem.endBind = target?.id;
			this.bindHighlightId = target?.id ?? null;
			elem.x0 = start.x;
			elem.y0 = start.y;
			elem.x1 = end.x;
			elem.y1 = end.y;
			this.updateArrowBindings(elem);
			this.applyGeometry(elem);
			this.renderSelectionOverlay();
			return;
		}
		let { x, y } = p;
		if (evt.shiftKey) {
			const dx = p.x - start.x;
			const dy = p.y - start.y;
			const m = Math.max(Math.abs(dx), Math.abs(dy));
			x = start.x + (dx < 0 ? -m : m);
			y = start.y + (dy < 0 ? -m : m);
		}
		elem.x1 = x;
		elem.y1 = y;
		this.applyGeometry(elem);
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
		this.attachTextEditorHandlers(ta);
	}

	/** Opens the text editor over a shape to edit its label, prefilled with
	 * the current one. Committing an empty label removes it. */
	private beginLabelEdit(elem: ShapeElement): void {
		if (this.textEditor) this.commitTextEditor();
		const fontSize = elem.labelSize ?? this.currentSize * TEXT_SIZE_MULTIPLIER;
		const anchor = this.labelAnchor(elem, fontSize);

		const ta = this.canvasWrapEl.createEl("textarea", { cls: "quick-sketch-text-input quick-sketch-label-input" });
		if (elem.kind === "arrow") ta.addClass("is-arrow");
		ta.rows = 1;
		ta.value = elem.label ?? "";
		ta.style.left = `${anchor.x * this.zoom + this.panX}px`;
		ta.style.top = `${anchor.y * this.zoom + this.panY}px`;
		ta.style.fontSize = `${fontSize * this.zoom}px`;
		ta.style.color = elem.fill === "solid" ? contrastColor(elem.color) : elem.color;
		if (elem.kind !== "arrow") {
			// Match the width the label will wrap to inside the shape.
			ta.style.width = `${Math.max(60, this.labelBox(elem).width * this.zoom)}px`;
		}
		// Hide the rendered label while editing so it doesn't show twice.
		elem.labelEl?.setAttribute("visibility", "hidden");

		this.textEditor = ta;
		this.textEditorCanvasPoint = anchor;
		this.textEditorTarget = elem;
		this.attachTextEditorHandlers(ta);
		window.setTimeout(() => {
			ta.style.height = `${ta.scrollHeight}px`;
			ta.select();
		}, 0);
	}

	/** Opens the text editor over an existing text element, prefilled with
	 * its text. Committing an empty value deletes the element. */
	private beginTextEdit(elem: TextElement): void {
		if (this.textEditor) this.commitTextEditor();
		// The element's y is its first baseline; the editor's top sits about
		// one line above it (the inverse of the nudge in commitTextEditor).
		const top = { x: elem.x, y: elem.y - elem.size * 0.8 };

		const ta = this.canvasWrapEl.createEl("textarea", { cls: "quick-sketch-text-input" });
		ta.rows = 1;
		ta.value = elem.text;
		ta.style.left = `${top.x * this.zoom + this.panX}px`;
		ta.style.top = `${top.y * this.zoom + this.panY}px`;
		ta.style.fontSize = `${elem.size * this.zoom}px`;
		ta.style.color = elem.color;
		// Hide the rendered text while editing so it doesn't show twice.
		elem.el.setAttribute("visibility", "hidden");

		this.textEditor = ta;
		this.textEditorCanvasPoint = top;
		this.textEditorTarget = elem;
		this.attachTextEditorHandlers(ta);
		window.setTimeout(() => {
			ta.style.width = `${Math.max(60, ta.scrollWidth + 2)}px`;
			ta.style.height = `${ta.scrollHeight}px`;
			ta.select();
		}, 0);
	}

	private attachTextEditorHandlers(ta: HTMLTextAreaElement): void {
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
		const target = this.textEditorTarget;
		this.cleanupTextEditor();
		if (target?.kind === "text") {
			if (value === target.text) return;
			this.pushUndoSnapshot();
			if (value) {
				this.setTextContent(target, value);
				this.updateAllBindings();
			} else {
				this.removeElementDom(target);
				this.elements = this.elements.filter((e) => e !== target);
				this.selectedIds.delete(target.id);
			}
			this.renderSelectionOverlay();
			this.markDirtyAndScheduleSave();
			return;
		}
		if (target) {
			if (value === (target.label ?? "")) return;
			this.pushUndoSnapshot();
			this.setShapeLabel(target, value || undefined, target.labelSize ?? this.currentSize * TEXT_SIZE_MULTIPLIER);
			this.renderSelectionOverlay();
			this.markDirtyAndScheduleSave();
			return;
		}
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
		// Clear all editor state *before* removing the textarea: removing a
		// focused element fires `blur` synchronously, which re-enters
		// commitTextEditor -- with state still set it would commit a second
		// time (as a stray free-floating text element).
		const ta = this.textEditor;
		const target = this.textEditorTarget;
		if (target?.kind === "text") target.el.removeAttribute("visibility");
		else target?.labelEl?.removeAttribute("visibility");
		this.textEditorTarget = null;
		this.textEditor = null;
		this.textEditorCanvasPoint = null;
		ta?.remove();
	}

	// --- Select / lasso tools ---

	private hitTest(p: Point): DrawnElement | undefined {
		const radius = SELECT_HIT_RADIUS_PX / this.zoom;
		for (let i = this.elements.length - 1; i >= 0; i--) {
			if (elementHit(this.elements[i], p.x, p.y, radius)) return this.elements[i];
		}
		return undefined;
	}

	private selectionBounds(): Rect | null {
		return unionRect(this.selectedElements().map(elementBBox));
	}

	private insideSelectionBounds(p: Point): boolean {
		const b = this.selectedIds.size > 1 ? this.selectionBounds() : null;
		if (!b) return false;
		const pad = 4 / this.zoom;
		return p.x >= b.x - pad && p.x <= b.x + b.width + pad && p.y >= b.y - pad && p.y <= b.y + b.height + pad;
	}

	private handleAt(p: Point): HandleId | null {
		const r = HANDLE_HIT_PX / this.zoom;
		let best: HandleId | null = null;
		let bestDist = Infinity;
		for (const h of this.handles) {
			const d = Math.hypot(h.x - p.x, h.y - p.y);
			if (d <= r && d < bestDist) {
				best = h.id;
				bestDist = d;
			}
		}
		return best;
	}

	private beginSelectInteraction(evt: PointerEvent): void {
		this.canvasWrapEl.setPointerCapture(evt.pointerId);
		const p = this.toCanvasPoint(evt);
		const additive = evt.shiftKey;

		// The selection's handles sit on top of everything.
		const handle = this.selectedIds.size > 0 ? this.handleAt(p) : null;
		if (handle) {
			this.beginHandleDrag(evt, handle);
			return;
		}

		const hit = this.hitTest(p);
		if (hit) {
			const now = performance.now();
			const tap = this.lastSelectTap;
			this.lastSelectTap = { id: hit.id, time: now };
			if (tap && tap.id === hit.id && now - tap.time < DOUBLE_TAP_MS && hit.kind !== "freehand" && !additive) {
				this.lastSelectTap = null;
				this.releaseCapture(evt.pointerId);
				this.selectionDrag = null;
				this.selectedIds.clear();
				this.selectedIds.add(hit.id);
				this.renderSelectionOverlay();
				if (hit.kind === "text") this.beginTextEdit(hit);
				else this.beginLabelEdit(hit);
				return;
			}
		}

		// Shift+click toggles an element in or out of the selection.
		if (hit && additive) {
			if (this.selectedIds.has(hit.id)) this.selectedIds.delete(hit.id);
			else this.selectedIds.add(hit.id);
			if (this.selectedIds.has(hit.id)) this.beginSelectionDrag(evt, p);
			this.renderSelectionOverlay();
			return;
		}

		// Pressing on the selection (or in the gaps of a multi-selection, e.g.
		// between handwritten letters) moves it; Alt moves a copy.
		if ((hit && this.selectedIds.has(hit.id)) || this.insideSelectionBounds(p)) {
			if (evt.altKey) this.duplicateSelection(0);
			this.beginSelectionDrag(evt, p, evt.altKey);
			this.renderSelectionOverlay();
			return;
		}

		// The box-select tool picks up what you press on; the lasso always
		// starts a lasso, so it can be drawn over ink.
		if (hit && this.tool === "select") {
			this.selectedIds.clear();
			this.selectedIds.add(hit.id);
			if (evt.altKey) this.duplicateSelection(0);
			this.beginSelectionDrag(evt, p, evt.altKey);
			this.renderSelectionOverlay();
			return;
		}

		const base = additive ? Array.from(this.selectedIds) : [];
		if (!additive) this.selectedIds.clear();
		if (this.tool === "lasso") this.lasso = { pointerId: evt.pointerId, points: [p], base };
		else this.selectionBox = { pointerId: evt.pointerId, x0: p.x, y0: p.y, x1: p.x, y1: p.y, base };
		this.renderSelectionOverlay();
	}

	private snapshotSelection(): Map<string, GeometrySnapshot> {
		const original = new Map<string, GeometrySnapshot>();
		for (const elem of this.elements) {
			if (!this.selectedIds.has(elem.id)) continue;
			if (elem.kind === "freehand") {
				original.set(elem.id, { kind: "freehand", points: elem.points });
			} else if (elem.kind === "text") {
				original.set(elem.id, { kind: "text", x: elem.x, y: elem.y, size: elem.size });
			} else {
				original.set(elem.id, { kind: "box", x0: elem.x0, y0: elem.y0, x1: elem.x1, y1: elem.y1 });
			}
		}
		return original;
	}

	private beginSelectionDrag(evt: PointerEvent, startCanvas: Point, snapshotTaken = false): void {
		this.selectionDrag = { pointerId: evt.pointerId, startCanvas, original: this.snapshotSelection(), snapshotTaken };
	}

	/** An arrow moved without the shape it's attached to comes loose. */
	private detachMovedArrows(): void {
		for (const elem of this.selectedElements()) {
			if (elem.kind !== "arrow") continue;
			if (elem.startBind && !this.selectedIds.has(elem.startBind)) elem.startBind = undefined;
			if (elem.endBind && !this.selectedIds.has(elem.endBind)) elem.endBind = undefined;
		}
	}

	private continueSelectionDrag(evt: PointerEvent): void {
		const drag = this.selectionDrag;
		if (!drag) return;
		if (!drag.moved) {
			drag.moved = true;
			if (!drag.snapshotTaken) {
				this.pushUndoSnapshot();
				drag.snapshotTaken = true;
			}
			this.detachMovedArrows();
		}
		const p = this.toCanvasPoint(evt);
		const dx = p.x - drag.startCanvas.x;
		const dy = p.y - drag.startCanvas.y;
		for (const elem of this.elements) {
			const orig = drag.original.get(elem.id);
			if (!orig) continue;
			if (elem.kind === "freehand" && orig.kind === "freehand") {
				elem.points = orig.points.map((pt) => ({ x: round1(pt.x + dx), y: round1(pt.y + dy), p: pt.p }));
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
		this.updateAllBindings();
		this.renderSelectionOverlay();
	}

	// --- Resize handles ---

	private beginHandleDrag(evt: PointerEvent, handle: HandleId): void {
		if (handle === "start" || handle === "end") {
			const elem = this.selectedElements()[0];
			if (elem?.kind !== "arrow") return;
			this.endpointDrag = { pointerId: evt.pointerId, elem, end: handle, snapshotTaken: false };
			return;
		}
		const box0 = this.selectionBounds();
		if (!box0) return;
		this.selectionResize = { pointerId: evt.pointerId, handle, box0, original: this.snapshotSelection(), snapshotTaken: false };
	}

	/** Scales the selection from the side/corner opposite the dragged handle.
	 * Shift on a corner (or a selection of only text) keeps proportions. */
	private continueResize(evt: PointerEvent): void {
		const r = this.selectionResize;
		if (!r) return;
		if (!r.snapshotTaken) {
			this.pushUndoSnapshot();
			r.snapshotTaken = true;
		}
		const p = this.toCanvasPoint(evt);
		const b = r.box0;
		const h = r.handle;
		const min = 4 / this.zoom;
		let x0 = b.x;
		let y0 = b.y;
		let x1 = b.x + b.width;
		let y1 = b.y + b.height;
		if (h.includes("w")) x0 = Math.min(p.x, x1 - min);
		if (h.includes("e")) x1 = Math.max(p.x, x0 + min);
		if (h.includes("n")) y0 = Math.min(p.y, y1 - min);
		if (h.includes("s")) y1 = Math.max(p.y, y0 + min);
		let sx = b.width > 0 ? (x1 - x0) / b.width : 1;
		let sy = b.height > 0 ? (y1 - y0) / b.height : 1;
		const corner = h.length === 2;
		const allText = this.selectedElements().every((e) => e.kind === "text");
		if (corner && (evt.shiftKey || allText)) {
			const s = Math.max(sx, sy);
			sx = sy = s;
			if (h.includes("w")) x0 = x1 - b.width * s;
			else x1 = x0 + b.width * s;
			if (h.includes("n")) y0 = y1 - b.height * s;
			else y1 = y0 + b.height * s;
		}
		const mx = (x: number) => round1(x0 + (x - b.x) * sx);
		const my = (y: number) => round1(y0 + (y - b.y) * sy);
		const textScale = corner ? Math.sqrt(sx * sy) : h === "n" || h === "s" ? sy : sx;

		for (const elem of this.elements) {
			const orig = r.original.get(elem.id);
			if (!orig) continue;
			if (elem.kind === "freehand" && orig.kind === "freehand") {
				elem.points = orig.points.map((pt) => ({ x: mx(pt.x), y: my(pt.y), p: pt.p }));
			} else if (elem.kind === "text" && orig.kind === "text") {
				elem.size = Math.max(4, round1(orig.size * textScale));
				// Scale about the text's top edge, not its baseline.
				elem.x = mx(orig.x);
				elem.y = round1(my(orig.y - orig.size * 0.8) + elem.size * 0.8);
			} else if (orig.kind === "box" && elem.kind !== "freehand" && elem.kind !== "text") {
				elem.x0 = mx(orig.x0);
				elem.y0 = my(orig.y0);
				elem.x1 = mx(orig.x1);
				elem.y1 = my(orig.y1);
			}
			this.applyGeometry(elem);
		}
		this.updateAllBindings();
		this.renderSelectionOverlay();
	}

	/** Dragging one end of a lone selected line/arrow; it attaches to a
	 * shape it's dropped on, and Shift snaps its angle. */
	private continueEndpointDrag(evt: PointerEvent): void {
		const d = this.endpointDrag;
		if (!d) return;
		if (!d.snapshotTaken) {
			this.pushUndoSnapshot();
			d.snapshotTaken = true;
		}
		const elem = d.elem;
		let p = this.toCanvasPoint(evt);
		const other = d.end === "start" ? { x: elem.x1, y: elem.y1 } : { x: elem.x0, y: elem.y0 };
		if (evt.shiftKey) p = snapAngle(other, p);
		const target = this.bindTargetAt(p, d.end === "start" ? elem.endBind : elem.startBind);
		if (d.end === "start") {
			elem.startBind = target?.id;
			elem.x0 = p.x;
			elem.y0 = p.y;
		} else {
			elem.endBind = target?.id;
			elem.x1 = p.x;
			elem.y1 = p.y;
		}
		this.bindHighlightId = target?.id ?? null;
		this.updateArrowBindings(elem);
		this.applyGeometry(elem);
		this.renderSelectionOverlay();
	}

	private commitSelectionBox(): void {
		if (!this.selectionBox) return;
		const { x0, y0, x1, y1, base } = this.selectionBox;
		const minX = Math.min(x0, x1);
		const maxX = Math.max(x0, x1);
		const minY = Math.min(y0, y1);
		const maxY = Math.max(y0, y1);

		this.selectedIds = new Set(base);
		if (maxX - minX > 2 && maxY - minY > 2) {
			for (const elem of this.elements) {
				const b = elementBBox(elem);
				const intersects = !(b.x + b.width < minX || b.x > maxX || b.y + b.height < minY || b.y > maxY);
				if (intersects) this.selectedIds.add(elem.id);
			}
		}
		this.selectionBox = null;
		this.renderSelectionOverlay();
	}

	/** Selects everything mostly (at least half) inside the lasso. */
	private commitLasso(): void {
		const lasso = this.lasso;
		if (!lasso) return;
		this.lasso = null;
		this.selectedIds = new Set(lasso.base);
		const poly = lasso.points;
		if (poly.length >= 3) {
			for (const elem of this.elements) {
				const samples = this.samplePoints(elem);
				const inside = samples.filter((s) => pointInPolygon(s.x, s.y, poly)).length;
				if (samples.length > 0 && inside / samples.length >= 0.5) this.selectedIds.add(elem.id);
			}
		}
		this.renderSelectionOverlay();
	}

	private samplePoints(elem: DrawnElement): Point[] {
		if (elem.kind === "freehand") return elem.points;
		if (elem.kind === "arrow") {
			return [
				{ x: elem.x0, y: elem.y0 },
				{ x: (elem.x0 + elem.x1) / 2, y: (elem.y0 + elem.y1) / 2 },
				{ x: elem.x1, y: elem.y1 },
			];
		}
		const b = elementBBox(elem);
		const pts: Point[] = [];
		for (const fx of [0, 0.5, 1]) for (const fy of [0, 0.5, 1]) pts.push({ x: b.x + b.width * fx, y: b.y + b.height * fy });
		return pts;
	}

	private renderSelectionOverlay(): void {
		this.overlayGroup.innerHTML = "";
		this.handles = [];
		const z = this.zoom;
		const add = (tag: string, attrs: Record<string, string | number>, cls: string): SVGElement => {
			const el = document.createElementNS(SVG_NS, tag) as SVGElement;
			for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
			el.classList.add(cls);
			this.overlayGroup.appendChild(el);
			return el;
		};

		if (this.selectionBox) {
			const { x0, y0, x1, y1 } = this.selectionBox;
			add("rect", { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) }, "quick-sketch-rubberband");
		}
		if (this.lasso) {
			add("path", { d: "M" + this.lasso.points.map((pt) => `${pt.x} ${pt.y}`).join("L") + "Z" }, "quick-sketch-rubberband");
		}

		const target = this.findElement(this.bindHighlightId ?? undefined);
		if (target && isBindable(target)) {
			const b = this.bindBox(target);
			const pad = 6 / z;
			add("rect", { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2, rx: 4 / z }, "qs-bind-highlight");
		}

		const sel = this.selectedElements();
		if (sel.length > 0) {
			const pad = 4 / z;
			const boxes = sel.map(elementBBox);
			if (sel.length > 1) {
				for (const b of boxes) {
					add("rect", { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 }, "quick-sketch-selection-rect");
				}
			}
			const hs = HANDLE_SIZE_PX / z;
			const handle = (id: HandleId, x: number, y: number, round: boolean) => {
				this.handles.push({ id, x, y });
				if (round) add("circle", { cx: x, cy: y, r: hs / 2 }, "qs-handle");
				else add("rect", { x: x - hs / 2, y: y - hs / 2, width: hs, height: hs, rx: 2 / z }, "qs-handle");
			};
			const single = sel.length === 1 ? sel[0] : null;
			if (single?.kind === "arrow") {
				add("line", { x1: single.x0, y1: single.y0, x2: single.x1, y2: single.y1 }, "quick-sketch-selection-rect");
				handle("start", single.x0, single.y0, true);
				handle("end", single.x1, single.y1, true);
			} else {
				const u = unionRect(boxes) as Rect;
				const x0 = u.x - pad;
				const y0 = u.y - pad;
				const x1 = u.x + u.width + pad;
				const y1 = u.y + u.height + pad;
				add("rect", { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, "qs-selection-box");
				const mx = (x0 + x1) / 2;
				const my = (y0 + y1) / 2;
				handle("nw", x0, y0, false);
				handle("ne", x1, y0, false);
				handle("se", x1, y1, false);
				handle("sw", x0, y1, false);
				// Side handles only when there's room for them between the
				// corners, and not for text (which only scales uniformly).
				const textOnly = sel.every((e) => e.kind === "text");
				if (!textOnly && (x1 - x0) * z > 48) {
					handle("n", mx, y0, false);
					handle("s", mx, y1, false);
				}
				if (!textOnly && (y1 - y0) * z > 48) {
					handle("e", x1, my, false);
					handle("w", x0, my, false);
				}
			}
		}

		this.refreshToolbarState();
	}

	private selectAll(): void {
		if (!SELECT_TOOLS.has(this.tool)) this.setTool("select");
		this.selectedIds = new Set(this.elements.map((e) => e.id));
		this.renderSelectionOverlay();
	}

	private deleteSelection(): void {
		if (this.selectedIds.size === 0) return;
		this.pushUndoSnapshot();
		for (const id of Array.from(this.selectedIds)) {
			const idx = this.elements.findIndex((e) => e.id === id);
			if (idx >= 0) {
				this.removeElementDom(this.elements[idx]);
				this.elements.splice(idx, 1);
			}
		}
		this.selectedIds.clear();
		this.updateAllBindings();
		this.renderSelectionOverlay();
		this.markDirtyAndScheduleSave();
	}

	/** Moves the selection by (dx, dy). Rapid repeats share one undo step. */
	private nudgeSelection(dx: number, dy: number): void {
		if (this.selectedIds.size === 0) return;
		const now = performance.now();
		if (now - this.lastNudgeAt > 800) this.pushUndoSnapshot();
		this.lastNudgeAt = now;
		this.detachMovedArrows();
		for (const elem of this.selectedElements()) {
			if (elem.kind === "freehand") {
				elem.points = elem.points.map((pt) => ({ x: round1(pt.x + dx), y: round1(pt.y + dy), p: pt.p }));
			} else if (elem.kind === "text") {
				elem.x += dx;
				elem.y += dy;
			} else {
				elem.x0 += dx;
				elem.y0 += dy;
				elem.x1 += dx;
				elem.y1 += dy;
			}
			this.applyGeometry(elem);
		}
		this.updateAllBindings();
		this.renderSelectionOverlay();
		this.markDirtyAndScheduleSave();
	}

	// --- Copy / paste / duplicate ---

	private copySelection(): void {
		if (this.selectedIds.size === 0) return;
		clipboard = this.cloneElements().filter((s) => this.selectedIds.has(s.id));
		this.pasteCount = 0;
	}

	private cutSelection(): void {
		this.copySelection();
		this.deleteSelection();
	}

	private paste(): void {
		if (clipboard.length === 0) return;
		this.pasteCount++;
		this.insertCopies(clipboard, PASTE_OFFSET * this.pasteCount);
	}

	private duplicateSelection(offset = PASTE_OFFSET): void {
		if (this.selectedIds.size === 0) return;
		this.insertCopies(
			this.cloneElements().filter((s) => this.selectedIds.has(s.id)),
			offset
		);
	}

	/** Adds copies of `items` (with new ids, shifted by `offset`) on top and
	 * selects them. Arrows stay attached only to shapes copied with them. */
	private insertCopies(items: SerializedElement[], offset: number): void {
		if (this.textEditor) this.commitTextEditor();
		this.pushUndoSnapshot();
		const ids = new Map(items.map((s) => [s.id, uid()]));
		const created = items.map((s) => {
			const copy = offsetSerialized(s, offset, offset);
			copy.id = ids.get(s.id) as string;
			if (copy.kind !== "freehand" && copy.kind !== "text") {
				copy.startBind = copy.startBind ? ids.get(copy.startBind) : undefined;
				copy.endBind = copy.endBind ? ids.get(copy.endBind) : undefined;
			}
			return this.createFromSerialized(copy);
		});
		this.elements.push(...created);
		if (!SELECT_TOOLS.has(this.tool)) this.setTool("select");
		this.selectedIds = new Set(created.map((e) => e.id));
		this.updateAllBindings();
		this.renderSelectionOverlay();
		this.markDirtyAndScheduleSave();
	}

	// --- Restyling the selection ---

	private applyStyle(patch: { color?: string; sizePx?: number; fill?: FillStyle; heads?: ArrowHeads }): void {
		const sel = this.selectedElements();
		if (sel.length === 0) return;
		this.pushUndoSnapshot();
		const snaps = new Map(this.cloneElements().map((s) => [s.id, s]));
		for (const elem of sel) {
			const s = snaps.get(elem.id);
			if (!s) continue;
			if (patch.color) s.color = patch.color;
			if (patch.sizePx !== undefined) {
				const px = patch.sizePx;
				if (s.kind === "freehand") s.size = s.highlight ? px * HIGHLIGHT_SIZE_MULTIPLIER : px;
				else if (s.kind === "text") s.size = px * TEXT_SIZE_MULTIPLIER;
				else {
					s.size = px;
					if (s.label) s.labelSize = px * TEXT_SIZE_MULTIPLIER;
				}
			}
			if (patch.fill && s.kind !== "freehand" && s.kind !== "text" && s.kind !== "arrow") {
				s.fill = patch.fill === "none" ? undefined : patch.fill;
			}
			if (patch.heads && s.kind === "arrow") s.heads = patch.heads;
			this.replaceElement(elem, s);
		}
		this.updateAllBindings();
		this.renderSelectionOverlay();
		this.markDirtyAndScheduleSave();
	}

	/** Swaps an element for a freshly built one, keeping its stacking place. */
	private replaceElement(old: DrawnElement, s: SerializedElement): DrawnElement {
		const fresh = this.createFromSerialized(s);
		rootNode(old).replaceWith(rootNode(fresh));
		const i = this.elements.indexOf(old);
		if (i >= 0) this.elements[i] = fresh;
		return fresh;
	}

	// --- Arrows attached to shapes ---

	private findElement(id?: string): DrawnElement | undefined {
		return id ? this.elements.find((e) => e.id === id) : undefined;
	}

	/** Topmost shape or text an arrow end at `p` would attach to. */
	private bindTargetAt(p: Point, exclude?: string): ShapeElement | TextElement | undefined {
		const tol = BIND_DISTANCE_PX / this.zoom;
		for (let i = this.elements.length - 1; i >= 0; i--) {
			const e = this.elements[i];
			if (e.id === exclude || !isBindable(e)) continue;
			const b = this.bindBox(e);
			if (p.x >= b.x - tol && p.x <= b.x + b.width + tol && p.y >= b.y - tol && p.y <= b.y + b.height + tol) return e;
		}
		return undefined;
	}

	private bindBox(e: ShapeElement | TextElement): Rect {
		if (e.kind === "text") {
			const b = e.el.getBBox();
			return { x: b.x, y: b.y, width: b.width, height: b.height };
		}
		return { x: Math.min(e.x0, e.x1), y: Math.min(e.y0, e.y1), width: Math.abs(e.x1 - e.x0), height: Math.abs(e.y1 - e.y0) };
	}

	/** Where the line from `target`'s center toward `toward` leaves its
	 * outline, pushed out by `gap`. */
	private boundaryPoint(target: ShapeElement | TextElement, toward: Point, gap: number): Point {
		const b = this.bindBox(target);
		const cx = b.x + b.width / 2;
		const cy = b.y + b.height / 2;
		const hw = b.width / 2;
		const hh = b.height / 2;
		const dx = toward.x - cx;
		const dy = toward.y - cy;
		const len = Math.hypot(dx, dy);
		if (len < 1e-6 || hw <= 0 || hh <= 0) return { x: cx, y: cy };
		let t: number;
		if (target.kind === "ellipse") t = 1 / Math.hypot(dx / hw, dy / hh);
		else if (target.kind === "diamond") t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
		else t = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh);
		const k = t + gap / len;
		return { x: round1(cx + dx * k), y: round1(cy + dy * k) };
	}

	/** Re-aims an arrow's attached end(s) at their shapes: each attached end
	 * sits on its shape's outline, on the line toward the other end (or the
	 * other shape's center, when both ends are attached). */
	private updateArrowBindings(elem: ShapeElement): void {
		const find = (id?: string) => {
			const e = this.findElement(id);
			return e && isBindable(e) ? e : undefined;
		};
		const s = find(elem.startBind);
		const e = find(elem.endBind);
		if (!s) elem.startBind = undefined;
		if (!e) elem.endBind = undefined;
		if (!s && !e) return;
		const center = (t: ShapeElement | TextElement) => {
			const b = this.bindBox(t);
			return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
		};
		const gap = (t: ShapeElement | TextElement) => 3 + elem.size / 2 + (t.kind === "text" ? 0 : t.size / 2);
		const startRef = e ? center(e) : { x: elem.x1, y: elem.y1 };
		const endRef = s ? center(s) : { x: elem.x0, y: elem.y0 };
		if (s) {
			const q = this.boundaryPoint(s, startRef, gap(s));
			elem.x0 = q.x;
			elem.y0 = q.y;
		}
		if (e) {
			const q = this.boundaryPoint(e, endRef, gap(e));
			elem.x1 = q.x;
			elem.y1 = q.y;
		}
	}

	/** Brings every attached arrow up to date with its shapes (and lets go
	 * of shapes that no longer exist). */
	private updateAllBindings(): void {
		for (const elem of this.elements) {
			if (elem.kind !== "arrow" || (!elem.startBind && !elem.endBind)) continue;
			this.updateArrowBindings(elem);
			this.applyGeometry(elem);
		}
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
		// Handles keep a constant on-screen size, so they're redrawn on zoom.
		if (this.selectedIds.size > 0) this.renderSelectionOverlay();
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
					pressure: elem.pressure,
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
				label: elem.label,
				labelSize: elem.labelSize,
				fill: elem.fill,
				heads: elem.heads,
				startBind: elem.startBind,
				endBind: elem.endBind,
			};
		});
	}

	private createFromSerialized(s: SerializedElement): DrawnElement {
		if (s.kind === "freehand") return this.createFreehandElement(s.color, s.size, s.points, s.id, s.highlight);
		if (s.kind === "text") return this.createTextElement(s.color, s.size, s.x, s.y, s.text, s.id);
		const { id, ...data } = s;
		return this.createShapeElement(data, id);
	}

	private restoreElements(snapshot: SerializedElement[]): void {
		this.elementsGroup.innerHTML = "";
		this.elements = snapshot.map((s) => this.createFromSerialized(s));
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
		const k = e.key.toLowerCase();
		if (e.key === " " && !mod) {
			e.preventDefault();
			if (!this.spaceHeld) {
				this.spaceHeld = true;
				this.applyToolClass();
			}
			return;
		}
		if (mod && !e.shiftKey && !e.altKey && ["a", "c", "x", "v", "d"].includes(k)) {
			e.preventDefault();
			if (k === "a") this.selectAll();
			else if (k === "c") this.copySelection();
			else if (k === "x") this.cutSelection();
			else if (k === "v") this.paste();
			else this.duplicateSelection();
			return;
		}
		if (!mod && e.key.startsWith("Arrow") && this.selectedIds.size > 0) {
			e.preventDefault();
			const step = e.shiftKey ? NUDGE_BIG_PX : NUDGE_PX;
			const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
			const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
			this.nudgeSelection(dx, dy);
			return;
		}
		if (e.key === "Escape" && this.selectedIds.size > 0) {
			e.preventDefault();
			this.selectedIds.clear();
			this.renderSelectionOverlay();
			return;
		}
		if (mod && !e.shiftKey && e.key.toLowerCase() === "z") {
			e.preventDefault();
			this.undo();
		} else if (mod && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
			e.preventDefault();
			this.redo();
		} else if (!mod && (e.key === "Delete" || e.key === "Backspace") && this.selectedIds.size > 0) {
			e.preventDefault();
			this.deleteSelection();
		} else if (e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === "r") {
			e.preventDefault();
			this.redo();
		} else if (!mod && !e.altKey && !e.shiftKey) {
			const key = e.key.toLowerCase();
			if (key === "u") {
				e.preventDefault();
				this.undo();
				return;
			}
			const tool = KEY_TOOLS[key];
			if (tool) {
				this.setTool(tool);
				return;
			}
			const color = KEY_COLORS[key];
			if (color) {
				this.currentColor = color;
				this.refreshToolbarState();
			}
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
			this.selectionResize ||
			this.endpointDrag ||
			this.lasso ||
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
	 * drawn. Every element's geometry is recoverable from its native SVG
	 * attributes -- freehand raw points included, since buildSmoothPath's
	 * `d` encodes them exactly (see parseSmoothPath). */
	private exportCroppedSvg(): string {
		const bbox = this.elementsGroup.getBBox();
		const hasContent = bbox.width > 0 || bbox.height > 0;

		const x = hasContent ? bbox.x - CROP_PADDING : 0;
		const y = hasContent ? bbox.y - CROP_PADDING : 0;
		const width = hasContent ? bbox.width + CROP_PADDING * 2 : EMPTY_EXPORT_WIDTH;
		const height = hasContent ? bbox.height + CROP_PADDING * 2 : EMPTY_EXPORT_HEIGHT;

		const exportSvg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
		exportSvg.setAttribute("xmlns", SVG_NS);
		exportSvg.setAttribute("viewBox", `${fmt(x)} ${fmt(y)} ${fmt(width)} ${fmt(height)}`);
		exportSvg.setAttribute("width", String(Math.round(width)));
		exportSvg.setAttribute("height", String(Math.round(height)));
		exportSvg.innerHTML = this.elementsGroup.innerHTML;
		// Element ids are only needed by arrows attached to them.
		const referenced = new Set<string>();
		for (const e of this.elements) {
			if (e.kind !== "arrow") continue;
			if (e.startBind) referenced.add(e.startBind);
			if (e.endBind) referenced.add(e.endBind);
		}
		exportSvg.querySelectorAll("[data-id]").forEach((el) => {
			if (!referenced.has(el.getAttribute("data-id") ?? "")) el.removeAttribute("data-id");
		});
		// Hoist the presentation attributes nearly every element repeats onto
		// the root, where children inherit them. Only top-level children are
		// touched (the loader reads those; nested arrow parts stay as-is), and
		// only when the value matches -- text sets its own fill, so it's
		// unaffected. Caps/joins are no-ops on closed shapes.
		const shared: Record<string, string> = { fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" };
		for (const [attr, value] of Object.entries(shared)) exportSvg.setAttribute(attr, value);
		for (const child of Array.from(exportSvg.children)) {
			for (const [attr, value] of Object.entries(shared)) {
				if (child.getAttribute(attr) === value) child.removeAttribute(attr);
			}
		}

		return new XMLSerializer().serializeToString(exportSvg);
	}

	private pngOf(svg: string): Promise<Blob> {
		const w = parseFloat(/width="([\d.]+)"/.exec(svg)?.[1] ?? "") || EMPTY_EXPORT_WIDTH;
		const h = parseFloat(/height="([\d.]+)"/.exec(svg)?.[1] ?? "") || EMPTY_EXPORT_HEIGHT;
		const s = this.plugin.settings;
		return svgToPng(svg, w, h, s.pngScale || 2, s.pngBackground === "transparent" ? null : "#ffffff");
	}

	/** Copies the whole drawing to the clipboard as a PNG image. Kept
	 * synchronous up to the clipboard write so WebKit treats it as part of
	 * the tap that triggered it. */
	copyAsPng(): void {
		if (this.textEditor) this.commitTextEditor();
		copyPngToClipboard(this.pngOf(this.exportCroppedSvg())).then(
			() => new Notice("Drawing copied as PNG."),
			(err: Error) => new Notice(`Couldn't copy the drawing: ${err.message}`)
		);
	}

	/** Saves the drawing as a PNG next to its SVG (overwriting an earlier
	 * export of the same drawing). */
	async exportPng(): Promise<void> {
		if (this.textEditor) this.commitTextEditor();
		if (!this.filePath) return;
		try {
			const png = await (await this.pngOf(this.exportCroppedSvg())).arrayBuffer();
			const path = normalizePath(this.filePath.replace(/\.svg$/i, "") + ".png");
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, png);
			else await this.app.vault.createBinary(path, png);
			new Notice(`Exported ${path}`);
		} catch (err) {
			new Notice(`Couldn't export the drawing: ${(err as Error).message}`);
		}
	}

	/** Recomputes an element's rendered SVG attributes from its geometry
	 * fields. Called on creation, on every drag-resize frame while drawing a
	 * shape, and after moving a selection. */
	private applyGeometry(elem: DrawnElement): void {
		if (elem.kind === "freehand") {
			elem.el.setAttribute("d", freehandPathData(elem.points, elem.size, !!elem.pressure));
			if (elem.pressure) {
				// The outline can't be turned back into points, so the
				// centerline and pressures are kept alongside it.
				elem.el.setAttribute("data-line", buildSmoothPath(elem.points));
				elem.el.setAttribute("data-pressure", encodePressure(elem.points));
			}
			return;
		}
		if (elem.kind === "text") {
			elem.el.setAttribute("font-size", fmt(elem.size));
			elem.el.setAttribute("x", fmt(elem.x));
			elem.el.setAttribute("y", fmt(elem.y));
			elem.el.querySelectorAll("tspan").forEach((t) => t.setAttribute("x", fmt(elem.x)));
			return;
		}

		const minX = Math.min(elem.x0, elem.x1);
		const maxX = Math.max(elem.x0, elem.x1);
		const minY = Math.min(elem.y0, elem.y1);
		const maxY = Math.max(elem.y0, elem.y1);

		if (elem.kind === "rectangle") {
			const rect = elem.el as SVGRectElement;
			rect.setAttribute("x", fmt(minX));
			rect.setAttribute("y", fmt(minY));
			rect.setAttribute("width", fmt(maxX - minX));
			rect.setAttribute("height", fmt(maxY - minY));
		} else if (elem.kind === "ellipse") {
			const ellipse = elem.el as SVGEllipseElement;
			ellipse.setAttribute("cx", fmt((minX + maxX) / 2));
			ellipse.setAttribute("cy", fmt((minY + maxY) / 2));
			ellipse.setAttribute("rx", fmt((maxX - minX) / 2));
			ellipse.setAttribute("ry", fmt((maxY - minY) / 2));
		} else if (elem.kind === "diamond") {
			const polygon = elem.el as SVGPolygonElement;
			const midX = (minX + maxX) / 2;
			const midY = (minY + maxY) / 2;
			polygon.setAttribute(
				"points",
				`${fmt(midX)},${fmt(minY)} ${fmt(maxX)},${fmt(midY)} ${fmt(midX)},${fmt(maxY)} ${fmt(minX)},${fmt(midY)}`
			);
		} else if (elem.kind === "triangle") {
			const polygon = elem.el as SVGPolygonElement;
			const midX = (minX + maxX) / 2;
			polygon.setAttribute("points", `${fmt(midX)},${fmt(minY)} ${fmt(minX)},${fmt(maxY)} ${fmt(maxX)},${fmt(maxY)}`);
		} else if (elem.kind === "arrow") {
			this.applyArrowGeometry(elem);
		}
		this.applyLabelGeometry(elem);
	}

	/** Where a shape's label goes: the center of a closed shape, or a point
	 * just off the midpoint of an arrow, on its upper side. `side` says how
	 * the text hangs off that point. */
	private labelAnchor(elem: ShapeElement, fontSize: number): Point & { side: "center" | "above" | "left" | "right" } {
		const mx = (elem.x0 + elem.x1) / 2;
		const my = (elem.y0 + elem.y1) / 2;
		if (elem.kind !== "arrow") return { x: mx, y: my, side: "center" };
		const dx = elem.x1 - elem.x0;
		const dy = elem.y1 - elem.y0;
		const len = Math.hypot(dx, dy);
		let nx = 0;
		let ny = -1;
		if (len >= 1) {
			nx = -dy / len;
			ny = dx / len;
			// Use whichever normal points up (or left, for a vertical line).
			if (ny > 0 || (ny === 0 && nx > 0)) {
				nx = -nx;
				ny = -ny;
			}
		}
		const gap = elem.size / 2 + fontSize * 0.3;
		const x = mx + nx * gap;
		const y = my + ny * gap;
		// A steep line has no room above its midpoint; put the label beside it.
		const side = Math.abs(nx) > 0.7 ? (nx < 0 ? "left" : "right") : "above";
		return { x, y, side };
	}

	/** The area a label may occupy: the largest centered box that fits
	 * inside a closed shape (minus stroke and padding), or a strip along an
	 * arrow as wide as the arrow is long. */
	private labelBox(elem: ShapeElement): { width: number; height: number } {
		const w = Math.abs(elem.x1 - elem.x0);
		const h = Math.abs(elem.y1 - elem.y0);
		const pad = elem.size + 4;
		if (elem.kind === "arrow") return { width: Math.max(Math.hypot(w, h) * 0.9, 40), height: Infinity };
		// Inscribed box: the full box for a rectangle, w/sqrt2 x h/sqrt2 for an
		// ellipse, half each way for a diamond (and the legacy triangle).
		const k = elem.kind === "rectangle" ? 1 : elem.kind === "ellipse" ? Math.SQRT1_2 : 0.5;
		return { width: Math.max(0, w * k - pad * 2), height: Math.max(0, h * k - pad * 2) };
	}

	private applyLabelGeometry(elem: ShapeElement): void {
		const textEl = elem.labelEl;
		if (!textEl || !elem.label) return;
		const baseSize = elem.labelSize ?? DEFAULT_STROKE_PX * TEXT_SIZE_MULTIPLIER;

		// Re-wrap only when the text or the shape's size changed -- moving a
		// shape calls this every frame and shouldn't re-measure.
		const box = this.labelBox(elem);
		const key = `${elem.label}|${baseSize}|${fmt(box.width)}|${fmt(box.height)}`;
		if (elem.labelFitKey !== key) {
			elem.labelFitKey = key;
			const { lines, fontSize } = fitLabel(elem.label, baseSize, box.width, box.height);
			textEl.setAttribute("font-size", fmt(fontSize));
			textEl.replaceChildren();
			for (const line of lines) {
				const tspan = document.createElementNS(SVG_NS, "tspan");
				tspan.textContent = line;
				textEl.appendChild(tspan);
			}
		}

		const fontSize = parseFloat(textEl.getAttribute("font-size") ?? "") || baseSize;
		const a = this.labelAnchor(elem, fontSize);
		const tspans = Array.from(textEl.querySelectorAll("tspan"));
		const n = tspans.length;
		textEl.setAttribute("x", fmt(a.x));
		textEl.setAttribute("y", fmt(a.y));
		textEl.setAttribute("text-anchor", a.side === "left" ? "end" : a.side === "right" ? "start" : "middle");
		const lh = LABEL_LINE_HEIGHT;
		if (a.side === "above") {
			// Lines stack upward so the last one sits just above the line.
			textEl.removeAttribute("dominant-baseline");
			tspans.forEach((t, i) => t.setAttribute("dy", i === 0 ? `${fmt(-(n - 1) * lh)}em` : `${lh}em`));
		} else {
			// Vertically center the block of lines on the anchor.
			textEl.setAttribute("dominant-baseline", "central");
			tspans.forEach((t, i) => t.setAttribute("dy", i === 0 ? `${fmt((-(n - 1) * lh) / 2)}em` : `${lh}em`));
		}
		tspans.forEach((t) => t.setAttribute("x", fmt(a.x)));
	}

	/** Sets (or, with `label` undefined, removes) a shape's label. A labeled
	 * shape lives in a <g data-kind="labeled"> together with its <text
	 * data-label>, so the two are one unit: they move, erase, delete and
	 * undo together, and the saved file keeps them grouped. */
	private setShapeLabel(elem: ShapeElement, label: string | undefined, baseSize: number): void {
		elem.labelEl?.remove();
		elem.labelEl = undefined;
		elem.labelFitKey = undefined;
		elem.label = label;
		elem.labelSize = label ? baseSize : undefined;

		if (!label) {
			// Unwrap: put the bare shape back where the group was.
			if (elem.labelGroup) {
				elem.labelGroup.replaceWith(elem.el);
				elem.labelGroup = undefined;
			}
			return;
		}

		if (!elem.labelGroup) {
			const g = document.createElementNS(SVG_NS, "g") as SVGGElement;
			g.setAttribute("data-kind", "labeled");
			if (elem.el.parentNode) elem.el.replaceWith(g);
			else this.elementsGroup.appendChild(g);
			g.appendChild(elem.el);
			elem.labelGroup = g;
		}
		const textEl = document.createElementNS(SVG_NS, "text") as SVGTextElement;
		textEl.setAttribute("data-label", "true");
		textEl.setAttribute("data-label-size", String(baseSize));
		// Text on a solid fill needs to contrast with the fill, not match it.
		textEl.setAttribute("fill", elem.fill === "solid" ? contrastColor(elem.color) : elem.color);
		textEl.setAttribute("font-family", "sans-serif");
		elem.labelGroup.appendChild(textEl);
		elem.labelEl = textEl;
		this.applyLabelGeometry(elem);
	}

	private removeElementDom(elem: DrawnElement): void {
		if (elem.kind !== "freehand" && elem.kind !== "text" && elem.labelGroup) elem.labelGroup.remove();
		else elem.el.remove();
	}

	private applyArrowGeometry(elem: ShapeElement): void {
		const g = elem.el as SVGGElement;
		const line = g.querySelector("line");
		if (!line) return;
		line.setAttribute("x1", fmt(elem.x0));
		line.setAttribute("y1", fmt(elem.y0));
		line.setAttribute("x2", fmt(elem.x1));
		line.setAttribute("y2", fmt(elem.y1));

		// Saved attributes: which ends have heads ("end" is the default and
		// what older files mean), and which shapes the ends are attached to.
		const heads = elem.heads ?? "end";
		if (heads === "end") g.removeAttribute("data-heads");
		else g.setAttribute("data-heads", heads);
		if (elem.startBind) g.setAttribute("data-start", elem.startBind);
		else g.removeAttribute("data-start");
		if (elem.endBind) g.setAttribute("data-end", elem.endBind);
		else g.removeAttribute("data-end");

		const want = heads === "none" ? 0 : heads === "end" ? 1 : 2;
		const polys = Array.from(g.querySelectorAll("polygon"));
		while (polys.length < want) {
			const head = document.createElementNS(SVG_NS, "polygon") as SVGPolygonElement;
			head.setAttribute("fill", elem.color);
			g.appendChild(head);
			polys.push(head);
		}
		while (polys.length > want) polys.pop()?.remove();

		const headLen = Math.max(10, elem.size * 4);
		const headAngle = Math.PI / 7; // ~25.7 degrees
		const drawHead = (poly: SVGPolygonElement, tipX: number, tipY: number, fromX: number, fromY: number) => {
			const angle = Math.atan2(tipY - fromY, tipX - fromX);
			const p1x = tipX - headLen * Math.cos(angle - headAngle);
			const p1y = tipY - headLen * Math.sin(angle - headAngle);
			const p2x = tipX - headLen * Math.cos(angle + headAngle);
			const p2y = tipY - headLen * Math.sin(angle + headAngle);
			poly.setAttribute("points", `${fmt(tipX)},${fmt(tipY)} ${fmt(p1x)},${fmt(p1y)} ${fmt(p2x)},${fmt(p2y)}`);
		};
		if (want >= 1) drawHead(polys[0], elem.x1, elem.y1, elem.x0, elem.y0);
		if (want === 2) drawHead(polys[1], elem.x0, elem.y0, elem.x1, elem.y1);
	}

	private createFreehandElement(
		color: string,
		size: number,
		points: Point[],
		id?: string,
		highlight = false
	): FreehandElement {
		const pressure = !highlight && points.some((p) => p.p !== undefined);
		const pathEl = document.createElementNS(SVG_NS, "path") as SVGPathElement;
		this.styleFreehandPath(pathEl, color, size, highlight, pressure);
		this.insertPath(pathEl, highlight);
		const elem: FreehandElement = { id: id ?? uid(), kind: "freehand", el: pathEl, color, size, points, highlight, pressure: pressure || undefined };
		this.applyGeometry(elem);
		return elem;
	}

	private createShapeElement(data: ShapeData, id?: string): ShapeElement {
		const { kind, color, size } = data;
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
		} else if (kind === "diamond" || kind === "triangle") {
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
			g.appendChild(line);
			// Arrowheads are added by applyArrowGeometry, per `heads`.
			el = g;
		}
		this.elementsGroup.appendChild(el);
		const elem: ShapeElement = {
			id: id ?? uid(),
			kind,
			el,
			color,
			size,
			x0: data.x0,
			y0: data.y0,
			x1: data.x1,
			y1: data.y1,
			fill: kind === "arrow" ? undefined : data.fill,
			heads: kind === "arrow" ? data.heads : undefined,
			startBind: kind === "arrow" ? data.startBind : undefined,
			endBind: kind === "arrow" ? data.endBind : undefined,
		};
		if (kind !== "arrow") {
			// Lets arrows in the saved file refer to this shape.
			el.setAttribute("data-id", elem.id);
			if (elem.fill && elem.fill !== "none") {
				el.setAttribute("fill", color);
				if (elem.fill === "light") el.setAttribute("fill-opacity", String(LIGHT_FILL_OPACITY));
			}
		}
		if (data.label) this.setShapeLabel(elem, data.label, data.labelSize ?? DEFAULT_STROKE_PX * TEXT_SIZE_MULTIPLIER);
		this.applyGeometry(elem);
		return elem;
	}

	private createTextElement(color: string, fontSize: number, x: number, y: number, text: string, id?: string): TextElement {
		const textEl = document.createElementNS(SVG_NS, "text") as SVGTextElement;
		textEl.setAttribute("fill", color);
		textEl.setAttribute("font-size", String(fontSize));
		textEl.setAttribute("font-family", "sans-serif");
		textEl.setAttribute("x", fmt(x));
		textEl.setAttribute("y", fmt(y));
		this.elementsGroup.appendChild(textEl);
		const elem: TextElement = { id: id ?? uid(), kind: "text", el: textEl, color, size: fontSize, x, y, text };
		textEl.setAttribute("data-id", elem.id);
		this.setTextContent(elem, text);
		return elem;
	}

	/** Replaces a text element's text, one <tspan> per line. */
	private setTextContent(elem: TextElement, text: string): void {
		elem.text = text;
		elem.el.replaceChildren();
		for (const line of text.split("\n")) {
			const tspan = document.createElementNS(SVG_NS, "tspan");
			tspan.setAttribute("x", fmt(elem.x));
			tspan.setAttribute("dy", elem.el.childElementCount === 0 ? "0" : "1.2em");
			tspan.textContent = line;
			elem.el.appendChild(tspan);
		}
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
			| (ShapeData & { id?: string })
			| { kind: "text"; color: string; size: number; x: number; y: number; text: string; id?: string };

		// Saved fills: "none" (or absent -- hoisted onto the root), a
		// translucent tint (fill-opacity < 1), or solid.
		const readFill = (el: Element): FillStyle | undefined => {
			const fill = el.getAttribute("fill");
			if (!fill || fill === "none") return undefined;
			return parseFloat(el.getAttribute("fill-opacity") ?? "1") < 1 ? "light" : "solid";
		};
		const readId = (el: Element) => el.getAttribute("data-id") ?? undefined;

		const raw: RawElement[] = [];
		// Every element this plugin writes is a direct child of the exported
		// <svg> root (see exportCroppedSvg); a shallow scan -- rather than
		// querySelectorAll, which would also match the arrowhead <polygon>
		// nested inside an arrow's <g> -- keeps each top-level element counted
		// exactly once.
		// A labeled shape is saved as <g data-kind="labeled"><shape/><text
		// data-label/></g>; flatten it so the shape is read as usual and the
		// label attaches to it below.
		const children = Array.from(root.children).flatMap((c) =>
			c.tagName.toLowerCase() === "g" && c.getAttribute("data-kind") === "labeled" ? Array.from(c.children) : [c]
		);
		for (const child of children) {
			const tag = child.tagName.toLowerCase();
			if (tag === "path" && child.hasAttribute("data-line")) {
				// Pressure stroke: a filled outline, with its centerline and
				// pressures saved alongside.
				const points = parseSmoothPath(child.getAttribute("data-line") ?? "") ?? [];
				decodePressure(child.getAttribute("data-pressure") ?? "", points);
				const color = child.getAttribute("fill") ?? DEFAULT_COLOR;
				const size = parseFloat(child.getAttribute("data-size") ?? "") || DEFAULT_STROKE_PX;
				if (points.length > 0) raw.push({ kind: "freehand", color, size, points, highlight: false });
			} else if (tag === "path") {
				const color = child.getAttribute("stroke") ?? DEFAULT_COLOR;
				const size = parseFloat(child.getAttribute("stroke-width") ?? "") || DEFAULT_STROKE_PX;
				const d = child.getAttribute("d") ?? "";
				let points: Point[] = parseSmoothPath(d) ?? [];
				// Files saved before the compact path format carry a
				// separate `data-points` copy of the raw points.
				const dataPoints = points.length === 0 ? child.getAttribute("data-points") : null;
				if (dataPoints) {
					try {
						const parsed = JSON.parse(dataPoints);
						if (Array.isArray(parsed)) points = parsed;
					} catch {
						points = [];
					}
				}
				if (points.length === 0) points = parseLegacyPathPoints(d);
				const highlight = child.getAttribute("data-highlight") === "true";
				if (points.length > 0) raw.push({ kind: "freehand", color, size, points, highlight });
			} else if (tag === "rect") {
				const color = child.getAttribute("stroke") ?? DEFAULT_COLOR;
				const size = parseFloat(child.getAttribute("stroke-width") ?? "") || DEFAULT_STROKE_PX;
				const x = parseFloat(child.getAttribute("x") ?? "0");
				const y = parseFloat(child.getAttribute("y") ?? "0");
				const w = parseFloat(child.getAttribute("width") ?? "0");
				const h = parseFloat(child.getAttribute("height") ?? "0");
				raw.push({ kind: "rectangle", color, size, x0: x, y0: y, x1: x + w, y1: y + h, fill: readFill(child), id: readId(child) });
			} else if (tag === "ellipse") {
				const color = child.getAttribute("stroke") ?? DEFAULT_COLOR;
				const size = parseFloat(child.getAttribute("stroke-width") ?? "") || DEFAULT_STROKE_PX;
				const cx = parseFloat(child.getAttribute("cx") ?? "0");
				const cy = parseFloat(child.getAttribute("cy") ?? "0");
				const rx = parseFloat(child.getAttribute("rx") ?? "0");
				const ry = parseFloat(child.getAttribute("ry") ?? "0");
				raw.push({
					kind: "ellipse",
					color,
					size,
					x0: cx - rx,
					y0: cy - ry,
					x1: cx + rx,
					y1: cy + ry,
					fill: readFill(child),
					id: readId(child),
				});
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
					const kind = pts.length === 3 ? "triangle" : "diamond";
					raw.push({ kind, color, size, x0: minX, y0: minY, x1: maxX, y1: maxY, fill: readFill(child), id: readId(child) });
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
				const heads = child.getAttribute("data-heads");
				raw.push({
					kind: "arrow",
					color,
					size,
					x0,
					y0,
					x1,
					y1,
					heads: heads === "none" || heads === "both" ? heads : undefined,
					startBind: child.getAttribute("data-start") ?? undefined,
					endBind: child.getAttribute("data-end") ?? undefined,
				});
			} else if (tag === "text" && child.hasAttribute("data-label")) {
				// A shape's label always directly follows its shape.
				const shape = raw[raw.length - 1];
				const tspans = Array.from(child.querySelectorAll("tspan"));
				const text = tspans.length > 0 ? tspans.map((t) => t.textContent ?? "").join("\n") : child.textContent ?? "";
				if (shape && shape.kind !== "freehand" && shape.kind !== "text" && text) {
					shape.label = text;
					// data-label-size is the requested size; font-size may have
					// been shrunk to fit the shape.
					shape.labelSize =
						parseFloat(child.getAttribute("data-label-size") ?? child.getAttribute("font-size") ?? "") ||
						DEFAULT_STROKE_PX * TEXT_SIZE_MULTIPLIER;
				}
			} else if (tag === "text") {
				const color = child.getAttribute("fill") ?? DEFAULT_COLOR;
				const fontSize = parseFloat(child.getAttribute("font-size") ?? "") || DEFAULT_STROKE_PX * TEXT_SIZE_MULTIPLIER;
				const x = parseFloat(child.getAttribute("x") ?? "0");
				const y = parseFloat(child.getAttribute("y") ?? "0");
				const tspans = Array.from(child.querySelectorAll("tspan"));
				const text = tspans.length > 0 ? tspans.map((t) => t.textContent ?? "").join("\n") : child.textContent ?? "";
				if (text) raw.push({ kind: "text", color, size: fontSize, x, y, text, id: readId(child) });
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
		const dx = Math.round(WORKSPACE_CENTER - (minX + maxX) / 2);
		const dy = Math.round(WORKSPACE_CENTER - (minY + maxY) / 2);

		this.elements = raw.map((r) => {
			if (r.kind === "freehand") {
				return this.createFreehandElement(
					r.color,
					r.size,
					r.points.map((p) => ({ x: round1(p.x + dx), y: round1(p.y + dy), p: p.p })),
					undefined,
					r.highlight
				);
			}
			if (r.kind === "text") {
				return this.createTextElement(r.color, r.size, r.x + dx, r.y + dy, r.text, r.id);
			}
			const { id, ...data } = r;
			return this.createShapeElement({ ...data, x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy }, id);
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
