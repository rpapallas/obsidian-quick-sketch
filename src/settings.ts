import { App, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_COLOR, INK, DEFAULT_STROKE_PX, LASER_COLORS, LaserTrail, Paper, STROKE_SIZES, Tool } from "./constants";
import type QuickSketchPlugin from "./main";

export interface QuickSketchSettings {
	/** Colors added to the palette with its "+" button, as #rrggbb. */
	customColors: string[];
	/** Where new drawings are created: Obsidian's attachment location (as
	 * configured in Files & links), or a fixed folder. */
	location: "attachments" | "folder";
	folder: string;
	/** moment.js format for new drawings' file names. */
	fileNameFormat: string;
	defaultTool: Tool;
	defaultColor: string;
	defaultSize: number;
	/** Vary the pen's stroke width with Apple Pencil / stylus pressure. */
	pressure: boolean;
	pngScale: number;
	pngBackground: "white" | "transparent";
	/** Snap a pen stroke to a shape when the pen is held still at its end. */
	shapeRecognition: boolean;
	/** Background paper of new drawings. */
	defaultPaper: Paper;
	/** Save the background paper into the drawing file (so embeds and
	 * exports show it), not just show it while editing. */
	paperInExport: boolean;
	laserColor: string;
	laserTrail: LaserTrail;
	/** Where the style panel was dragged to, from the nearest side of the
	 * editor and its top, in px; null for its default place (top right). */
	stylePanelPos: { side: "left" | "right"; x: number; y: number } | null;
}

export const DEFAULT_SETTINGS: QuickSketchSettings = {
	customColors: [],
	location: "attachments",
	folder: "Drawings",
	fileNameFormat: "[Drawing] YYYY-MM-DD HH.mm.ss",
	defaultTool: "pencil",
	defaultColor: DEFAULT_COLOR,
	defaultSize: DEFAULT_STROKE_PX,
	pressure: true,
	pngScale: 2,
	pngBackground: "white",
	shapeRecognition: true,
	defaultPaper: "none",
	paperInExport: false,
	laserColor: LASER_COLORS[0],
	laserTrail: "short",
	stylePanelPos: null,
};

const TOOL_NAMES: Partial<Record<Tool, string>> = {
	pencil: "Pen",
	highlighter: "Highlighter",
	select: "Select",
	lasso: "Lasso",
	rectangle: "Rectangle",
	ellipse: "Ellipse",
	diamond: "Diamond",
	line: "Line",
	arrow: "Arrow",
	text: "Text",
};

export class QuickSketchSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: QuickSketchPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;
		const save = () => void this.plugin.saveSettings();

		new Setting(containerEl).setName("New drawings").setHeading();

		new Setting(containerEl)
			.setName("Location")
			.setDesc("Where new drawing files are created.")
			.addDropdown((d) =>
				d
					.addOption("attachments", "Same as attachments (Files & links setting)")
					.addOption("folder", "A specific folder")
					.setValue(s.location)
					.onChange((v) => {
						s.location = v as QuickSketchSettings["location"];
						save();
						this.display();
					})
			);

		if (s.location === "folder") {
			new Setting(containerEl)
				.setName("Folder")
				.setDesc("Created if it doesn't exist.")
				.addText((t) =>
					t
						.setPlaceholder("Drawings")
						.setValue(s.folder)
						.onChange((v) => {
							s.folder = v.trim();
							save();
						})
				);
		}

		new Setting(containerEl)
			.setName("File name")
			.setDesc("A moment.js date format. Put literal text in [brackets].")
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_SETTINGS.fileNameFormat)
					.setValue(s.fileNameFormat)
					.onChange((v) => {
						s.fileNameFormat = v.trim() || DEFAULT_SETTINGS.fileNameFormat;
						save();
					})
			);

		new Setting(containerEl).setName("Defaults").setHeading();

		new Setting(containerEl).setName("Tool").setDesc("The tool selected when a drawing opens.").addDropdown((d) => {
			for (const [tool, name] of Object.entries(TOOL_NAMES)) d.addOption(tool, name);
			d.setValue(s.defaultTool).onChange((v) => {
				s.defaultTool = v as Tool;
				save();
			});
		});

		new Setting(containerEl).setName("Color").addDropdown((d) => {
			for (const [name, hex] of Object.entries(INK)) d.addOption(hex, name[0].toUpperCase() + name.slice(1));
			for (const c of s.customColors) d.addOption(c, c);
			// A default from the older, longer palette stays selectable.
			if (!Object.values<string>(INK).includes(s.defaultColor) && !s.customColors.includes(s.defaultColor)) d.addOption(s.defaultColor, s.defaultColor);
			d.setValue(s.defaultColor).onChange((v) => {
				s.defaultColor = v;
				save();
			});
		});

		new Setting(containerEl).setName("Stroke size").addDropdown((d) => {
			for (const size of STROKE_SIZES) d.addOption(String(size.px), size.label);
			d.setValue(String(s.defaultSize)).onChange((v) => {
				s.defaultSize = Number(v);
				save();
			});
		});

		new Setting(containerEl)
			.setName("Pressure sensitivity")
			.setDesc("Vary the pen's line width with Apple Pencil or stylus pressure.")
			.addToggle((t) =>
				t.setValue(s.pressure).onChange((v) => {
					s.pressure = v;
					save();
				})
			);

		new Setting(containerEl)
			.setName("Shape recognition")
			.setDesc("Hold the pen still at the end of a stroke to snap it to a line, rectangle, ellipse or diamond.")
			.addToggle((t) =>
				t.setValue(s.shapeRecognition).onChange((v) => {
					s.shapeRecognition = v;
					save();
				})
			);

		new Setting(containerEl).setName("Background").setHeading();

		new Setting(containerEl)
			.setName("Paper for new drawings")
			.setDesc("Change it for a single drawing from its ⋯ menu.")
			.addDropdown((d) =>
				d
					.addOption("none", "Plain")
					.addOption("dots", "Dots")
					.addOption("grid", "Grid")
					.addOption("lines", "Lines")
					.setValue(s.defaultPaper)
					.onChange((v) => {
						s.defaultPaper = v as Paper;
						save();
					})
			);

		new Setting(containerEl)
			.setName("Save paper with the drawing")
			.setDesc("Show the dots/grid/lines in embedded drawings and exports too, not only while editing.")
			.addToggle((t) =>
				t.setValue(s.paperInExport).onChange((v) => {
					s.paperInExport = v;
					save();
				})
			);

		new Setting(containerEl).setName("Export").setHeading();

		new Setting(containerEl).setName("Resolution").addDropdown((d) =>
			d
				.addOption("1", "1x")
				.addOption("2", "2x")
				.addOption("3", "3x")
				.setValue(String(s.pngScale))
				.onChange((v) => {
					s.pngScale = Number(v);
					save();
				})
		);

		new Setting(containerEl).setName("PNG/PDF background").addDropdown((d) =>
			d
				.addOption("white", "White")
				.addOption("transparent", "Transparent")
				.setValue(s.pngBackground)
				.onChange((v) => {
					s.pngBackground = v as QuickSketchSettings["pngBackground"];
					save();
				})
		);
	}
}
