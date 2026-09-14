import Link from 'next/link'
import { requireBrand } from '@/lib/auth/dal'
import { signOut } from '@/lib/auth/actions'
import { PortalNav } from './nav'
import styles from './shell.module.css'

/**
 * The portal shell: brand and role resolved once, in one place.
 *
 * requireBrand() runs here rather than in each page, so a page added later
 * cannot forget it. It is wrapped in React's cache(), so the layout and the
 * page beneath it share one lookup instead of making two.
 *
 * This still is not the security boundary — the database is. A page that
 * somehow rendered without this layout would show no other brand's rows,
 * because the policies do not care which React component asked.
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const brand = await requireBrand()

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.identity}>
          <Link href="/portal" className={styles.brandLink}>
            <span className={styles.eyebrow}>Campaign Portal</span>
            <span className={styles.brandName}>{brand.brandName}</span>
          </Link>

          <span className={brand.role === 'owner' ? styles.roleOwner : styles.roleAnalyst}>
            {brand.role === 'owner' ? 'Owner' : 'Analyst'}
          </span>
        </div>

        <div className={styles.account}>
          <span className={styles.email}>{brand.email}</span>
          <form action={signOut}>
            <button type="submit" className={styles.signOut}>
              Sign out
            </button>
          </form>
        </div>
      </header>

      <PortalNav />

      {children}
    </div>
  )
}
