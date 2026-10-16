import { getDbWorker, initializeDatabase, isDbUsingMainThread } from './db.js';
import { onDbWorkerChange } from './db-worker-client.js';
import SearchWorker from '../workers/search.worker.ts?worker&inline';
import { createPendingRequests } from './pending-requests.js';

const createWorker = () => new SearchWorker();

export class SearchWorkerClient {
  constructor() {
    this.worker = createWorker();
    this.requests = createPendingRequests();
    this.counter = 0;
    this.dbConnected = false;
    this.dbConnectionPromise = null;
    // The db worker this client last opened a port to.
    this.connectedDbWorker = null;

    this.worker.onmessage = (event) => {
      const { id, ok, result, error } = event.data || {};
      if (!id) return;
      if (ok) this.requests.resolve(id, result);
      else this.requests.reject(id, new Error(error || 'Search worker error'));
    };

    this.worker.onerror = (event) => {
      const errorMsg = event?.message || 'Search worker crashed';
      console.error('[SearchWorkerClient] Worker error:', errorMsg);
      this.requests.clear(new Error(errorMsg));
    };

    // When the db worker is replaced, the port to the old one is dead. Mark the
    // connection stale and open a new port to the replacement.
    this.stopWatchingDbWorker = onDbWorkerChange(({ worker, useMainThread }) => {
      this.dbConnected = false;
      this.connectedDbWorker = null;
      if (useMainThread || !worker) return;
      this.dbConnectionPromise = this.connectToDbWorker(worker).catch((err) => {
        console.error('[SearchWorkerClient] Reconnecting to db.worker failed:', err);
      });
    });

    // Connect to db worker via MessageChannel (store promise for awaiting)
    this.dbConnectionPromise = this.connectToDbWorker();
  }

  /**
   * Connect this worker to db.worker via MessageChannel
   * @throws {Error} If connection fails after initialization attempt
   */
  async connectToDbWorker(knownDbWorker = null) {
    // When the DB runs on the main thread (WebKitGTK worker-IndexedDB fallback)
    // there is no db worker to connect a MessageChannel to. Skip rather than
    // throwing; search degrades gracefully on this platform.
    if (isDbUsingMainThread()) return;

    let dbWorker = knownDbWorker || getDbWorker();
    if (!dbWorker) {
      try {
        await initializeDatabase();
        dbWorker = getDbWorker();
      } catch (err) {
        throw new Error(
          `[SearchWorkerClient] Failed to initialize db.worker: ${err.message || 'Unknown error'}`,
        );
      }
    }
    if (!dbWorker) {
      throw new Error('[SearchWorkerClient] db.worker not available after initialization');
    }
    // Starting the database announces the new db worker, and the change
    // listener may already have opened a port to it while we waited.
    if (this.connectedDbWorker === dbWorker) return;
    this.connectedDbWorker = dbWorker;

    // Create a MessageChannel
    const channel = new MessageChannel();

    // Send one port to db.worker
    dbWorker.postMessage({ type: 'connectPort', workerId: 'search' }, [channel.port1]);

    // Send the other port to search.worker
    await this.send('connectDbPort', {}, [channel.port2]);
    this.dbConnected = true;
  }

  /**
   * Ensure db connection is ready before operations
   */
  async ensureDbConnected() {
    if (this.dbConnected) return;
    if (this.dbConnectionPromise) {
      await this.dbConnectionPromise;
    }
  }

  send(action, payload = {}, transfer = []) {
    const id = ++this.counter;
    const promise = this.requests.add(id);
    this.worker.postMessage({ id, action, payload }, transfer);
    return promise;
  }

  async init(account, includeBody) {
    await this.ensureDbConnected();
    return this.send('init', { account, includeBody });
  }

  index(payload) {
    return this.send('index', payload);
  }

  remove(payload) {
    return this.send('remove', payload);
  }

  search(payload) {
    return this.send('search', payload);
  }

  rebuildFromCache(payload) {
    return this.send('rebuildFromCache', payload);
  }

  getStats(payload) {
    return this.send('getStats', payload);
  }

  getHealth(payload) {
    return this.send('getHealth', payload);
  }

  syncMissingMessages(payload) {
    return this.send('syncMissingMessages', payload);
  }

  // Connect a MessagePort for sync worker communication
  connectSyncPort(port) {
    return this.send('connectSyncPort', {}, [port]);
  }

  // Get the underlying worker for direct MessageChannel setup
  getWorker() {
    return this.worker;
  }

  terminate() {
    this.stopWatchingDbWorker?.();
    this.worker?.terminate?.();
    this.requests.clear(new Error('Search worker terminated'));
  }
}
