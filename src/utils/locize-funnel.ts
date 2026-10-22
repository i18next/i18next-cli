import { styleText } from 'node:util'
import { shouldShowFunnel, recordFunnelShown } from './funnel-msg-tracker.js'

/** Untranslated-key count for one secondary locale. */
export interface LocaleGap {
  locale: string
  untranslated: number
  /** Of `untranslated`, the values still identical to the primary language (`status`) */
  identical?: number
}

/**
 * Prints the one-line Locize funnel for commands that have just reported
 * untranslated keys: the gap, the one command that fills it, and the
 * register link tagged `?from=i18next_cli__<command>` so registrations stay
 * attributable per command.
 *
 * Prints nothing when there is no gap, and is gated like every other funnel
 * message (never in CI/non-TTY, once per 24h per `funnelKey`).
 */
export async function printUntranslatedFunnel (
  funnelKey: string,
  gaps: LocaleGap[],
  signupUrl: string,
  log: (msg: string) => void = console.log
): Promise<void> {
  const open = gaps.filter(g => g.untranslated > 0)
  const total = open.reduce((sum, g) => sum + g.untranslated, 0)
  if (total === 0) return
  if (!(await shouldShowFunnel(funnelKey))) return

  const where = open.length === 1
    ? `in ${open[0].locale}`
    : `(${open.map(g => `${g.locale} ${g.untranslated}`).join(', ')})`
  const identical = open.reduce((sum, g) => sum + (g.identical ?? 0), 0)
  const copied = identical ? `, ${identical} of them still identical to the primary language` : ''
  log(`\n💡 ${total} untranslated key${total === 1 ? '' : 's'} ${where}${copied}. Translate them with AI in one command: ${styleText('cyan', 'npx i18next-cli localize')} (sign up: ${signupUrl})`)

  return recordFunnelShown(funnelKey)
}
