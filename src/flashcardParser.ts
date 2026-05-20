import { join, dirname, basename, extname } from 'path';
import { existsSync, readdirSync, statSync } from 'fs';
import { Flashcard } from './types';

// Image extensions recognised by Anki
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.bmp', '.tiff', '.tif']);

// Regex for Obsidian-style embeds: ![[filename]] or ![[filename|size]]
const OBSIDIAN_IMAGE_RE = /!\[\[([^\]]+?)(?:\|[^\]]+)?\]\]/g;
// Regex for standard Markdown images: ![alt](path)
const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

// ---------------------------------------------------------------------------
// Tag detection (mirrors Python has_flashcards_tag)
// ---------------------------------------------------------------------------

/**
 * Returns true if the markdown content contains the given tag either:
 *   - inline: #flashcards
 *   - YAML frontmatter: tags: flashcards  /  tags: [a, flashcards]  /  - flashcards
 */
export function hasFlashcardsTag(content: string, tag: string): boolean {
	// Inline tag anywhere in the body
	const inlineRe = new RegExp(`(?:^|\\s)#${escapeRegex(tag)}(?:\\s|$)`, 'm');
	if (inlineRe.test(content)) return true;

	// Extract YAML frontmatter block
	const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
	if (!fmMatch) return false;
	const fm = fmMatch[1];

	// tags: flashcards  (single value)
	const singleRe = new RegExp(`^tags:\\s*${escapeRegex(tag)}\\s*$`, 'm');
	if (singleRe.test(fm)) return true;

	// tags: [a, flashcards, b]
	const inlineListMatch = fm.match(/^tags:\s*\[([^\]]*)\]/m);
	if (inlineListMatch) {
		const items = inlineListMatch[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
		if (items.includes(tag)) return true;
	}

	// tags:
	//   - flashcards
	const blockListRe = /^tags:\s*\n((?:\s+-\s+.+\n?)+)/m;
	const blockMatch = fm.match(blockListRe);
	if (blockMatch) {
		const items = blockMatch[1]
			.split('\n')
			.map(l => l.replace(/^\s*-\s*/, '').trim().replace(/^['"]|['"]$/g, ''))
			.filter(Boolean);
		if (items.includes(tag)) return true;
	}

	return false;
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Image reference extraction (mirrors Python find_images_in_text)
// ---------------------------------------------------------------------------

/**
 * Find all image references in text.
 * Returns raw reference strings (filename or path), deduplicated.
 */
export function findImagesInText(text: string): string[] {
	const refs: string[] = [];

	for (const match of text.matchAll(OBSIDIAN_IMAGE_RE)) {
		const ref = match[1].trim();
		if (IMAGE_EXTS.has(extname(ref).toLowerCase())) {
			refs.push(ref);
		}
	}

	for (const match of text.matchAll(MD_IMAGE_RE)) {
		const ref = match[2].trim();
		if (IMAGE_EXTS.has(extname(ref).toLowerCase())) {
			refs.push(ref);
		}
	}

	// Deduplicate while preserving order
	return [...new Set(refs)];
}

// ---------------------------------------------------------------------------
// Image path resolution (mirrors Python resolve_image_path — 5 candidates)
// ---------------------------------------------------------------------------

/**
 * Try to resolve an image reference to an absolute path.
 * Tries (in order):
 *   1. Next to the source file
 *   2. Vault root
 *   3. Vault root / attachments/
 *   4. Vault root / assets/
 *   5. Recursive search under vault root
 */
export function resolveImagePath(ref: string, sourceFile: string, vaultDir: string): string | null {
	const filename = basename(ref);
	const candidates = [
		join(dirname(sourceFile), filename),
		join(vaultDir, filename),
		join(vaultDir, 'attachments', filename),
		join(vaultDir, 'assets', filename),
		join(dirname(sourceFile), ref),   // relative path as-is
	];

	for (const c of candidates) {
		if (existsSync(c)) return c;
	}

	// Recursive search
	return rglobFind(vaultDir, filename);
}

function rglobFind(dir: string, filename: string): string | null {
	try {
		const entries = readdirSync(dir);
		for (const entry of entries) {
			if (entry === '.git' || entry === 'node_modules') continue;
			const full = join(dir, entry);
			try {
				const stat = statSync(full);
				if (stat.isDirectory()) {
					const found = rglobFind(full, filename);
					if (found) return found;
				} else if (entry === filename) {
					return full;
				}
			} catch {
				// skip unreadable entries
			}
		}
	} catch {
		// skip unreadable dirs
	}
	return null;
}

// ---------------------------------------------------------------------------
// Convert image references to HTML <img> tags (mirrors Python convert_images_to_html)
// ---------------------------------------------------------------------------

/**
 * Replace image references in text with <img src="filename"> HTML tags.
 * Returns the modified text.
 * addedMedia is populated with { ref, absolutePath } for any resolved images.
 */
export function convertImagesToHtml(
	text: string,
	sourceFile: string,
	vaultDir: string,
	addedMedia: Array<{ ref: string; absolutePath: string }>,
): string {
	// Replace Obsidian-style embeds
	let result = text.replace(OBSIDIAN_IMAGE_RE, (_match, ref) => {
		const name = basename(ref.trim());
		if (!IMAGE_EXTS.has(extname(name).toLowerCase())) return _match;
		const abs = resolveImagePath(ref.trim(), sourceFile, vaultDir);
		if (abs) addedMedia.push({ ref: name, absolutePath: abs });
		return `<img src="${name}">`;
	});

	// Replace standard Markdown images
	result = result.replace(MD_IMAGE_RE, (_match, _alt, ref) => {
		const name = basename(ref.trim());
		if (!IMAGE_EXTS.has(extname(name).toLowerCase())) return _match;
		const abs = resolveImagePath(ref.trim(), sourceFile, vaultDir);
		if (abs) addedMedia.push({ ref: name, absolutePath: abs });
		return `<img src="${name}">`;
	});

	return result;
}

// ---------------------------------------------------------------------------
// Flashcard parsing (mirrors Python extract_flashcards)
// ---------------------------------------------------------------------------

/**
 * Parse all flashcards from a markdown file's content.
 *
 * Supports two formats:
 *   1. Single-line:  question :: answer
 *   2. Multi-line:
 *        question line 1
 *        question line 2
 *        ?
 *        answer line 1
 *        answer line 2
 *
 * Blank lines and YAML frontmatter are stripped before parsing.
 */
export function extractFlashcards(
	content: string,
	sourceFile: string,
	vaultDir: string,
): Flashcard[] {
	const cards: Flashcard[] = [];

	// Strip YAML frontmatter
	const stripped = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');

	// Split into non-empty lines
	const lines = stripped.split('\n');

	// --- Pass 1: single-line cards (question :: answer) ---
	for (const line of lines) {
		const sepIdx = line.indexOf('::');
		if (sepIdx === -1) continue;
		const front = line.slice(0, sepIdx).trim();
		const back = line.slice(sepIdx + 2).trim();
		if (!front || !back) continue;
		const imageRefs = [...findImagesInText(front), ...findImagesInText(back)];
		const images = imageRefs
			.map(ref => resolveImagePath(ref, sourceFile, vaultDir))
			.filter((p): p is string => p !== null);
		cards.push({ front, back, images, sourceFile });
	}

	// --- Pass 2: multi-line cards (separated by '?') ---
	// Collect blocks separated by blank lines, find '?' dividers
	let questionLines: string[] = [];
	let inQuestion = true;
	let answerLines: string[] = [];

	const flushMultiline = () => {
		const front = questionLines.join('\n').trim();
		const back = answerLines.join('\n').trim();
		if (front && back) {
			// Skip if this is already captured as a single-line card
			const isSingleLine = front.includes('::') && answerLines.length <= 1;
			if (!isSingleLine) {
				const imageRefs = [...findImagesInText(front), ...findImagesInText(back)];
				const images = imageRefs
					.map(ref => resolveImagePath(ref, sourceFile, vaultDir))
					.filter((p): p is string => p !== null);
				cards.push({ front, back, images, sourceFile });
			}
		}
		questionLines = [];
		answerLines = [];
		inQuestion = true;
	};

	for (const line of lines) {
		const trimmed = line.trim();

		// A blank line resets the current block
		if (trimmed === '') {
			if (questionLines.length > 0 || answerLines.length > 0) {
				flushMultiline();
			}
			continue;
		}

		// Single-line format — skip; already handled above
		if (trimmed.includes('::') && !trimmed.startsWith('?')) {
			// reset any in-progress multiline
			if (questionLines.length > 0 || answerLines.length > 0) {
				flushMultiline();
			}
			continue;
		}

		if (trimmed === '?') {
			inQuestion = false;
			continue;
		}

		if (inQuestion) {
			questionLines.push(line);
		} else {
			answerLines.push(line);
		}
	}

	// Flush any trailing multi-line card
	if (questionLines.length > 0 && answerLines.length > 0) {
		flushMultiline();
	}

	return cards;
}
