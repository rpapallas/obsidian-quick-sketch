/** Shape recognition for "hold the pen still to snap": turns a hand-drawn
 * stroke into a clean line, rectangle, ellipse or diamond, or returns null
 * when it doesn't clearly look like one (it's then left as ink). Only
 * axis-aligned shapes are recognized, since those are what the shape tools
 * draw. */

export interface RecognizedShape {
	/** A line is an "arrow" with no heads, as everywhere else. */
	kind: "arrow" | "rectangle" | "ellipse" | "diamond";
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

interface Pt {
	x: number;
	y: number;
}

/** Mean fit error (in half-size units) above which a closed stroke isn't
 * considered any shape. */
const MAX_CLOSED_ERROR = 0.11;
/** A stroke this close to straight (chord / path length) may be a line. */
const LINE_STRAIGHTNESS = 0.94;
/** Lines within this many degrees of a multiple of 45 degrees snap to it. */
const LINE_SNAP_DEG = 6;

function dist(a: Pt, b: Pt): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len2 = dx * dx + dy * dy;
	const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
	return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Resamples to evenly spaced points so slow and fast parts of a stroke
 * weigh the same in the fit. */
function resample(points: Pt[], n: number): Pt[] {
	let total = 0;
	for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
	if (total === 0) return [points[0]];
	const step = total / (n - 1);
	const out: Pt[] = [{ ...points[0] }];
	let carried = 0;
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1];
		const b = points[i];
		let seg = dist(a, b);
		let start = a;
		while (carried + seg >= step && out.length < n) {
			const t = (step - carried) / seg;
			const q = { x: start.x + (b.x - start.x) * t, y: start.y + (b.y - start.y) * t };
			out.push(q);
			seg -= step - carried;
			start = q;
			carried = 0;
		}
		carried += seg;
	}
	while (out.length < n) out.push({ ...points[points.length - 1] });
	return out;
}

export function recognizeShape(points: Pt[], minSize: number): RecognizedShape | null {
	if (points.length < 3) return null;
	let pathLen = 0;
	for (let i = 1; i < points.length; i++) pathLen += dist(points[i - 1], points[i]);
	let minX = Infinity,
		minY = Infinity,
		maxX = -Infinity,
		maxY = -Infinity;
	for (const p of points) {
		minX = Math.min(minX, p.x);
		minY = Math.min(minY, p.y);
		maxX = Math.max(maxX, p.x);
		maxY = Math.max(maxY, p.y);
	}
	const w = maxX - minX;
	const h = maxY - minY;
	if (Math.max(w, h) < minSize || pathLen === 0) return null;

	const first = points[0];
	const last = points[points.length - 1];
	const chord = dist(first, last);

	// A line: nearly as long as the path, and never strays far from it.
	if (chord >= minSize && chord / pathLen >= LINE_STRAIGHTNESS) {
		const maxDev = Math.max(...points.map((p) => distToSegment(p, first, last)));
		if (maxDev <= chord * 0.07 + 2) {
			let end = { ...last };
			const angle = Math.atan2(last.y - first.y, last.x - first.x);
			const step = Math.PI / 4;
			const snapped = Math.round(angle / step) * step;
			if (Math.abs(angle - snapped) <= (LINE_SNAP_DEG * Math.PI) / 180) {
				end = { x: first.x + Math.cos(snapped) * chord, y: first.y + Math.sin(snapped) * chord };
			}
			return { kind: "arrow", x0: first.x, y0: first.y, x1: end.x, y1: end.y };
		}
		return null;
	}

	// Closed shapes: the stroke must end near where it started, relative
	// to its size, and actually go around (not a scribble in a corner).
	if (w < minSize * 0.5 || h < minSize * 0.5) return null;
	if (chord > Math.max(w, h) * 0.3) return null;
	if (pathLen < (w + h) * 1.5) return null;

	const cx = (minX + maxX) / 2;
	const cy = (minY + maxY) / 2;
	const hw = w / 2;
	const hh = h / 2;
	const pts = resample(points, 64);
	let ellipse = 0;
	let rect = 0;
	let diamond = 0;
	for (const p of pts) {
		const nx = Math.abs((p.x - cx) / hw);
		const ny = Math.abs((p.y - cy) / hh);
		ellipse += Math.abs(Math.hypot(nx, ny) - 1);
		rect += Math.min(Math.abs(1 - nx), Math.abs(1 - ny));
		diamond += Math.abs(nx + ny - 1);
	}
	const fits: [RecognizedShape["kind"], number][] = [
		["ellipse", ellipse / pts.length],
		["rectangle", rect / pts.length],
		["diamond", diamond / pts.length],
	];
	fits.sort((a, b) => a[1] - b[1]);
	const [kind, error] = fits[0];
	if (error > MAX_CLOSED_ERROR) return null;
	return { kind, x0: minX, y0: minY, x1: maxX, y1: maxY };
}
