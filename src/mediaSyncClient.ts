import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, basename } from 'path';
import JSZip from 'jszip';
import { HttpSyncClient } from './httpSyncClient';
import { SyncAuth, MediaAction, MediaChange, MAX_MEDIA_FILES_PER_ZIP, MEDIA_SYNC_TARGET_ZIP_BYTES } from './types';

// sql.js singleton
let SQL: SqlJsStatic | null = null;
async function getSql(): Promise<SqlJsStatic> {
	if (!SQL) SQL = await initSqlJs();
	return SQL;
}

// ---------------------------------------------------------------------------
// MediaSyncClient
// Manages media.db and syncs media files via /msync/ endpoints.
// Ported from ankiclientsync/client.py MediaSyncClient.
// ---------------------------------------------------------------------------

export class MediaSyncClient {
	private auth: SyncAuth;
	private http: HttpSyncClient;
	private mediaDir: string;
	private mediaDbPath: string;
	private db: Database | null = null;

	constructor(auth: SyncAuth, mediaDir: string, mediaDbPath: string) {
		this.auth = auth;
		this.http = new HttpSyncClient(auth);
		this.mediaDir = mediaDir;
		this.mediaDbPath = mediaDbPath;
	}

	// -------------------------------------------------------------------------
	// Lifecycle
	// -------------------------------------------------------------------------

	async open(): Promise<void> {
		const sql = await getSql();
		if (existsSync(this.mediaDbPath)) {
			const data = readFileSync(this.mediaDbPath);
			this.db = new sql.Database(data);
		} else {
			this.db = new sql.Database();
			this.db.run(`
				CREATE TABLE IF NOT EXISTS media (
					fname TEXT NOT NULL PRIMARY KEY,
					csum  TEXT,
					mtime INTEGER NOT NULL,
					dirty INTEGER NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_media_dirty ON media (dirty) WHERE dirty = 1;
				CREATE TABLE IF NOT EXISTS meta (
					dirMod  INTEGER,
					lastUsn INTEGER
				);
				INSERT OR IGNORE INTO meta (dirMod, lastUsn) VALUES (0, 0);
			`);
		}
	}

	private flush(): void {
		if (!this.db) return;
		const data = this.db.export();
		writeFileSync(this.mediaDbPath, Buffer.from(data));
	}

	close(): void {
		this.flush();
		this.db?.close();
		this.db = null;
	}

	// -------------------------------------------------------------------------
	// Local change detection
	// -------------------------------------------------------------------------

	/** Scan mediaDir and mark new/modified/deleted files as dirty. */
	registerLocalChanges(): void {
		if (!this.db) throw new Error('MediaSyncClient not opened');

		// Build set of files currently on disk
		const onDisk = new Map<string, { mtime: number; csum: string }>();
		if (existsSync(this.mediaDir)) {
			for (const fname of readdirSync(this.mediaDir)) {
				const full = join(this.mediaDir, fname);
				try {
					const stat = statSync(full);
					if (!stat.isFile()) continue;
					const data = readFileSync(full);
					const csum = sha1(data);
					onDisk.set(fname, { mtime: Math.floor(stat.mtimeMs / 1000), csum });
				} catch {
					// skip unreadable files
				}
			}
		}

		// Get currently tracked files
		const tracked = new Map<string, { csum: string | null; mtime: number; dirty: number }>();
		const rows = this.db.exec('SELECT fname, csum, mtime, dirty FROM media');
		if (rows.length) {
			for (const [fname, csum, mtime, dirty] of rows[0].values as [string, string | null, number, number][]) {
				tracked.set(fname, { csum, mtime, dirty });
			}
		}

		// Check for new or modified files
		for (const [fname, { mtime, csum }] of onDisk) {
			const t = tracked.get(fname);
			if (!t || t.csum !== csum) {
				this.db.run(
					'INSERT OR REPLACE INTO media (fname, csum, mtime, dirty) VALUES (?, ?, ?, 1)',
					[fname, csum, mtime],
				);
			}
		}

		// Check for deleted files
		for (const [fname, t] of tracked) {
			if (!onDisk.has(fname) && t.csum !== null) {
				// Mark as deleted (csum=NULL)
				this.db.run(
					'UPDATE media SET csum = NULL, mtime = 0, dirty = 1 WHERE fname = ?',
					[fname],
				);
			}
		}
	}

	private getLastUsn(): number {
		if (!this.db) return 0;
		const r = this.db.exec('SELECT lastUsn FROM meta');
		if (!r.length || !r[0].values.length) return 0;
		return r[0].values[0][0] as number;
	}

	private setLastUsn(usn: number): void {
		this.db!.run('UPDATE meta SET lastUsn = ?', [usn]);
	}

	// -------------------------------------------------------------------------
	// Main sync
	// -------------------------------------------------------------------------

	/**
	 * Full media sync cycle:
	 *   1. begin session
	 *   2. apply server changes (download new/modified files, track deletions)
	 *   3. upload local changes
	 *   4. sanity check
	 */
	async sync(): Promise<{ downloaded: number; uploaded: number; deleted: number }> {
		if (!this.db) await this.open();
		this.registerLocalChanges();

		let downloaded = 0;
		let uploaded = 0;
		let deleted = 0;

		const serverUsn = await this.http.mediaBegin();
		const lastUsn = this.getLastUsn();

		// --- Step 2: apply server changes ---
		let cursor = lastUsn;
		while (true) {
			const changes = await this.http.mediaChanges(cursor);
			if (!changes.length) break;

			const toDownload: string[] = [];
			for (const [fname, usn, sha1hex] of changes) {
				if (sha1hex === '') {
					// Server deletion
					this.db!.run(
						'INSERT OR REPLACE INTO media (fname, csum, mtime, dirty) VALUES (?, NULL, 0, 0)',
						[fname],
					);
					deleted++;
				} else {
					toDownload.push(fname);
				}
				cursor = Math.max(cursor, usn);
			}

			// Download files in batches
			for (let i = 0; i < toDownload.length; i += MAX_MEDIA_FILES_PER_ZIP) {
				const batch = toDownload.slice(i, i + MAX_MEDIA_FILES_PER_ZIP);
				const zipData = await this.http.downloadFiles(batch);
				const extracted = await this.extractMediaZip(zipData);
				for (const { fname, data } of extracted) {
					const dest = join(this.mediaDir, fname);
					writeFileSync(dest, data);
					const csum = sha1(data);
					const mtime = Math.floor(statSync(dest).mtimeMs / 1000);
					this.db!.run(
						'INSERT OR REPLACE INTO media (fname, csum, mtime, dirty) VALUES (?, ?, ?, 0)',
						[fname, csum, mtime],
					);
					downloaded++;
				}
			}

			if (changes.length < 1000) break;
		}

		this.setLastUsn(cursor || serverUsn);

		// --- Step 3: upload local dirty files ---
		const dirtyRows = this.db!.exec('SELECT fname, csum FROM media WHERE dirty = 1');
		if (dirtyRows.length && dirtyRows[0].values.length) {
			const dirty = dirtyRows[0].values as [string, string | null][];
			for (let i = 0; i < dirty.length; i += MAX_MEDIA_FILES_PER_ZIP) {
				const batch = dirty.slice(i, i + MAX_MEDIA_FILES_PER_ZIP);
				const zipData = await this.buildUploadZip(batch);
				const [processed, newUsn] = await this.http.uploadChanges(zipData);
				uploaded += processed;
				this.setLastUsn(newUsn);

				// Mark uploaded files as clean
				for (const [fname] of batch) {
					this.db!.run('UPDATE media SET dirty = 0 WHERE fname = ?', [fname]);
				}
			}
		}

		// --- Step 4: sanity check ---
		const localCount = this.countLocalMedia();
		const ok = await this.http.mediaSanity(localCount);
		if (!ok) {
			console.warn('obsidian-ankisync: media sanity check failed, resync may be needed');
		}

		this.flush();
		return { downloaded, uploaded, deleted };
	}

	private countLocalMedia(): number {
		if (!this.db) return 0;
		const r = this.db.exec('SELECT COUNT(*) FROM media WHERE csum IS NOT NULL');
		if (!r.length) return 0;
		return r[0].values[0][0] as number;
	}

	// -------------------------------------------------------------------------
	// ZIP helpers
	// -------------------------------------------------------------------------

	private async extractMediaZip(
		zipData: Buffer,
	): Promise<Array<{ fname: string; data: Buffer }>> {
		const zip = await JSZip.loadAsync(zipData);
		// _meta maps index string → filename
		const metaFile = zip.file('_meta');
		if (!metaFile) return [];
		const metaStr = await metaFile.async('string');
		const meta = JSON.parse(metaStr) as Record<string, string>;

		const results: Array<{ fname: string; data: Buffer }> = [];
		for (const [idx, fname] of Object.entries(meta)) {
			const file = zip.file(idx);
			if (!file) continue;
			const data = Buffer.from(await file.async('arraybuffer'));
			results.push({ fname, data });
		}
		return results;
	}

	private async buildUploadZip(
		files: Array<[string, string | null]>,
	): Promise<Buffer> {
		const zip = new JSZip();
		// _meta: array of [fname, index_string_or_null]
		const meta: Array<[string, string | null]> = [];
		let idx = 0;

		for (const [fname, csum] of files) {
			if (csum === null) {
				// Deletion
				meta.push([fname, null]);
			} else {
				const fullPath = join(this.mediaDir, fname);
				if (existsSync(fullPath)) {
					const data = readFileSync(fullPath);
					const idxStr = String(idx++);
					zip.file(idxStr, data);
					meta.push([fname, idxStr]);
				}
			}
		}

		zip.file('_meta', JSON.stringify(meta));
		const content = await zip.generateAsync({ type: 'nodebuffer' });
		return content;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha1(data: Buffer): string {
	return createHash('sha1').update(data).digest('hex');
}
