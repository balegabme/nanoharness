import { defineConfig } from 'vitest/config'

/**
 * The tests are the ones under `src/`, and only those.
 *
 * Vitest's default glob is the whole working directory, so anything a developer
 * happens to keep beside the repo is collected too, and fails for reasons
 * that have nothing to do with this project.
 */
/**
 * Vitest's 5 second default is a number for tests that do arithmetic. Several
 * here spawn real subprocesses, an MCP server that stalls on purpose or a
 * shell that has to actually run, because the bugs they cover are about a
 * process still being alive after this side gave up on it, which no fake
 * transport can have and none can leak.
 *
 * On Linux that costs milliseconds. On Windows a process launch is a few
 * hundred milliseconds, and the first shell of each test file sources a login
 * profile, which is seconds on an idle machine and tens of seconds on one that
 * is busy. The app reads that PATH once at startup; a test file is a process of
 * its own, and pays for the read unless it waits on `warmShell()` first. A
 * minute covers a loaded laptop and still ends a genuine hang while somebody
 * is watching it.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
