import { requireBrand } from '@/lib/auth/dal'
import { signOut } from '@/lib/auth/actions'
import { SiteFooter } from '../footer'
import { PortalNav } from './nav'
import styles from './shell.module.css'

/**
 * The portal shell: a fixed rail on the left, content beside it.
 *
 * requireBrand() runs here rather than in each page, so a page added later
 * cannot forget it, and it is wrapped in React's cache() so the layout and the
 * page beneath share one lookup.
 *
 * This still is not the security boundary — the database is. A page that
 * somehow rendered without this layout would show no other brand's rows,
 * because the policies do not care which React component asked.
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const brand = await requireBrand()

  return (
    <>
      <div className={styles.shell} data-portal-shell>
        <PortalNav
          brandName={brand.brandName}
          brandCode={brand.brandCode}
          email={brand.email}
          role={brand.role}
          signOut={signOut}
        />

        <div className={styles.content}>{children}</div>
      </div>

      {/* A sibling of the shell rather than a child of the content column, so
          it stays pinned to the viewport instead of scrolling away at the end
          of an 81,842-row table. */}
      <SiteFooter />
    </>
  )
}
