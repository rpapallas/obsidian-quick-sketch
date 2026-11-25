/**
 * Toolbar icons, as the inner markup of a 24x24 SVG.
 *
 * Most are Lucide icons (https://lucide.dev, ISC License; see the README),
 * copied unmodified from lucide-static 0.460.0. "laser", "ellipse",
 * "diamond" and "line" are drawn for this plugin.
 */
import { addIcon } from "obsidian";

const LUCIDE: Record<string, string[]> = {
	pencil: [`<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>`, `<path d="m15 5 4 4"/>`], // pencil
	highlighter: [`<path d="m9 11-6 6v3h9l3-3"/>`, `<path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>`], // highlighter
	eraser: [`<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/>`, `<path d="M22 21H7"/>`, `<path d="m5 11 9 9"/>`], // eraser
	hand: [`<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/>`, `<path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/>`, `<path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/>`, `<path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>`], // hand
	pointer: [`<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/>`], // mouse-pointer-2
	lasso: [`<path d="M7 22a5 5 0 0 1-2-4"/>`, `<path d="M3.3 14A6.8 6.8 0 0 1 2 10c0-4.4 4.5-8 10-8s10 3.6 10 8-4.5 8-10 8a12 12 0 0 1-5-1"/>`, `<path d="M5 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/>`], // lasso
	rectangle: [`<rect width="18" height="18" x="3" y="3" rx="2"/>`], // square
	arrow: [`<path d="M5 12h14"/>`, `<path d="m12 5 7 7-7 7"/>`], // arrow-right
	text: [`<polyline points="4 7 4 4 20 4 20 7"/>`, `<line x1="9" x2="15" y1="20" y2="20"/>`, `<line x1="12" x2="12" y1="4" y2="20"/>`], // type
	undo: [`<path d="M9 14 4 9l5-5"/>`, `<path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>`], // undo-2
	redo: [`<path d="m15 14 5-5-5-5"/>`, `<path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13"/>`], // redo-2
	more: [`<circle cx="12" cy="12" r="1"/>`, `<circle cx="19" cy="12" r="1"/>`, `<circle cx="5" cy="12" r="1"/>`], // ellipsis
	present: [`<path d="M2 3h20"/>`, `<path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"/>`, `<path d="m7 21 5-5 5 5"/>`], // presentation
	close: [`<path d="M18 6 6 18"/>`, `<path d="m6 6 12 12"/>`], // x
	fit: [`<polyline points="15 3 21 3 21 9"/>`, `<polyline points="9 21 3 21 3 15"/>`, `<line x1="21" x2="14" y1="3" y2="10"/>`, `<line x1="3" x2="10" y1="21" y2="14"/>`], // maximize-2
	reset: [`<line x1="2" x2="5" y1="12" y2="12"/>`, `<line x1="19" x2="22" y1="12" y2="12"/>`, `<line x1="12" x2="12" y1="2" y2="5"/>`, `<line x1="12" x2="12" y1="19" y2="22"/>`, `<circle cx="12" cy="12" r="7"/>`], // locate
	minus: [`<path d="M5 12h14"/>`], // minus
	plus: [`<path d="M5 12h14"/>`, `<path d="M12 5v14"/>`], // plus
	trash: [`<path d="M3 6h18"/>`, `<path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>`, `<path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>`, `<line x1="10" x2="10" y1="11" y2="17"/>`, `<line x1="14" x2="14" y1="11" y2="17"/>`], // trash-2
	clear: [`<circle cx="12" cy="12" r="10"/>`, `<path d="m15 9-6 6"/>`, `<path d="m9 9 6 6"/>`], // circle-x
	copy: [`<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>`, `<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>`], // copy
	duplicate: [`<line x1="15" x2="15" y1="12" y2="18"/>`, `<line x1="12" x2="18" y1="15" y2="15"/>`, `<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>`, `<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>`], // copy-plus
	image: [`<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>`, `<circle cx="9" cy="9" r="2"/>`, `<path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>`], // image
	imagePlus: [`<path d="M16 5h6"/>`, `<path d="M19 2v6"/>`, `<path d="M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5"/>`, `<path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>`, `<circle cx="9" cy="9" r="2"/>`], // image-plus
	download: [`<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>`, `<polyline points="7 10 12 15 17 10"/>`, `<line x1="12" x2="12" y1="15" y2="3"/>`], // download
	settings: [`<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>`, `<circle cx="12" cy="12" r="3"/>`], // settings
	paper: [`<rect width="18" height="18" x="3" y="3" rx="2"/>`, `<path d="M3 9h18"/>`, `<path d="M3 15h18"/>`, `<path d="M9 3v18"/>`, `<path d="M15 3v18"/>`], // grid-3x3
	grip: [`<circle cx="12" cy="9" r="1"/>`, `<circle cx="19" cy="9" r="1"/>`, `<circle cx="5" cy="9" r="1"/>`, `<circle cx="12" cy="15" r="1"/>`, `<circle cx="19" cy="15" r="1"/>`, `<circle cx="5" cy="15" r="1"/>`], // grip-horizontal
	chevronDown: [`<path d="m6 9 6 6 6-6"/>`], // chevron-down
};

const OWN: Record<string, string[]> = {
	laser: [`<path d="m3 21 6-6" stroke-width="3.5"/>`, `<path d="m11.5 12.5 2-2" stroke-dasharray="0.5 2.5"/>`, `<circle cx="17" cy="7" r="2.2" fill="currentColor"/>`, `<path d="M17 2v1.2M22 7h-1.2M20.5 3.5l-.9.9M20.5 10.5l-.9-.9M13.5 3.5l.9.9"/>`],
	ellipse: [`<ellipse cx="12" cy="12" rx="9.5" ry="7.5"/>`],
	diamond: [`<path d="M12 2.5 21.5 12 12 21.5 2.5 12z"/>`],
	line: [`<path d="M5 19 19 5"/>`],
};

/** Icon ids to pass to setIcon(). The "qs-icon-" prefix keeps them (and
 * the class Obsidian puts on each rendered icon) from clashing with
 * anything else. */
export const ICON = {
	pencil: "qs-icon-pencil",
	highlighter: "qs-icon-highlighter",
	eraser: "qs-icon-eraser",
	hand: "qs-icon-hand",
	pointer: "qs-icon-pointer",
	lasso: "qs-icon-lasso",
	rectangle: "qs-icon-rectangle",
	arrow: "qs-icon-arrow",
	text: "qs-icon-text",
	undo: "qs-icon-undo",
	redo: "qs-icon-redo",
	more: "qs-icon-more",
	present: "qs-icon-present",
	close: "qs-icon-close",
	fit: "qs-icon-fit",
	reset: "qs-icon-reset",
	minus: "qs-icon-minus",
	plus: "qs-icon-plus",
	trash: "qs-icon-trash",
	clear: "qs-icon-clear",
	copy: "qs-icon-copy",
	duplicate: "qs-icon-duplicate",
	image: "qs-icon-image",
	imagePlus: "qs-icon-imagePlus",
	download: "qs-icon-download",
	settings: "qs-icon-settings",
	paper: "qs-icon-paper",
	chevronDown: "qs-icon-chevronDown",
	grip: "qs-icon-grip",
	laser: "qs-icon-laser",
	ellipse: "qs-icon-ellipse",
	diamond: "qs-icon-diamond",
	line: "qs-icon-line",
} as const;

/** addIcon() draws into a 100x100 box; the icons are 24x24. */
const UP = 100 / 24;

/** Registers every icon with Obsidian. */
export function addToolbarIcons(): void {
	for (const [name, parts] of [...Object.entries(LUCIDE), ...Object.entries(OWN)]) {
		addIcon(
			`qs-icon-${name}`,
			`<g transform="scale(${UP})" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" fill="none">${parts.join("")}</g>`
		);
	}
}
