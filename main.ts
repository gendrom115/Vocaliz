import { Editor, MarkdownView, moment, normalizePath, Notice, Plugin, TFile, TFolder } from "obsidian";
import { ApiError, rewrite, transcribe } from "./src/api";
import { Mode, SEPARATOR, systemPrompt, userMessage } from "./src/prompts";
import { extensionFor, mimeForExtension, Recorder, RecordingBar } from "./src/recorder";
import { DEFAULT_SETTINGS, Keys, NotesVocalesSettingTab, PendingItem, Settings, vocabularyList } from "./src/settings";

const MODE_LABEL: Record<Mode, string> = { dictee: "Dictée", resume: "Résumé" };

/** En dessous, on considère que c'est un appui accidentel. */
const MIN_SECONDS = 0.8;

interface Session {
	mode: Mode;
	recorder: Recorder;
	bar: RecordingBar;
	targetPath: string;
	state: "recording" | "processing";
}

export default class NotesVocalesPlugin extends Plugin {
	settings!: Settings;
	keys!: Keys;
	private session: Session | null = null;
	private retrying = false;

	async onload() {
		await this.loadSettings();
		this.keys = new Keys(this.app, this);
		this.addSettingTab(new NotesVocalesSettingTab(this.app, this));

		this.addCommand({
			id: "dictee",
			name: "Dictée propre (démarrer / terminer)",
			icon: "mic",
			callback: () => this.toggle("dictee"),
		});
		this.addCommand({
			id: "resume",
			name: "Résumé vocal (démarrer / terminer)",
			icon: "list",
			callback: () => this.toggle("resume"),
		});
		this.addCommand({
			id: "annuler",
			name: "Annuler l'enregistrement en cours",
			icon: "x",
			checkCallback: (checking) => {
				if (this.session?.state !== "recording") return false;
				if (!checking) this.cancel();
				return true;
			},
		});
		this.addCommand({
			id: "traiter-en-attente",
			name: "Traiter les vocaux en attente",
			icon: "refresh-cw",
			callback: () => this.retryPending(),
		});

		this.addRibbonIcon("mic", "Dictée propre", () => this.toggle("dictee"));
		this.addRibbonIcon("list", "Résumé vocal", () => this.toggle("resume"));

		// obsidian://notes-vocales?mode=dictee  (ou mode=resume) — pour le bouton Action / Raccourcis iOS.
		this.registerObsidianProtocolHandler("notes-vocales", (params) => {
			const mode: Mode = params.mode === "resume" ? "resume" : "dictee";
			this.app.workspace.onLayoutReady(() => this.toggle(mode));
		});

		this.app.workspace.onLayoutReady(() => {
			this.forgetMissingPending();
			const n = this.settings.pending.length;
			if (n > 0) {
				new Notice(
					`Notes vocales : ${n} vocal${n > 1 ? "aux" : ""} en attente.\nCommande « Traiter les vocaux en attente ».`,
					8000
				);
			}
		});
	}

	onunload() {
		if (this.session?.state === "recording") this.cancel();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.settings.pending = this.settings.pending ?? [];
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// ─── Enregistrement ─────────────────────────────────────────────────────

	private async toggle(mode: Mode) {
		if (this.session?.state === "recording") return this.finish();
		if (this.session?.state === "processing") {
			new Notice("Un vocal est déjà en cours de traitement, patiente quelques secondes.");
			return;
		}
		await this.start(mode);
	}

	private async start(mode: Mode) {
		if (!this.keys.get("openai") || !this.keys.get("anthropic")) {
			new Notice("Notes vocales : renseigne tes clés OpenAI et Anthropic dans les réglages du plugin.", 8000);
			return;
		}
		// La note ouverte au moment où tu commences à parler. Aucune → note du jour.
		const targetPath = this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? "";

		const recorder = new Recorder();
		try {
			await recorder.start();
		} catch (e) {
			const err = e as Error;
			const denied = err.name === "NotAllowedError" || err.name === "SecurityError";
			new Notice(
				denied
					? "Accès au micro refusé. Autorise le micro pour Obsidian (Réglages iPhone → Obsidian → Micro)."
					: `Impossible de démarrer le micro : ${err.message}`,
				8000
			);
			return;
		}

		const bar = new RecordingBar(
			MODE_LABEL[mode],
			() => this.finish(),
			() => this.cancel()
		);
		this.session = { mode, recorder, bar, targetPath, state: "recording" };
		bar.startTimer(this.settings.maxMinutes * 60, () => {
			new Notice("Durée maximale atteinte, je traite le vocal.");
			this.finish();
		});
	}

	private cancel() {
		const s = this.session;
		if (!s || s.state !== "recording") return;
		s.recorder.cancel();
		s.bar.remove();
		this.session = null;
		new Notice("Enregistrement annulé");
	}

	private async finish() {
		const s = this.session;
		if (!s || s.state !== "recording") return;
		s.state = "processing";
		const seconds = s.bar.elapsedSeconds();
		s.bar.setStatus("Envoi…");

		try {
			const blob = await s.recorder.stop();
			if (seconds < MIN_SECONDS || blob.size < 1000) {
				new Notice("Vocal trop court, rien n'a été inséré.");
				return;
			}
			// L'audio est d'abord écrit dans le coffre : si l'appli est fermée ou le réseau coupe,
			// rien n'est perdu. Il est supprimé dès que le texte est inséré.
			const item = await this.savePending(blob, s.mode, s.targetPath);
			await this.process(item, (status) => s.bar.setStatus(status));
		} catch (e) {
			new Notice(`Notes vocales : ${(e as Error).message}`, 10000);
		} finally {
			s.bar.remove();
			this.session = null;
		}
	}

	private async savePending(blob: Blob, mode: Mode, targetPath: string): Promise<PendingItem> {
		const folder = normalizePath(this.settings.pendingFolder);
		await this.ensureFolder(folder);
		const stamp = moment().format("YYYY-MM-DD HHmmss");
		const ext = extensionFor(blob.type);
		let path = normalizePath(`${folder}/Vocal ${stamp}.${ext}`);
		for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) {
			path = normalizePath(`${folder}/Vocal ${stamp} (${i}).${ext}`);
		}
		await this.app.vault.createBinary(path, await blob.arrayBuffer());
		const item: PendingItem = { audioPath: path, mode, targetPath, createdAt: Date.now(), lastError: "" };
		this.settings.pending.push(item);
		await this.saveSettings();
		return item;
	}

	// ─── Traitement ─────────────────────────────────────────────────────────

	/** Transcrit, met au propre, insère. En cas d'échec, l'audio reste en attente. */
	private async process(item: PendingItem, status: (s: string) => void = () => undefined): Promise<boolean> {
		const file = this.app.vault.getAbstractFileByPath(item.audioPath);
		if (!(file instanceof TFile)) {
			await this.dropPending(item, false);
			return false;
		}
		const vocab = vocabularyList(this.settings.vocabulary);

		try {
			status("Transcription…");
			const transcript = await transcribe({
				apiKey: this.keys.get("openai"),
				model: this.settings.transcriptionModel,
				audio: await this.app.vault.readBinary(file),
				fileName: file.name,
				mimeType: mimeForExtension(file.extension),
				vocabulary: vocab,
			});
			if (!transcript) {
				new Notice("Rien entendu dans ce vocal.");
				await this.dropPending(item, true);
				return true;
			}

			status(item.mode === "resume" ? "Résumé…" : "Mise au propre…");
			const output = await rewrite({
				apiKey: this.keys.get("anthropic"),
				model: this.settings.claudeModel,
				system: systemPrompt(item.mode, this.settings.cleanupLevel, this.settings.summaryFormat, vocab),
				user: userMessage(transcript),
			});
			const text = item.mode === "resume" ? formatSummary(output, transcript) : output || transcript;

			await this.insert(item, text);
			await this.dropPending(item, true);
			return true;
		} catch (e) {
			const msg = (e as Error).message;
			item.lastError = msg;
			await this.saveSettings();
			const hint =
				e instanceof ApiError && !e.retryable
					? "Vérifie la clé dans les réglages, puis lance « Traiter les vocaux en attente »."
					: "Le vocal est gardé : lance « Traiter les vocaux en attente » quand le réseau revient.";
			new Notice(`Notes vocales — échec\n${msg}\n\n${hint}`, 12000);
			return false;
		}
	}

	private async retryPending() {
		if (this.retrying) return;
		this.forgetMissingPending();
		const items = [...this.settings.pending];
		if (items.length === 0) {
			new Notice("Aucun vocal en attente.");
			return;
		}
		this.retrying = true;
		const notice = new Notice(`Traitement de ${items.length} vocal${items.length > 1 ? "aux" : ""}…`, 0);
		let ok = 0;
		try {
			for (const [i, item] of items.entries()) {
				notice.setMessage(`Vocal ${i + 1}/${items.length}…`);
				if (await this.process(item)) ok++;
				else break; // Si ça échoue (réseau…), inutile d'enchaîner les échecs.
			}
		} finally {
			notice.hide();
			this.retrying = false;
		}
		const left = this.settings.pending.length;
		new Notice(left === 0 ? `${ok} vocal${ok > 1 ? "aux" : ""} traité${ok > 1 ? "s" : ""}.` : `${ok} traité(s), ${left} encore en attente.`);
	}

	private async dropPending(item: PendingItem, deleteAudio: boolean) {
		this.settings.pending = this.settings.pending.filter((p) => p.audioPath !== item.audioPath);
		await this.saveSettings();
		if (deleteAudio) {
			const f = this.app.vault.getAbstractFileByPath(item.audioPath);
			if (f instanceof TFile) await this.app.vault.delete(f);
		}
	}

	/** Si tu as supprimé un audio en attente à la main, on l'oublie. */
	private forgetMissingPending() {
		const before = this.settings.pending.length;
		this.settings.pending = this.settings.pending.filter((p) => this.app.vault.getAbstractFileByPath(p.audioPath));
		if (this.settings.pending.length !== before) this.saveSettings();
	}

	// ─── Insertion ──────────────────────────────────────────────────────────

	private async insert(item: PendingItem, text: string) {
		// 1. La note de départ est toujours ouverte → au curseur, comme une dictée.
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (item.targetPath && view?.file?.path === item.targetPath) {
			insertAtCursor(view.editor, text);
			new Notice("Texte inséré", 1500);
			return;
		}
		// 2. Tu as changé de note entre-temps → à la fin de la note de départ.
		const target = item.targetPath ? this.app.vault.getAbstractFileByPath(item.targetPath) : null;
		if (target instanceof TFile) {
			await this.app.vault.process(target, (data) => appendBlock(data, text));
			new Notice(`Texte ajouté à la fin de « ${target.basename} »`, 3000);
			return;
		}
		// 3. Aucune note ouverte au départ → note du jour, sous l'heure du vocal.
		const daily = await this.dailyNote(item.createdAt);
		const heading = `*${moment(item.createdAt).format("HH:mm")}* · ${MODE_LABEL[item.mode].toLowerCase()} vocale`;
		await this.app.vault.process(daily, (data) => appendBlock(data, `${heading}\n${text}`));
		new Notice(`Ajouté à la note du jour (${daily.basename})`, 3000);
	}

	/** Note du jour selon les réglages du module « Notes quotidiennes » d'Obsidian. */
	private async dailyNote(timestamp: number): Promise<TFile> {
		type DailyOpts = { folder?: string; format?: string; template?: string };
		const internal = (this.app as unknown as {
			internalPlugins?: { getPluginById?(id: string): { enabled: boolean; instance?: { options?: DailyOpts } } | null };
		}).internalPlugins;
		const dn = internal?.getPluginById?.("daily-notes");
		const opts: DailyOpts = (dn?.enabled && dn.instance?.options) || {};

		const date = moment(timestamp);
		const name = date.format(opts.format || "YYYY-MM-DD");
		const folder = (opts.folder || "").trim().replace(/\/+$/, "");
		const path = normalizePath(folder ? `${folder}/${name}.md` : `${name}.md`);

		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) return existing;

		const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		if (parent) await this.ensureFolder(parent);

		let content = "";
		if (opts.template) {
			const tpl = this.app.metadataCache.getFirstLinkpathDest(opts.template.replace(/\.md$/, ""), "");
			if (tpl) {
				content = (await this.app.vault.read(tpl))
					.replace(/{{\s*date\s*}}/gi, date.format("YYYY-MM-DD"))
					.replace(/{{\s*time\s*}}/gi, date.format("HH:mm"))
					.replace(/{{\s*title\s*}}/gi, name.split("/").pop() ?? name);
			}
		}
		return this.app.vault.create(path, content);
	}

	private async ensureFolder(path: string) {
		const parts = normalizePath(path).split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const f = this.app.vault.getAbstractFileByPath(current);
			if (!f) await this.app.vault.createFolder(current);
			else if (!(f instanceof TFolder)) throw new Error(`« ${current} » existe déjà et n'est pas un dossier.`);
		}
	}
}

// ─── Fonctions utilitaires ──────────────────────────────────────────────────

/** Résumé + texte complet replié dans un encadré. */
export function formatSummary(output: string, rawTranscript: string): string {
	const idx = output.indexOf(SEPARATOR);
	const summary = (idx >= 0 ? output.slice(0, idx) : output).trim();
	const full = (idx >= 0 ? output.slice(idx + SEPARATOR.length) : rawTranscript).trim() || rawTranscript;
	const quoted = full
		.split("\n")
		.map((l) => (l.trim() ? `> ${l}` : ">"))
		.join("\n");
	return `${summary}\n\n> [!quote]- Texte complet\n${quoted}`;
}

/** Insère au curseur (remplace la sélection s'il y en a une) en gérant les espaces autour. */
export function insertAtCursor(editor: Editor, text: string) {
	const from = editor.getCursor("from");
	const to = editor.getCursor("to");
	const before = editor.getLine(from.line).slice(0, from.ch);
	const after = editor.getLine(to.line).slice(to.ch);
	const multiline = text.includes("\n");

	let prefix = "";
	let suffix = "";
	if (multiline) {
		// Un bloc (paragraphes, liste) commence sur sa propre ligne.
		if (before.trim()) prefix = "\n\n";
		if (after.trim()) suffix = "\n\n";
	} else {
		if (before && !/\s$/.test(before)) prefix = " ";
		if (after && !/^[\s.,;:!?)]/.test(after)) suffix = " ";
	}
	editor.replaceSelection(prefix + text + suffix);
}

export function appendBlock(data: string, block: string): string {
	const trimmed = data.replace(/\s+$/, "");
	return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}
