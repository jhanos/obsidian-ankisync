/**
 * test-entry.ts
 * Entry point for the standalone test harness bundle.
 * Imports SyncManager directly (bypassing the Obsidian plugin wrapper).
 */

import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { SyncManager } from './syncManager';
import { AnkiSyncSettings } from './settings';

const pluginDir = join(__dirname, 'test-vault/.obsidian/plugins/obsidian-ankisync');
const vaultDir  = join(__dirname, 'test-vault');

const settings: AnkiSyncSettings = {
  ankiEndpoint:       'http://localhost:8080',
  username:           'syncuser',
  password:           'pass',
  flashcardsTag:      'flashcards',
  deckPrefix:         'o_',
  deleteRemovedCards: false,
  autoSyncOnSave:     false,
};

const args = process.argv.slice(2);
const clean = args.includes('--clean');

if (clean) {
  const colPath = join(pluginDir, 'tmp', 'collection.anki2');
  if (existsSync(colPath)) {
    rmSync(colPath);
    console.log('[harness] deleted cached collection.anki2 (clean run)');
  }
}

const manager = new SyncManager(settings, pluginDir);

console.log('[harness] Starting sync...');
console.log('[harness] pluginDir:', pluginDir);
console.log('[harness] vaultDir: ', vaultDir);
console.log('');

manager.sync(vaultDir).then((result) => {
  console.log('');
  console.log('[harness] Sync complete!');
  console.log(`[harness] added=${result.added} updated=${result.updated} deleted=${result.deleted}`);
  if (result.added === 0 && result.updated === 0) {
    console.log('[harness] WARNING: no cards were added — check flashcard parsing or server state');
  }
}).catch((err: unknown) => {
  console.error('[harness] Sync FAILED:', err);
  process.exit(1);
});
