import type { Metadata } from 'next'
import { IBM_Plex_Sans, IBM_Plex_Sans_Arabic, IBM_Plex_Serif } from 'next/font/google'
import './globals.css'

/*
 * Typography: one family across three scripts.
 *
 * IBM Plex was drawn as a single system with matching Latin and Arabic faces,
 * so English and Arabic share proportions, weight and voice instead of looking
 * like two different products bolted together. That is the whole argument for
 * choosing it over pairing, say, Inter with Tajawal.
 *
 * next/font downloads these at BUILD time and self-hosts them. Nothing is
 * requested from Google at run time, which means no third-party connection
 * from the user's browser and no layout shift while a font loads.
 */

const plexSans = IBM_Plex_Sans({
  variable: '--font-plex-sans',
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
})

const plexSerif = IBM_Plex_Serif({
  variable: '--font-plex-serif',
  subsets: ['latin'],
  weight: ['400', '600'],
  display: 'swap',
})

const plexArabic = IBM_Plex_Sans_Arabic({
  variable: '--font-plex-arabic',
  subsets: ['arabic'],
  weight: ['400', '500', '600'],
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
   * `lang` and `dir` are hard-coded to English for now. In the language phase
   * they become dynamic, and that single change is what flips the entire UI to
   * right-to-left — because every stylesheet in this project uses logical
   * properties (margin-inline, padding-block, inset-inline-start) instead of
   * left/right. The browser resolves "inline-start" against `dir`, so the
   * layout mirrors itself with no RTL-specific CSS to maintain.
   */
  return (
    <html
      lang="en"
      dir="ltr"
      className={`${plexSans.variable} ${plexSerif.variable} ${plexArabic.variable}`}
    >
      <body>{children}</body>
    </html>
  )
}
