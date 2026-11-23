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
	| "pan"
	| "rectangle"
	| "ellipse"
	| "triangle"
	| "arrow"
	| "text";
export const DEFAULT_TOOL: Tool = "pencil";

export const SHAPE_TOOLS: ReadonlySet<Tool> = new Set(["rectangle", "ellipse", "triangle", "arrow"]);

// Screen-pixel radii for hit-testing; divided by the current zoom so the
// effective canvas-space radius stays visually constant as you zoom.
export const ERASE_RADIUS_PX = 10;
export const SELECT_HIT_RADIUS_PX = 6;

// Text tool reuses the pencil size buttons (S/M/L) for font size, scaled up
// by this factor -- a stroke width of 2-10px isn't legible as text size.
export const TEXT_SIZE_MULTIPLIER = 6;

// Saved/embedded files are cropped to the bounding box of the strokes, plus
// this much breathing room on each side.
export const CROP_PADDING = 20;

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
