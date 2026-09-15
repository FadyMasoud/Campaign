import type { Metadata } from 'next'
import { IBM_Plex_Mono, IBM_Plex_Sans, IBM_Plex_Serif } from 'next/font/google'
import './globals.css'

/*
 * Typography: one family, three voices.
 *
 * IBM Plex was drawn as a single system, so the serif, the grotesque and the
 * mono share proportions and a common skeleton. That is what carries the
 * "classic format" half of the brief: headings set in the serif give the
 * screens an editorial weight that lets the palette be bright without the
 * whole thing reading as a toy.
 *
 *   Serif   headings and figures with something to say
 *   Sans    everything a person operates — labels, buttons, navigation
 *   Mono    numbers that must line up, and identifiers meant to be copied
 *
 * next/font downloads these at BUILD time and self-hosts them, so nothing is
 * requested from Google at run time: no third-party connection from the
 * reader's browser, and no layout shift while a font loads.
 */

const plexSans = IBM_Plex_Sans({
  variable: '--font-plex-sans',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
})

const plexSerif = IBM_Plex_Serif({
  variable: '--font-plex-serif',
  subsets: ['latin'],
  weight: ['400', '600'],
  display: 'swap',
})

const plexMono = IBM_Plex_Mono({
  variable: '--font-plex-mono',
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Campaign Portal',
  description: 'Multi-tenant client campaign portal',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  /*
   * English only. An Arabic edition was in the original plan and has been
   * dropped deliberately — it is not in the brief, and a half-translated
   * interface is worse than an untranslated one.
   *
   * The stylesheets keep their logical properties (margin-inline,
   * inset-inline-start, text-align: start) regardless. They cost nothing, they
   * read no worse than left and right, and they mean a right-to-left edition
   * would be a `dir` attribute rather than a second stylesheet.
   */
  return (
    <html
      lang="en"
      dir="ltr"
      className={`${plexSans.variable} ${plexSerif.variable} ${plexMono.variable}`}
    >
      {/*
        The footer is deliberately NOT here. It belongs to the portal shell and
        is rendered by the portal layout, so sign-in, /no-access and the public
        shared report have no footer at all — a bar reading "Campaign Portal ·
        Velocity Growth" under a stranger's one-campaign report is chrome from
        an application they have no account for.
      */}
      <body>{children}</body>
    </html>
  )
}
