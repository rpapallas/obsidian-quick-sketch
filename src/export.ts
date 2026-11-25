/** Renders an SVG document (as text) onto a canvas, `scale` device px per
 * SVG px. `background` fills the canvas first; null leaves it transparent. */
export async function svgToCanvas(svg: string, width: number, height: number, scale: number, background: string | null): Promise<HTMLCanvasElement> {
	const img = new Image();
	img.decoding = "async";
	const loaded = new Promise<void>((resolve, reject) => {
		img.onload = () => resolve();
		img.onerror = () => reject(new Error("Couldn't render the drawing."));
	});
	img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
	await loaded;

	const canvas = createEl("canvas");
	canvas.width = Math.max(1, Math.round(width * scale));
	canvas.height = Math.max(1, Math.round(height * scale));
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Canvas isn't available.");
	if (background) {
		ctx.fillStyle = background;
		ctx.fillRect(0, 0, canvas.width, canvas.height);
	}
	ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
	return canvas;
}

/** Rasterizes an SVG document (as text) to a PNG blob. */
export async function svgToPng(svg: string, width: number, height: number, scale: number, background: string | null): Promise<Blob> {
	const canvas = await svgToCanvas(svg, width, height, scale, background);
	return new Promise<Blob>((resolve, reject) =>
		canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed."))), "image/png")
	);
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
	// "deflate" is the zlib format, which is what PDF's FlateDecode expects.
	const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A one-page PDF (`pageWidth` x `pageHeight` points) showing the canvas
 * stretched over the page. The pixels are stored losslessly (Flate) where
 * the platform can compress, else as a high-quality JPEG. Opaque only: any
 * transparency in the canvas comes out black, so fill it first. */
export async function canvasToPdf(canvas: HTMLCanvasElement, pageWidth: number, pageHeight: number): Promise<ArrayBuffer> {
	const { width, height } = canvas;
	let image: Uint8Array;
	let filter: string;
	if (typeof CompressionStream !== "undefined") {
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("Canvas isn't available.");
		const rgba = ctx.getImageData(0, 0, width, height).data;
		const rgb = new Uint8Array(width * height * 3);
		for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
			rgb[j] = rgba[i];
			rgb[j + 1] = rgba[i + 1];
			rgb[j + 2] = rgba[i + 2];
		}
		image = await deflate(rgb);
		filter = "/FlateDecode";
	} else {
		const jpeg = await new Promise<Blob>((resolve, reject) =>
			canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("JPEG encoding failed."))), "image/jpeg", 0.95)
		);
		image = new Uint8Array(await jpeg.arrayBuffer());
		filter = "/DCTDecode";
	}

	const num = (n: number) => String(Math.round(n * 100) / 100);
	const content = `q ${num(pageWidth)} 0 0 ${num(pageHeight)} 0 0 cm /Im0 Do Q`;
	const enc = new TextEncoder();
	const chunks: Uint8Array[] = [];
	const offsets: number[] = [];
	let length = 0;
	const push = (part: string | Uint8Array) => {
		const bytes = typeof part === "string" ? enc.encode(part) : part;
		chunks.push(bytes);
		length += bytes.length;
	};
	const object = (id: number, body: string, stream?: Uint8Array) => {
		offsets[id] = length;
		push(`${id} 0 obj\n${body}\n`);
		if (stream) {
			push("stream\n");
			push(stream);
			push("\nendstream\n");
		}
		push("endobj\n");
	};

	push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
	object(1, "<< /Type /Catalog /Pages 2 0 R >>");
	object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
	object(
		3,
		`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(pageWidth)} ${num(pageHeight)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`
	);
	object(
		4,
		`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter ${filter} /Length ${image.length} >>`,
		image
	);
	object(5, `<< /Length ${enc.encode(content).length} >>`, enc.encode(content));
	const xref = length;
	push(`xref\n0 6\n0000000000 65535 f \n`);
	for (let id = 1; id <= 5; id++) push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
	push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

	const out = new Uint8Array(length);
	let pos = 0;
	for (const c of chunks) {
		out.set(c, pos);
		pos += c.length;
	}
	return out.buffer;
}

/** Puts a PNG on the system clipboard. The blob is passed as a promise so
 * Safari/WebKit (iPad) still counts the write as part of the user's tap. */
export async function copyPngToClipboard(png: Promise<Blob>): Promise<void> {
	if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
		throw new Error("Copying images isn't supported here.");
	}
	await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}
