import type { Metadata } from 'next'
import { LoginForm } from './login-form'
import styles from './login.module.css'

export const metadata: Metadata = {
  title: 'Sign in · Campaign Portal',
}

/*
 * Reads the query string, so it cannot be pre-rendered at build time.
 */
export const dynamic = 'force-dynamic'

export default async function LoginPage({
  searchParams,
}: {
  // In Next.js 16 searchParams is a Promise: the framework resolves the
  // request lazily, so a page that never reads it can still be static.
  searchParams: Promise<{ next?: string; error?: string }>
}) {
  const params = await searchParams

  // Only a same-origin path is ever passed on. The value is re-checked in the
  // Server Action too — this is the tidy version, that one is the enforced one.
  const requested = params.next
  const next = requested?.startsWith('/') && !requested.startsWith('//') ? requested : '/portal'

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <header className={styles.header}>
          <p className={styles.eyebrow}>Campaign Portal</p>
          <h1 className={styles.title}>Sign in</h1>
          <p className={styles.lede}>
            Each account belongs to one brand and sees only that brand&rsquo;s
            customers, campaigns and results.
          </p>
        </header>

        <LoginForm next={next} errorCode={params.error} />
      </div>
    </main>
  )
}
