import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const createRandomX = require(join(__dirname, '..', 'public', process.env.RX_BUILD === 'st' ? 'randomx_st.js' : 'randomx.js'));

async function test() {
  const Module = await createRandomX();

  const randomx_get_flags = Module.cwrap('randomx_get_flags', 'number', []);
  const randomx_alloc_cache = Module.cwrap('randomx_alloc_cache', 'number', ['number']);
  const randomx_init_cache = Module.cwrap('randomx_init_cache', null, ['number', 'number', 'number']);
  const randomx_create_vm = Module.cwrap('randomx_create_vm', 'number', ['number', 'number', 'number']);
  const randomx_calculate_hash = Module.cwrap('randomx_calculate_hash', null, ['number', 'number', 'number', 'number']);
  const randomx_destroy_vm = Module.cwrap('randomx_destroy_vm', null, ['number']);
  const randomx_release_cache = Module.cwrap('randomx_release_cache', null, ['number']);

  const key = "RandomX example key\0";
  const input = "RandomX example input\0";

  const keyBuf = Module._malloc(key.length);
  const inputBuf = Module._malloc(input.length);
  const hashBuf = Module._malloc(32);

  for (let i = 0; i < key.length; i++) {
    Module.HEAPU8[keyBuf + i] = key.charCodeAt(i);
  }
  for (let i = 0; i < input.length; i++) {
    Module.HEAPU8[inputBuf + i] = input.charCodeAt(i);
  }

  console.log('Flags:', randomx_get_flags());

  console.log('Allocating cache...');
  const flags = 0; // RANDOMX_FLAG_DEFAULT (portable, interpreted, soft AES)
  const cache = randomx_alloc_cache(flags);
  if (!cache) { console.error('Failed to allocate cache'); process.exit(1); }

  console.log('Initializing cache (this takes ~10-30s for 256MB Argon2)...');
  const t0 = Date.now();
  randomx_init_cache(cache, keyBuf, key.length);
  console.log(`Cache initialized in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  console.log('Creating VM...');
  const vm = randomx_create_vm(flags, cache, 0);
  if (!vm) { console.error('Failed to create VM'); process.exit(1); }

  console.log('Calculating hash...');
  const t1 = Date.now();
  randomx_calculate_hash(vm, inputBuf, input.length, hashBuf);
  console.log(`Hash calculated in ${Date.now() - t1}ms`);

  const hash = [];
  for (let i = 0; i < 32; i++) {
    hash.push(Module.HEAPU8[hashBuf + i].toString(16).padStart(2, '0'));
  }
  const got = hash.join('');
  const expected = '8a48e5f9db45ab79d9080574c4d81954fe6ac63842214aff73c244b26330b7c9';
  console.log('Hash:    ', got);
  console.log('Expected:', expected);

  randomx_destroy_vm(vm);
  randomx_release_cache(cache);
  Module._free(keyBuf);
  Module._free(inputBuf);
  Module._free(hashBuf);

  if (got !== expected) {
    console.error('\nFAIL - hash does not match canonical RandomX test vector.');
    process.exit(1);
  }
  console.log('\nPASS - hash matches canonical RandomX test vector.');
}

test().catch((err) => { console.error(err); process.exit(1); });
