import { config } from 'dotenv'

/*
 * Loads .env.local INSIDE the worker that runs the tests.
 *
 * Doing it in vitest.config.ts is not enough: that file is evaluated in the
 * main process, and Vitest runs each test file in a separate worker whose
 * process.env is a copy made before those variables existed. The tests then
 * see nothing. Running dotenv here puts the values where the test code
 * actually reads them.
 */
config({ path: '.env.local' })
