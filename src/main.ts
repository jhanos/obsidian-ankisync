import { Plugin, Notice, PluginSettingTab, App, Setting, TFile, debounce } from 'obsidian';
import { AnkiSyncSettings, DEFAULT_SETTINGS } from './settings';
import { SyncManager } from './syncManager';

// ---------------------------------------------------------------------------
// Main plugin class
// ---------------------------------------------------------------------------

export default class AnkiSyncPlugin extends Plugin {
	settings!: AnkiSyncSettings;
	private syncing = false;

	async onload(): Promise<void> {
		await this.loadSettings();

		// Ribbon icon — manual sync trigger
		this.addRibbonIcon('sync', 'Sync flashcards to Anki', () => {
			void this.runSync();
		});

		// Command palette
		this.addCommand({
			id: 'sync-flashcards',
			name: 'Sync flashcards to Anki',
			callback: () => void this.runSync(),
		});

		// Settings tab
		this.addSettingTab(new AnkiSyncSettingTab(this.app, this));

		// Auto-sync on file save
		if (this.settings.autoSyncOnSave) {
			this.registerAutoSync();
		}
	}

	onunload(): void {
		// nothing to clean up
	}

	// -------------------------------------------------------------------------
	// Settings
	// -------------------------------------------------------------------------

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<AnkiSyncSettings>);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	// -------------------------------------------------------------------------
	// Sync
	// -------------------------------------------------------------------------

	async runSync(): Promise<void> {
		if (this.syncing) {
			new Notice('Anki sync already in progress…');
			return;
		}

		this.syncing = true;
		const notice = new Notice('Anki sync in progress…', 0);

		try {
			const vaultDir = this.getVaultDir();
			const pluginDir = this.getPluginDir();
			const manager = new SyncManager(this.settings, pluginDir);
			const result = await manager.sync(vaultDir);
			notice.hide();
			new Notice(
				`Anki sync complete: ${result.added} added, ${result.updated} updated, ${result.deleted} deleted`,
				5000,
			);
		} catch (err) {
			notice.hide();
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Anki sync failed: ${msg}`, 8000);
			console.error('obsidian-ankisync: sync error', err);
		} finally {
			this.syncing = false;
		}
	}

	// -------------------------------------------------------------------------
	// Auto-sync registration
	// -------------------------------------------------------------------------

	registerAutoSync(): void {
		const debouncedSync = debounce(() => void this.runSync(), 5000, true);
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					debouncedSync();
				}
			}),
		);
	}

	// -------------------------------------------------------------------------
	// Path helpers
	// -------------------------------------------------------------------------

	private getVaultDir(): string {
		const adapter = this.app.vault.adapter;
		// FileSystemAdapter has a getBasePath method
		if ('getBasePath' in adapter && typeof (adapter as Record<string, unknown>)['getBasePath'] === 'function') {
			return (adapter as { getBasePath: () => string }).getBasePath();
		}
		throw new Error('Cannot determine vault directory (non-desktop adapter)');
	}

	getPluginDir(): string {
		const vaultDir = this.getVaultDir();
		// manifest.dir is relative to vault root (e.g. ".obsidian/plugins/obsidian-ankisync")
		const relDir = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
		return `${vaultDir}/${relDir}`;
	}
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

class AnkiSyncSettingTab extends PluginSettingTab {
	plugin: AnkiSyncPlugin;

	constructor(app: App, plugin: AnkiSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Anki Sync Settings' });

		// Anki endpoint
		new Setting(containerEl)
			.setName('Anki server URL')
			.setDesc('URL of your remote Anki sync server (e.g. https://ankiweb.thonis.fr/)')
			.addText(text =>
				text
					.setPlaceholder('https://sync.ankiweb.net/')
					.setValue(this.plugin.settings.ankiEndpoint)
					.onChange(async (value) => {
						this.plugin.settings.ankiEndpoint = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		// Username
		new Setting(containerEl)
			.setName('Username')
			.setDesc('Your Anki account username / email')
			.addText(text =>
				text
					.setPlaceholder('user@example.com')
					.setValue(this.plugin.settings.username)
					.onChange(async (value) => {
						this.plugin.settings.username = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		// Password
		new Setting(containerEl)
			.setName('Password')
			.setDesc('Your Anki account password (stored in data.json)')
			.addText(text => {
				text
					.setPlaceholder('password')
					.setValue(this.plugin.settings.password)
					.onChange(async (value) => {
						this.plugin.settings.password = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password';
			});

		containerEl.createEl('h3', { text: 'Flashcard Options' });

		// Flashcards tag
		new Setting(containerEl)
			.setName('Flashcards tag')
			.setDesc('Tag used to identify notes containing flashcards')
			.addText(text =>
				text
					.setPlaceholder('flashcards')
					.setValue(this.plugin.settings.flashcardsTag)
					.onChange(async (value) => {
						this.plugin.settings.flashcardsTag = value.trim() || 'flashcards';
						await this.plugin.saveSettings();
					}),
			);

		// Deck prefix
		new Setting(containerEl)
			.setName('Deck prefix')
			.setDesc('Prefix added to deck names (e.g. "o_" creates decks like "o_MyNote")')
			.addText(text =>
				text
					.setPlaceholder('o_')
					.setValue(this.plugin.settings.deckPrefix)
					.onChange(async (value) => {
						this.plugin.settings.deckPrefix = value;
						await this.plugin.saveSettings();
					}),
			);

		// Delete removed cards
		new Setting(containerEl)
			.setName('Delete removed cards')
			.setDesc('Delete Anki cards whose flashcards have been removed from the vault')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.deleteRemovedCards)
					.onChange(async (value) => {
						this.plugin.settings.deleteRemovedCards = value;
						await this.plugin.saveSettings();
					}),
			);

		// Auto-sync on save
		new Setting(containerEl)
			.setName('Auto-sync on save')
			.setDesc('Automatically sync whenever a markdown file is modified (debounced 5 seconds)')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.autoSyncOnSave)
					.onChange(async (value) => {
						this.plugin.settings.autoSyncOnSave = value;
						await this.plugin.saveSettings();
					}),
			);

		containerEl.createEl('h3', { text: 'Separator Options' });

		// Single-line separator
		new Setting(containerEl)
			.setName('Single-line separator')
			.setDesc('Separator used for single-line flashcards (e.g. "Question :: Answer")')
			.addText(text =>
				text
					.setPlaceholder('::')
					.setValue(this.plugin.settings.singleLineSeparator)
					.onChange(async (value) => {
						this.plugin.settings.singleLineSeparator = value.trim() || '::';
						await this.plugin.saveSettings();
					}),
			);

		// Reverse card separator
		new Setting(containerEl)
			.setName('Reverse card separator')
			.setDesc('Separator for cards that generate both front→back and back→front (e.g. "Question ::: Answer"). Uses the "Basic (and reversed card)" Anki notetype.')
			.addText(text =>
				text
					.setPlaceholder(':::')
					.setValue(this.plugin.settings.reverseSeparator)
					.onChange(async (value) => {
						this.plugin.settings.reverseSeparator = value.trim() || ':::';
						await this.plugin.saveSettings();
					}),
			);

		// Multi-line separator
		new Setting(containerEl)
			.setName('Multi-line separator')
			.setDesc('Separator line that divides question from answer in multi-line flashcards. Must appear alone on its own line.')
			.addText(text =>
				text
					.setPlaceholder('?')
					.setValue(this.plugin.settings.multiLineSeparator)
					.onChange(async (value) => {
						this.plugin.settings.multiLineSeparator = value.trim() || '?';
						await this.plugin.saveSettings();
					}),
			);

		containerEl.createEl('h3', { text: 'Actions' });

		// Manual sync button
		new Setting(containerEl)
			.setName('Sync now')
			.setDesc('Run a manual sync immediately')
			.addButton(button =>
				button
					.setButtonText('Sync')
					.setCta()
					.onClick(() => void this.plugin.runSync()),
			);

		// Reset local collection
		new Setting(containerEl)
			.setName('Reset local collection')
			.setDesc('Delete the local cached collection (tmp/) to force a fresh download on next sync')
			.addButton(button =>
				button
					.setButtonText('Reset')
					.setWarning()
					.onClick(async () => {
						const { rmSync } = await import('fs');
						const pluginDir = this.plugin.getPluginDir();
						const tmpDir = `${pluginDir}/tmp`;
						try {
							rmSync(tmpDir, { recursive: true, force: true });
							new Notice('Local collection reset. Next sync will re-download from server.');
						} catch (err) {
							new Notice(`Failed to reset: ${err instanceof Error ? err.message : String(err)}`);
						}
					}),
			);
	}
}
