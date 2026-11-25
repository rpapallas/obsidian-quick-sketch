/** Small 2D helpers shared by the editor and shape recognition. */

export interface XY {
	x: number;
	y: number;
}

/** An axis-aligned box by its edges. */
export interface Box {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** Shortest distance from `p` to the segment from `a` to `b` (or to `a`
 * itself, if the segment has no length). */
export function segmentDistance(p: XY, a: XY, b: XY): number {
	const abx = b.x - a.x;
	const aby = b.y - a.y;
	const lengthSq = abx * abx + aby * aby;
	// Where p's projection falls along a->b, as a fraction, kept on the segment.
	const along = lengthSq > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSq)) : 0;
	return Math.hypot(p.x - (a.x + along * abx), p.y - (a.y + along * aby));
}

/** The smallest box holding every point, or null when there are none. */
export function boxAround(points: Iterable<XY>): Box | null {
	let box: Box | null = null;
	for (const { x, y } of points) {
		if (box === null) {
			box = { left: x, top: y, right: x, bottom: y };
			continue;
		}
		box.left = Math.min(box.left, x);
		box.top = Math.min(box.top, y);
		box.right = Math.max(box.right, x);
		box.bottom = Math.max(box.bottom, y);
	}
	return box;
}

/** `box` with every edge pushed outward by `by`. */
export function grow(box: Box, by: number): Box {
	return { left: box.left - by, top: box.top - by, right: box.right + by, bottom: box.bottom + by };
}

export function boxHas(box: Box, p: XY): boolean {
	return p.x >= box.left && p.x <= box.right && p.y >= box.top && p.y <= box.bottom;
}

export function boxesTouch(a: Box, b: Box): boolean {
	return a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom;
}
