# RandomX bonanza — build / serve / test / bench harness.
# wasm/build.sh is the single source of truth for compiler flags.

SHELL        := /bin/bash
.SHELLFLAGS  := -eu -o pipefail -c
MAKEFLAGS    += --no-print-directory
.DELETE_ON_ERROR:

ROOT         := $(CURDIR)
WASM_DIR     := $(ROOT)/wasm
SRC_DIR      := $(WASM_DIR)/src/src
PUBLIC_DIR   := $(ROOT)/public
BENCH_DIR    := $(ROOT)/bench
PROXY        := $(ROOT)/proxy/index.js
STAMP_DIR    := $(ROOT)/.make
DEPS_STAMP   := $(STAMP_DIR)/deps-ok

UNAME_S      := $(shell uname -s 2>/dev/null)

WASM_SRC_FILES := $(shell find $(SRC_DIR) -maxdepth 2 \
                    \( -name '*.c' -o -name '*.cpp' \
                       -o -name '*.h' -o -name '*.hpp' \) 2>/dev/null)
WASM_DEPS      := $(WASM_DIR)/build.sh $(WASM_DIR)/wasm_softround.h $(WASM_DIR)/aes_relaxed/aes_relaxed.c $(WASM_SRC_FILES)
WASM_WASM      := $(PUBLIC_DIR)/randomx.wasm
WASM_JS        := $(PUBLIC_DIR)/randomx.js
WASM_ST        := $(PUBLIC_DIR)/randomx_st.wasm $(PUBLIC_DIR)/randomx_st.js
WASM_OUT       := $(WASM_WASM) $(WASM_JS) $(WASM_ST)

# Bench knobs — override on the command line, eg. `make bench DURATION=10`.
SWEEP        ?= 1,4,10,32
INIT_THREADS ?= 32
DURATION     ?= 30
PROFILE      ?= auto
EXTRA        ?=

.PHONY: all help install build embed serve bench bench-light test test-embed clean fclean re

# Target dep graph:
#   install ──→ deps stamp ──→ public/randomx{,_st}.{js,wasm} ──→ build
#                                                                  ├──→ serve
#                                                                  ├──→ test
#                                                                  ├──→ embed → dist/
#                                                                  └──→ bench, bench-light
#   test-embed      standalone (reads public/*.js, no wasm build needed)
#   clean → fclean → re ──→ build
#
# Every target that needs the wasm build carries the deps stamp, so on a cold
# tree it runs the toolchain check first.

# ─── help ───────────────────────────────────────────────────────────────
all: help

help:
	@printf 'RandomX bonanza — make targets\n'
	@printf '  install      verify toolchain (emcc, clang, wasm-opt, node)\n'
	@printf '  build        compile public/randomx{,_st}.{js,wasm}\n'
	@printf '  serve        build + run the proxy on http://localhost:8080\n'
	@printf '  test         canonical RandomX hash vs. reference test vector\n'
	@printf '  embed        build + package the jsDelivr embed into dist/\n'
	@printf '  test-embed   embed lifecycle and consent tests\n'
	@printf '  bench        full-mode hashrate sweep (mirrors the webui)\n'
	@printf '  bench-light  light-mode sweep, incl. full-dataset workers (RAM-capped at 60%%)\n'
	@printf '  clean        remove build outputs\n'
	@printf '  fclean       clean + drop .make/ stamps\n'
	@printf '  re           fclean + build\n'
	@printf '\n'
	@printf 'Bench knobs:  SWEEP=$(SWEEP)  INIT_THREADS=$(INIT_THREADS)  DURATION=$(DURATION)  PROFILE=$(PROFILE)\n'
	@printf '              PROFILE: JIT generator profile, auto (x86 on x86-64 hosts, else arm) | arm | x86\n'
	@printf '              EXTRA=<bench_webui flags> passed through to every pass\n'

# ─── install / toolchain check ──────────────────────────────────────────
# Per-platform install hints surfaced inline on failure — no sub-make.
ifeq ($(UNAME_S),Darwin)
  HINT_EMCC     := brew install emscripten   (or upstream emsdk: https://emscripten.org/docs/getting_started/downloads.html)
  HINT_CLANG    := xcode-select --install   OR   brew install llvm
  HINT_WASM_OPT := brew install binaryen
  HINT_NODE     := brew install node   OR   nvm install --lts
else
  HINT_EMCC     := apt install emscripten   |   dnf install emscripten   |   pacman -S emscripten
  HINT_CLANG    := apt install clang        |   dnf install clang        |   pacman -S clang
  HINT_WASM_OPT := apt install binaryen     |   dnf install binaryen     |   pacman -S binaryen
  HINT_NODE     := apt install nodejs       |   dnf install nodejs       |   pacman -S nodejs   (or nvm install --lts)
endif

install: $(DEPS_STAMP)
	@printf '[install] toolchain OK — ws is vendored under vendor/, there is no package manager\n'

$(STAMP_DIR):
	@mkdir -p $@

$(DEPS_STAMP): | $(STAMP_DIR)
	@printf '[install] checking toolchain…\n'
	@miss=0; \
	check() { local p; p="$$(command -v "$$1" 2>/dev/null || true)"; \
	  if [ -z "$$p" ]; then \
	    printf '  [missing] %-9s → %s\n' "$$1" "$$2" >&2; miss=1; \
	  else \
	    printf '  [ok]      %-9s (%s)\n' "$$1" "$$p"; \
	  fi; }; \
	check emcc     "$(HINT_EMCC)"; \
	check clang    "$(HINT_CLANG)"; \
	check wasm-opt "$(HINT_WASM_OPT)"; \
	check node     "$(HINT_NODE)"; \
	if [ $$miss -ne 0 ]; then \
	  printf '\n[install] toolchain incomplete — install the items above and re-run `make install`.\n' >&2; \
	  exit 1; \
	fi
	@touch $@

# ─── wasm build ─────────────────────────────────────────────────────────
build: $(WASM_OUT)
	@printf '[build] public/randomx{,_st}.{js,wasm} ready\n'

# emcc emits both .js and .wasm in one go: .wasm carries the recipe, .js is
# a sibling with no recipe (its mtime is bumped by the same emcc call). The
# single-thread no-SAB build (randomx_st) comes from the same build.sh run.
$(WASM_WASM): $(DEPS_STAMP) $(WASM_DEPS)
	@printf '[build] emcc → public/randomx{,_st}.{js,wasm}\n'
	@if ! bash $(WASM_DIR)/build.sh; then \
	  printf '\n[build] FAILED — wasm/build.sh exited non-zero.\n' >&2; \
	  printf '        common causes:\n' >&2; \
	  printf '          • emsdk not sourced in this shell — `source <emsdk>/emsdk_env.sh`\n' >&2; \
	  printf '          • binaryen / clang missing       — re-run `make install`\n' >&2; \
	  printf '          • toolchain version drift        — see wasm/build.sh for flags\n' >&2; \
	  exit 1; \
	fi

$(WASM_JS) $(WASM_ST): $(WASM_WASM)

embed: build
	@node scripts/package-embed.mjs

test-embed:
	@node --test tests/embed.test.cjs

# ─── serve ──────────────────────────────────────────────────────────────
serve: build
	@printf '[serve] node proxy/index.js → http://localhost:8080\n'
	@node $(PROXY)

# ─── test / bench ───────────────────────────────────────────────────────
test: build
	@printf '[test] canonical RandomX hash\n'
	@node $(BENCH_DIR)/canonical_hash.mjs

# Default bench mirrors the webui worker exactly: full-memory dataset, async
# parallel init (rxInitDatasetStart/Progress/Join + supjit kernel), threaded-
# interpreter JIT with INLINE_FPRC_ZERO + V3 regs_in_memory + split_id. Each
# pass in SWEEP runs in a fresh node process so JIT/pthread state does not
# leak between thread counts.
bench: build
	@printf '[bench] register-file micro-bench (threaded-interpreter codegen)\n'
	@node $(BENCH_DIR)/bench_regfile.mjs
	@printf '\n[bench] full-memory hashrate — sweep %s @ %ss / pass, init=%s threads\n' \
	        '$(SWEEP)' '$(DURATION)' '$(INIT_THREADS)'
	@printf '        (~2.8 GiB RAM; supjit + async dataset init; fresh node process per pass)\n'
	@node $(BENCH_DIR)/bench_sweep.mjs \
	      --sweep $(SWEEP) --init-threads $(INIT_THREADS) --duration $(DURATION) \
	      --profile '$(PROFILE)' $(if $(EXTRA),--extra '$(EXTRA)')

# Light mode (no SharedArrayBuffer): one randomx_st worker per thread, as the
# browser's fallback. Fixed passes — the full sweep's thread counts, then 1 and
# 2 full-dataset workers — skipping any estimated above 60% of system RAM.
bench-light: build
	@node $(BENCH_DIR)/bench_light_sweep.mjs

# ─── clean ──────────────────────────────────────────────────────────────
BUILD_FILES := randomx.js randomx.wasm randomx.worker.js randomx_st.js randomx_st.wasm

clean:
	@rm -f $(addprefix $(PUBLIC_DIR)/,$(BUILD_FILES)) $(addprefix $(WASM_DIR)/,$(BUILD_FILES))
	@rm -f $(WASM_DIR)/aes_relaxed/aes_relaxed.wasm
	@printf '[clean] build outputs removed\n'

fclean: clean
	@rm -rf $(STAMP_DIR)
	@printf '[fclean] stamps removed\n'

re: fclean build
