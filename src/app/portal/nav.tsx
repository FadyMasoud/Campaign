'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import styles from './shell.module.css'

/**
 * A Client Component for one reason only: it needs to know which route is
 * open, to mark it current. Nothing else here is interactive, and no data
 * passes through it.
 *
 * `aria-current="page"` rather than styling alone, so the current section is
 * announced rather than merely coloured.
 */
const SECTIONS = [
  { href: '/portal', label: 'Dashboard' },
  { href: '/portal/contacts', label: 'Customers' },
  { href: '/portal/campaigns', label: 'Campaigns' },
  { href: '/portal/imports', label: 'Imports' },
] as const

export function PortalNav() {
  const pathname = usePathname()

  return (
    <nav className={styles.nav} aria-label="Portal sections">
      <ul className={styles.navList}>
        {SECTIONS.map((section) => {
          const current =
            section.href === '/portal' ? pathname === '/portal' : pathname.startsWith(section.href)

          return (
            <li key={section.href}>
              <Link
                href={section.href}
                className={current ? styles.navLinkCurrent : styles.navLink}
                aria-current={current ? 'page' : undefined}
              >
                {section.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
