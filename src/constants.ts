export const VIEW_TYPE_DRAWING = "quick-sketch-drawing-view";

// The editing surface is a large, fixed scrollable canvas (pan via native
// scroll) rather than a truly unbounded one -- big enough that you'll never
// practically hit an edge while sketching, without the complexity of a real
// infinite/tiled canvas. 1 unit == 1px, no viewBox scaling.
export const WORKSPACE_SIZE = 6000;
export const WORKSPACE_CENTER = WORKSPACE_SIZE / 2;

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

export type Tool =
	| "pencil"
	| "highlighter"
	| "eraser"
	| "select"
	| "lasso"
	| "pan"
	| "laser"
	| "rectangle"
	| "ellipse"
	| "diamond"
	| "line"
	| "arrow"
	| "text";
export const DEFAULT_TOOL: Tool = "pencil";

export const SHAPE_TOOLS: ReadonlySet<Tool> = new Set(["rectangle", "ellipse", "diamond", "line", "arrow"]);
/** Shape tools that draw a closed outline (and so can be filled). */
export const CLOSED_SHAPE_TOOLS: ReadonlySet<Tool> = new Set(["rectangle", "ellipse", "diamond"]);
export const SELECT_TOOLS: ReadonlySet<Tool> = new Set(["select", "lasso"]);

/** How a closed shape is filled: not at all, a translucent tint of its
 * stroke color, or solid. */
export type FillStyle = "none" | "light" | "solid";
export const LIGHT_FILL_OPACITY = 0.2;

/** Which ends of a line/arrow carry an arrowhead. */
export type ArrowHeads = "none" | "end" | "both";

// Screen-pixel size of the selection resize handles, and how far from one a
// press still grabs it (generous, for fingers and the pencil).
export const HANDLE_SIZE_PX = 9;
export const HANDLE_HIT_PX = 14;

// An arrow end dropped within this many screen px of a shape (or inside it)
// attaches to it, and then follows the shape when it moves.
export const BIND_DISTANCE_PX = 12;

// Arrow keys nudge a selection this many px (with Shift: NUDGE_BIG_PX).
export const NUDGE_PX = 1;
export const NUDGE_BIG_PX = 10;

// Pasted/duplicated elements land this far down-right of their source.
export const PASTE_OFFSET = 20;

// Two taps on the same shape within this many ms (select tool) open its
// label editor.
export const DOUBLE_TAP_MS = 400;

// Screen-pixel radii for hit-testing; divided by the current zoom so the
// effective canvas-space radius stays visually constant as you zoom.
export const ERASE_RADIUS_PX = 10;
export const SELECT_HIT_RADIUS_PX = 6;

// Text tool reuses the pencil size buttons (S/M/L) for font size, scaled up
// by this factor -- a stroke width of 2-10px isn't legible as text size.
export const TEXT_SIZE_MULTIPLIER = 6;

// Laser pointer (presenting). The trail is drawn this wide (screen px) at
// its freshest point, and fades out after LASER_TRAILS[...].ms -- or, for
// "hold", stays until the next stroke starts (then fades over HOLD_FADE_MS).
export const LASER_WIDTH_PX = 5;
export const LASER_COLORS: string[] = [
	"#ff2828", // red
	"#22d34f", // green
	"#2f8bff", // blue
	"#ff2bd6", // magenta
];
export type LaserTrail = "short" | "long" | "hold";
export const LASER_TRAIL_MS: Record<LaserTrail, number> = { short: 700, long: 2000, hold: 0 };
export const LASER_HOLD_FADE_MS = 500;

// Shape recognition: holding the pen still (within HOLD_TOLERANCE_PX screen
// px) for HOLD_MS at the end of a pen stroke snaps it to a clean shape, if it
// looks like one. Strokes smaller than MIN_SIZE_PX on screen are left alone.
export const RECOGNIZE_HOLD_MS = 550;
export const RECOGNIZE_HOLD_TOLERANCE_PX = 4;
export const RECOGNIZE_MIN_SIZE_PX = 24;

// Background paper: shown behind the drawing (and optionally saved with it).
// Its pattern is anchored at workspace (0, 0); loading a file recenters it by
// a multiple of PAPER_ALIGN so writing stays on the same lines.
export type Paper = "none" | "dots" | "grid" | "lines";
export const PAPER_SPACING: Record<Exclude<Paper, "none">, number> = { dots: 24, grid: 24, lines: 32 };
export const PAPER_ALIGN = 96;
export const PAPER_COLOR = "#d0d4da";

/** Stroke pattern of a shape or line. Missing means solid. */
export type DashStyle = "solid" | "dashed" | "dotted";

// Inserted images are downscaled so their longest side is at most this many
// px (they're stored inside the drawing's SVG), and placed no larger than
// this fraction of the visible canvas.
export const IMAGE_MAX_PX = 1600;
export const IMAGE_VIEW_FRACTION = 0.6;

// Saved/embedded files are cropped to the bounding box of the strokes, plus
// this much breathing room on each side.
export const CROP_PADDING = 20;

// Finished freehand strokes drop any point that moves the line by less than
// this many canvas px (a tenth of the default stroke width -- invisible).
// The pen reports a point every ~1.3px, most of them redundant, so this
// roughly halves the point count and the saved file size.
export const SIMPLIFY_TOLERANCE = 0.5;

// Fallback export size for a drawing with no strokes yet.
export const EMPTY_EXPORT_WIDTH = 400;
export const EMPTY_EXPORT_HEIGHT = 300;

export interface StrokeSize {
	label: string;
	px: number;
}

export const STROKE_SIZES: StrokeSize[] = [
	{ label: "S", px: 2 },
	{ label: "M", px: 5 },
	{ label: "L", px: 10 },
];

export const COLORS: string[] = [
	"#1e1e1e", // black
	"#7a7a7a", // gray
	"#e03131", // red
	"#f08c00", // orange
	"#2f9e44", // green
	"#1971c2", // blue
	"#9c36b5", // purple
	"#795548", // brown
];

// Highlighter strokes are drawn semi-transparent, underneath all other ink,
// and this many times wider than the selected S/M/L pencil size.
export const HIGHLIGHT_COLORS: string[] = [
	"#ffe066", // light yellow
	"#ff8787", // light red
	"#74c0fc", // light blue
];
export const HIGHLIGHT_OPACITY = 0.5;
export const HIGHLIGHT_SIZE_MULTIPLIER = 4;

export const DEFAULT_STROKE_PX = STROKE_SIZES[1].px;
export const DEFAULT_COLOR = COLORS[0];

// A brand-new drawing has no strokes yet; this is just a valid placeholder
// until the first save writes a properly cropped export.
export const EMPTY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${EMPTY_EXPORT_WIDTH} ${EMPTY_EXPORT_HEIGHT}" width="${EMPTY_EXPORT_WIDTH}" height="${EMPTY_EXPORT_HEIGHT}"></svg>`;
