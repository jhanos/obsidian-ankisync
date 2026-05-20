import { readdirSync, statSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename, extname } from 'path';
import { SyncClient } from './syncClient';
import { SyncableCollection } from './syncableCollection';
import { MediaSyncClient } from './mediaSyncClient';
import { hasFlashcardsTag, extractFlashcards, convertImagesToHtml } from './flashcardParser';
import { initZstd } from './httpSyncClient';
import { initSql } from './syncableCollection';
import { AnkiSyncSettings } from './settings';
import { SyncActionRequired, SyncResult } from './types';

// ---------------------------------------------------------------------------
// SyncManager
// Orchestrates the full obsidian → anki sync flow.
// Mirrors Python main.py sync_flashcards_to_anki / main.
// ---------------------------------------------------------------------------

export class SyncManager {
	private settings: AnkiSyncSettings;
	private pluginDir: string;

	constructor(settings: AnkiSyncSettings, pluginDir: string) {
		this.settings = settings;
		this.pluginDir = pluginDir;
	}

	get tmpDir(): string {
		return join(this.pluginDir, 'tmp');
	}

	get collectionPath(): string {
		return join(this.tmpDir, 'collection.anki2');
	}

	get mediaDir(): string {
		return join(this.tmpDir, 'collection.media');
	}

	get mediaDbPath(): string {
		return join(this.tmpDir, 'media.db');
	}

	// -------------------------------------------------------------------------
	// Main entry point
	// -------------------------------------------------------------------------

	async sync(vaultDir: string): Promise<SyncResult> {
		let { ankiEndpoint, username, password, flashcardsTag, deckPrefix, deleteRemovedCards, singleLineSeparator, multiLineSeparator, reverseSeparator } = this.settings;

		if (!username || !password) {
			throw new Error('Anki credentials are not configured. Please set username and password in plugin settings.');
		}

		// Normalise endpoint: ensure it has a scheme and trailing slash
		ankiEndpoint = ankiEndpoint.trim();
		if (!ankiEndpoint) {
			throw new Error('Anki server URL is not configured. Please set it in plugin settings.');
		}
		if (!/^https?:\/\//i.test(ankiEndpoint)) {
			ankiEndpoint = 'https://' + ankiEndpoint;
		}
		if (!ankiEndpoint.endsWith('/')) {
			ankiEndpoint += '/';
		}

		// Validate the URL early to give a clear error
		try {
			new URL(ankiEndpoint);
		} catch (e) {
			throw new Error(`Invalid Anki server URL: "${ankiEndpoint}". Example: https://ankiweb.thonis.fr/`);
		}

		// --- Step 1: initialise zstd + sql.js WASM from plugin dir ---
		const wasmPath = join(this.pluginDir, 'zstd.wasm');
		const sqlWasmPath = join(this.pluginDir, 'sql-wasm.wasm');
		await initZstd(wasmPath);
		await initSql(sqlWasmPath);

		// --- Step 2: login ---
		const auth = await SyncClient.login(username, password, ankiEndpoint);

		// --- Step 3: ensure tmp dir exists ---
		mkdirSync(this.tmpDir, { recursive: true });
		mkdirSync(this.mediaDir, { recursive: true });

		// --- Step 4: open or download collection ---
		const syncClient = new SyncClient(auth);
		let col: SyncableCollection | null = null;

		if (!existsSync(this.collectionPath)) {
			// First run — no local collection yet
			const tmpCol = await SyncableCollection.createEmpty(this.collectionPath, this.mediaDir);
			await syncClient.fullDownload(tmpCol);
			col = await SyncableCollection.open(this.collectionPath, this.mediaDir);
		} else {
			// Subsequent run — check if server has changed since our last sync
			const tmpCol = await SyncableCollection.open(this.collectionPath, this.mediaDir);
			const localMeta = tmpCol.syncMeta();
			const serverMeta = await syncClient.fetchServerMeta();
			console.log(`[ankisync] local usn=${localMeta.usn} scm=${localMeta.scm} | server usn=${serverMeta.usn} scm=${serverMeta.scm}`);

			if (localMeta.scm !== serverMeta.scm) {
				console.log('[ankisync] schema mismatch: full download required');
				tmpCol.close();
				const freshCol = await SyncableCollection.createEmpty(this.collectionPath, this.mediaDir);
				await syncClient.fullDownload(freshCol);
				col = await SyncableCollection.open(this.collectionPath, this.mediaDir);
			} else if (serverMeta.usn !== localMeta.usn) {
				console.log(`[ankisync] server ahead (usn ${localMeta.usn} → ${serverMeta.usn}): downloading latest...`);
				tmpCol.close();
				const freshCol = await SyncableCollection.createEmpty(this.collectionPath, this.mediaDir);
				await syncClient.fullDownload(freshCol);
				col = await SyncableCollection.open(this.collectionPath, this.mediaDir);
			} else {
				console.log('[ankisync] local collection up to date, skipping download');
				col = tmpCol;
			}
		}

		// --- Step 4: find all flashcard files ---
		const mdFiles = this.findFlashcardFiles(vaultDir, flashcardsTag);

		// --- Step 5: parse all flashcards and gather media ---
		const cardsByFile = new Map<string, { front: string; back: string; reverse: boolean }[]>();
		const allMedia: Array<{ ref: string; absolutePath: string }> = [];

		for (const filePath of mdFiles) {
			const content = readFileSync(filePath, 'utf8');
			const rawCards = extractFlashcards(content, filePath, vaultDir, singleLineSeparator, multiLineSeparator, reverseSeparator);

			const processedCards: { front: string; back: string; reverse: boolean }[] = [];
			for (const card of rawCards) {
				// Convert image references to <img> HTML and collect media
				const front = convertImagesToHtml(card.front, filePath, vaultDir, allMedia);
				const back = convertImagesToHtml(card.back, filePath, vaultDir, allMedia);
				processedCards.push({ front, back, reverse: card.reverse });
			}
			if (processedCards.length > 0) {
				cardsByFile.set(filePath, processedCards);
			}
		}

		// --- Step 6: copy media files into collection.media ---
		for (const { ref, absolutePath } of allMedia) {
			try {
				col.addMedia(absolutePath, basename(ref));
			} catch (err) {
				console.warn(`obsidian-ankisync: could not add media ${ref}:`, err);
			}
		}

		// --- Step 7: diff and apply changes ---
		const result: SyncResult = { added: 0, updated: 0, deleted: 0 };

		try {
			const notetypeId = col.getOrCreateBasicNotetype();
			const reverseNotetypeId = col.getOrCreateBasicReversedNotetype();

			// Track which deck names are managed by this plugin (for delete logic)
			const managedDeckNames = new Set<string>();

			for (const [filePath, cards] of cardsByFile) {
				const stem = basename(filePath, extname(filePath));
				const deckName = `${deckPrefix}${stem}`;
				managedDeckNames.add(deckName);

				const deckId = col.createDeck(deckName);
				const existingNotes = col.getNotesInDeck(deckId, deckName);

				// Build lookup: front → noteId for existing notes.
				// If multiple notes share the same front in this deck (stale duplicates
				// from previous broken syncs), delete the older ones via graves so the
				// server cleans up on next sync.
				const existingByFront = new Map<string, { id: number; back: string; mid: number }>();
				for (const [id, note] of existingNotes) {
					const prev = existingByFront.get(note.front);
					if (prev) {
						// Keep the newer note (higher id), delete the older one with graves
						const olderId = prev.id < id ? prev.id : id;
						const keepId  = prev.id < id ? id : prev.id;
						console.warn(`[ankisync] deduplicating front "${note.front}" in deck "${deckName}" — deleting note ${olderId}, keeping ${keepId}`);
						col.deleteNote(olderId);
						const keeper = existingNotes.get(keepId)!;
						existingByFront.set(note.front, { id: keepId, back: keeper.back, mid: keeper.mid });
					} else {
						existingByFront.set(note.front, { id, back: note.back, mid: note.mid });
					}
				}

				// Track which fronts are in the vault (to detect deletions)
				const vaultFronts = new Set<string>();

				for (const { front, back, reverse } of cards) {
					vaultFronts.add(front);
					const existing = existingByFront.get(front);
					const targetMid = reverse ? reverseNotetypeId : notetypeId;
					if (!existing) {
						// New card — use reversed notetype if flagged
						col.addNote(front, back, deckId, targetMid, reverse);
						result.added++;
					} else if (existing.back !== back || existing.mid !== targetMid) {
						// Content or notetype changed
						col.updateNote(existing.id, front, back, deckId, targetMid, reverse);
						result.updated++;
					}
					// else: unchanged — nothing to do
				}

				// Deletions: notes in Anki not present in vault
				if (deleteRemovedCards) {
					for (const [front, { id }] of existingByFront) {
						if (!vaultFronts.has(front)) {
							col.deleteNote(id);
							result.deleted++;
						}
					}
				}
			}

			// --- Step 8: sync with server ---
			let action = await syncClient.sync(col);
			console.log(`[ankisync] sync action = ${action}`);

			if (action === SyncActionRequired.FULL_SYNC) {
				// Schema mismatch — the server's collection has a different schema than ours.
				// Re-download the server's collection, re-apply vault changes on top, then
				// sync again. This preserves the server's schema (e.g. AnkiDroid v1 format).
				console.log('[ankisync] FULL_SYNC required: re-downloading server collection...');
				col.close();
				const freshCol = await SyncableCollection.createEmpty(this.collectionPath, this.mediaDir);
				await syncClient.fullDownload(freshCol);
				col = await SyncableCollection.open(this.collectionPath, this.mediaDir);

				// Re-apply vault changes on the freshly downloaded collection
				const notetypeId2 = col.getOrCreateBasicNotetype();
				const reverseNotetypeId2 = col.getOrCreateBasicReversedNotetype();
				for (const [filePath, cards] of cardsByFile) {
					const stem = basename(filePath, extname(filePath));
					const deckName = `${deckPrefix}${stem}`;
					const deckId = col.createDeck(deckName);
					const existingNotes = col.getNotesInDeck(deckId, deckName);
					const existingByFront2 = new Map<string, { id: number; back: string; mid: number }>();
					for (const [id, note] of existingNotes) {
						const prev = existingByFront2.get(note.front);
						if (prev) {
							const olderId = prev.id < id ? prev.id : id;
							const keepId  = prev.id < id ? id : prev.id;
							col.deleteNote(olderId);
							const keeper = existingNotes.get(keepId)!;
							existingByFront2.set(note.front, { id: keepId, back: keeper.back, mid: keeper.mid });
						} else {
							existingByFront2.set(note.front, { id, back: note.back, mid: note.mid });
						}
					}
					const vaultFronts = new Set<string>();
					for (const { front, back, reverse } of cards) {
						vaultFronts.add(front);
						const existing = existingByFront2.get(front);
						const targetMid = reverse ? reverseNotetypeId2 : notetypeId2;
						if (!existing) {
							col.addNote(front, back, deckId, targetMid, reverse);
							result.added++;
						} else if (existing.back !== back || existing.mid !== targetMid) {
							col.updateNote(existing.id, front, back, deckId, targetMid, reverse);
							result.updated++;
						}
					}
					if (deleteRemovedCards) {
						for (const [front, { id }] of existingByFront2) {
							if (!vaultFronts.has(front)) {
								col.deleteNote(id);
								result.deleted++;
							}
						}
					}
				}

				// Now do a normal sync — schema matches so it should be NORMAL_SYNC
				action = await syncClient.sync(col);
			}

			// --- Step 9: media sync (if any media was added) ---
			if (allMedia.length > 0 || action !== SyncActionRequired.NO_CHANGES) {
				const mediaClient = new MediaSyncClient(auth, this.mediaDir, this.mediaDbPath);
				try {
					await mediaClient.open();
					const mediaResult = await mediaClient.sync();
					if (mediaResult.downloaded > 0 || mediaResult.uploaded > 0 || mediaResult.deleted > 0) {
						console.log(`[ankisync] media sync: downloaded=${mediaResult.downloaded} uploaded=${mediaResult.uploaded} deleted=${mediaResult.deleted}`);
					}
				} catch (err) {
					console.warn('obsidian-ankisync: media sync failed:', err);
				} finally {
					mediaClient.close();
				}
			}
		} finally {
			col.close();
		}

		return result;
	}

	// -------------------------------------------------------------------------
	// Find flashcard files
	// -------------------------------------------------------------------------

	/** Recursively find all .md files in vaultDir that have the flashcards tag. */
	private findFlashcardFiles(vaultDir: string, tag: string): string[] {
		const files: string[] = [];
		this.walkDir(vaultDir, files, tag);
		return files;
	}

	private walkDir(dir: string, results: string[], tag: string): void {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.startsWith('.') || entry === 'node_modules') continue;
			const full = join(dir, entry);
			try {
				const stat = statSync(full);
				if (stat.isDirectory()) {
					this.walkDir(full, results, tag);
				} else if (entry.endsWith('.md')) {
					const content = readFileSync(full, 'utf8');
					if (hasFlashcardsTag(content, tag)) {
						results.push(full);
					}
				}
			} catch {
				// skip unreadable entries
			}
		}
	}
}
