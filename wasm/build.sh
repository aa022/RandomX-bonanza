#!/bin/bash
set -e

SRCDIR="$(dirname "$0")/src/src"
OUTDIR="$(dirname "$0")"

SOURCES=(
  "$SRCDIR/randomx.cpp"
  "$SRCDIR/vm_interpreted.cpp"
  "$SRCDIR/vm_interpreted_light.cpp"
  "$SRCDIR/virtual_machine.cpp"
  "$SRCDIR/superscalar.cpp"
  "$SRCDIR/instruction.cpp"
  "$SRCDIR/instructions_portable.cpp"
  "$SRCDIR/aes_hash.cpp"
  "$SRCDIR/soft_aes.cpp"
  "$SRCDIR/blake2_generator.cpp"
  "$SRCDIR/blake2/blake2b.c"
  "$SRCDIR/argon2_core.c"
  "$SRCDIR/argon2_ref.c"
  "$SRCDIR/argon2_avx2.c"
  "$SRCDIR/argon2_ssse3.c"
  "$SRCDIR/dataset.cpp"
  "$SRCDIR/allocator.cpp"
  "$SRCDIR/reciprocal.c"
  "$SRCDIR/bytecode_machine.cpp"
  "$SRCDIR/wasm_jit_compiler.cpp"
  "$SRCDIR/wasm_jit_leb128.c"
  "$SRCDIR/wasm_jit_decode.c"
  "$SRCDIR/wasm_jit_inst.c"
  "$SRCDIR/wasm_jit_gen.c"
  "$SRCDIR/wasm_jit_threaded.c"
  "$SRCDIR/wasm_jit_superscalar.cpp"
  "$SRCDIR/wasm_jit_run.cpp"
  "$SRCDIR/vm_compiled.cpp"
  "$SRCDIR/vm_compiled_light.cpp"
  "$SRCDIR/virtual_memory.c"
  "$SRCDIR/cpu.cpp"
)

EXPORTED_FUNCTIONS='[
  "_randomx_alloc_cache",
  "_randomx_init_cache",
  "_randomx_alloc_dataset",
  "_randomx_init_dataset",
  "_randomx_dataset_item_count",
  "_randomx_create_vm",
  "_randomx_vm_set_cache",
  "_randomx_vm_set_dataset",
  "_randomx_calculate_hash",
  "_randomx_calculate_hash_first",
  "_randomx_calculate_hash_next",
  "_randomx_calculate_hash_last",
  "_randomx_destroy_vm",
  "_randomx_release_cache",
  "_randomx_release_dataset",
  "_randomx_get_flags",
  "_randomx_get_dataset_memory",
  "_rxSetJitEnabled",
  "_rxGetRoundingModePtr",
  "_rxjit_set_max_memory_pages",
  "_rxjit_set_feature",
  "_rxjit_test_generate",
  "_rxjit_test_generate_static",
  "_rxjit_stat_runs",
  "_rxjit_stat_fails",
  "_rxjit_stat_static_init_attempts",
  "_rxjit_stat_static_init_failures",
  "_rxjit_stat_static_compile_us",
  "_rxjit_stat_dyn_compile_us",
  "_rxjit_stat_run_us",
  "_rxjit_stat_reset",
  "_rxjit_record_timing",
  "_rxjit_err_buf_ptr",
  "_rxjit_err_buf_size",
  "_rxjit_set_experiment_reuse_module",
  "_rxjit_get_experiment_reuse_module",
  "_rxjit_set_use_threaded_interp",
  "_rxjit_set_regs_in_memory",
  "_rxjit_set_split_inner_dispatch",
  "_rxjit_set_supjit_enabled",
  "_rxjit_get_supjit_enabled",
  "_rxjit_stat_threaded_module_size",
  "_rxjit_stat_threaded_entries",
  "_rxjit_stat_threaded_phase",
  "_rxjit_record_run_us_sample",
  "_rxjit_get_samples_ptr",
  "_rxjit_get_samples_capacity",
  "_rxjit_get_samples_count",
  "_rxMulh",
  "_rxSmulh",
  "_rxSoftroundAdd",
  "_rxSoftroundSub",
  "_rxSoftroundMul",
  "_rxSoftroundDiv",
  "_rxSoftroundSqrt",
  "_rxInitDatasetParallel",
  "_rxInitDatasetStart",
  "_rxInitDatasetProgress",
  "_rxInitDatasetJoin",
  "_rxMineBatchParallel",
  "_rxCreateMiningContext",
  "_rxMineBatchContext",
  "_rxDestroyMiningContext",
  "_rxProfileSetEnabled",
  "_rxProfileReset",
  "_rxProfileGetInitMs",
  "_rxProfileGetRunMs",
  "_rxProfileGetBytecodeMs",
  "_rxProfileGetFinalMs",
  "_rxProfileGetHashes",
  "_malloc",
  "_free"
]'

echo "Building RandomX WASM..."
MEMORY_FLAGS=(
  -s ALLOW_MEMORY_GROWTH=1
  -s MAXIMUM_MEMORY=4294967296
)

if [ "${FIXED_MEMORY:-0}" = "1" ]; then
  MEMORY_FLAGS=(
    -s ALLOW_MEMORY_GROWTH=0
    -s INITIAL_MEMORY="${INITIAL_MEMORY:-3221225472}"
    -s MAXIMUM_MEMORY="${MAXIMUM_MEMORY:-3221225472}"
  )
  echo "Using fixed shared memory: ${INITIAL_MEMORY:-3221225472} bytes"
fi

emcc -O3 -flto -DNDEBUG -msimd128 -pthread \
  -s WASM=1 \
  -s USE_PTHREADS=1 \
  -s PTHREAD_POOL_SIZE=32 \
  "${MEMORY_FLAGS[@]}" \
  -s SHARED_MEMORY=1 \
  -s EXPORTED_FUNCTIONS="$EXPORTED_FUNCTIONS" \
  -s EXPORTED_RUNTIME_METHODS='["cwrap","ccall","HEAPU8","wasmMemory"]' \
  -s MODULARIZE=1 \
  -s EXPORT_NAME="createRandomX" \
  -s ENVIRONMENT='web,worker,node' \
  -s NO_EXIT_RUNTIME=1 \
  -s DISABLE_EXCEPTION_CATCHING=0 \
  -I "$SRCDIR" \
  -I "$SRCDIR/blake2" \
  "${SOURCES[@]}" \
  -o "$OUTDIR/randomx.js"

cp "$OUTDIR/randomx.js" "$OUTDIR/../public/randomx.js"
cp "$OUTDIR/randomx.wasm" "$OUTDIR/../public/randomx.wasm"
if [ -f "$OUTDIR/randomx.worker.js" ]; then
  cp "$OUTDIR/randomx.worker.js" "$OUTDIR/../public/randomx.worker.js"
fi

echo "Build complete: $OUTDIR/randomx.js + $OUTDIR/randomx.wasm"
echo "Copied to public/"
ls -lh "$OUTDIR/randomx.js" "$OUTDIR/randomx.wasm" "$OUTDIR"/randomx.worker.js 2>/dev/null || true
