import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import {
	SyncMeta,
	Graves,
	Chunk,
	UnchunkedChanges,
	SanityCheckCounts,
	NoteTypeDef,
	DeckDef,
	DeckConfigDef,
	FieldDef,
	TemplateDef,
	NoteRow,
	CardRow,
	RevlogRow,
	CHUNK_SIZE,
} from './types';
import {
	parseProtobufFields,
	getStringField,
	getVarintField,
	getBytesField,
	encodeDeckCommon,
	encodeDeckKindNormal,
	decodeNotetypeConfigCss,
	decodeFieldConfig,
	decodeTemplateConfig,
	decodeDeckKindIsFiltered,
	decodeDeckKindConfigId,
} from './protobuf';

// sql.js is loaded once and cached
let SQL: SqlJsStatic | null = null;

export async function initSql(wasmPath: string): Promise<void> {
	if (!SQL) {
		const buf = readFileSync(wasmPath);
		SQL = await initSqlJs({ wasmBinary: buf.buffer as ArrayBuffer });
	}
}

async function getSql(): Promise<SqlJsStatic> {
	if (!SQL) throw new Error('sql.js not initialised — call initSql(wasmPath) first');
	return SQL;
}

/** Return the already-initialised sql.js instance. Throws if initSql() has not been called. */
export async function getSqlInstance(): Promise<SqlJsStatic> {
	return getSql();
}

/**
 * sql.js does not support custom collations. Anki's collection uses `unicase`
 * (case-insensitive Unicode) in its schema DDL. We patch the raw SQLite bytes
 * replacing every occurrence of the ASCII string "unicase" with "NOCASE "
 * (same length — 7 bytes) so sql.js can open the file without errors.
 * This is safe because SQLite stores the schema as plain text in page 1 and
 * the collation name in index definitions; NOCASE is functionally equivalent
 * for our read/write use of the collection.
 */
function patchUnicase(data: Buffer): Buffer {
	const src = Buffer.from('unicase');
	const dst = Buffer.from('NOCASE '); // same length: 7 bytes
	let buf = Buffer.from(data); // copy
	let idx = 0;
	while ((idx = buf.indexOf(src, idx)) !== -1) {
		dst.copy(buf, idx);
		idx += dst.length;
	}
	return buf;
}

/**
 * Reverse the unicase patch: replace 'NOCASE ' back with 'unicase' so the
 * on-disk file retains the original Anki-compatible collation name.
 * Called before writing exported bytes to disk.
 */
function unpatchUnicase(data: Buffer): Buffer {
	const src = Buffer.from('NOCASE ');
	const dst = Buffer.from('unicase'); // same length: 7 bytes
	let buf = Buffer.from(data); // copy
	let idx = 0;
	while ((idx = buf.indexOf(src, idx)) !== -1) {
		dst.copy(buf, idx);
		idx += dst.length;
	}
	return buf;
}

function crc32(str: string): number {
	let crc = 0xffffffff;
	for (let i = 0; i < str.length; i++) {
		crc ^= str.charCodeAt(i);
		for (let j = 0; j < 8; j++) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/** Generate a 10-character alphanumeric GUID for a note. */
function generateGuid(): string {
	const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
	let g = '';
	for (let i = 0; i < 10; i++) g += chars[Math.floor(Math.random() * chars.length)];
	return g;
}

function nowSecs(): number {
	return Math.floor(Date.now() / 1000);
}

function nowMs(): number {
	return Date.now();
}

// Monotonically-increasing ID for notes/cards — prevents UNIQUE collisions
// when multiple rows are inserted within the same millisecond.
let _lastId = 0;
function nextId(): number {
	const t = Date.now();
	_lastId = t > _lastId ? t : _lastId + 1;
	return _lastId;
}

// ---------------------------------------------------------------------------
// SyncableCollection
// Wraps a collection.anki2 SQLite database via sql.js.
// Ported from ankiclientsync/collection.py SyncableCollection.
// ---------------------------------------------------------------------------

export class SyncableCollection {
	private db: Database;
	private dbPath: string;
	private mediaDir: string;

	private constructor(db: Database, dbPath: string, mediaDir: string) {
		this.db = db;
		this.dbPath = dbPath;
		this.mediaDir = mediaDir;
	}

	/** Open an existing collection.anki2 file. */
	static async open(dbPath: string, mediaDir: string): Promise<SyncableCollection> {
		const sql = await getSql();
		const raw = readFileSync(dbPath);
		const data = patchUnicase(raw);
		const db = new sql.Database(data);
		return new SyncableCollection(db, dbPath, mediaDir);
	}

	/** Create a minimal empty collection (used for first-time setup). */
	static async createEmpty(dbPath: string, mediaDir: string): Promise<SyncableCollection> {
		const sql = await getSql();
		const db = new sql.Database();

		db.run(`
			CREATE TABLE col (
				id INTEGER PRIMARY KEY,
				crt INTEGER NOT NULL,
				mod INTEGER NOT NULL,
				scm INTEGER NOT NULL,
				ver INTEGER NOT NULL,
				dty INTEGER NOT NULL,
				usn INTEGER NOT NULL,
				ls  INTEGER NOT NULL,
				conf TEXT NOT NULL,
				models TEXT NOT NULL,
				decks TEXT NOT NULL,
				dconf TEXT NOT NULL,
				tags TEXT NOT NULL
			);
			INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags)
			VALUES (1, ${nowSecs()}, 0, ${nowMs()}, 18, 0, 0, 0, '{}', '{}', '{}', '{}', '{}');

			CREATE TABLE notes (
				id INTEGER PRIMARY KEY,
				guid TEXT NOT NULL,
				mid INTEGER NOT NULL,
				mod INTEGER NOT NULL,
				usn INTEGER NOT NULL,
				tags TEXT NOT NULL,
				flds TEXT NOT NULL,
				sfld TEXT NOT NULL,
				csum INTEGER NOT NULL,
				flags INTEGER NOT NULL,
				data TEXT NOT NULL
			);

			CREATE TABLE cards (
				id INTEGER PRIMARY KEY,
				nid INTEGER NOT NULL,
				did INTEGER NOT NULL,
				ord INTEGER NOT NULL,
				mod INTEGER NOT NULL,
				usn INTEGER NOT NULL,
				type INTEGER NOT NULL,
				queue INTEGER NOT NULL,
				due INTEGER NOT NULL,
				ivl INTEGER NOT NULL,
				factor INTEGER NOT NULL,
				reps INTEGER NOT NULL,
				lapses INTEGER NOT NULL,
				left INTEGER NOT NULL,
				odue INTEGER NOT NULL,
				odid INTEGER NOT NULL,
				flags INTEGER NOT NULL,
				data TEXT NOT NULL
			);

			CREATE TABLE revlog (
				id INTEGER PRIMARY KEY,
				cid INTEGER NOT NULL,
				usn INTEGER NOT NULL,
				ease INTEGER NOT NULL,
				ivl INTEGER NOT NULL,
				lastIvl INTEGER NOT NULL,
				factor INTEGER NOT NULL,
				time INTEGER NOT NULL,
				type INTEGER NOT NULL
			);

			CREATE TABLE graves (
				usn INTEGER NOT NULL,
				oid INTEGER NOT NULL,
				type INTEGER NOT NULL
			);

			CREATE TABLE notetypes (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				mtime_secs INTEGER NOT NULL,
				usn INTEGER NOT NULL,
				config BLOB NOT NULL
			);

			CREATE TABLE fields (
				ntid INTEGER NOT NULL,
				ord  INTEGER NOT NULL,
				name TEXT NOT NULL,
				config BLOB NOT NULL,
				PRIMARY KEY (ntid, ord)
			);

			CREATE TABLE templates (
				ntid INTEGER NOT NULL,
				ord  INTEGER NOT NULL,
				name TEXT NOT NULL,
				mtime_secs INTEGER NOT NULL,
				usn INTEGER NOT NULL,
				config BLOB NOT NULL,
				PRIMARY KEY (ntid, ord)
			);

			CREATE TABLE decks (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				mtime_secs INTEGER NOT NULL,
				usn INTEGER NOT NULL,
				common BLOB NOT NULL,
				kind BLOB NOT NULL
			);

			CREATE TABLE deck_config (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				mtime_secs INTEGER NOT NULL,
				usn INTEGER NOT NULL,
				config BLOB NOT NULL
			);

			CREATE TABLE tags (
				tag TEXT PRIMARY KEY,
				usn INTEGER NOT NULL
			);
		`);

		// Create default deck (id=1)
		const col = new SyncableCollection(db, dbPath, mediaDir);
		col.ensureDefaultDeck();
		col.ensureDefaultDeckConfig();
		col.ensureBasicNotetype();
		col.flush();
		return col;
	}

	// -------------------------------------------------------------------------
	// Persistence
	// -------------------------------------------------------------------------

	/** Write the in-memory database back to disk. */
	flush(): void {
		const exported = Buffer.from(this.db.export());
		const data = unpatchUnicase(exported);
		try {
			writeFileSync(this.dbPath, data);
		} catch (err) {
			console.error('[ankisync] flush() writeFileSync FAILED:', err);
			throw err;
		}
	}

	/** Close and free the in-memory database. */
	close(): void {
		this.db.close();
	}

	// -------------------------------------------------------------------------
	// Sync metadata
	// -------------------------------------------------------------------------

	syncMeta(): SyncMeta {
		const row = this.db.exec('SELECT mod, scm, usn FROM col WHERE id = 1')[0];
		const [mod, scm, usn] = row.values[0] as [number, number, number];
		return {
			mod,
			scm,
			usn,
			ts: nowSecs(),
			msg: '',
			cont: true,
			hostNum: 0,
			empty: this.isCollectionEmpty(),
			mediaUsn: 0,
		};
	}

	private isCollectionEmpty(): boolean {
		const r = this.db.exec('SELECT COUNT(*) FROM notes')[0];
		return (r.values[0][0] as number) === 0;
	}

	// -------------------------------------------------------------------------
	// Transactions
	// -------------------------------------------------------------------------

	beginTransaction(): void {
		this.db.run('BEGIN IMMEDIATE');
	}

	commitTransaction(): void {
		this.db.run('COMMIT');
		this.flush();
	}

	rollbackTransaction(): void {
		try {
			this.db.run('ROLLBACK');
		} catch {
			// already rolled back
		}
	}

	// -------------------------------------------------------------------------
	// Schema modification (force full sync next time)
	// -------------------------------------------------------------------------

	setSchemaModified(): void {
		this.db.run('UPDATE col SET scm = ? WHERE id = 1', [nowMs()]);
		this.flush();
	}

	// -------------------------------------------------------------------------
	// Graves
	// -------------------------------------------------------------------------

	getPendingGraves(pendingUsn: number): Graves {
		const rows = this.db.exec(`SELECT oid, type FROM graves WHERE usn = ${pendingUsn}`);
		const graves: Graves = { cards: [], notes: [], decks: [] };
		if (!rows.length) return graves;
		for (const [oid, type] of rows[0].values as [number, number][]) {
			if (type === 0) graves.cards.push(oid);
			else if (type === 1) graves.notes.push(oid);
			else if (type === 2) graves.decks.push(oid);
		}
		return graves;
	}

	updatePendingGraveUsns(serverUsn: number): void {
		this.db.run('UPDATE graves SET usn = ? WHERE usn = -1', [serverUsn]);
	}

	applyGraves(graves: Graves, serverUsn: number): void {
		for (const id of graves.cards) {
			this.db.run('DELETE FROM cards WHERE id = ?', [id]);
		}
		for (const id of graves.notes) {
			this.db.run('DELETE FROM notes WHERE id = ?', [id]);
			this.db.run('DELETE FROM cards WHERE nid = ?', [id]);
		}
		for (const id of graves.decks) {
			this.db.run('DELETE FROM decks WHERE id = ?', [id]);
		}
	}

	/** Insert a grave record (for locally deleted notes). */
	insertGrave(oid: number, type: number): void {
		// type: 0=card, 1=note, 2=deck
		this.db.run('INSERT INTO graves (usn, oid, type) VALUES (-1, ?, ?)', [oid, type]);
	}

	// -------------------------------------------------------------------------
	// Unchunked changes
	// -------------------------------------------------------------------------

	getLocalUnchunkedChanges(
		pendingUsn: number,
		serverUsn: number,
		_localIsNewer: boolean,
	): UnchunkedChanges {
		const notetypes = this.getLocalNotetypes(pendingUsn, serverUsn);
		const decks = this.getLocalDecks(pendingUsn, serverUsn);
		const deckConfigs = this.getLocalDeckConfigs(pendingUsn, serverUsn);
		const tags = this.getLocalTags(pendingUsn, serverUsn);

		const confRow = this.db.exec('SELECT conf, crt FROM col WHERE id = 1')[0];
		const [confStr, crt] = confRow.values[0] as [string, number];
		let config: Record<string, unknown> | null = null;
		if (confStr) {
			try {
				const parsed = JSON.parse(confStr) as Record<string, unknown>;
				// Only send config if it has actual keys — sending an empty {}
				// overwrites the server's scheduler config (schedVer etc.) with
				// nothing, which triggers Anki's v3 scheduler upgrade prompt.
				if (Object.keys(parsed).length > 0) {
					config = parsed;
				}
			} catch {
				// unparseable conf — send null so server keeps its own config
			}
		}

		return {
			notetypes,
			decks: [decks, deckConfigs],
			tags,
			config,
			creationStamp: crt,
		};
	}

	private getLocalNotetypes(pendingUsn: number, serverUsn: number): NoteTypeDef[] {
		const rows = this.db.exec(
			`SELECT id, name, mtime_secs, usn, config FROM notetypes WHERE usn = ${pendingUsn}`,
		);
		if (!rows.length) return [];
		const defs: NoteTypeDef[] = [];
		for (const [id, name, mtime, , configBlob] of rows[0].values as [number, string, number, number, Uint8Array | null][]) {
			this.db.run('UPDATE notetypes SET usn = ? WHERE id = ?', [serverUsn, id]);
			const css = configBlob ? decodeNotetypeConfigCss(configBlob) : '';
			const flds = this.getFieldsForNotetype(id as number);
			const tmpls = this.getTemplatesForNotetype(id as number);
			defs.push({ id: id as number, name: name as string, mod: mtime as number, usn: serverUsn, css, type: 0, flds, tmpls });
		}
		return defs;
	}

	private getFieldsForNotetype(ntid: number): FieldDef[] {
		const rows = this.db.exec(
			`SELECT name, ord, config FROM fields WHERE ntid = ${ntid} ORDER BY ord`,
		);
		if (!rows.length) return [];
		return (rows[0].values as [string, number, Uint8Array | null][]).map(([name, ord, configBlob]) => {
			const cfg = configBlob ? decodeFieldConfig(configBlob) : { font: 'Arial', size: 20 };
			return { name, ord, font: cfg.font, size: cfg.size };
		});
	}

	private getTemplatesForNotetype(ntid: number): TemplateDef[] {
		const rows = this.db.exec(
			`SELECT name, ord, config FROM templates WHERE ntid = ${ntid} ORDER BY ord`,
		);
		if (!rows.length) return [];
		return (rows[0].values as [string, number, Uint8Array | null][]).map(([name, ord, configBlob]) => {
			const cfg = configBlob ? decodeTemplateConfig(configBlob) : { qfmt: '{{Front}}', afmt: '{{Back}}' };
			return { name, ord, qfmt: cfg.qfmt, afmt: cfg.afmt };
		});
	}

	private getLocalDecks(pendingUsn: number, serverUsn: number): DeckDef[] {
		const rows = this.db.exec(
			`SELECT id, name, mtime_secs, usn, common, kind FROM decks WHERE usn = ${pendingUsn}`,
		);
		if (!rows.length) return [];
		const defs: DeckDef[] = [];
		for (const [id, name, mtime, , commonBlob, kindBlob] of rows[0].values as [number, string, number, number, Uint8Array | null, Uint8Array | null][]) {
			this.db.run('UPDATE decks SET usn = ? WHERE id = ?', [serverUsn, id]);
			let collapsed = false;
			if (commonBlob) {
				const f = parseProtobufFields(commonBlob);
				collapsed = getVarintField(f, 1) !== 0n;
			}
			let confId = 1;
			const dyn = kindBlob ? (decodeDeckKindIsFiltered(kindBlob) ? 1 : 0) : 0;
			if (kindBlob && !decodeDeckKindIsFiltered(kindBlob)) {
				confId = decodeDeckKindConfigId(kindBlob);
			}
			defs.push({
				id: id as number,
				name: name as string,
				mod: mtime as number,
				usn: serverUsn,
				conf: confId,
				dyn,
				desc: '',
				collapsed,
				browserCollapsed: collapsed,
				newToday: [0, 0],
				revToday: [0, 0],
				lrnToday: [0, 0],
				timeToday: [0, 0],
				extendNew: 0,
				extendRev: 0,
			});
		}
		return defs;
	}

	private getLocalDeckConfigs(pendingUsn: number, serverUsn: number): DeckConfigDef[] {
		const rows = this.db.exec(
			`SELECT id, name, mtime_secs, usn FROM deck_config WHERE usn = ${pendingUsn}`,
		);
		if (!rows.length) return [];
		const defs: DeckConfigDef[] = [];
		for (const [id, name, mtime] of rows[0].values as [number, string, number][]) {
			this.db.run('UPDATE deck_config SET usn = ? WHERE id = ?', [serverUsn, id]);
			defs.push({
				id: id as number,
				name: name as string,
				mod: mtime as number,
				usn: serverUsn,
				new: { perDay: 20 },
				rev: { perDay: 200 },
				lapse: {},
				dyn: false,
			});
		}
		return defs;
	}

	private getLocalTags(pendingUsn: number, serverUsn: number): string[] {
		const rows = this.db.exec(
			`SELECT tag FROM tags WHERE usn = ${pendingUsn}`,
		);
		if (!rows.length) return [];
		const tags = (rows[0].values as [string][]).map(([t]) => t);
		this.db.run(`UPDATE tags SET usn = ${serverUsn} WHERE usn = ${pendingUsn}`);
		return tags;
	}

	applyUnchunkedChanges(changes: UnchunkedChanges, serverUsn: number): void {
		for (const nt of changes.notetypes) {
			this.applyNotetype(nt, serverUsn);
		}
		const [decks, deckConfigs] = changes.decks ?? [[], []];
		for (const d of (decks ?? [])) {
			this.applyDeck(d, serverUsn);
		}
		for (const dc of (deckConfigs ?? [])) {
			this.applyDeckConfig(dc, serverUsn);
		}
		for (const tag of changes.tags) {
			this.db.run(
				'INSERT OR REPLACE INTO tags (tag, usn) VALUES (?, ?)',
				[tag, serverUsn],
			);
		}
		if (changes.config) {
			this.db.run('UPDATE col SET conf = ? WHERE id = 1', [JSON.stringify(changes.config)]);
		}
		if (changes.creationStamp != null) {
			this.db.run('UPDATE col SET crt = ? WHERE id = 1', [changes.creationStamp]);
		}
	}

	private applyNotetype(nt: NoteTypeDef, serverUsn: number): void {
		this.db.run(
			'INSERT OR REPLACE INTO notetypes (id, name, mtime_secs, usn, config) VALUES (?, ?, ?, ?, NULL)',
			[nt.id, nt.name, nt.mod, serverUsn],
		);
		this.db.run('DELETE FROM fields WHERE ntid = ?', [nt.id]);
		this.db.run('DELETE FROM templates WHERE ntid = ?', [nt.id]);
		for (const f of nt.flds) {
			this.db.run(
				'INSERT INTO fields (ntid, ord, name, config) VALUES (?, ?, ?, X\'\')',
				[nt.id, f.ord, f.name],
			);
		}
		for (const t of nt.tmpls) {
			this.db.run(
				'INSERT INTO templates (ntid, ord, name, mtime_secs, usn, config) VALUES (?, ?, ?, ?, ?, X\'\')',
				[nt.id, t.ord, t.name, nt.mod, serverUsn],
			);
		}
	}

	private applyDeck(d: DeckDef, serverUsn: number): void {
		const common = Buffer.from(encodeDeckCommon(d.collapsed, d.browserCollapsed));
		const kind = d.dyn ? Buffer.from([0x12, 0x00]) : Buffer.from(encodeDeckKindNormal(BigInt(d.conf)));
		this.db.run(
			'INSERT OR REPLACE INTO decks (id, name, mtime_secs, usn, common, kind) VALUES (?, ?, ?, ?, ?, ?)',
			[d.id, d.name, d.mod, serverUsn, common, kind],
		);
	}

	private applyDeckConfig(dc: DeckConfigDef, serverUsn: number): void {
		this.db.run(
			'INSERT OR REPLACE INTO deck_config (id, name, mtime_secs, usn, config) VALUES (?, ?, ?, ?, NULL)',
			[dc.id, dc.name, dc.mod, serverUsn],
		);
	}

	// -------------------------------------------------------------------------
	// Chunked changes
	// -------------------------------------------------------------------------

	getChunkableIds(pendingUsn: number): { notes: number[]; cards: number[]; revlog: number[] } {
		const noteRows = this.db.exec(`SELECT id FROM notes WHERE usn = ${pendingUsn}`);
		const cardRows = this.db.exec(`SELECT id FROM cards WHERE usn = ${pendingUsn}`);
		const revlogRows = this.db.exec(`SELECT id FROM revlog WHERE usn = ${pendingUsn}`);
		return {
			notes: noteRows.length ? (noteRows[0].values as [number][]).map(([id]) => id) : [],
			cards: cardRows.length ? (cardRows[0].values as [number][]).map(([id]) => id) : [],
			revlog: revlogRows.length ? (revlogRows[0].values as [number][]).map(([id]) => id) : [],
		};
	}

	getChunk(
		ids: { notes: number[]; cards: number[]; revlog: number[] },
		serverUsn: number,
	): Chunk {
		const noteIds = ids.notes.splice(0, CHUNK_SIZE);
		const cardIds = ids.cards.splice(0, CHUNK_SIZE);
		const revlogIds = ids.revlog.splice(0, CHUNK_SIZE);

		const done = ids.notes.length === 0 && ids.cards.length === 0 && ids.revlog.length === 0;

		const notes: NoteRow[] = noteIds.map(id => this.getNoteForSync(id, serverUsn));
		const cards: CardRow[] = cardIds.map(id => this.getCardForSync(id, serverUsn));
		const revlog: RevlogRow[] = revlogIds.map(id => this.getRevlogForSync(id, serverUsn));

		return { done, notes, cards, revlog };
	}

	private getNoteForSync(id: number, serverUsn: number): NoteRow {
		const r = this.db.exec(
			'SELECT id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data FROM notes WHERE id = ?',
			[id],
		)[0].values[0] as unknown[];
		this.db.run('UPDATE notes SET usn = ? WHERE id = ?', [serverUsn, id]);
		// Wire format: sfld and csum are sent as empty strings
		return [r[0], r[1], r[2], r[3], serverUsn, r[5], r[6], '', '', r[9], r[10]] as NoteRow;
	}

	private getCardForSync(id: number, serverUsn: number): CardRow {
		const r = this.db.exec(
			'SELECT id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data FROM cards WHERE id = ?',
			[id],
		)[0].values[0] as unknown[];
		this.db.run('UPDATE cards SET usn = ? WHERE id = ?', [serverUsn, id]);
		return [r[0], r[1], r[2], r[3], r[4], serverUsn, r[6], r[7], r[8], r[9], r[10], r[11], r[12], r[13], r[14], r[15], r[16], r[17]] as CardRow;
	}

	private getRevlogForSync(id: number, serverUsn: number): RevlogRow {
		const r = this.db.exec(
			'SELECT id, cid, usn, ease, ivl, lastIvl, factor, time, type FROM revlog WHERE id = ?',
			[id],
		)[0].values[0] as unknown[];
		this.db.run('UPDATE revlog SET usn = ? WHERE id = ?', [serverUsn, id]);
		return [r[0], r[1], serverUsn, r[3], r[4], r[5], r[6], r[7], r[8]] as RevlogRow;
	}

	applyChunk(chunk: Chunk, _pendingUsn: number): void {
		for (const n of chunk.notes) {
			this.applyNote(n);
		}
		for (const c of chunk.cards) {
			this.applyCard(c);
		}
		for (const r of chunk.revlog) {
			this.applyRevlog(r);
		}
	}

	private applyNote(n: NoteRow): void {
		const [id, guid, mid, mod, usn, tags, flds, , , flags, data] = n;
		const sfld = (flds as string).split('\x1f')[0] ?? '';
		const csum = crc32(sfld) & 0xffffffff;
		this.db.run(
			'INSERT OR REPLACE INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
			[id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data],
		);
	}

	private applyCard(c: CardRow): void {
		this.db.run(
			'INSERT OR REPLACE INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
			[...c],
		);
	}

	private applyRevlog(r: RevlogRow): void {
		this.db.run(
			'INSERT OR REPLACE INTO revlog (id, cid, usn, ease, ivl, lastIvl, factor, time, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
			[...r],
		);
	}

	// -------------------------------------------------------------------------
	// Sanity check & finalize
	// -------------------------------------------------------------------------

	getSanityCheckCounts(): SanityCheckCounts {
		const count = (table: string) => {
			const r = this.db.exec(`SELECT COUNT(*) FROM ${table}`)[0];
			return r.values[0][0] as number;
		};
		return {
			cards: count('cards'),
			notes: count('notes'),
			revlog: count('revlog'),
			graves: count('graves'),
			notetypes: count('notetypes'),
			decks: count('decks'),
			deckConfig: count('deck_config'),
		};
	}

	finalizeSync(serverUsn: number, newMod: number): void {
		this.db.run('UPDATE col SET usn = ?, mod = ? WHERE id = 1', [serverUsn, newMod]);
	}

	// -------------------------------------------------------------------------
	// Full upload / download
	// -------------------------------------------------------------------------

	/** Reset all pending USNs to 0, clear graves, return raw DB bytes. */
	closeForFullUpload(): Uint8Array {
		this.db.run('UPDATE notes SET usn = 0 WHERE usn = -1');
		this.db.run('UPDATE cards SET usn = 0 WHERE usn = -1');
		this.db.run('UPDATE decks SET usn = 0 WHERE usn = -1');
		this.db.run('UPDATE notetypes SET usn = 0 WHERE usn = -1');
		this.db.run('UPDATE deck_config SET usn = 0 WHERE usn = -1');
		this.db.run('UPDATE tags SET usn = 0 WHERE usn = -1');
		this.db.run('UPDATE revlog SET usn = 0 WHERE usn = -1');
		this.db.run('DELETE FROM graves');
		this.db.run('UPDATE col SET usn = 0 WHERE id = 1');
		// Restore original Anki collation name before sending to the server so
		// other Anki clients (desktop, mobile) can open the uploaded collection.
		return unpatchUnicase(Buffer.from(this.db.export()));
	}

	/** Replace collection with downloaded bytes. */
	replaceWithFullDownload(data: Buffer): void {
		this.db.close();
		writeFileSync(this.dbPath, data);
		const sql = SQL!;
		this.db = new sql.Database(patchUnicase(data));
	}

	// -------------------------------------------------------------------------
	// Deck management
	// -------------------------------------------------------------------------

	private getDeckId(name: string): number | null {
		const r = this.db.exec('SELECT id FROM decks WHERE name = ?', [name]);
		if (!r.length || !r[0].values.length) return null;
		return r[0].values[0][0] as number;
	}

	createDeck(name: string): number {
		const existing = this.getDeckId(name);
		if (existing != null) return existing;

		const id = nowMs();
		const common = Buffer.from(encodeDeckCommon(false, false));
		const kind = Buffer.from(encodeDeckKindNormal(1n));
		this.db.run(
			'INSERT INTO decks (id, name, mtime_secs, usn, common, kind) VALUES (?, ?, ?, -1, ?, ?)',
			[id, name, nowSecs(), common, kind],
		);
		return id;
	}

	// -------------------------------------------------------------------------
	// Note management (for syncManager diff logic)
	// -------------------------------------------------------------------------

	/** Find all note ids in a deck. Returns Map<noteId, {front, back}>. */
	getNotesInDeck(deckId: number, deckName?: string): Map<number, { front: string; back: string }> {
		const rows = this.db.exec(
			'SELECT n.id, n.flds FROM notes n JOIN cards c ON c.nid = n.id WHERE c.did = ? GROUP BY n.id',
			[deckId],
		);
		const result = new Map<number, { front: string; back: string }>();
		if (!rows.length) return result;
		// Secondary map to detect duplicate fronts within the same deck
		const frontToId = new Map<string, number>();
		for (const [id, flds] of rows[0].values as [number, string][]) {
			const parts = flds.split('\x1f');
			const front = parts[0] ?? '';
			const back = parts[1] ?? '';
			const existingId = frontToId.get(front);
			if (existingId !== undefined) {
				const label = deckName ?? `id=${deckId}`;
				console.warn(`[ankisync] duplicate front "${front}" in deck "${label}" — note ids ${existingId} and ${id} — keeping latest`);
			}
			frontToId.set(front, id);
			result.set(id, { front, back });
		}
		return result;
	}

	/** Add a note+card to the collection. Returns the new note id. */
	addNote(front: string, back: string, deckId: number, notetypeId: number): number {
		const id = nextId();
		const cardId = nextId();
		const guid = generateGuid();
		const flds = `${front}\x1f${back}`;
		const sfld = front;
		const csum = crc32(sfld) & 0xffffffff;

		this.db.run(
			'INSERT OR IGNORE INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data) VALUES (?, ?, ?, ?, -1, \'\', ?, ?, ?, 0, \'\')',
			[id, guid, notetypeId, nowSecs(), flds, sfld, csum],
		);
		this.db.run(
			'INSERT OR IGNORE INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data) VALUES (?, ?, ?, 0, ?, -1, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, \'\')',
			[cardId, id, deckId, nowSecs(), cardId],
		);

		this.touchCollection();
		return id;
	}

	/** Bump col.mod so the local collection appears newer than the server. */
	private touchCollection(): void {
		// col.mod must be in milliseconds to compare correctly with the server's
		// mod value (which is also ms). Using nowSecs() would make the local mod
		// ~1000x smaller than the server's, causing localIsNewer to always be
		// false and triggering a redundant full-download on every sync.
		this.db.run('UPDATE col SET mod = ? WHERE id = 1', [nowMs()]);
	}

	/** Update front and back fields of an existing note. */
	updateNote(noteId: number, front: string, back: string): void {
		const flds = `${front}\x1f${back}`;
		const sfld = front;
		const csum = crc32(sfld) & 0xffffffff;
		this.db.run(
			'UPDATE notes SET flds = ?, sfld = ?, csum = ?, mod = ?, usn = -1 WHERE id = ?',
			[flds, sfld, csum, nowSecs(), noteId],
		);
		this.touchCollection();
	}

	/** Delete a note and its cards; insert graves for sync propagation. */
	deleteNote(noteId: number): void {
		const cardRows = this.db.exec('SELECT id FROM cards WHERE nid = ?', [noteId]);
		if (cardRows.length) {
			for (const [cardId] of cardRows[0].values as [number][]) {
				this.db.run('DELETE FROM cards WHERE id = ?', [cardId]);
				this.insertGrave(cardId, 0);
			}
		}
		this.db.run('DELETE FROM notes WHERE id = ?', [noteId]);
		this.insertGrave(noteId, 1);
		this.touchCollection();
	}

	// -------------------------------------------------------------------------
	// Notetype management
	// -------------------------------------------------------------------------

	/** Get or create a Basic notetype. Returns the notetype id. */
	getOrCreateBasicNotetype(): number {
		const r = this.db.exec('SELECT id FROM notetypes WHERE name = \'Basic\'');
		if (r.length && r[0].values.length) return r[0].values[0][0] as number;
		return this.ensureBasicNotetype();
	}

	private ensureBasicNotetype(): number {
		const id = nowMs() - 1;
		this.db.run(
			'INSERT OR IGNORE INTO notetypes (id, name, mtime_secs, usn, config) VALUES (?, \'Basic\', ?, -1, X\'\')',
			[id, nowSecs()],
		);
		this.db.run(
			'INSERT OR IGNORE INTO fields (ntid, ord, name, config) VALUES (?, 0, \'Front\', X\'\')',
			[id],
		);
		this.db.run(
			'INSERT OR IGNORE INTO fields (ntid, ord, name, config) VALUES (?, 1, \'Back\', X\'\')',
			[id],
		);
		this.db.run(
			'INSERT OR IGNORE INTO templates (ntid, ord, name, mtime_secs, usn, config) VALUES (?, 0, \'Card 1\', ?, -1, X\'\')',
			[id, nowSecs()],
		);
		return id;
	}

	private ensureDefaultDeck(): void {
		const common = Buffer.from(encodeDeckCommon(false, false));
		const kind = Buffer.from(encodeDeckKindNormal(1n));
		this.db.run(
			'INSERT OR IGNORE INTO decks (id, name, mtime_secs, usn, common, kind) VALUES (1, \'Default\', ?, -1, ?, ?)',
			[nowSecs(), common, kind],
		);
	}

	private ensureDefaultDeckConfig(): void {
		this.db.run(
			'INSERT OR IGNORE INTO deck_config (id, name, mtime_secs, usn, config) VALUES (1, \'Default\', ?, -1, NULL)',
			[nowSecs()],
		);
	}

	// -------------------------------------------------------------------------
	// Media
	// -------------------------------------------------------------------------

	/** Copy a media file into the collection.media directory. */
	addMedia(sourcePath: string, filename: string): void {
		mkdirSync(this.mediaDir, { recursive: true });
		const dest = join(this.mediaDir, filename);
		if (!existsSync(dest)) {
			copyFileSync(sourcePath, dest);
		}
	}
}
