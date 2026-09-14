import type { Metadata } from 'next'
import { signOut } from '@/lib/auth/actions'
import styles from './no-access.module.css'

export const metadata: Metadata = {
  title: 'No brand access · Campaign Portal',
}

export const dynamic = 'force-dynamic'

/**
 * A real, verified account that belongs to no brand.
 *
 * This is not a hypothetical. Google sign-in will happily authenticate anyone
 * with a Google account, and they arrive as a genuinely signed-in user. What
 * they must not arrive at is data. Authentication answers "who are you";
 * membership of a brand answers "may you be here", and only the second one
 * opens anything.
 *
 * The page says what happened in plain words and offers the way out. It names
 * no brand and shows no numbers, because a stranger should not learn from an
 * error screen which brands exist or how large they are.
 */
export default function NoAccessPage() {
  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <p className={styles.eyebrow}>Campaign Portal</p>
        <h1 className={styles.title}>This account has no brand</h1>

        <p className={styles.body}>
          You are signed in, but the account is not attached to any of the
          brands in this portal, so there is nothing here for it to show.
        </p>

        <p className={styles.body}>
          If you should have access, ask the person who runs the portal to add
          your account to a brand. Signing in again will not change it — access
          is granted per account, not per sign-in method.
        </p>

        <form action={signOut}>
          <button type="submit" className={styles.button}>
            Sign out
          </button>
        </form>
      </div>
    </main>
  )
}
