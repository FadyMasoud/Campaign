import { config } from 'dotenv'
import { defineConfig } from 'vitest/config'

/*
 * Tests need the same secrets the server uses, but they are NOT running inside
 * Next.js, so nothing loads .env.local for them. This line does it explicitly.
 *
 * The isolation test we write in the next phase deliberately connects to the
 * real hosted database as two different users and proves one cannot see the
 * other's rows. That means these are integration tests against a live service,
 * not unit tests — hence the generous timeout and the network dependency.
 */
config({ path: '.env.local' })

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
