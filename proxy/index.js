// Local demo proxy: serves the static webui on HTTP, bridges browser
// WebSocket sessions to a Monero pool over raw TCP stratum, and exposes
// the same bridge on a TCP port so xmrig / any standard stratum client
// can hit it too.
//
// Localhost is treated as a secure context by browsers, so SharedArrayBuffer
// + WASM pthreads work over plain HTTP as long as we send COOP/COEP — no
// certs needed for a local demo. For LAN access, add HTTPS yourself.

const net  = require('net');
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('../vendor/ws');
const config = require('../config');

const MIME = {
  '.html':  'text/html',
  '.js':    'application/javascript',
  '.wasm':  'application/wasm',
  '.css':   'text/css',
  '.woff2': 'font/woff2',
};

const publicDir = path.join(__dirname, '..', 'public');

function hexToBytes(hex) {
  const out = Buffer.alloc(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function targetToDiff(targetHex) {
  const raw = hexToBytes(targetHex);
  let target = 0n;
  if (raw.length === 4) {
    const t32 = BigInt(raw.readUInt32LE(0));
    if (t32 !== 0n) target = 0xffffffffffffffffn / (0xffffffffn / t32);
  } else if (raw.length === 8) {
    target = raw.readBigUInt64LE(0);
  } else if (raw.length >= 32) {
    target = raw.readBigUInt64LE(24);
  }
  return target ? Number(0xffffffffffffffffn / target) : 0;
}

// One client session = one upstream pool TCP socket. `tag` distinguishes
// browser ('ws') from xmrig ('tcp') sessions in the proxy log.
function createSession(tag, sendToClient) {
  let pool          = null;
  let poolBuffer    = '';
  let poolReady     = false;
  let minerId       = null;
  let pending       = [];
  let rewriteLogin  = true;
  // Random per-session suffix on the worker name so multiple browser tabs
  // sharing this proxy don't collide on the pool side.
  const sessionUid  = Math.random().toString(36).slice(2, 8);

  let currentHost   = config.POOL_HOST;
  let currentPort   = config.POOL_PORT;
  let walletOverride = null;
  let workerOverride = null;

  function sendToPool(msg) {
    const line = JSON.stringify(msg) + '\n';
    if (poolReady && pool && !pool.destroyed) pool.write(line);
    else pending.push(line);
  }

  function safeSendToClient(obj) {
    try { sendToClient(JSON.stringify(obj)); } catch (_) {}
  }

  function disconnectPool() {
    if (pool && !pool.destroyed) { try { pool.destroy(); } catch (_) {} }
    pool = null;
    poolReady = false;
    poolBuffer = '';
  }

  function connectPool() {
    // Capture this socket so async 'close'/'error' on a stale socket (from
    // a set_target-driven reconnect) doesn't tear down the new pool.
    const myPool = new net.Socket();
    pool = myPool;
    poolBuffer = '';
    myPool.connect(currentPort, currentHost, () => {
      if (pool !== myPool) return;
      console.log(`[${tag}/pool] connected ${currentHost}:${currentPort}`);
      poolReady = true;
      for (const line of pending) myPool.write(line);
      pending = [];
    });

    myPool.on('data', (data) => {
      if (pool !== myPool) return;
      poolBuffer += data.toString();
      const lines = poolBuffer.split('\n');
      poolBuffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.result && msg.result.id) minerId = msg.result.id;
          const job = (msg.result && msg.result.job) || (msg.method === 'job' && msg.params);
          if (job && job.target) {
            const diff = targetToDiff(job.target);
            console.log(`[${tag}/pool job] id ${job.job_id} diff ${diff || '?'}`);
          }
          safeSendToClient(msg);
        } catch (_) {
          console.error(`[${tag}/pool] bad JSON: ${line.slice(0, 80)}`);
        }
      }
    });

    myPool.on('error', (err) => {
      if (pool !== myPool) return;
      console.error(`[${tag}/pool] error: ${err.message}`);
      poolReady = false;
      safeSendToClient({ error: 'Pool connection error: ' + err.message });
    });

    myPool.on('close', () => {
      if (pool !== myPool) return;
      console.log(`[${tag}/pool] disconnected`);
      poolReady = false;
      safeSendToClient({ error: 'Pool disconnected' });
    });
  }

  connectPool();

  function onClientMessage(rawText) {
    try {
      const msg = JSON.parse(rawText);

      // Browser tells us which pool + wallet to use before login. We may
      // need to reconnect upstream if the host:port actually changed.
      if (msg.method === 'set_target') {
        const p = msg.params || {};
        const newHost   = p.host   ? String(p.host) : currentHost;
        const newPort   = p.port   ? Number(p.port) : currentPort;
        const newWallet = p.wallet ? String(p.wallet) : walletOverride;
        const newWorker = (typeof p.worker === 'string') ? p.worker : workerOverride;
        const changed   = newHost !== currentHost || newPort !== currentPort;
        currentHost = newHost;
        currentPort = newPort;
        walletOverride = newWallet;
        workerOverride = newWorker;
        console.log(`[${tag}/set_target] -> ${currentHost}:${currentPort}, wallet=${(walletOverride || config.WALLET).slice(0, 12)}…`);
        if (changed) {
          disconnectPool();
          pending = [];
          connectPool();
        }
        return;
      }

      if (msg.method === 'login' && rewriteLogin) {
        msg.params = msg.params || {};
        const baseLogin  = walletOverride || config.WALLET;
        const baseWorker = (workerOverride && workerOverride.trim()) || config.WORKER_NAME || 'x';
        const uniqueWorker = `${baseWorker}-${sessionUid}`;
        msg.params.login = baseLogin;
        // supportxmr reads worker from `pass`; xmrig-style pools read `rigid`.
        // Sending both keeps both happy.
        msg.params.pass  = uniqueWorker;
        msg.params.rigid = uniqueWorker;
        msg.params.agent = `gh-distro-miner/1.0 (${tag})`;
        msg.params.algo  = ['rx/0'];
        console.log(`[${tag}/login] worker=${uniqueWorker}`);
      }

      if (msg.method === 'submit' && minerId) {
        msg.params = msg.params || {};
        msg.params.id = minerId;
      }

      sendToPool(msg);
    } catch (e) {
      console.error(`[${tag}] bad client message: ${e.message}`);
    }
  }

  function onClientClose() {
    console.log(`[${tag}] client disconnected`);
    if (pool) pool.destroy();
  }

  return {
    onClientMessage,
    onClientClose,
    setLoginPassthrough() { rewriteLogin = false; },
  };
}

const requestHandler = (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { res.writeHead(400); res.end('bad request'); return; }

  const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  // Resolve relative to publicDir and reject anything that escapes it
  // (canonical defence against `..` traversal on the static server).
  const filePath = path.resolve(publicDir, relative);
  if (!filePath.startsWith(publicDir + path.sep) && filePath !== publicDir) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    const errPath = path.join(publicDir, '404.html');
    if (fs.existsSync(errPath) && fs.statSync(errPath).isFile()) {
      res.writeHead(404, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cross-Origin-Opener-Policy':   'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Cache-Control': 'no-store',
      });
      res.end(fs.readFileSync(errPath));
    } else {
      res.writeHead(404); res.end('not found');
    }
    return;
  }

  const ext = path.extname(filePath);
  // COOP+COEP make this origin crossOriginIsolated, which is required for
  // SharedArrayBuffer / WASM pthreads. wasm-unsafe-eval + unsafe-eval let
  // the C-side JIT instantiate dynamically-built WASM modules.
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cross-Origin-Opener-Policy':   'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' 'unsafe-inline'",
      "connect-src 'self' ws: wss:",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
    ].join('; '),
    'Cache-Control': 'no-store',
  });

  if (/\.html$/i.test(filePath)) {
    let html = fs.readFileSync(filePath, 'utf8');
    html = html
      .replace(/DEFAULT_WALLET_PLACEHOLDER/g,    config.WALLET    || '')
      .replace(/DEFAULT_POOL_HOST_PLACEHOLDER/g, config.POOL_HOST || '')
      .replace(/DEFAULT_POOL_PORT_PLACEHOLDER/g, String(config.POOL_PORT || ''));
    res.end(html);
    return;
  }

  fs.createReadStream(filePath).pipe(res);
};

const server = http.createServer(requestHandler);

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  console.log('[ws] browser connected');
  const session = createSession('ws', (text) => ws.send(text));
  ws.on('message', (data) => session.onClientMessage(data.toString()));
  ws.on('close',  ()      => session.onClientClose());
});

// Raw-TCP stratum front-door for xmrig and friends. They send their own
// login fields, so we don't rewrite anything for these clients.
const tcpServer = net.createServer((socket) => {
  console.log(`[tcp] stratum client ${socket.remoteAddress}:${socket.remotePort}`);
  const session = createSession('tcp', (text) => {
    if (!socket.destroyed) socket.write(text + '\n');
  });
  session.setLoginPassthrough();

  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) if (line.trim()) session.onClientMessage(line);
  });
  socket.on('close', () => session.onClientClose());
  socket.on('error', (err) => console.error('[tcp] socket error:', err.message));
});

tcpServer.listen(config.STRATUM_TCP_PORT, () => {
  console.log(`[tcp] stratum bridge on tcp://0.0.0.0:${config.STRATUM_TCP_PORT}`);
});

server.listen(config.WS_PORT, () => {
  console.log(`webminer demo on http://localhost:${config.WS_PORT}`);
  console.log(`pool: ${config.POOL_HOST}:${config.POOL_PORT}`);
  console.log(`wallet: ${config.WALLET.slice(0, 12)}…`);
});
