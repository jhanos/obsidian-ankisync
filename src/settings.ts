import { DEFAULT_ENDPOINT } from './types';

export interface AnkiSyncSettings {
	ankiEndpoint: string;
	username: string;
	/** Stored plaintext in data.json */
	password: string;
	flashcardsTag: string;
	deckPrefix: string;
	deleteRemovedCards: boolean;
	autoSyncOnSave: boolean;
	singleLineSeparator: string;
	multiLineSeparator: string;
}

export const DEFAULT_SETTINGS: AnkiSyncSettings = {
	ankiEndpoint: DEFAULT_ENDPOINT,
	username: '',
	password: '',
	flashcardsTag: 'flashcards',
	deckPrefix: 'o_',
	deleteRemovedCards: true,
	autoSyncOnSave: false,
	singleLineSeparator: '::',
	multiLineSeparator: '?',
};
