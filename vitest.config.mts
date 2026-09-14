import { defineConfig } from 'vitest/config'

/*
 * These are integration tests, not unit tests. The isolation suite connects to
 * the real hosted database as two different signed-in users and proves one
 * cannot see the other's rows — which is the only way to test a guarantee that
 * lives in the database rather than in the application. Hence the network
 * dependency and the generous timeouts.
 *
 * .env.local is loaded by tests/setup.ts rather than here, because this file is
 * evaluated in the main process while the tests run in a worker with its own
 * copy of process.env.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,

    /*
     * One database, shared by every test file, so they must not run at once.
     *
     * This was not a guess: with files running in parallel, the isolation
     * suite's temporary fixture users were attached to Kilele and Karoo while
     * the accounts suite was counting the members of those same brands, which
     * saw three members where there are two. Both suites were correct; the
     * concurrency was not.
     *
     * The alternative — giving each suite its own throwaway brands — would
     * weaken the accounts suite, whose entire point is to assert against the
     * six real logins that ship with the project.
     */
    fileParallelism: false,
  },
})
