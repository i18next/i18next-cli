import { describe, it, expect } from 'vitest'
import { transformFile } from '../src/instrumenter/core/transformer'
import type { CandidateString, I18nextToolkitConfig, ComponentBoundary, LanguageChangeSite } from '../src/types'

const mockConfig: Omit<I18nextToolkitConfig, 'plugins'> = {
  locales: ['en', 'de'],
  extract: {
    input: 'src/**/*.{ts,tsx,js,jsx}',
    output: 'locales/{{language}}/{{namespace}}.json',
    functions: ['t'],
    transComponents: ['Trans']
  }
}

describe('language change detection and transformation', () => {
  describe('transformer: language change site injection', () => {
    it('injects i18n.changeLanguage() before a call inside a component (arrow body)', () => {
      const content = `export function Settings() {
  return (
    <button onClick={() => updateSettings({ language: lang.code })}>
      Click
    </button>
  )
}`
      const components: ComponentBoundary[] = [{
        name: 'Settings',
        bodyStart: 28,
        bodyEnd: content.length - 1,
        hasUseTranslation: false
      }]

      const sites: LanguageChangeSite[] = [{
        languageExpression: 'lang.code',
        callStart: content.indexOf('updateSettings'),
        callEnd: content.indexOf('})') + 2,
        insideComponent: 'Settings',
        line: 3,
        column: 27
      }]

      const result = transformFile(content, 'Settings.tsx', [], {
        isDryRun: false,
        hasReact: true,
        isPrimaryLanguageFile: true,
        config: mockConfig,
        components,
        languageChangeSites: sites
      })

      expect(result.modified).toBe(true)
      expect(result.newContent).toContain('i18n.changeLanguage(lang.code)')
      expect(result.newContent).toContain('updateSettings({ language: lang.code })')
      // Should inject useTranslation with i18n destructured
      expect(result.newContent).toContain('const { i18n } = useTranslation()')
    })

    it('injects i18n.changeLanguage() wrapping arrow fn expression body', () => {
      const content = `export function App() {
  return <button onClick={() => setLang(code)}>Go</button>
}`
      // Find positions
      const callStart = content.indexOf('setLang(code)')
      const callEnd = callStart + 'setLang(code)'.length

      const components: ComponentBoundary[] = [{
        name: 'App',
        bodyStart: 22,
        bodyEnd: content.length - 1,
        hasUseTranslation: false
      }]

      const sites: LanguageChangeSite[] = [{
        languageExpression: 'code',
        callStart,
        callEnd,
        insideComponent: 'App',
        line: 2,
        column: 33
      }]

      const result = transformFile(content, 'App.tsx', [], {
        isDryRun: false,
        hasReact: true,
        isPrimaryLanguageFile: true,
        config: mockConfig,
        components,
        languageChangeSites: sites
      })

      expect(result.modified).toBe(true)
      // The arrow function body should be wrapped in braces
      expect(result.newContent).toContain('{ i18n.changeLanguage(code); setLang(code); }')
    })

    it('destructures both t and i18n when component has strings and language change', () => {
      const content = `export function Settings() {
  const msg = "Choose language"
  return <button onClick={() => updateSettings({ language: lng })}>{msg}</button>
}`
      const msgStart = content.indexOf('"Choose language"')
      const msgEnd = msgStart + '"Choose language"'.length
      const callStart = content.indexOf('updateSettings')
      const callEnd = content.indexOf('})') + 2

      const components: ComponentBoundary[] = [{
        name: 'Settings',
        bodyStart: 28,
        bodyEnd: content.length - 1,
        hasUseTranslation: false
      }]

      const candidates: CandidateString[] = [{
        content: 'Choose language',
        confidence: 0.9,
        offset: msgStart,
        endOffset: msgEnd,
        type: 'string-literal',
        file: 'Settings.tsx',
        line: 2,
        column: 14,
        key: 'chooseLanguage',
        insideComponent: 'Settings'
      }]

      const sites: LanguageChangeSite[] = [{
        languageExpression: 'lng',
        callStart,
        callEnd,
        insideComponent: 'Settings',
        line: 3,
        column: 33
      }]

      const result = transformFile(content, 'Settings.tsx', candidates, {
        isDryRun: false,
        hasReact: true,
        isPrimaryLanguageFile: true,
        config: mockConfig,
        components,
        languageChangeSites: sites
      })

      expect(result.modified).toBe(true)
      // Should have both t and i18n destructured
      expect(result.newContent).toContain('const { t, i18n } = useTranslation()')
      expect(result.newContent).toContain('i18n.changeLanguage(lng)')
      expect(result.newContent).toContain("t('chooseLanguage'")
    })

    it('upgrades existing { t } to { t, i18n } when component already has useTranslation', () => {
      const content = `export function Settings() {
  const { t } = useTranslation()
  return <button onClick={() => updateSettings({ language: lng })}>{t('save')}</button>
}`
      const callStart = content.indexOf('updateSettings')
      const callEnd = content.indexOf('})') + 2

      const components: ComponentBoundary[] = [{
        name: 'Settings',
        bodyStart: 28,
        bodyEnd: content.length - 1,
        hasUseTranslation: true
      }]

      const sites: LanguageChangeSite[] = [{
        languageExpression: 'lng',
        callStart,
        callEnd,
        insideComponent: 'Settings',
        line: 3,
        column: 33
      }]

      const result = transformFile(content, 'Settings.tsx', [], {
        isDryRun: false,
        hasReact: true,
        isPrimaryLanguageFile: true,
        config: mockConfig,
        components,
        languageChangeSites: sites
      })

      expect(result.modified).toBe(true)
      // Should upgrade the existing destructuring
      expect(result.newContent).toContain('const { t, i18n } = useTranslation()')
      expect(result.newContent).toContain('i18n.changeLanguage(lng)')
    })

    it('does not double-add i18n when already destructured', () => {
      const content = `export function Settings() {
  const { t, i18n } = useTranslation()
  return <button onClick={() => updateSettings({ locale: code })}>{t('save')}</button>
}`
      const callStart = content.indexOf('updateSettings')
      const callEnd = content.indexOf('})') + 2

      const components: ComponentBoundary[] = [{
        name: 'Settings',
        bodyStart: 28,
        bodyEnd: content.length - 1,
        hasUseTranslation: true
      }]

      const sites: LanguageChangeSite[] = [{
        languageExpression: 'code',
        callStart,
        callEnd,
        insideComponent: 'Settings',
        line: 3,
        column: 33
      }]

      const result = transformFile(content, 'Settings.tsx', [], {
        isDryRun: false,
        hasReact: true,
        isPrimaryLanguageFile: true,
        config: mockConfig,
        components,
        languageChangeSites: sites
      })

      expect(result.modified).toBe(true)
      // Should NOT duplicate the i18n destructuring
      expect(result.newContent).not.toContain('{ t, i18n, i18n }')
      expect(result.newContent).toContain('const { t, i18n } = useTranslation()')
      expect(result.newContent).toContain('i18n.changeLanguage(code)')
    })

    it('uses i18next.changeLanguage() outside component', () => {
      const content = `function switchLang(code: string) {
  updateSettings({ language: code })
}`
      const callStart = content.indexOf('updateSettings')
      const callEnd = content.indexOf('})') + 2

      const sites: LanguageChangeSite[] = [{
        languageExpression: 'code',
        callStart,
        callEnd,
        line: 2,
        column: 2
      }]

      const result = transformFile(content, 'utils.ts', [], {
        isDryRun: false,
        hasReact: true,
        isPrimaryLanguageFile: true,
        config: mockConfig,
        languageChangeSites: sites
      })

      expect(result.modified).toBe(true)
      expect(result.newContent).toContain('i18next.changeLanguage(code); updateSettings({ language: code })')
      expect(result.newContent).toContain("import i18next from 'i18next'")
    })

    it('handles statement position (inside block body)', () => {
      const content = `export function Settings() {
  function handleLangChange(code) {
    updateSettings({ lang: code })
    console.log('changed')
  }
  return <div />
}`
      const callStart = content.indexOf('updateSettings')
      const callEnd = content.indexOf('})') + 2

      const components: ComponentBoundary[] = [{
        name: 'Settings',
        bodyStart: 28,
        bodyEnd: content.length - 1,
        hasUseTranslation: false
      }]

      const sites: LanguageChangeSite[] = [{
        languageExpression: 'code',
        callStart,
        callEnd,
        insideComponent: 'Settings',
        line: 3,
        column: 4
      }]

      const result = transformFile(content, 'Settings.tsx', [], {
        isDryRun: false,
        hasReact: true,
        isPrimaryLanguageFile: true,
        config: mockConfig,
        components,
        languageChangeSites: sites
      })

      expect(result.modified).toBe(true)
      // In a block body, prepend as a statement
      expect(result.newContent).toContain('i18n.changeLanguage(code); updateSettings({ lang: code })')
      expect(result.newContent).toContain("console.log('changed')")
    })

    it('respects dry-run mode for language change sites', () => {
      const content = `export function App() {
  return <button onClick={() => setLang(code)}>Go</button>
}`
      const callStart = content.indexOf('setLang(code)')
      const callEnd = callStart + 'setLang(code)'.length

      const components: ComponentBoundary[] = [{
        name: 'App',
        bodyStart: 22,
        bodyEnd: content.length - 1,
        hasUseTranslation: false
      }]

      const sites: LanguageChangeSite[] = [{
        languageExpression: 'code',
        callStart,
        callEnd,
        insideComponent: 'App',
        line: 2,
        column: 33
      }]

      const result = transformFile(content, 'App.tsx', [], {
        isDryRun: true,
        hasReact: true,
        isPrimaryLanguageFile: true,
        config: mockConfig,
        components,
        languageChangeSites: sites
      })

      expect(result.modified).toBe(true)
      expect(result.newContent).toBeUndefined() // dry-run doesn't return content
      expect(result.transformCount).toBe(0)
      expect(result.languageChangeCount).toBe(1)
    })
  })
})
