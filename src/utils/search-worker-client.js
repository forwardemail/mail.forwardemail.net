import { initializeDatabase } from './db.js';
import { onDbWorkerChange, openDbPortForWorker } from './db-worker-client.js';
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
    // Bumped each time the database moves, so a connection started before the
    // move does not mark the new one as made.
    this.dbGeneration = 0;

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

    // The engine moved: a new db worker, or the main-thread fallback. The port
    // to the old one is dead, so open a new one.
    this.stopWatchingDbWorker = onDbWorkerChange(({ worker, useMainThread }) => {
      this.dbConnected = false;
      this.dbGeneration += 1;
      if (!useMainThread && !worker) return;
      this.dbConnectionPromise = this.connectToDbWorker().catch((err) => {
        console.error('[SearchWorkerClient] Reconnecting to the database failed:', err);
      });
    });

    // Connect to db worker via MessageChannel (store promise for awaiting)
    this.dbConnectionPromise = this.connectToDbWorker();
  }

  /**
   * Give the search worker a channel to the database: to the db worker, or to
   * the main thread when the engine runs there.
   * @throws {Error} If the database cannot be started
   */
  async connectToDbWorker() {
    // Wait for the database to be up, so the channel never goes to a worker
    // that is still starting and may be replaced by the main-thread fallback.
    try {
      await initializeDatabase();
    } catch (err) {
      throw new Error(
        `[SearchWorkerClient] Failed to initialize the database: ${err.message || 'Unknown error'}`,
      );
    }
    // Starting the database announces it, and the change listener may already
    // have opened a port while we waited.
    if (this.dbConnected) return;
    const generation = this.dbGeneration;
    const port = openDbPortForWorker('search');
    if (!port) throw new Error('[SearchWorkerClient] Database not available');
    await this.send('connectDbPort', {}, [port]);
    if (generation === this.dbGeneration) this.dbConnected = true;
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
