'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import styles from './shell.module.css'

/**
 * The left sidebar.
 *
 * A Client Component for two reasons and no others: it needs to know which
 * route is open, and on a phone it needs to open and close. No data passes
 * through it.
 *
 * On a narrow screen the rail becomes a drawer behind a menu button. It is
 * plain state rather than a CSS-only checkbox trick, because the drawer has to
 * close when a link is followed — otherwise you tap a section and the menu
 * stays over the page you asked for.
 */

type Section = { href: string; label: string; icon: React.ReactNode }

/*
 * Inline SVG rather than an icon package: nine small glyphs do not justify a
 * dependency, and these inherit currentColor so they follow the sidebar's
 * active state without a second set of rules.
 */
const icon = (path: React.ReactNode) => (
  <svg viewBox="0 0 20 20" aria-hidden="true" className={styles.icon}>
    {path}
  </svg>
)

const SECTIONS: Section[] = [
  {
    href: '/portal',
    label: 'Dashboard',
    icon: icon(
      <>
        <rect x="2.5" y="2.5" width="6" height="7" rx="1.5" />
        <rect x="11.5" y="2.5" width="6" height="4" rx="1.5" />
        <rect x="2.5" y="12.5" width="6" height="5" rx="1.5" />
        <rect x="11.5" y="9.5" width="6" height="8" rx="1.5" />
      </>,
    ),
  },
  {
    href: '/portal/contacts',
    label: 'Customers',
    icon: icon(
      <>
        <circle cx="7.5" cy="6.5" r="3" />
        <path d="M2 17c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
        <path d="M13.5 4.2a3 3 0 0 1 0 5.6M15 12.4c2 .7 3 2.4 3 4.6" />
      </>,
    ),
  },
  {
    href: '/portal/campaigns',
    label: 'Campaigns',
    icon: icon(
      <>
        <path d="M3 8.5v3a1.5 1.5 0 0 0 1.5 1.5H6l6 4V4.5l-6 4H4.5A1.5 1.5 0 0 0 3 10Z" />
        <path d="M15 7.5a4 4 0 0 1 0 5" />
      </>,
    ),
  },
  {
    href: '/portal/imports',
    label: 'Imports',
    icon: icon(
      <>
        <path d="M10 2.5v9" />
        <path d="m6.5 8.5 3.5 3.5 3.5-3.5" />
        <path d="M3 13.5v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />
      </>,
    ),
  },
]

export function PortalNav({
  brandName,
  brandCode,
  email,
  role,
  signOut,
}: {
  brandName: string
  brandCode: string
  email: string
  role: 'owner' | 'analyst'
  signOut: () => Promise<void>
}) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  const isCurrent = (href: string) =>
    href === '/portal' ? pathname === '/portal' : pathname.startsWith(href)

  return (
    <>
      {/* Only ever visible on a narrow screen; the rail itself is the nav on a
          laptop, so this would otherwise be a button with nothing to do. */}
      <div className={styles.mobileBar}>
        <button
          type="button"
          className={styles.menuButton}
          onClick={() => setOpen(true)}
          aria-expanded={open}
          aria-controls="portal-sidebar"
        >
          <svg viewBox="0 0 20 20" aria-hidden="true" className={styles.icon}>
            <path d="M3 5.5h14M3 10h14M3 14.5h14" />
          </svg>
          Menu
        </button>
        <span className={styles.mobileBrand}>{brandName}</span>
      </div>

      {/* Closes the drawer when the page behind it is tapped. Inert on a
          laptop, where the rail is always present. */}
      {open ? (
        <button
          type="button"
          className={styles.scrim}
          aria-label="Close menu"
          onClick={() => setOpen(false)}
        />
      ) : null}

      <aside
        id="portal-sidebar"
        className={open ? styles.sidebarOpen : styles.sidebar}
        aria-label="Portal sections"
      >
        <div className={styles.brandBlock}>
          <Link href="/portal" className={styles.brandLink} onClick={() => setOpen(false)}>
            <span className={styles.mark} aria-hidden="true">
              {brandCode.slice(0, 2)}
            </span>
            <span className={styles.brandText}>
              <span className={styles.brandName}>{brandName}</span>
              <span className={styles.brandEyebrow}>Campaign Portal</span>
            </span>
          </Link>
        </div>

        <nav className={styles.nav}>
          <ul className={styles.navList}>
            {SECTIONS.map((section) => {
              const current = isCurrent(section.href)
              return (
                <li key={section.href}>
                  <Link
                    href={section.href}
                    className={current ? styles.navLinkCurrent : styles.navLink}
                    aria-current={current ? 'page' : undefined}
                    onClick={() => setOpen(false)}
                  >
                    {section.icon}
                    {section.label}
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>

        <div className={styles.account}>
          <span className={role === 'owner' ? styles.roleOwner : styles.roleAnalyst}>
            {role === 'owner' ? 'Owner' : 'Analyst'}
          </span>
          <span className={styles.email}>{email}</span>
          <form action={signOut}>
            <button type="submit" className={styles.signOut}>
              Sign out
            </button>
          </form>
        </div>
      </aside>
    </>
  )
}
