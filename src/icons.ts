import { addIcon } from "obsidian";

/**
 * Lucide icon source data (24x24 coordinate space), bundled ourselves rather
 * than relying on Obsidian's built-in icon names -- some names aren't
 * recognised on older/mobile Obsidian builds, so bundling guarantees the
 * toolbar always renders real icons. Wrapped at registration time and passed
 * to addIcon, which expects a 0 0 100 100 viewBox.
 */
const LUCIDE_24: Record<string, string> = {
	"quick-sketch-pencil": `
		<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
		<path d="m15 5 4 4" />
	`,
	"quick-sketch-highlighter": `
		<path d="m9 11-6 6v3h9l3-3" />
		<path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
	`,
	"quick-sketch-eraser": `
		<path d="M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21" />
		<path d="m5.082 11.09 8.828 8.828" />
	`,
	"quick-sketch-select": `
		<path d="M7 22a5 5 0 0 1-2-4" />
		<path d="M7 16.93c.96.43 1.96.74 2.99.91" />
		<path d="M3.34 14A6.8 6.8 0 0 1 2 10c0-4.42 4.48-8 10-8s10 3.58 10 8a7.19 7.19 0 0 1-.33 2" />
		<path d="M5 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" />
		<path d="M14.33 22h-.09a.35.35 0 0 1-.24-.32v-10a.34.34 0 0 1 .33-.34c.08 0 .15.03.21.08l7.34 6a.33.33 0 0 1-.21.59h-4.49l-2.57 3.85a.35.35 0 0 1-.28.14z" />
	`,
	"quick-sketch-hand": `
		<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" />
		<path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" />
		<path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" />
		<path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
	`,
	"quick-sketch-undo": `
		<path d="M9 14 L 4 9 l 5-5" />
		<path d="M4 9 h 10.5 a 5.5 5.5 0 0 1 5.5 5.5 a 5.5 5.5 0 0 1-5.5 5.5 H 11" />
	`,
	"quick-sketch-redo": `
		<path d="m15 14 5-5-5-5" />
		<path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13" />
	`,
	"quick-sketch-zoom-in": `
		<circle cx="11" cy="11" r="8" />
		<line x1="21" x2="16.65" y1="21" y2="16.65" />
		<line x1="11" x2="11" y1="8" y2="14" />
		<line x1="8" x2="14" y1="11" y2="11" />
	`,
	"quick-sketch-zoom-out": `
		<circle cx="11" cy="11" r="8" />
		<line x1="21" x2="16.65" y1="21" y2="16.65" />
		<line x1="8" x2="14" y1="11" y2="11" />
	`,
	"quick-sketch-fit": `
		<path d="M15 3h6v6" />
		<path d="m21 3-7 7" />
		<path d="m3 21 7-7" />
		<path d="M9 21H3v-6" />
	`,
	"quick-sketch-reset": `
		<line x1="2" x2="5" y1="12" y2="12" />
		<line x1="19" x2="22" y1="12" y2="12" />
		<line x1="12" x2="12" y1="2" y2="5" />
		<line x1="12" x2="12" y1="19" y2="22" />
		<circle cx="12" cy="12" r="7" />
		<circle cx="12" cy="12" r="3" />
	`,
	"quick-sketch-trash": `
		<path d="M10 11v6" />
		<path d="M14 11v6" />
		<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
		<path d="M3 6h18" />
		<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
	`,
	"quick-sketch-clear": `
		<circle cx="12" cy="12" r="10" />
		<path d="m15 9-6 6" />
		<path d="m9 9 6 6" />
	`,
	"quick-sketch-rectangle": `
		<rect width="18" height="18" x="3" y="3" rx="2" />
	`,
	"quick-sketch-ellipse": `
		<circle cx="12" cy="12" r="9" />
	`,
	"quick-sketch-diamond": `
		<path d="M12 2.5 L21.5 12 L12 21.5 L2.5 12 Z" />
	`,
	"quick-sketch-arrow": `
		<path d="M5 12h14" />
		<path d="m12 5 7 7-7 7" />
	`,
	"quick-sketch-line": `
		<path d="M5 19 19 5" />
	`,
	"quick-sketch-lasso": `
		<path d="M7 22a5 5 0 0 1-2-4" />
		<path d="M3.3 14A6.8 6.8 0 0 1 2 10c0-4.4 4.5-8 10-8s10 3.6 10 8-4.5 8-10 8a12 12 0 0 1-5-1" />
		<path d="M5 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" />
	`,
	"quick-sketch-pointer": `
		<path d="M4.04 4.73a.5.5 0 0 1 .69-.69l15.5 6.06a.5.5 0 0 1-.04.95l-6.32 1.95a2 2 0 0 0-1.33 1.33l-1.95 6.32a.5.5 0 0 1-.95.04z" />
	`,
	"quick-sketch-shapes": `
		<path d="M8.3 10a.7.7 0 0 1-.63-1.04l3.7-6.43a.7.7 0 0 1 1.23 0l3.7 6.43a.7.7 0 0 1-.63 1.04z" />
		<rect x="3" y="14" width="7" height="7" rx="1" />
		<circle cx="17.5" cy="17.5" r="3.5" />
	`,
	"quick-sketch-more": `
		<circle cx="12" cy="12" r="1" />
		<circle cx="19" cy="12" r="1" />
		<circle cx="5" cy="12" r="1" />
	`,
	"quick-sketch-copy": `
		<rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
		<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
	`,
	"quick-sketch-duplicate": `
		<line x1="15" x2="15" y1="12" y2="18" />
		<line x1="12" x2="18" y1="15" y2="15" />
		<rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
		<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
	`,
	"quick-sketch-image": `
		<rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
		<circle cx="9" cy="9" r="2" />
		<path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21" />
	`,
	"quick-sketch-download": `
		<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
		<polyline points="7 10 12 15 17 10" />
		<line x1="12" x2="12" y1="15" y2="3" />
	`,
	"quick-sketch-minus": `
		<path d="M5 12h14" />
	`,
	"quick-sketch-plus": `
		<path d="M5 12h14" />
		<path d="M12 5v14" />
	`,
	"quick-sketch-settings": `
		<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
		<circle cx="12" cy="12" r="3" />
	`,
	"quick-sketch-text": `
		<polyline points="4 7 4 4 20 4 20 7" />
		<line x1="9" x2="15" y1="20" y2="20" />
		<line x1="12" x2="12" y1="4" y2="20" />
	`,
};

let registered = false;

/** Registers all toolbar icons. Safe to call multiple times. */
export function registerIcons(): void {
	if (registered) return;
	registered = true;
	for (const [name, inner] of Object.entries(LUCIDE_24)) {
		const svg = `<g transform="scale(4.166667)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`;
		addIcon(name, svg);
	}
}

export const ICON = {
	pencil: "quick-sketch-pencil",
	highlighter: "quick-sketch-highlighter",
	eraser: "quick-sketch-eraser",
	select: "quick-sketch-select",
	hand: "quick-sketch-hand",
	undo: "quick-sketch-undo",
	redo: "quick-sketch-redo",
	zoomIn: "quick-sketch-zoom-in",
	zoomOut: "quick-sketch-zoom-out",
	fit: "quick-sketch-fit",
	reset: "quick-sketch-reset",
	trash: "quick-sketch-trash",
	clear: "quick-sketch-clear",
	rectangle: "quick-sketch-rectangle",
	ellipse: "quick-sketch-ellipse",
	diamond: "quick-sketch-diamond",
	arrow: "quick-sketch-arrow",
	text: "quick-sketch-text",
	line: "quick-sketch-line",
	lasso: "quick-sketch-lasso",
	pointer: "quick-sketch-pointer",
	shapes: "quick-sketch-shapes",
	more: "quick-sketch-more",
	copy: "quick-sketch-copy",
	duplicate: "quick-sketch-duplicate",
	image: "quick-sketch-image",
	download: "quick-sketch-download",
	minus: "quick-sketch-minus",
	plus: "quick-sketch-plus",
	settings: "quick-sketch-settings",
} as const;
