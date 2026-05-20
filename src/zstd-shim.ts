/**
 * Shim for @bokuweb/zstd-wasm.
 * Implements compress/decompress directly against the single Module instance
 * from module.js. module.js must be marked as external in the esbuild config
 * so that Node's CJS require cache provides a single shared instance.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const moduleMod = require('../node_modules/@bokuweb/zstd-wasm/dist/common/module') as {
	Module: {
		init?: (buf: Buffer | Uint8Array) => void;
		HEAP8: Int8Array;
		HEAPU8: Uint8Array;
		_malloc: (n: number) => number;
		_free: (p: number) => void;
		_ZSTD_compressBound: (n: number) => number;
		_ZSTD_compress: (dst: number, dstCap: number, src: number, srcSize: number, level: number) => number;
		_ZSTD_decompress: (dst: number, dstCap: number, src: number, srcSize: number) => number;
		_ZSTD_isError: (n: number) => number;
		_ZSTD_getFrameContentSize: (src: number, srcSize: number) => number;
		[key: string]: unknown;
	};
	waitInitialized: () => Promise<void>;
};

export const ZstdModule = moduleMod.Module;
export const waitInitialized = moduleMod.waitInitialized;

/**
 * Initialize the WASM module with provided bytes.
 */
export async function initZstdWasm(buf: Buffer): Promise<void> {
	moduleMod.Module.init!(buf);
	await moduleMod.waitInitialized();
}

export function compress(buf: Uint8Array, level = 3): Uint8Array {
	const M = moduleMod.Module;
	const compressBound = M._ZSTD_compressBound(buf.byteLength);
	const dstPtr = M._malloc(compressBound);
	const srcPtr = M._malloc(buf.byteLength);
	// Access HEAPU8 AFTER malloc in case malloc triggered memory growth
	M.HEAPU8.set(buf, srcPtr);
	try {
		const sizeOrErr = M._ZSTD_compress(dstPtr, compressBound, srcPtr, buf.byteLength, level);
		if (M._ZSTD_isError(sizeOrErr)) {
			throw new Error(`Failed to compress with code ${sizeOrErr}`);
		}
		// Access HEAPU8 again after compression in case memory grew
		const result = new Uint8Array(M.HEAPU8.buffer, dstPtr, sizeOrErr).slice();
		return result;
	} finally {
		M._free(dstPtr);
		M._free(srcPtr);
	}
}

export function decompress(buf: Uint8Array): Uint8Array {
	const M = moduleMod.Module;
	if (!M._ZSTD_decompress) {
		throw new Error('[zstd-shim] WASM not initialized — _ZSTD_decompress is undefined');
	}
	// Ensure we have a contiguous Uint8Array view starting at offset 0
	const input = (buf.byteOffset !== 0 || buf.buffer.byteLength !== buf.byteLength)
		? new Uint8Array(buf)
		: buf;
	// Allocate src buffer
	const srcPtr = M._malloc(input.byteLength);
	// Access HEAPU8 AFTER malloc (malloc may grow memory, invalidating old typed array views)
	M.HEAPU8.set(input, srcPtr);
	// Get actual decompressed size from frame header
	let contentSize = M._ZSTD_getFrameContentSize(srcPtr, input.byteLength);
	// 0xFFFFFFFF (-1) = unknown, 0xFFFFFFFE (-2) = error in determining size
	if (contentSize <= 0 || contentSize > 200 * 1024 * 1024) {
		contentSize = Math.max(input.byteLength * 20, 1024 * 1024);
	}
	const dstPtr = M._malloc(contentSize);
	try {
		// Re-set src in case the second malloc triggered memory growth
		M.HEAPU8.set(input, srcPtr);
		const sizeOrErr = M._ZSTD_decompress(dstPtr, contentSize, srcPtr, input.byteLength);
		if (M._ZSTD_isError(sizeOrErr)) {
			throw new Error(`Failed to decompress with code ${sizeOrErr}`);
		}
		// Access HEAPU8 again after decompression (memory may have grown)
		const result = new Uint8Array(M.HEAPU8.buffer, dstPtr, sizeOrErr).slice();
		return result;
	} finally {
		M._free(dstPtr);
		M._free(srcPtr);
	}
}
