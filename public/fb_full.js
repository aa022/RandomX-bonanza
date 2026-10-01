// No-SAB full-dataset replicas (?fb_full=K, miner.js NoSabPool). Without
// SharedArrayBuffer every worker has its own memory, so a full-mode worker
// needs a private 2 GiB dataset. K "replica" workers allocate one; ALL workers
// (replicas and light ones) build it together from their own caches in
// 2^16-item chunks (4 MiB, rxInitItemsInto), which the coordinator hands out
// and forwards to the replicas as transferable ArrayBuffers. A replica computes
// its own chunks straight into its dataset. When a replica has every chunk it
// releases its cache and mines in full mode; the light workers keep mining
// light. A new seed repeats the build (the replicas keep their allocation).
//
// Shared by the browser (miner.js: FbCoordinator; worker.js: FbWorker) and the
// Node benches (bench/nosab_pool.mjs over worker_threads). A classic script:
// the global RxFbFull in pages and workers, module.exports under require().
//
// Messages (all carry the epoch's seed; the coordinator drops stale ones):
//   worker -> coord  fb_cache    {seed, full, items}   cache ready; full: replica with its dataset
//   coord -> worker  fb_compute  {seed, chunk, start, count, share}
//   worker -> coord  fb_chunk    {seed, chunk, own, buf, fail}  buf transferred (null: own, unshared)
//   coord -> worker  fb_write    {seed, chunk, start, buf}      replicas only
//   worker -> coord  fb_written  {seed, chunk}
//   coord -> worker  fb_finalize {seed}                          replica has every chunk
//   worker -> coord  fb_final    {seed, ok}                      ok: mining in full mode
(function (root) {
  'use strict';

  const CHUNK_ITEMS = 1 << 16;
  const ITEM_BYTES = 64;

  // Worker side. host: {
  //   Module,                   the randomx_st instance (supjit on for the kernel path)
  //   full,                     replica role (demoted to light if the dataset can't be allocated)
  //   post(msg, transfer),      to the coordinator
  //   seed(), cache(),          the current epoch's seed and cache pointer (0 once released)
  //   finalize(ds),             switch to a full-mode VM on ds and release the cache; true on success
  //   log(msg) }
  class FbWorker {
    constructor(host) {
      this.h = host;
      this.full = host.full === true;
      this.ds = 0;
      this.dsMem = 0;
      this.staging = 0;
      this.queue = [];
      this.scheduled = false;
      this.lastMsg = 0;
    }

    // Call after every cache build (epoch start). The replica allocates its
    // dataset once and reuses it for later seeds.
    cacheReady(seed) {
      const M = this.h.Module;
      if (this.full && !this.ds) {
        this.ds = M._randomx_alloc_dataset(0);
        if (this.ds) {
          this.dsMem = M._randomx_get_dataset_memory(this.ds) >>> 0; // crosses 2 GiB: unsigned
        } else {
          this.full = false;
          this.h.log('fb_full: dataset allocation failed, this worker stays in light mode');
        }
      }
      this.h.post({ type: 'fb_cache', seed, full: this.full, items: M._randomx_dataset_item_count() >>> 0 });
    }

    // Chunk work pending: the host's mine loop yields to it.
    busy() {
      return this.queue.length > 0;
    }

    // A build is (probably) on: work pending or a chunk message within the
    // last second. The host's mine loop yields often then, since a replica
    // whose writes sit behind a long slice holds up every worker (in-flight cap).
    active() {
      return this.queue.length > 0 || Date.now() - this.lastMsg < 1000;
    }

    // Queues an fb_* message; false for anything else.
    handle(msg) {
      if (!msg || typeof msg.type !== 'string' || msg.type.slice(0, 3) !== 'fb_') return false;
      this.queue.push(msg);
      this.lastMsg = Date.now();
      this._schedule();
      return true;
    }

    // One message per macrotask, so new messages (and the mine loop) get in
    // between. Writes go first: they free the coordinator's in-flight slots.
    _schedule() {
      if (this.scheduled) return;
      this.scheduled = true;
      setTimeout(() => {
        this.scheduled = false;
        let k = this.queue.findIndex((m) => m.type === 'fb_write');
        if (k < 0) k = 0;
        const msg = this.queue.splice(k, 1)[0];
        if (msg) this._run(msg);
        if (this.queue.length) this._schedule();
      }, 0);
    }

    _run(msg) {
      const M = this.h.Module;
      const h = this.h;
      const current = msg.seed === h.seed();
      switch (msg.type) {
        case 'fb_compute': {
          const cache = current ? h.cache() : 0;
          const bytes = msg.count * ITEM_BYTES;
          if (cache && this.full && this.ds) {
            const dst = this.dsMem + msg.start * ITEM_BYTES;
            M._rxInitItemsInto(cache, dst, msg.start, msg.count);
            const buf = msg.share ? M.HEAPU8.slice(dst, dst + bytes).buffer : null;
            h.post({ type: 'fb_chunk', seed: msg.seed, chunk: msg.chunk, own: true, buf }, buf ? [buf] : []);
            break;
          }
          if (cache && !this.staging) this.staging = M._malloc(CHUNK_ITEMS * ITEM_BYTES);
          if (!cache || !this.staging) {
            h.post({ type: 'fb_chunk', seed: msg.seed, chunk: msg.chunk, fail: true });
            break;
          }
          M._rxInitItemsInto(cache, this.staging, msg.start, msg.count);
          const buf = M.HEAPU8.slice(this.staging, this.staging + bytes).buffer;
          h.post({ type: 'fb_chunk', seed: msg.seed, chunk: msg.chunk, own: false, buf }, [buf]);
          break;
        }
        case 'fb_write':
          if (!current || !this.ds) break; // stale epoch: the coordinator has moved on
          M.HEAPU8.set(new Uint8Array(msg.buf), this.dsMem + msg.start * ITEM_BYTES);
          h.post({ type: 'fb_written', seed: msg.seed, chunk: msg.chunk });
          break;
        case 'fb_finalize':
          if (!current || !this.ds) break;
          h.post({ type: 'fb_final', seed: msg.seed, ok: h.finalize(this.ds) === true });
          break;
      }
    }
  }

  // Coordinator (main thread). opts: {
  //   n, full: [worker indices with the replica role],
  //   send(i, msg, transfer),
  //   progress(done, total, etaSec)   dataset items over all replicas (throttled)
  //   done(seed, replicas)            every replica finalized (replicas: indices in full mode)
  //   perWorker (2), maxInFlight (2n)  compute requests per worker; chunks until in every replica }
  class FbCoordinator {
    constructor(opts) {
      this.o = opts;
      this.n = opts.n;
      this.fullIdx = opts.full.slice();
      this.perWorker = opts.perWorker || 2;
      this.maxInFlight = opts.maxInFlight || 2 * opts.n;
      this.seed = null;
    }

    // A job with a (new) seed: every worker rebuilds its cache and reports
    // fb_cache; the build starts once all replica-role workers have reported.
    epoch(seed) {
      if (seed === this.seed) return;
      this.seed = seed;
      this.known = new Array(this.n).fill(null); // fb_cache of this epoch
      this.targets = null;                       // replicas with a dataset
      this.queue = [];
      this.busy = new Array(this.n).fill(0);
      this.bad = new Set();                      // failed a compute (no cache): skip until fb_cache
      this.flight = 0;
      this.writesLeft = new Map();
      this.have = new Map();
      this.finals = [];
      this.finished = false;
      this.t0 = Date.now();
      this.lastProgress = 0;
    }

    // Handles fb_* messages from worker i; false for anything else.
    recv(i, msg) {
      if (!msg || typeof msg.type !== 'string' || msg.type.slice(0, 3) !== 'fb_') return false;
      if (msg.seed !== this.seed) return true; // stale epoch
      switch (msg.type) {
        case 'fb_cache':
          this.known[i] = msg;
          this.bad.delete(i);
          this._start();
          break;
        case 'fb_chunk':
          this.busy[i]--;
          if (msg.fail) {
            this.bad.add(i);
            this.flight--;
            this.queue.unshift(msg.chunk);
            break;
          }
          if (msg.own) this._have(i);
          {
            const to = this.targets.filter((t) => !(msg.own && t === i));
            if (!to.length) { this.flight--; break; }
            this.writesLeft.set(msg.chunk, to.length);
            const start = msg.chunk * CHUNK_ITEMS;
            // structured clones first, the last one takes the buffer
            to.forEach((t, k) => {
              const last = k === to.length - 1;
              this.o.send(t, { type: 'fb_write', seed: this.seed, chunk: msg.chunk, start, buf: msg.buf },
                last ? [msg.buf] : []);
            });
          }
          break;
        case 'fb_written': {
          this._have(i);
          const left = this.writesLeft.get(msg.chunk) - 1;
          if (left > 0) this.writesLeft.set(msg.chunk, left);
          else { this.writesLeft.delete(msg.chunk); this.flight--; }
          break;
        }
        case 'fb_final':
          if (msg.ok) this.finals.push(i);
          this.have.delete(i);
          if (!this.have.size) this._finish();
          break;
      }
      this._pump();
      return true;
    }

    _start() {
      if (this.targets) return;
      if (!this.fullIdx.every((i) => this.known[i])) return;
      this.targets = this.fullIdx.filter((i) => this.known[i].full);
      if (!this.targets.length) { this._finish(); return; }
      this.items = this.known[this.targets[0]].items;
      this.chunks = Math.ceil(this.items / CHUNK_ITEMS);
      for (let c = 0; c < this.chunks; c++) this.queue.push(c);
      for (const t of this.targets) this.have.set(t, 0);
      this._progress(true);
    }

    _have(t) {
      const got = this.have.get(t) + 1;
      this.have.set(t, got);
      if (got === this.chunks) this.o.send(t, { type: 'fb_finalize', seed: this.seed });
      this._progress(false);
    }

    _progress(force) {
      const now = Date.now();
      if (!this.o.progress || (!force && now - this.lastProgress < 500)) return;
      this.lastProgress = now;
      let got = 0;
      for (const v of this.have.values()) got += v;
      got += (this.targets.length - this.have.size) * this.chunks; // finalized
      const frac = got / (this.chunks * this.targets.length);
      const elapsed = (now - this.t0) / 1000;
      const eta = frac > 0 ? Math.ceil(elapsed * (1 - frac) / frac) : 0;
      this.o.progress(Math.min(this.items, Math.round(frac * this.items)), this.items, eta);
    }

    _finish() {
      if (this.finished) return;
      this.finished = true;
      if (this.targets && this.targets.length && this.o.progress) this.o.progress(this.items, this.items, 0);
      if (this.o.done) this.o.done(this.seed, this.finals.slice());
    }

    // Least-busy worker whose cache is ready, while chunks and in-flight room last.
    _pump() {
      if (!this.targets || this.finished) return;
      while (this.queue.length && this.flight < this.maxInFlight) {
        let w = -1;
        for (let i = 0; i < this.n; i++) {
          if (!this.known[i] || this.bad.has(i) || this.busy[i] >= this.perWorker) continue;
          if (w < 0 || this.busy[i] < this.busy[w]) w = i;
        }
        if (w < 0) return;
        const chunk = this.queue.shift();
        const start = chunk * CHUNK_ITEMS;
        const own = this.targets.includes(w);
        this.busy[w]++;
        this.flight++;
        this.o.send(w, {
          type: 'fb_compute', seed: this.seed, chunk, start,
          count: Math.min(CHUNK_ITEMS, this.items - start),
          share: own && this.targets.length > 1,
        });
      }
    }
  }

  const api = { CHUNK_ITEMS, FbWorker, FbCoordinator };
  root.RxFbFull = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
