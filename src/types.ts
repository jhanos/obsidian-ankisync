/**
 * Shared types for obsidian-ankisync.
 * Ported from ankiclientsync Python library.
 */

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface SyncAuth {
	hkey: string;
	endpoint: string;
	ioTimeoutSecs: number;
}

// ---------------------------------------------------------------------------
// Sync protocol enums & result types
// ---------------------------------------------------------------------------

export const enum SyncActionRequired {
	NO_CHANGES = 'NO_CHANGES',
	NORMAL_SYNC = 'NORMAL_SYNC',
	FULL_SYNC = 'FULL_SYNC',
}

export interface SyncMeta {
	mod: number;
	scm: number;
	usn: number;
	ts: number;
	msg: string;
	cont: boolean;
	hostNum: number;
	empty: boolean;
	mediaUsn: number;
}

// ---------------------------------------------------------------------------
// Graves (deletions)
// ---------------------------------------------------------------------------

export interface Graves {
	cards: number[];
	notes: number[];
	decks: number[];
}

/** Take up to CHUNK_SIZE items from each list, mutating in place. */
export function takeGravesChunk(graves: Graves, chunkSize: number): Graves {
	return {
		cards: graves.cards.splice(0, chunkSize),
		notes: graves.notes.splice(0, chunkSize),
		decks: graves.decks.splice(0, chunkSize),
	};
}

export function gravesEmpty(graves: Graves): boolean {
	return graves.cards.length === 0 && graves.notes.length === 0 && graves.decks.length === 0;
}

// ---------------------------------------------------------------------------
// Chunked changes (notes, cards, revlog)
// ---------------------------------------------------------------------------

// Wire format: list of lists.  Field order matches Anki protocol exactly.
export type NoteRow = [number, string, number, number, number, string, string, string, string, number, string];
export type CardRow = [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, string];
export type RevlogRow = [number, number, number, number, number, number, number, number, number];

export interface Chunk {
	done: boolean;
	notes: NoteRow[];
	cards: CardRow[];
	revlog: RevlogRow[];
}

// ---------------------------------------------------------------------------
// Unchunked changes (notetypes, decks, tags, config)
// ---------------------------------------------------------------------------

export interface FieldDef {
	name: string;
	ord: number;
	font: string;
	size: number;
}

export interface TemplateDef {
	name: string;
	ord: number;
	qfmt: string;
	afmt: string;
}

export interface NoteTypeDef {
	id: number;
	name: string;
	mod: number;
	usn: number;
	css: string;
	type: number;
	flds: FieldDef[];
	tmpls: TemplateDef[];
}

export interface DeckDef {
	id: number;
	name: string;
	mod: number;
	usn: number;
	conf: number;
	dyn: number;
	desc: string;
	collapsed: boolean;
	browserCollapsed: boolean;
	newToday: [number, number];
	revToday: [number, number];
	lrnToday: [number, number];
	timeToday: [number, number];
	extendNew: number;
	extendRev: number;
}

export interface DeckConfigDef {
	id: number;
	name: string;
	mod: number;
	usn: number;
	new: Record<string, unknown>;
	rev: Record<string, unknown>;
	lapse: Record<string, unknown>;
	dyn: boolean;
}

export interface UnchunkedChanges {
	notetypes: NoteTypeDef[];
	decks: [DeckDef[], DeckConfigDef[]];
	tags: string[];
	config: Record<string, unknown> | null;
	creationStamp: number | null;
}

// ---------------------------------------------------------------------------
// Sanity check
// ---------------------------------------------------------------------------

export interface SanityCheckCounts {
	cards: number;
	notes: number;
	revlog: number;
	graves: number;
	notetypes: number;
	decks: number;
	deckConfig: number;
}

// ---------------------------------------------------------------------------
// Flashcard domain types
// ---------------------------------------------------------------------------

export interface Flashcard {
	front: string;
	back: string;
	/** Absolute paths to images found in front or back fields */
	images: string[];
	/** Source file path (absolute) */
	sourceFile: string;
	/** 1-based line number in the source file where this card is defined */
	line: number;
}

export interface SyncResult {
	added: number;
	updated: number;
	deleted: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SYNC_VERSION = 11;
export const CHUNK_SIZE = 250;
export const DEFAULT_ENDPOINT = 'https://ankiweb.thonis.fr/';
export const MAX_MEDIA_FILES_PER_ZIP = 25;
