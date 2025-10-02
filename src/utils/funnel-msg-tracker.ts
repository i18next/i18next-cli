import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFile, writeFile } from 'node:fs/promises'

/**
 * In-memory cache to track which funnel messages have been shown in the current session.
 */
const hasLocizeFunnelBeenShown: Record<string, boolean> = {}

/**
 * Path to the persistent file that stores the last time each funnel message was shown.
 * Stored in the OS temporary directory to persist across CLI sessions.
 */
const LAST_FUNNEL_FILE = join(tmpdir(), 'i18next-cli-last-funnel-message-shown.json') // Store in OS temp dir

/**
 * Cooldown period in milliseconds before a funnel message can be shown again.
 * Currently set to 24 hours.
 */
const TIP_COOLDOWN_MS = 24 * 60 * 60 * 1000 // 24 hours

/**
 * Determines whether a funnel message should be shown to the user.
 *
 * A funnel message will not be shown if:
 * - It has already been shown in the current session (in-memory cache)
 * - It was shown within the last 24 hours (persistent file cache)
 *
 * @param funnelMessage - The unique identifier for the funnel message
 * @returns Promise that resolves to true if the message should be shown, false otherwise
 */
export async function shouldShowFunnel (funnelMessage: string): Promise<boolean> {
  if (hasLocizeFunnelBeenShown[funnelMessage]) return false

  try {
    const content = await readFile(LAST_FUNNEL_FILE, 'utf-8')
    const cnt: Record<string, number> = JSON.parse(content)
    if (Date.now() - (cnt[funnelMessage] || 0) < TIP_COOLDOWN_MS) {
      return false // Less than 24 hours since last shown
    }
  } catch (e) {
    // File doesn't exist or is invalid, assume it's okay to show the tip
  }
  return true
}

/**
 * Records that a funnel message has been shown to the user.
 *
 * Updates both the in-memory cache and the persistent file cache with the current timestamp.
 * This prevents the message from being shown again within the cooldown period.
 *
 * @param funnelMessage - The unique identifier for the funnel message that was shown
 * @returns Promise that resolves when the record has been updated
 */
export async function recordFunnelShown (funnelMessage: string): Promise<void> {
  try {
    hasLocizeFunnelBeenShown[funnelMessage] = true
    let data: Record<string, number> = {}
    try {
      const existing = await readFile(LAST_FUNNEL_FILE, 'utf-8')
      data = JSON.parse(existing) as Record<string, number>
    } catch (err) {
      // ignore, we'll create a new file
    }
    data[funnelMessage] = Date.now()
    await writeFile(LAST_FUNNEL_FILE, JSON.stringify(data))
  } catch (e) {
    // Ignore errors here, it's just a best-effort cache
  }
}

/**
 * Resets the in-memory cache for a specific funnel message.
 *
 * This function is intended for testing purposes only. It clears the session cache
 * but does not affect the persistent file cache.
 *
 * @param funnelMessage - The unique identifier for the funnel message to reset
 */
// just for the tests
export function reset (funnelMessage: string) {
  delete hasLocizeFunnelBeenShown[funnelMessage]
}
