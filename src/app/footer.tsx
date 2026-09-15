import styles from './footer.module.css'

/**
 * The site footer, rendered once in the root layout so it appears on every
 * page — portal, sign-in, and the public shared report alike.
 *
 * It sits beside the sidebar rather than underneath it. The rail is
 * `position: fixed`, so a full-width footer would run behind it; the offset is
 * applied in CSS with `:has()`, which lets one footer serve both the pages
 * that have a sidebar and the ones that do not, without the component needing
 * to know which route it is on.
 */
export function SiteFooter() {
  const year = new Date().getFullYear()

  return (
    <footer className={styles.footer}>
      <p className={styles.line}>
        <span className={styles.name}>Campaign Portal</span>
        <span className={styles.sep} aria-hidden="true">·</span>
        <span>Built for Velocity Growth</span>
        <span className={styles.sep} aria-hidden="true">·</span>
        <span>{year}</span>
      </p>
      <p className={styles.note}>
        Each brand sees only its own data. Enforced in the database, not in this
        interface.
      </p>
    </footer>
  )
}
