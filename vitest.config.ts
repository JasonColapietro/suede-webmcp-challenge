import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";

/*
 * Three quarters of the cores, never below 2. The floor matters: CI runs on
 * ubuntu-latest, which is a 2-vCPU standard runner for a private repo, and
 * 75% of 2 rounds down to a single fork — that would serialise all 358 test
 * files against the workflow's 30-minute budget. Expressed as an explicit
 * fork range rather than `maxWorkers: "75%"` because the forks pool maps that
 * onto maxThreads while minThreads keeps its own default, and the two
 * conflict at startup (RangeError before a single test runs).
 */
const TEST_FORKS = Math.max(2, Math.floor((cpus().length * 3) / 4));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup-isolated-sqlite.ts"],
    /*
     * Slight concurrency cap, not a strict one. ~19 test files spawn their OWN
     * child processes (vite-node workers, multiprocess claim/version races), so
     * the live process count is the worker pool PLUS those children; leaving a
     * few cores free keeps that headroom.
     *
     * Deliberately modest, because the cap is NOT what fixed the flakiness —
     * injecting fixed clocks did, and that is the part with evidence behind it
     * (the previously-flaky suites pass with the machine at load 400+). No
     * honest measurement of what this cap costs in wall-clock was possible:
     * every full-suite run during this work started with the box already at
     * load ~500 from other processes. So it is set to give the children room
     * without giving up much parallelism, rather than to a number some
     * benchmark justified.
     */
    pool: "forks",
    poolOptions: { forks: { minForks: 1, maxForks: TEST_FORKS } },
    /*
     * 5s (the default) is tight for a suite whose slowest tests legitimately
     * spawn and join OS processes. Raised so honest work isn't killed; still
     * far below the explicit 20-45s timeouts the genuinely long tests declare
     * for themselves, so a real hang is still caught rather than masked.
     */
    testTimeout: 15_000,
    /*
     * Hooks need the same treatment, and did not get it: this defaults to 10s,
     * which is tighter than the test budget above even though a hook can do
     * strictly more work than the test it wraps.
     *
     * `tests/runtime/provider.test.ts` is the case that matters. Its afterEach
     * calls `vi.resetModules()`, so every test in the file re-pays a cold
     * import of the provider module graph, and vitest bills that hook time
     * into the reported duration — measured at 36s for a single test on a
     * loaded machine. Nobody had it on a flaky list, which is the point: the
     * exposure was never limited to the suites that had been named.
     *
     * Matched to the test budget rather than guessed at. A hook that is
     * genuinely wedged is still caught by the job-level `timeout-minutes`.
     */
    hookTimeout: 15_000,
    include: [
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
      "packages/*/tests/**/*.test.ts",
      "packages/*/tests/**/*.test.tsx",
    ],
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
    },
  },
  /*
   * Match the transform Next actually ships. esbuild defaults .tsx to the
   * classic runtime, which requires `React` in scope at every call site — so
   * a component that renders correctly in production (Next compiles with the
   * automatic runtime) threw `React is not defined` the moment a test string-
   * rendered it. That pushed real structure out of pages to keep suites green:
   * the run receipt shipped without SiteNav because mounting it broke ten
   * pinned tests. Tests now exercise the same runtime the browser gets.
   */
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
