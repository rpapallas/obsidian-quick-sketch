/** Rasterizes an SVG document (as text) to a PNG blob. `background` fills
 * the canvas first; null leaves it transparent. */
export async function svgToPng(svg: string, width: number, height: number, scale: number, background: string | null): Promise<Blob> {
	const img = new Image();
	img.decoding = "async";
	const loaded = new Promise<void>((resolve, reject) => {
		img.onload = () => resolve();
		img.onerror = () => reject(new Error("Couldn't render the drawing."));
	});
	img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
	await loaded;

	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(width * scale));
	canvas.height = Math.max(1, Math.round(height * scale));
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Canvas isn't available.");
	if (background) {
		ctx.fillStyle = background;
		ctx.fillRect(0, 0, canvas.width, canvas.height);
	}
	ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
	return new Promise<Blob>((resolve, reject) =>
		canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed."))), "image/png")
	);
}

/** Puts a PNG on the system clipboard. The blob is passed as a promise so
 * Safari/WebKit (iPad) still counts the write as part of the user's tap. */
export async function copyPngToClipboard(png: Promise<Blob>): Promise<void> {
	if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
		throw new Error("Copying images isn't supported here.");
	}
	await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}
