import styles from './states.module.css'

/*
 * Next.js renders this automatically while the async Server Component above it
 * is still working, then swaps in the real page. We get a loading state for
 * free simply by putting a file here with this name.
 *
 * It is a skeleton rather than a spinner because the shape of the page is
 * already known: showing that shape makes the wait feel shorter and stops the
 * layout jumping when content arrives.
 */
export default function Loading() {
  return (
    <main className={styles.page}>
      <div className={styles.container}>
        {/* aria-busy + a polite live region tells a screen-reader user that
            something is coming, instead of announcing silence. */}
        <div role="status" aria-busy="true">
          <span className="visually-hidden">Checking connection…</span>

          <div className={styles.skeleton} style={{ inlineSize: '8rem', blockSize: '0.75rem' }} />
          <div className={styles.skeleton} style={{ inlineSize: '60%', blockSize: '2.5rem' }} />
          <div className={styles.skeleton} style={{ inlineSize: '100%', blockSize: '1rem' }} />
          <div className={styles.skeleton} style={{ inlineSize: '85%', blockSize: '1rem' }} />
          <div className={styles.skeletonPanel} />
        </div>
      </div>
    </main>
  )
}
