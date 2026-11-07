cmake_minimum_required(VERSION 3.22.1)

project(lecturnhighlights LANGUAGES C)

set(LECTURN_HIGHLIGHTS_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../..")

add_library(
  lecturnhighlights SHARED
  lecturn_highlights_jni.c
  "${LECTURN_HIGHLIGHTS_ROOT}/cpp/lecturn_highlights.c"
  "${LECTURN_HIGHLIGHTS_ROOT}/Vendor/highlights/highlights.c"
  "${LECTURN_HIGHLIGHTS_ROOT}/Vendor/wasm2c/wasm-rt-impl.c"
  "${LECTURN_HIGHLIGHTS_ROOT}/Vendor/wasm2c/wasm-rt-mem-impl.c"
)

target_include_directories(
  lecturnhighlights
  PRIVATE "${LECTURN_HIGHLIGHTS_ROOT}/cpp" "${LECTURN_HIGHLIGHTS_ROOT}/Vendor"
          "${LECTURN_HIGHLIGHTS_ROOT}/Vendor/highlights" "${LECTURN_HIGHLIGHTS_ROOT}/Vendor/wasm2c"
)

# Plain malloc memory with explicit bounds checks: no guard-page signal
# handlers competing with ART's.
target_compile_definitions(
  lecturnhighlights PRIVATE WASM_RT_USE_MMAP=0 WASM_RT_MEMCHECK_BOUNDS_CHECK=1
                       WASM_RT_SKIP_SIGNAL_RECOVERY=1
)

# The lexers are generated code; keep them fast in debug builds too.
target_compile_options(lecturnhighlights PRIVATE -O2)

target_link_options(
  lecturnhighlights PRIVATE "-Wl,-z,common-page-size=16384" "-Wl,-z,max-page-size=16384"
)
