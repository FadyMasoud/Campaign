import { checkSupabaseHealth, type CheckStatus } from '@/lib/supabase/health'
import styles from './page.module.css'

/*
 * This page reads cookies and probes a live service, so its output is
 * different on every request and must never be cached or pre-rendered at
 * build time. `force-dynamic` says that explicitly rather than relying on
 * Next.js inferring it from the cookies() call inside the health check.
 */
export const dynamic = 'force-dynamic'

const STATUS_GLYPH: Record<CheckStatus, string> = {
  pass: '✓',
  fail: '✕',
  skip: '–',
}

export default async function SetupPage() {
  const report = await checkSupabaseHealth()

  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <p className={styles.eyebrow}>Setup diagnostic</p>

        <h1 className={styles.title}>Campaign Portal</h1>

        <p className={styles.lede}>
          A multi-tenant portal for three brands&rsquo; marketing teams. This
          screen is a setup diagnostic: it confirms the app can reach Supabase
          before we build anything on top of it.
        </p>

        <section className={styles.panel} aria-labelledby="checks-heading">
          <header className={styles.panelHeader}>
            <h2 id="checks-heading" className={styles.panelTitle}>
              Connection
            </h2>
            <span
              className={styles.badge}
              data-state={report.configured ? 'ok' : 'blocked'}
            >
              {report.configured ? 'Ready' : 'Setup required'}
            </span>
          </header>

          <ul className={styles.checks}>
            {report.checks.map((check) => (
              <li
                key={check.id}
                className={styles.check}
                data-status={check.status}
              >
                <span className={styles.checkGlyph} aria-hidden="true">
                  {STATUS_GLYPH[check.status]}
                </span>
                <div className={styles.checkBody}>
                  <p className={styles.checkLabel}>
                    {check.label}
                    {/* The glyph is decorative; screen readers get real words. */}
                    <span className="visually-hidden">: {check.status}</span>
                  </p>
                  <p className={styles.checkDetail}>{check.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {!report.configured && (
          <section className={styles.panel} aria-labelledby="next-heading">
            <header className={styles.panelHeader}>
              <h2 id="next-heading" className={styles.panelTitle}>
                To finish setup
              </h2>
            </header>
            <ol className={styles.steps}>
              <li>
                Create a project at{' '}
                <a
                  className={styles.link}
                  href="https://supabase.com/dashboard"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  supabase.com/dashboard
                </a>
                .
              </li>
              <li>
                Copy <code className={styles.code}>.env.example</code> to{' '}
                <code className={styles.code}>.env.local</code>.
              </li>
              <li>
                Paste in the Project URL and the publishable (anon) key from
                Project Settings → API Keys.
              </li>
              <li>
                Restart the dev server. Environment variables are read once at
                startup, so an edit to{' '}
                <code className={styles.code}>.env.local</code> does nothing
                until you do.
              </li>
            </ol>
          </section>
        )}
      </div>
    </main>
  )
}
