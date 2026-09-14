import { BASIS_EXPLANATION, BASIS_LABEL, type Basis } from '@/lib/analytics/queries'
import styles from './basis.module.css'

/**
 * The device that answers "say on the screen which way you counted".
 *
 * Every figure in the portal carries one of these. It is deliberately a
 * visible chip rather than a tooltip: a number whose basis is only revealed on
 * hover is a number most people will read without its basis, and on a phone
 * there is no hover at all.
 *
 * `<abbr title>` gives the longer explanation to anyone who wants it, and
 * screen readers announce it, without hiding the short label from anybody.
 */
export function BasisTag({ basis }: { basis: Basis }) {
  return (
    <abbr className={styles[basis]} title={BASIS_EXPLANATION[basis]}>
      {BASIS_LABEL[basis]}
    </abbr>
  )
}

/**
 * A stated counting rule, shown next to the number it governs rather than in a
 * footnote. If two careful people could count something two ways, the way we
 * counted it is written here.
 */
export function CountingRule({ children }: { children: React.ReactNode }) {
  return <p className={styles.rule}>{children}</p>
}
