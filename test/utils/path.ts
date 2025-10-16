/**
 * Normalize a file path to use forward slashes.
 */
export function normalizePath (p: string | undefined): string {
  if (typeof p !== 'string') return ''
  return p.replace(/\\/g, '/')
}

/**
 * Case-sensitive endsWith that is safe for Windows and POSIX paths.
 */
export function pathEndsWith (p: string | undefined, what: string): boolean {
  const np = normalizePath(p)
  const nw = normalizePath(what)
  return nw.length > 0 && np.endsWith(nw)
}
