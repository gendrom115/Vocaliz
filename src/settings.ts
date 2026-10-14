import { AbstractInputSuggest, App, moment, Notice, PluginSettingTab, Setting, TFile } from "obsidian";
import type VocalizPlugin from "../main";
import { testAnthropic, testOpenAI } from "./api";
import type { CleanupLevel, Mode, SummaryFormat } from "./prompts";

export interface PendingItem {
	audioPath: string;
	mode: Mode;
	/** Note où le texte devait aller ; vide = note du jour. */
	targetPath: string;
	createdAt: number;
	lastError: string;
}

/**
 * curseur : au curseur ; sans note ouverte, dans la note du jour (comportement d'origine).
 * curseur-sinon-note : au curseur ; sans note ouverte, dans une nouvelle note.
 * note : toujours dans une nouvelle note créée depuis le modèle.
 */
export type Destination = "curseur" | "curseur-sinon-note" | "note";

/** Modèle utilisé quand aucun fichier modèle n'est choisi. */
export const DEFAULT_NOTE_TEMPLATE = `---
date: {{date}} {{time}}
tags:
  - vocal
---
{{contenu}}
`;

export interface Settings {
	destination: Destination;
	/** Dossier des notes créées. */
	noteFolder: string;
	/** Nom des notes créées, au format moment.js. */
	noteNameFormat: string;
	/** Chemin d'un fichier modèle du coffre ; vide = DEFAULT_NOTE_TEMPLATE. */
	noteTemplate: string;
	/** Ouvrir la note créée. */
	openNewNote: boolean;
	transcriptionModel: string;
	claudeModel: string;
	cleanupLevel: CleanupLevel;
	summaryFormat: SummaryFormat;
	vocabulary: string;
	pendingFolder: string;
	maxMinutes: number;
	/** Clés : seulement si le trousseau d'Obsidian (SecretStorage) n'est pas disponible. */
	openaiKeyFallback: string;
	anthropicKeyFallback: string;
	pending: PendingItem[];
}

export const DEFAULT_SETTINGS: Settings = {
	destination: "curseur",
	noteFolder: "Vocaliz",
	noteNameFormat: "YYYY-MM-DD HHmm [Vocal]",
	noteTemplate: "",
	openNewNote: true,
	transcriptionModel: "gpt-4o-mini-transcribe",
	claudeModel: "claude-haiku-5-5",
	cleanupLevel: "moyen",
	summaryFormat: "points",
	vocabulary: "",
	pendingFolder: "Vocaliz/En attente",
	maxMinutes: 10,
	openaiKeyFallback: "",
	anthropicKeyFallback: "",
	pending: [],
};

const SECRET_IDS = { openai: "vocaliz-openai", anthropic: "vocaliz-anthropic" } as const;
type KeyName = keyof typeof SECRET_IDS;

/**
 * Les clés API vont dans le trousseau d'Obsidian (stocké sur l'appareil, hors du coffre,
 * donc jamais synchronisé ni visible dans les fichiers). Repli sur data.json pour les
 * anciennes versions d'Obsidian.
 */
export class Keys {
	constructor(private app: App, private plugin: VocalizPlugin) {}

	private get store() {
		return (this.app as App & { secretStorage?: App["secretStorage"] }).secretStorage;
	}

	get usesKeychain(): boolean {
		return !!this.store;
	}

	get(name: KeyName): string {
		const fromStore = this.store?.getSecret(SECRET_IDS[name]);
		if (fromStore) return fromStore;
		return name === "openai" ? this.plugin.settings.openaiKeyFallback : this.plugin.settings.anthropicKeyFallback;
	}

	async set(name: KeyName, value: string): Promise<void> {
		value = value.trim();
		if (this.store) {
			this.store.setSecret(SECRET_IDS[name], value);
			// Ne jamais laisser traîner une ancienne copie en clair.
			if (name === "openai") this.plugin.settings.openaiKeyFallback = "";
			else this.plugin.settings.anthropicKeyFallback = "";
		} else if (name === "openai") {
			this.plugin.settings.openaiKeyFallback = value;
		} else {
			this.plugin.settings.anthropicKeyFallback = value;
		}
		await this.plugin.saveSettings();
	}
}

export function vocabularyList(raw: string): string[] {
	return raw
		.split(/[\n,;]/)
		.map((t) => t.trim())
		.filter(Boolean);
}

export class VocalizSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: VocalizPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const keys = this.plugin.keys;
		containerEl.empty();

		new Setting(containerEl).setName("Texte").setHeading();

		new Setting(containerEl)
			.setName("Niveau de nettoyage")
			.setDesc("Moyen : tes mots remis au propre (style Wispr). Fort : réécrit en vrai style écrit, plus concis.")
			.addDropdown((d) =>
				d
					.addOption("moyen", "Moyen")
					.addOption("fort", "Fort")
					.setValue(s.cleanupLevel)
					.onChange(async (v) => {
						s.cleanupLevel = v as CleanupLevel;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Format du résumé")
			.setDesc("Utilisé par le mode Résumé. Le texte complet est toujours ajouté, replié, en dessous.")
			.addDropdown((d) =>
				d
					.addOption("court", "Résumé court (2 à 4 phrases)")
					.addOption("points", "Points clés")
					.addOption("actions", "Actions à faire")
					.setValue(s.summaryFormat)
					.onChange(async (v) => {
						s.summaryFormat = v as SummaryFormat;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Vocabulaire perso")
			.setDesc("Noms, sigles et termes métier à toujours bien orthographier. Un par ligne.")
			.addTextArea((t) => {
				t.setPlaceholder("Ubipharm\nGESCOM\nMorne-à-l'Eau")
					.setValue(s.vocabulary)
					.onChange(async (v) => {
						s.vocabulary = v;
						await this.plugin.saveSettings();
					});
				t.inputEl.rows = 6;
				t.inputEl.addClass("nv-vocab");
			});

		this.destinationSettings(containerEl);

		new Setting(containerEl).setName("Clés API").setHeading();

		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: keys.usesKeychain
				? "Les clés sont rangées dans le trousseau d'Obsidian, sur cet appareil uniquement : elles ne sont pas dans ton coffre et ne se synchronisent pas. Saisis-les une fois sur chaque appareil."
				: "Ta version d'Obsidian n'a pas de trousseau : les clés sont enregistrées dans les réglages du plugin, dans le dossier .obsidian de ton coffre. Mets Obsidian à jour pour plus de sécurité.",
		});

		this.keySetting(containerEl, "openai", "Clé OpenAI", "Pour la transcription. platform.openai.com → API keys.", "sk-…");
		this.keySetting(containerEl, "anthropic", "Clé Anthropic", "Pour la mise au propre par Claude. console.anthropic.com → API keys.", "sk-ant-…");

		new Setting(containerEl)
			.setName("Tester les clés")
			.addButton((b) =>
				b.setButtonText("Tester").onClick(async () => {
					b.setDisabled(true).setButtonText("Test…");
					const results: string[] = [];
					for (const [name, label, fn] of [
						["openai", "OpenAI", testOpenAI],
						["anthropic", "Claude", testAnthropic],
					] as const) {
						const key = keys.get(name);
						if (!key) {
							results.push(`${label} : clé manquante`);
							continue;
						}
						try {
							await fn(key);
							results.push(`${label} : OK`);
						} catch (e) {
							results.push((e as Error).message);
						}
					}
					new Notice(results.join("\n"), 8000);
					b.setDisabled(false).setButtonText("Tester");
				})
			);

		new Setting(containerEl).setName("Avancé").setHeading();

		new Setting(containerEl)
			.setName("Modèle de transcription (OpenAI)")
			.setDesc("gpt-4o-mini-transcribe : rapide et économique. gpt-4o-transcribe : un peu plus précis.")
			.addDropdown((d) =>
				d
					.addOption("gpt-4o-mini-transcribe", "gpt-4o-mini-transcribe")
					.addOption("gpt-4o-transcribe", "gpt-4o-transcribe")
					.addOption("whisper-1", "whisper-1")
					.setValue(s.transcriptionModel)
					.onChange(async (v) => {
						s.transcriptionModel = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Modèle Claude")
			.setDesc("Haiku : le plus rapide. Sonnet : meilleure qualité de réécriture, un peu plus lent.")
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_SETTINGS.claudeModel)
					.setValue(s.claudeModel)
					.onChange(async (v) => {
						s.claudeModel = v.trim() || DEFAULT_SETTINGS.claudeModel;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Durée maximale (minutes)")
			.setDesc("L'enregistrement s'arrête tout seul au-delà.")
			.addSlider((sl) =>
				sl
					.setLimits(1, 20, 1)
					.setValue(s.maxMinutes)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.maxMinutes = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Dossier des vocaux en attente")
			.setDesc("Où l'audio est gardé si le traitement échoue (pas de réseau…). Supprimé après succès.")
			.addText((t) =>
				t.setValue(s.pendingFolder).onChange(async (v) => {
					s.pendingFolder = v.trim().replace(/\/+$/, "") || DEFAULT_SETTINGS.pendingFolder;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).setName("Lancement rapide").setHeading();
		const help = containerEl.createDiv({ cls: "setting-item-description nv-help" });
		help.createEl("p", {
			text: "Pour lancer une dictée sans ouvrir Obsidian à la main (bouton Action, Raccourcis, widget), utilise ces liens :",
		});
		for (const url of ["obsidian://vocaliz?mode=dictee", "obsidian://vocaliz?mode=resume"]) {
			const row = help.createDiv({ cls: "nv-url" });
			row.createEl("code", { text: url });
			const btn = row.createEl("button", { text: "Copier" });
			btn.addEventListener("click", async () => {
				await navigator.clipboard.writeText(url);
				new Notice("Lien copié");
			});
		}
	}

	private destinationSettings(el: HTMLElement) {
		const s = this.plugin.settings;
		new Setting(el).setName("Destination").setHeading();

		new Setting(el)
			.setName("Où va le texte")
			.setDesc("La nouvelle note est créée dès que tu lances l'enregistrement, à partir du modèle ci-dessous, et le texte s'y insère à la fin.")
			.addDropdown((d) =>
				d
					.addOption("curseur", "Au curseur, sinon dans la note du jour")
					.addOption("curseur-sinon-note", "Au curseur, sinon dans une nouvelle note")
					.addOption("note", "Toujours dans une nouvelle note")
					.setValue(s.destination)
					.onChange(async (v) => {
						s.destination = v as Destination;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (s.destination === "curseur") return;

		new Setting(el)
			.setName("Dossier des nouvelles notes")
			.addText((t) =>
				t.setPlaceholder(DEFAULT_SETTINGS.noteFolder).setValue(s.noteFolder).onChange(async (v) => {
					s.noteFolder = v.trim().replace(/\/+$/, "");
					await this.plugin.saveSettings();
				})
			);

		const nameSetting = new Setting(el).setName("Nom des nouvelles notes");
		const preview = () =>
			nameSetting.setDesc(`Format de date moment.js, texte fixe entre crochets. Exemple : ${moment().format(s.noteNameFormat || DEFAULT_SETTINGS.noteNameFormat)}`);
		preview();
		nameSetting.addText((t) =>
			t.setPlaceholder(DEFAULT_SETTINGS.noteNameFormat).setValue(s.noteNameFormat).onChange(async (v) => {
				s.noteNameFormat = v.trim() || DEFAULT_SETTINGS.noteNameFormat;
				preview();
				await this.plugin.saveSettings();
			})
		);

		new Setting(el)
			.setName("Fichier modèle")
			.setDesc(
				"Une note de ton coffre. Variables : {{contenu}} (le texte), {{transcription}} (le texte brut), {{date}}, {{time}}, {{title}}, {{mode}}. Sans {{contenu}}, le texte est ajouté à la fin. Vide : un modèle simple avec la date et le tag #vocal."
			)
			.addSearch((t) => {
				t.setPlaceholder("Modèles/Vocal.md")
					.setValue(s.noteTemplate)
					.onChange(async (v) => {
						s.noteTemplate = v.trim();
						await this.plugin.saveSettings();
					});
				new MarkdownFileSuggest(this.app, t.inputEl, async (path) => {
					t.setValue(path);
					s.noteTemplate = path;
					await this.plugin.saveSettings();
				});
			});

		new Setting(el)
			.setName("Ouvrir la note créée")
			.addToggle((t) =>
				t.setValue(s.openNewNote).onChange(async (v) => {
					s.openNewNote = v;
					await this.plugin.saveSettings();
				})
			);
	}

	private keySetting(el: HTMLElement, name: "openai" | "anthropic", label: string, desc: string, placeholder: string) {
		new Setting(el)
			.setName(label)
			.setDesc(desc)
			.addText((t) => {
				t.inputEl.type = "password";
				t.inputEl.autocomplete = "off";
				t.setPlaceholder(placeholder)
					.setValue(this.plugin.keys.get(name))
					.onChange(async (v) => {
						await this.plugin.keys.set(name, v);
					});
			});
	}
}

/** Propose les notes du coffre pendant la saisie du fichier modèle. */
class MarkdownFileSuggest extends AbstractInputSuggest<TFile> {
	constructor(app: App, private input: HTMLInputElement, private onPick: (path: string) => void) {
		super(app, input);
	}

	getSuggestions(query: string): TFile[] {
		const q = query.toLowerCase();
		return this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.toLowerCase().includes(q))
			.slice(0, 20);
	}

	renderSuggestion(file: TFile, el: HTMLElement): void {
		el.setText(file.path);
	}

	selectSuggestion(file: TFile): void {
		this.onPick(file.path);
		this.close();
	}
}
