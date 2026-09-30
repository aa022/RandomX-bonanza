// The page owns every pthread, so Stop can terminate initialization and
// mining immediately, even while the engine worker is blocked inside WASM.
(() => {
  const workers = new Map();
  let nextId = 0;
  self.Worker = class {
    constructor(url, options) {
      this.id = ++nextId;
      workers.set(this.id, this);
      self.postMessage({ type: 'rx:thread-create', id: this.id, url: String(url), options });
    }
    postMessage(data, transfer = []) {
      self.postMessage({ type: 'rx:thread-post', id: this.id, data, transfer }, transfer);
    }
    terminate() {
      workers.delete(this.id);
      self.postMessage({ type: 'rx:thread-terminate', id: this.id });
    }
  };
  self.addEventListener('message', ({ data }) => {
    if (data.type !== 'rx:thread-event') return;
    const worker = workers.get(data.id);
    if (worker && worker['on' + data.event]) {
      worker['on' + data.event](data.event === 'message' ? { data: data.data } : data.data);
    }
  });
  importScripts(new URL('worker.js', self.__randomxAssets.baseURL).href);
})();
