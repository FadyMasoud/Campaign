import styles from './footer.module.css'

/**
 * The footer, rendered by the portal layout — not by the root layout.
 *
 * So it appears on the signed-in portal and nowhere else. Sign-in,
 * /no-access and the public shared report have no footer: a bar reading
 * "Campaign Portal · Velocity Growth" under a stranger's one-campaign report
 * is chrome from an application they have no account for, and the isolation
 * note beneath it is addressed to someone who is signed in.
 *
 * It sits beside the sidebar rather than underneath it. The rail is
 * `position: fixed`, so the offset is a plain margin in CSS — no `:has()`,
 * because the footer now only ever renders on a page that has the rail.
 */
export function SiteFooter() {
  const year = new Date().getFullYear()

  return (
    <footer className={styles.footer}>
      <p className={styles.line}>
        <span className={styles.name}>Campaign Portal</span>
        <span className={styles.sep} aria-hidden="true">·</span>
        <span>Velocity Growth</span>
        <span className={styles.sep} aria-hidden="true">·</span>
        <span>{year}</span>
      </p>
      <p className={styles.note}>
        Each brand sees only its own data — enforced in the database, not in
        this interface.
      </p>
    </footer>
  )
}
