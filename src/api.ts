import { requestUrl, RequestUrlResponse } from "obsidian";

/** Erreur réseau ou serveur : l'audio est gardé pour être relancé plus tard. */
export class ApiError extends Error {
	constructor(message: string, readonly retryable: boolean) {
		super(message);
	}
}

function errorDetail(res: RequestUrlResponse): string {
	try {
		const body = res.json;
		return body?.error?.message ?? res.text.slice(0, 200);
	} catch {
		return res.text?.slice(0, 200) ?? "";
	}
}

function checkStatus(res: RequestUrlResponse, service: string): void {
	if (res.status < 400) return;
	const detail = errorDetail(res);
	if (res.status === 401 || res.status === 403) {
		throw new ApiError(`${service} : clé API refusée (${detail})`, false);
	}
	// 408, 429 (quota/débit), 5xx (panne) : ça vaut la peine de réessayer plus tard.
	const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
	throw new ApiError(`${service} : erreur ${res.status} (${detail})`, retryable);
}

async function send(params: Parameters<typeof requestUrl>[0] & object, service: string): Promise<RequestUrlResponse> {
	let res: RequestUrlResponse;
	try {
		res = await requestUrl({ ...params, throw: false });
	} catch (e) {
		// Pas de réseau, DNS, coupure : toujours relançable.
		throw new ApiError(`${service} : réseau indisponible (${(e as Error).message})`, true);
	}
	checkStatus(res, service);
	return res;
}

/** Corps multipart/form-data construit à la main (requestUrl n'accepte pas FormData). */
function multipart(fields: Record<string, string>, file: { name: string; type: string; data: ArrayBuffer }) {
	const boundary = "----vocaliz" + Math.random().toString(16).slice(2);
	const enc = new TextEncoder();
	const parts: Uint8Array[] = [];
	for (const [key, value] of Object.entries(fields)) {
		parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
	}
	parts.push(
		enc.encode(
			`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`
		)
	);
	parts.push(new Uint8Array(file.data));
	parts.push(enc.encode(`\r\n--${boundary}--\r\n`));

	const total = parts.reduce((n, p) => n + p.length, 0);
	const body = new Uint8Array(total);
	let offset = 0;
	for (const p of parts) {
		body.set(p, offset);
		offset += p.length;
	}
	return { body: body.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}

export async function transcribe(opts: {
	apiKey: string;
	model: string;
	audio: ArrayBuffer;
	fileName: string;
	mimeType: string;
	vocabulary: string[];
}): Promise<string> {
	const fields: Record<string, string> = {
		model: opts.model,
		language: "fr",
		response_format: "json",
	};
	if (opts.vocabulary.length > 0) {
		fields.prompt = `Vocabulaire : ${opts.vocabulary.join(", ")}.`;
	}
	const { body, contentType } = multipart(fields, {
		name: opts.fileName,
		type: opts.mimeType.split(";")[0],
		data: opts.audio,
	});
	const res = await send(
		{
			url: "https://api.openai.com/v1/audio/transcriptions",
			method: "POST",
			headers: { Authorization: `Bearer ${opts.apiKey}` },
			contentType,
			body,
		},
		"OpenAI"
	);
	return String(res.json?.text ?? "").trim();
}

export async function rewrite(opts: {
	apiKey: string;
	model: string;
	system: string;
	user: string;
}): Promise<string> {
	const res = await send(
		{
			url: "https://api.anthropic.com/v1/messages",
			method: "POST",
			headers: {
				"x-api-key": opts.apiKey,
				"anthropic-version": "2023-06-01",
			},
			contentType: "application/json",
			body: JSON.stringify({
				model: opts.model,
				max_tokens: 4096,
				system: opts.system,
				messages: [{ role: "user", content: opts.user }],
			}),
		},
		"Claude"
	);
	const blocks: { type: string; text?: string }[] = res.json?.content ?? [];
	return blocks
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("")
		.trim();
}

export async function testOpenAI(apiKey: string): Promise<void> {
	await send(
		{ url: "https://api.openai.com/v1/models", method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
		"OpenAI"
	);
}

export async function testAnthropic(apiKey: string): Promise<void> {
	await send(
		{
			url: "https://api.anthropic.com/v1/models",
			method: "GET",
			headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
		},
		"Claude"
	);
}
