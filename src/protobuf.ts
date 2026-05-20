/**
 * Minimal protobuf encode/decode helpers.
 * Ported from ankiclientsync/collection.py — supports only the field types
 * used by Anki's collection format (varint, length-delimited strings/bytes).
 *
 * Wire types:
 *   0 = VARINT
 *   1 = I64  (8 bytes, little-endian) — not used here
 *   2 = LEN  (varint length prefix + bytes)
 *   5 = I32  (4 bytes, little-endian) — not used here
 */

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

/**
 * Read a base-128 varint from buf at offset.
 * Returns [value, newOffset].
 */
function readVarint(buf: Uint8Array, offset: number): [bigint, number] {
	let result = 0n;
	let shift = 0n;
	let pos = offset;
	while (pos < buf.length) {
		const byte = buf[pos++];
		result |= BigInt(byte & 0x7f) << shift;
		shift += 7n;
		if ((byte & 0x80) === 0) break;
	}
	return [result, pos];
}

/**
 * Parse all protobuf fields from a buffer.
 * Returns a Map from field number → array of values.
 * Values are either bigint (varint) or Uint8Array (length-delimited).
 */
export function parseProtobufFields(buf: Uint8Array): Map<number, Array<bigint | Uint8Array>> {
	const fields = new Map<number, Array<bigint | Uint8Array>>();
	let offset = 0;

	const add = (fieldNum: number, value: bigint | Uint8Array) => {
		if (!fields.has(fieldNum)) fields.set(fieldNum, []);
		fields.get(fieldNum)!.push(value);
	};

	while (offset < buf.length) {
		let tag: bigint;
		[tag, offset] = readVarint(buf, offset);
		const fieldNum = Number(tag >> 3n);
		const wireType = Number(tag & 0x7n);

		switch (wireType) {
			case 0: {
				// VARINT
				let val: bigint;
				[val, offset] = readVarint(buf, offset);
				add(fieldNum, val);
				break;
			}
			case 2: {
				// LEN — length-delimited (string or nested message)
				let len: bigint;
				[len, offset] = readVarint(buf, offset);
				const lenNum = Number(len);
				add(fieldNum, buf.slice(offset, offset + lenNum));
				offset += lenNum;
				break;
			}
			case 1: {
				// I64 — skip 8 bytes
				offset += 8;
				break;
			}
			case 5: {
				// I32 — skip 4 bytes
				offset += 4;
				break;
			}
			default:
				// Unknown wire type — skip this field and stop (cannot know its length)
				// This makes parsing forward-compatible with newer Anki server versions.
				console.warn(`[ankisync] protobuf: unknown wire type ${wireType} at offset ${offset}, skipping remaining bytes`);
				offset = buf.length;
				break;
		}
	}

	return fields;
}

/** Get the first string value for a field, or a default. */
export function getStringField(
	fields: Map<number, Array<bigint | Uint8Array>>,
	fieldNum: number,
	defaultValue = '',
): string {
	const vals = fields.get(fieldNum);
	if (!vals || vals.length === 0) return defaultValue;
	const v = vals[0];
	if (v instanceof Uint8Array) return new TextDecoder().decode(v);
	return defaultValue;
}

/** Get the first bigint value for a field, or a default. */
export function getVarintField(
	fields: Map<number, Array<bigint | Uint8Array>>,
	fieldNum: number,
	defaultValue = 0n,
): bigint {
	const vals = fields.get(fieldNum);
	if (!vals || vals.length === 0) return defaultValue;
	const v = vals[0];
	if (typeof v === 'bigint') return v;
	return defaultValue;
}

/** Get the first bytes value for a field, or null. */
export function getBytesField(
	fields: Map<number, Array<bigint | Uint8Array>>,
	fieldNum: number,
): Uint8Array | null {
	const vals = fields.get(fieldNum);
	if (!vals || vals.length === 0) return null;
	const v = vals[0];
	if (v instanceof Uint8Array) return v;
	return null;
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

/** Encode a non-negative integer as a base-128 varint. */
function encodeVarint(value: bigint): Uint8Array {
	if (value === 0n) return new Uint8Array([0]);
	const bytes: number[] = [];
	let v = value;
	while (v > 0n) {
		const byte = Number(v & 0x7fn);
		v >>= 7n;
		bytes.push(v > 0n ? byte | 0x80 : byte);
	}
	return new Uint8Array(bytes);
}

/** Encode the field tag (field number + wire type). */
function encodeTag(fieldNum: number, wireType: number): Uint8Array {
	return encodeVarint(BigInt((fieldNum << 3) | wireType));
}

/** Encode a raw bytes field (wire type 2). */
function encodeBytes(fieldNum: number, value: Uint8Array): Uint8Array {
	const tag = encodeTag(fieldNum, 2);
	const len = encodeVarint(BigInt(value.length));
	const out = new Uint8Array(tag.length + len.length + value.length);
	out.set(tag, 0);
	out.set(len, tag.length);
	out.set(value, tag.length + len.length);
	return out;
}

/** Encode a varint field (wire type 0). */
function encodeVarintField(fieldNum: number, value: bigint): Uint8Array {
	const tag = encodeTag(fieldNum, 0);
	const val = encodeVarint(value);
	const out = new Uint8Array(tag.length + val.length);
	out.set(tag, 0);
	out.set(val, tag.length);
	return out;
}

/** Concatenate multiple Uint8Arrays into one. */
function concatBytes(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Anki-specific protobuf blobs
// ---------------------------------------------------------------------------

/**
 * Encode a deck `common` blob (DeckCommon).
 *   field 1 (varint): studyCollapsed
 *   field 2 (varint): browserCollapsed
 */
export function encodeDeckCommon(studyCollapsed = false, browserCollapsed = false): Uint8Array {
	return concatBytes(
		encodeVarintField(1, studyCollapsed ? 1n : 0n),
		encodeVarintField(2, browserCollapsed ? 1n : 0n),
	);
}

/**
 * Encode a deck `kind` blob for a normal deck (DeckKind → NormalDeck).
 *   field 1 (len): NormalDeck { field 1 (varint): configId }
 */
export function encodeDeckKindNormal(configId = 1n): Uint8Array {
	const inner = encodeVarintField(1, configId);
	return encodeBytes(1, inner);
}

/**
 * Decode the `css` string from a notetype config blob.
 *   field 3 (string): css
 */
export function decodeNotetypeConfigCss(blob: Uint8Array): string {
	const fields = parseProtobufFields(blob);
	return getStringField(fields, 3, '');
}

/**
 * Decode field config: font (field 3), size (field 4).
 */
export function decodeFieldConfig(blob: Uint8Array): { font: string; size: number } {
	const fields = parseProtobufFields(blob);
	return {
		font: getStringField(fields, 3, 'Arial'),
		size: Number(getVarintField(fields, 4, 20n)),
	};
}

/**
 * Decode template config: qfmt (field 1), afmt (field 2).
 */
export function decodeTemplateConfig(blob: Uint8Array): { qfmt: string; afmt: string } {
	const fields = parseProtobufFields(blob);
	return {
		qfmt: getStringField(fields, 1, ''),
		afmt: getStringField(fields, 2, ''),
	};
}

/**
 * Decode deck kind: returns true if filtered, false if normal.
 *   field 1 = NormalDeck, field 2 = FilteredDeck
 */
export function decodeDeckKindIsFiltered(blob: Uint8Array): boolean {
	const fields = parseProtobufFields(blob);
	return fields.has(2);
}

/**
 * Decode normal deck config_id from kind blob.
 *   field 1 (len) = NormalDeck { field 1 (varint) = config_id }
 */
export function decodeDeckKindConfigId(blob: Uint8Array): number {
	const fields = parseProtobufFields(blob);
	const normalBlob = getBytesField(fields, 1);
	if (!normalBlob) return 1;
	const innerFields = parseProtobufFields(normalBlob);
	return Number(getVarintField(innerFields, 1, 1n));
}
