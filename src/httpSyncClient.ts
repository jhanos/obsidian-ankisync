import * as https from 'https';
import * as http from 'http';
import * as zlib from 'zlib';
import { readFileSync } from 'fs';
import { compress, decompress, ZstdModule, waitInitialized, initZstdWasm } from './zstd-shim';
import {
	SyncAuth,
	SyncMeta,
	Graves,
	Chunk,
	UnchunkedChanges,
	SanityCheckCounts,
	SYNC_VERSION,
} from './types';

// ---------------------------------------------------------------------------
// zstd init — reads wasm bytes from the plugin directory at runtime,
// then passes them directly to Module.init(), bypassing the broken
// new URL('./zstd.wasm', import.meta.url) call in the web build.
// ---------------------------------------------------------------------------

let zstdReady: Promise<void> | null = null;

export function initZstd(wasmPath: string): Promise<void> {
	if (!zstdReady) {
		zstdReady = (async () => {
			const buf = readFileSync(wasmPath);
			await initZstdWasm(buf);
		})().catch((e: unknown) => {
			console.error('[ankisync] zstdInit FAILED:', e);
			zstdReady = null;
			throw e;
		});
	}
	return zstdReady;
}

function ensureZstd(): Promise<void> {
	if (!zstdReady) throw new Error('zstd WASM not initialised — call initZstd(wasmPath) first');
	return zstdReady;
}

export class SyncRedirectError extends Error {
	constructor(public newEndpoint: string) {
		super(`Sync redirect to ${newEndpoint}`);
	}
}

export class SyncError extends Error {}

// ---------------------------------------------------------------------------
// HttpSyncClient
// Handles all low-level HTTP communication with the Anki sync server.
// Ported from ankiclientsync/client.py HttpSyncClient.
// ---------------------------------------------------------------------------

export class HttpSyncClient {
	private auth: SyncAuth;
	private sessionKey: string;

	constructor(auth: SyncAuth) {
		this.auth = auth;
		this.sessionKey = randomSessionKey();
	}

	// -------------------------------------------------------------------------
	// /sync/ endpoints
	// -------------------------------------------------------------------------

	/** POST /sync/hostKey — login, returns hkey */
	async hostKey(username: string, password: string): Promise<string> {
		const resp = await this.postSync('hostKey', { u: username, p: password });
		const data = JSON.parse(resp.toString('utf8')) as { key: string };
		return data.key;
	}

	/** POST /sync/meta — fetch server metadata */
	async meta(): Promise<SyncMeta> {
		const resp = await this.postSync('meta', { v: SYNC_VERSION, cv: 'anki,ts-sync-client,1.0' });
		const d = JSON.parse(resp.toString('utf8')) as Record<string, unknown>;
		return {
			mod: (d['mod'] as number) ?? 0,
			scm: (d['scm'] as number) ?? 0,
			usn: (d['usn'] as number) ?? 0,
			ts: (d['ts'] as number) ?? 0,
			msg: (d['msg'] as string) ?? '',
			cont: (d['cont'] as boolean) ?? true,
			hostNum: (d['hostNum'] as number) ?? 0,
			empty: (d['empty'] as boolean) ?? false,
			mediaUsn: (d['media_usn'] as number) ?? 0,
		};
	}

	/** POST /sync/start — begin normal sync, receive remote graves */
	async start(minUsn: number, lnewer: boolean): Promise<Graves> {
		const resp = await this.postSync('start', { minUsn, lnewer });
		const d = JSON.parse(resp.toString('utf8')) as Record<string, unknown>;
		return {
			cards: (d['cards'] as number[]) ?? [],
			notes: (d['notes'] as number[]) ?? [],
			decks: (d['decks'] as number[]) ?? [],
		};
	}

	/** POST /sync/applyGraves — send local deletions */
	async applyGraves(chunk: Graves): Promise<void> {
		await this.postSync('applyGraves', { chunk });
	}

	/** POST /sync/applyChanges — exchange unchunked changes */
	async applyChanges(changes: UnchunkedChanges): Promise<UnchunkedChanges> {
		const payload = unchunkedChangesToWire(changes);
		const resp = await this.postSync('applyChanges', { changes: payload });
		const d = JSON.parse(resp.toString('utf8')) as Record<string, unknown>;
		return unchunkedChangesFromWire(d);
	}

	/** POST /sync/chunk — receive one chunk of server data */
	async chunk(): Promise<Chunk> {
		const resp = await this.postSync('chunk', {});
		const d = JSON.parse(resp.toString('utf8')) as Record<string, unknown>;
		return {
			done: (d['done'] as boolean) ?? false,
			notes: (d['notes'] as unknown[]) as Chunk['notes'] ?? [],
			cards: (d['cards'] as unknown[]) as Chunk['cards'] ?? [],
			revlog: (d['revlog'] as unknown[]) as Chunk['revlog'] ?? [],
		};
	}

	/** POST /sync/applyChunk — send one chunk of local data */
	async applyChunk(chunk: Chunk): Promise<void> {
		await this.postSync('applyChunk', { chunk: chunkToWire(chunk) });
	}

	/** POST /sync/sanityCheck2 — verify counts match */
	async sanityCheck(counts: SanityCheckCounts): Promise<boolean> {
		const client = sanityCountsToWire(counts);
		const resp = await this.postSync('sanityCheck2', { client });
		const d = JSON.parse(resp.toString('utf8')) as Record<string, unknown>;
		if (d['status'] !== 'ok') {
			throw new SyncError(`Sanity check failed: ${JSON.stringify(d)}`);
		}
		return true;
	}

	/** POST /sync/finish — finalise sync, returns new mod timestamp */
	async finish(): Promise<number> {
		const resp = await this.postSync('finish', {});
		const val = JSON.parse(resp.toString('utf8')) as number;
		return val;
	}

	/** POST /sync/abort — abort an in-progress sync (errors swallowed) */
	async abort(): Promise<void> {
		try {
			await this.postSync('abort', {});
		} catch {
			// intentionally swallowed
		}
	}

	/** POST /sync/upload — full collection upload */
	async upload(data: Buffer): Promise<void> {
		const resp = await this.postRaw('sync', 'upload', data);
		const text = resp.toString('utf8').trim();
		if (text !== 'OK') {
			throw new SyncError(`Upload failed: ${text}`);
		}
	}

	/** POST /sync/download — full collection download */
	async download(): Promise<Buffer> {
		return this.postSync('download', {});
	}

	// -------------------------------------------------------------------------
	// /msync/ endpoints
	// -------------------------------------------------------------------------

	/** POST /msync/begin — start media sync, returns server media USN */
	async mediaBegin(): Promise<number> {
		const resp = await this.postMsync('begin', { v: 'anki,ts-sync-client,1.0' });
		const d = JSON.parse(resp.toString('utf8')) as { data: { usn: number }; err: string };
		if (d.err) throw new SyncError(`Media begin error: ${d.err}`);
		return d.data.usn;
	}

	/** POST /msync/mediaChanges — get server media changes since lastUsn */
	async mediaChanges(lastUsn: number): Promise<Array<[string, number, string]>> {
		const resp = await this.postMsync('mediaChanges', { lastUsn });
		const d = JSON.parse(resp.toString('utf8')) as {
			data: Array<[string, number, string]>;
			err: string;
		};
		if (d.err) throw new SyncError(`Media changes error: ${d.err}`);
		return d.data;
	}

	/** POST /msync/downloadFiles — download media files as ZIP bytes */
	async downloadFiles(files: string[]): Promise<Buffer> {
		return this.postMsync('downloadFiles', { files });
	}

	/** POST /msync/uploadChanges — upload media ZIP, returns [processed, newUsn] */
	async uploadChanges(zipData: Buffer): Promise<[number, number]> {
		const resp = await this.postRaw('msync', 'uploadChanges', zipData);
		const d = JSON.parse(resp.toString('utf8')) as { data: [number, number]; err: string };
		if (d.err) throw new SyncError(`Media upload error: ${d.err}`);
		return d.data;
	}

	/** POST /msync/mediaSanity — verify media count */
	async mediaSanity(localCount: number): Promise<boolean> {
		const resp = await this.postMsync('mediaSanity', { local: localCount });
		const d = JSON.parse(resp.toString('utf8')) as { data: string; err: string };
		if (d.err) throw new SyncError(`Media sanity error: ${d.err}`);
		return d.data === 'OK';
	}

	// -------------------------------------------------------------------------
	// Low-level HTTP helpers
	// -------------------------------------------------------------------------

	private async postSync(method: string, body: unknown): Promise<Buffer> {
		return this.postJson('sync', method, body);
	}

	private async postMsync(method: string, body: unknown): Promise<Buffer> {
		return this.postJson('msync', method, body);
	}

	private async postJson(prefix: string, method: string, body: unknown): Promise<Buffer> {
		const jsonBytes = Buffer.from(JSON.stringify(body), 'utf8');
		return this.postRaw(prefix, method, jsonBytes);
	}

	private async postRaw(prefix: string, method: string, body: Buffer): Promise<Buffer> {
		await ensureZstd();
		const compressed = Buffer.from(compress(new Uint8Array(body)));
		const endpoint = this.auth.endpoint.replace(/\/$/, '');
		if (!endpoint || !/^https?:\/\//i.test(endpoint)) {
			throw new SyncError(`Invalid endpoint URL: "${endpoint}". Ensure the Anki server URL starts with https:// or http://`);
		}
		let url: URL;
		try {
			url = new URL(`${endpoint}/${prefix}/${method}`);
		} catch (e) {
			throw new SyncError(`Failed to construct URL from endpoint="${endpoint}" prefix="${prefix}" method="${method}": ${e}`);
		}

		const headers: Record<string, string> = {
			'Content-Type': 'application/octet-stream',
			'Content-Length': String(compressed.length),
			'anki-sync': JSON.stringify({
				v: SYNC_VERSION,
				k: this.auth.hkey,
				c: 'anki,ts-sync-client,1.0',
				s: this.sessionKey,
			}),
		};

		const raw = await doRequest(url, headers, compressed, this.auth.ioTimeoutSecs * 1000);
		return decompressResponse(raw.body, raw.headers);
	}
}

// ---------------------------------------------------------------------------
// Decompression (mirrors Python _decompress_response)
// ---------------------------------------------------------------------------

async function decompressResponse(
	body: Buffer,
	headers: Record<string, string>,
): Promise<Buffer> {
	const origSize = headers['anki-original-size'];
	const encoding = headers['content-encoding'];

	if (origSize) {
		return Buffer.from(decompress(new Uint8Array(body)));
	} else if (encoding === 'zstd') {
		return Buffer.from(decompress(new Uint8Array(body)));
	} else if (encoding === 'gzip') {
		return await gunzip(body);
	}
	return body;
}

function gunzip(buf: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		zlib.gunzip(buf, (err, result) => {
			if (err) reject(err);
			else resolve(result);
		});
	});
}

// ---------------------------------------------------------------------------
// Raw HTTP request
// ---------------------------------------------------------------------------

interface RawResponse {
	statusCode: number;
	headers: Record<string, string>;
	body: Buffer;
}

function doRequest(
	url: URL,
	headers: Record<string, string>,
	body: Buffer,
	timeoutMs: number,
): Promise<RawResponse> {
	return new Promise((resolve, reject) => {
		const isHttps = url.protocol === 'https:';
		const lib = isHttps ? https : http;

		const options: https.RequestOptions = {
			hostname: url.hostname,
			port: url.port || (isHttps ? 443 : 80),
			path: url.pathname + url.search,
			method: 'POST',
			headers,
			timeout: timeoutMs,
		};

		const req = lib.request(options, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (chunk: Buffer) => chunks.push(chunk));
			res.on('end', () => {
				const responseBody = Buffer.concat(chunks);
				const statusCode = res.statusCode ?? 0;

				// Handle 308 redirect
				if (statusCode === 308) {
					const location = res.headers['location'];
					if (location) {
						reject(new SyncRedirectError(location));
						return;
					}
				}

				if (statusCode < 200 || statusCode >= 300) {
					reject(new SyncError(`HTTP ${statusCode}: ${responseBody.toString('utf8').slice(0, 200)}`));
					return;
				}

				const respHeaders: Record<string, string> = {};
				for (const [k, v] of Object.entries(res.headers)) {
					if (typeof v === 'string') respHeaders[k.toLowerCase()] = v;
					else if (Array.isArray(v)) respHeaders[k.toLowerCase()] = v[0];
				}

				resolve({ statusCode, headers: respHeaders, body: responseBody });
			});
			res.on('error', reject);
		});

		req.on('error', reject);
		req.on('timeout', () => {
			req.destroy();
			reject(new SyncError('Request timed out'));
		});

		req.write(body);
		req.end();
	});
}

// ---------------------------------------------------------------------------
// Wire format helpers
// ---------------------------------------------------------------------------

function unchunkedChangesToWire(c: UnchunkedChanges): Record<string, unknown> {
	const wire: Record<string, unknown> = {
		models: c.notetypes,
		decks: c.decks,
		tags: c.tags,
	};
	if (c.config) wire['conf'] = c.config;
	if (c.creationStamp != null) wire['crt'] = c.creationStamp;
	return wire;
}

function unchunkedChangesFromWire(d: Record<string, unknown>): UnchunkedChanges {
	return {
		notetypes: (d['models'] as UnchunkedChanges['notetypes']) ?? [],
		decks: (d['decks'] as UnchunkedChanges['decks']) ?? [[], []],
		tags: (d['tags'] as string[]) ?? [],
		config: (d['conf'] as Record<string, unknown>) ?? null,
		creationStamp: (d['crt'] as number) ?? null,
	};
}

function chunkToWire(c: Chunk): Record<string, unknown> {
	return {
		done: c.done,
		notes: c.notes,
		cards: c.cards,
		revlog: c.revlog,
	};
}

function sanityCountsToWire(c: SanityCheckCounts): unknown[] {
	return [
		[0, 0, 0],
		c.cards,
		c.notes,
		c.revlog,
		c.graves,
		c.notetypes,
		c.decks,
		c.deckConfig,
	];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomSessionKey(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let key = '';
	for (let i = 0; i < 8; i++) {
		key += chars[Math.floor(Math.random() * chars.length)];
	}
	return key;
}
