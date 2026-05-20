import { HttpSyncClient, SyncRedirectError, SyncError } from './httpSyncClient';
import { SyncableCollection } from './syncableCollection';
import {
	SyncAuth,
	SyncActionRequired,
	SyncMeta,
	Graves,
	Chunk,
	UnchunkedChanges,
	takeGravesChunk,
	gravesEmpty,
	CHUNK_SIZE,
} from './types';

// ---------------------------------------------------------------------------
// SyncClient
// Orchestrates the full Anki sync protocol.
// Ported from ankiclientsync/client.py SyncClient.
// ---------------------------------------------------------------------------

export class SyncClient {
	private auth: SyncAuth;
	private http: HttpSyncClient;

	constructor(auth: SyncAuth) {
		this.auth = auth;
		this.http = new HttpSyncClient(auth);
	}

	/** Login and return a SyncAuth. Handles 308 redirects on meta. */
	static async login(username: string, password: string, endpoint: string): Promise<SyncAuth> {
		const baseAuth: SyncAuth = { hkey: '', endpoint, ioTimeoutSecs: 30 };
		const tempHttp = new HttpSyncClient(baseAuth);
		const hkey = await tempHttp.hostKey(username, password);
		return { hkey, endpoint, ioTimeoutSecs: 30 };
	}

	/** Fetch server SyncMeta, following redirects. Updates auth endpoint if redirected. */
	async fetchServerMeta(): Promise<SyncMeta> {
		let retries = 5;
		while (true) {
			try {
				return await this.http.meta();
			} catch (err) {
				if (err instanceof SyncRedirectError && retries-- > 0) {
					this.auth = { ...this.auth, endpoint: err.newEndpoint };
					this.http = new HttpSyncClient(this.auth);
					continue;
				}
				throw err;
			}
		}
	}

	async sync(col: SyncableCollection): Promise<SyncActionRequired> {
		const localMeta = col.syncMeta();
		const serverMeta = await this.fetchServerMeta();

		// Determine what action is required
		const action = this.determineAction(localMeta, serverMeta);

		if (action === SyncActionRequired.NO_CHANGES) {
			return SyncActionRequired.NO_CHANGES;
		}

		if (action === SyncActionRequired.FULL_SYNC) {
			// Return FULL_SYNC to caller — do NOT upload our local schema.
			// The caller should re-download from server and retry.
			return SyncActionRequired.FULL_SYNC;
		}

		// NORMAL_SYNC
		try {
			await this.normalSync(col, localMeta, serverMeta);
			return SyncActionRequired.NORMAL_SYNC;
		} catch (err) {
			await this.http.abort();
			if (err instanceof SyncError) {
				// Force full sync next time by setting schema modified
				col.setSchemaModified();
				col.rollbackTransaction();
			}
			throw err;
		}
	}

	/** Full collection download — writes raw bytes to the collection path. */
	async fullDownload(col: SyncableCollection): Promise<void> {
		const data = await this.http.download();
		col.replaceWithFullDownload(data);
	}

	// -------------------------------------------------------------------------
	// Normal sync — full 20-step incremental protocol
	// -------------------------------------------------------------------------

	private async normalSync(
		col: SyncableCollection,
		localMeta: SyncMeta,
		serverMeta: SyncMeta,
	): Promise<void> {
		const localIsNewer = localMeta.mod > serverMeta.mod;
		const serverUsn = serverMeta.usn;
		const pendingUsn = -1;

		col.beginTransaction();

		try {
			// Step 5: /sync/start — get remote graves
			const remoteGraves = await this.http.start(localMeta.usn, localIsNewer);

			// Steps 6–7: get local graves and mark them with server USN
			const localGraves = col.getPendingGraves(pendingUsn);
			col.updatePendingGraveUsns(serverUsn);

			// Step 8: send local graves to server in chunks of CHUNK_SIZE
			let chunk = takeGravesChunk(localGraves, CHUNK_SIZE);
			const hadGraves = !gravesEmpty(chunk);
			while (!gravesEmpty(chunk)) {
				await this.http.applyGraves(chunk);
				chunk = takeGravesChunk(localGraves, CHUNK_SIZE);
			}
			// Send final empty chunk to signal end of graves stream (only if we sent at least one)
			if (hadGraves) {
				await this.http.applyGraves({ cards: [], notes: [], decks: [] });
			}

			// Step 9: apply remote graves locally
			col.applyGraves(remoteGraves, serverUsn);

			// Step 10: get local unchunked changes (notetypes, decks, tags, config)
			const localChanges = col.getLocalUnchunkedChanges(pendingUsn, serverUsn, localIsNewer);

			// Step 11: exchange unchunked changes
			const remoteChanges = await this.http.applyChanges(localChanges);

			// Step 12: apply server unchunked changes
			col.applyUnchunkedChanges(remoteChanges, serverUsn);

			// Steps 13: receive chunks from server
			while (true) {
				const serverChunk = await this.http.chunk();
				col.applyChunk(serverChunk, pendingUsn);
				if (serverChunk.done) break;
			}

			// Steps 14–15: send local chunks to server
			const chunkableIds = col.getChunkableIds(pendingUsn);
			while (true) {
				const localChunk = col.getChunk(chunkableIds, serverUsn);
				await this.http.applyChunk(localChunk);
				if (localChunk.done) break;
			}

			// Step 16–17: sanity check
			const counts = col.getSanityCheckCounts();
			await this.http.sanityCheck(counts);

			// Step 18: finish
			const newMod = await this.http.finish();

			// Step 19: finalize local collection
			col.finalizeSync(serverUsn, newMod);

			// Step 20: commit
			col.commitTransaction();
		} catch (err) {
			col.rollbackTransaction();
			try {
				await this.http.abort();
			} catch {
				// swallow abort errors
			}
			throw err;
		}
	}

	// -------------------------------------------------------------------------
	// Decision logic
	// -------------------------------------------------------------------------

	private determineAction(local: SyncMeta, server: SyncMeta): SyncActionRequired {
		if (local.mod === server.mod) return SyncActionRequired.NO_CHANGES;
		if (local.scm !== server.scm) return SyncActionRequired.FULL_SYNC;
		return SyncActionRequired.NORMAL_SYNC;
	}
}


