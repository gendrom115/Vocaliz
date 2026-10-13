/** Formats essayés dans l'ordre : mp4/AAC pour l'iPhone, webm/Opus pour ordinateur et Android. */
const MIME_CANDIDATES = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];

export function extensionFor(mime: string): string {
	if (mime.startsWith("audio/mp4")) return "m4a";
	if (mime.startsWith("audio/ogg")) return "ogg";
	return "webm";
}

export function mimeForExtension(ext: string): string {
	switch (ext) {
		case "m4a":
		case "mp4":
			return "audio/mp4";
		case "ogg":
			return "audio/ogg";
		case "wav":
			return "audio/wav";
		case "mp3":
			return "audio/mpeg";
		default:
			return "audio/webm";
	}
}

export class Recorder {
	private stream: MediaStream | null = null;
	private media: MediaRecorder | null = null;
	private chunks: Blob[] = [];
	private wakeLock: { release(): Promise<void> } | null = null;
	mimeType = "";

	async start(): Promise<void> {
		this.stream = await navigator.mediaDevices.getUserMedia({
			audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
		});
		const supported = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
		this.media = new MediaRecorder(this.stream, supported ? { mimeType: supported } : undefined);
		this.mimeType = this.media.mimeType || supported || "audio/webm";
		this.chunks = [];
		this.media.ondataavailable = (e) => {
			if (e.data && e.data.size > 0) this.chunks.push(e.data);
		};
		// Tranches d'une seconde : si l'appli est coupée, on ne perd pas tout.
		this.media.start(1000);
		await this.keepScreenOn();
	}

	/** Arrête et renvoie l'audio enregistré. */
	stop(): Promise<Blob> {
		return new Promise((resolve) => {
			const media = this.media;
			if (!media || media.state === "inactive") {
				resolve(new Blob(this.chunks, { type: this.mimeType }));
				this.cleanup();
				return;
			}
			media.onstop = () => {
				resolve(new Blob(this.chunks, { type: this.mimeType }));
				this.cleanup();
			};
			media.stop();
		});
	}

	cancel(): void {
		if (this.media && this.media.state !== "inactive") {
			this.media.onstop = null;
			this.media.stop();
		}
		this.chunks = [];
		this.cleanup();
	}

	private cleanup(): void {
		this.stream?.getTracks().forEach((t) => t.stop());
		this.stream = null;
		this.media = null;
		this.wakeLock?.release().catch(() => undefined);
		this.wakeLock = null;
	}

	/** Empêche l'iPhone de se verrouiller pendant la dictée (sinon l'enregistrement s'arrête). */
	private async keepScreenOn(): Promise<void> {
		try {
			const nav = navigator as Navigator & {
				wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> };
			};
			if (nav.wakeLock) this.wakeLock = await nav.wakeLock.request("screen");
		} catch {
			// Non supporté sur cet appareil : pas bloquant.
		}
	}
}

/** Petite barre flottante affichée pendant l'enregistrement puis le traitement. */
export class RecordingBar {
	private el: HTMLElement;
	private labelEl: HTMLElement;
	private timerEl: HTMLElement;
	private actionsEl: HTMLElement;
	private interval: number | null = null;
	private startedAt = 0;

	constructor(label: string, onStop: () => void, onCancel: () => void) {
		this.el = document.body.createDiv({ cls: "nv-bar is-recording" });
		this.el.createDiv({ cls: "nv-dot" });
		this.labelEl = this.el.createSpan({ cls: "nv-label", text: label });
		this.timerEl = this.el.createSpan({ cls: "nv-timer", text: "0:00" });
		this.actionsEl = this.el.createDiv({ cls: "nv-actions" });

		const stopBtn = this.actionsEl.createEl("button", { cls: "nv-stop mod-cta", text: "Terminer" });
		stopBtn.addEventListener("click", (e) => {
			e.preventDefault();
			onStop();
		});
		const cancelBtn = this.actionsEl.createEl("button", { cls: "nv-cancel", text: "✕" });
		cancelBtn.setAttr("aria-label", "Annuler");
		cancelBtn.addEventListener("click", (e) => {
			e.preventDefault();
			onCancel();
		});
	}

	startTimer(maxSeconds: number, onMax: () => void): void {
		this.startedAt = Date.now();
		this.interval = window.setInterval(() => {
			const s = Math.floor((Date.now() - this.startedAt) / 1000);
			this.timerEl.setText(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
			if (s >= maxSeconds) onMax();
		}, 250);
	}

	elapsedSeconds(): number {
		return this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0;
	}

	/** Passe en mode « traitement » : plus de boutons, juste un message. */
	setStatus(text: string): void {
		this.stopTimer();
		this.el.removeClass("is-recording");
		this.el.addClass("is-working");
		this.actionsEl.empty();
		this.timerEl.setText("");
		this.labelEl.setText(text);
	}

	remove(): void {
		this.stopTimer();
		this.el.remove();
	}

	private stopTimer(): void {
		if (this.interval !== null) window.clearInterval(this.interval);
		this.interval = null;
	}
}
