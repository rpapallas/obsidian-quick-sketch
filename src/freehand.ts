/**
 * Pressure-sensitive strokes. A plain stroke is an SVG path with a fixed
 * stroke-width; a pressure stroke instead is a *filled outline* whose width
 * follows the pen pressure at every point, so it renders the same in the
 * editor, in embeds, and in exported PNGs, with no special viewer support.
 */

export interface PressurePoint {
	x: number;
	y: number;
	/** Pen pressure, 0..1. Missing means "normal" (0.5). */
	p?: number;
}

// How strongly pressure changes the width: 0 = not at all, 1 = from zero
// width at no pressure to twice the base width at full pressure.
const THINNING = 0.6;
// Smoothing of the pressure signal along the stroke (0..1, higher = smoother);
// raw pencil pressure jitters, which would show as a lumpy outline.
const PRESSURE_SMOOTHING = 0.6;
// The thinnest a stroke gets, as a fraction of its base width.
const MIN_WIDTH_FRACTION = 0.25;

function round1(n: number): number {
	return Math.round(n * 10) / 10;
}

function f(n: number): string {
	return String(round1(n));
}

/** Width of the stroke at pressure `p`, for a stroke whose base width
 * (at the default 0.5 pressure) is `size`. */
function widthAt(size: number, p: number): number {
	const w = size * (1 + THINNING * (2 * p - 1));
	return Math.max(size * MIN_WIDTH_FRACTION, w);
}

/** SVG path data for the filled outline of a pressure stroke through
 * `points`, `size` wide at normal pressure. */
export function pressureOutline(points: PressurePoint[], size: number): string {
	// Drop exact repeats -- they have no direction to offset along.
	const pts: PressurePoint[] = [];
	for (const pt of points) {
		const last = pts[pts.length - 1];
		if (!last || Math.hypot(pt.x - last.x, pt.y - last.y) > 0.01) pts.push(pt);
	}
	if (pts.length === 0) return "";

	// Smoothed per-point radius.
	const radii: number[] = [];
	let p = pts[0].p ?? 0.5;
	for (const pt of pts) {
		p = p * PRESSURE_SMOOTHING + (pt.p ?? 0.5) * (1 - PRESSURE_SMOOTHING);
		radii.push(widthAt(size, p) / 2);
	}

	if (pts.length === 1) {
		const { x, y } = pts[0];
		const r = radii[0];
		return `M${f(x - r)} ${f(y)}A${f(r)} ${f(r)} 0 1 0 ${f(x + r)} ${f(y)}A${f(r)} ${f(r)} 0 1 0 ${f(x - r)} ${f(y)}Z`;
	}

	// Offset each point to both sides along the normal of the local direction.
	const left: PressurePoint[] = [];
	const right: PressurePoint[] = [];
	for (let i = 0; i < pts.length; i++) {
		const a = pts[Math.max(0, i - 1)];
		const b = pts[Math.min(pts.length - 1, i + 1)];
		let tx = b.x - a.x;
		let ty = b.y - a.y;
		const len = Math.hypot(tx, ty) || 1;
		tx /= len;
		ty /= len;
		const r = radii[i];
		left.push({ x: pts[i].x - ty * r, y: pts[i].y + tx * r });
		right.push({ x: pts[i].x + ty * r, y: pts[i].y - tx * r });
	}

	// Each side is a smooth curve through its offset points (quadratic
	// segments between midpoints, like the plain strokes); the two sides are
	// joined by round caps.
	const side = (side: PressurePoint[]): string => {
		let d = "";
		for (let i = 1; i < side.length - 1; i++) {
			const mx = (side[i].x + side[i + 1].x) / 2;
			const my = (side[i].y + side[i + 1].y) / 2;
			d += `Q${f(side[i].x)} ${f(side[i].y)} ${f(mx)} ${f(my)}`;
		}
		const last = side[side.length - 1];
		return d + `L${f(last.x)} ${f(last.y)}`;
	};
	const rEnd = radii[radii.length - 1];
	const rStart = radii[0];
	const back = right.slice().reverse();
	return (
		`M${f(left[0].x)} ${f(left[0].y)}` +
		side(left) +
		`A${f(rEnd)} ${f(rEnd)} 0 0 0 ${f(back[0].x)} ${f(back[0].y)}` +
		side(back) +
		`A${f(rStart)} ${f(rStart)} 0 0 0 ${f(left[0].x)} ${f(left[0].y)}Z`
	);
}

/** Compact encoding of the per-point pressures: two digits (00-99) each. */
export function encodePressure(points: PressurePoint[]): string {
	return points.map((pt) => String(Math.round((pt.p ?? 0.5) * 99)).padStart(2, "0")).join("");
}

/** Attaches pressures decoded from `encoded` to `points` (in place). */
export function decodePressure(encoded: string, points: PressurePoint[]): void {
	for (let i = 0; i < points.length; i++) {
		const v = parseInt(encoded.slice(i * 2, i * 2 + 2), 10);
		points[i].p = Number.isFinite(v) ? v / 99 : 0.5;
	}
}
