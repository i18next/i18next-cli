import { vol } from 'memfs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runExtractor } from '../src/extractor/core/extractor'
import type { I18nextToolkitConfig, Logger } from '../src/types'

// Use memfs for node:fs/promises reads done by the extractor
vi.mock('node:fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
// Some modules might still import fs/promises (keep both to be safe)
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

vi.mock('glob', () => ({ glob: vi.fn() }))

// Prevent ora from rewriting output (which can hide the real warning message in CI/TTY)
vi.mock('ora', () => {
  const spinner = {
    start () {
      return spinner
    },
    succeed: vi.fn(),
    fail: vi.fn(),
    text: '',
  }
  return { default: () => spinner }
})

// Silence the post-extraction funnel message in tests
vi.mock('../src/utils/funnel-msg-tracker', () => ({
  shouldShowFunnel: vi.fn(async () => false),
  recordFunnelShown: vi.fn(async () => {}),
}))

describe('extractor: JSX Trans conditional expression causes file skip', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
  })

  it('extracts keys and does not error on ConditionalExpression inside <Trans> children', async () => {
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/components/DocumentFolders/Header/CategoryLayout.jsx'])

    const categoryLayoutJsx = `
      import { Trans } from 'react-i18next'
      import Loader from '@/ui/Loader'

      import Arrow from './Arrow'
      import {
        NavigationInfo,
        ReturnIcon,
        NoResults,
        CategoryContainer,
      } from './Styles'
      import Text from '@/ui/Text'

      const CategoryLayout = ({
        categoryContent,
        resultsContent,
        t,
        isLastSection,
        loading,
        excludeFiles,
      }) => {
        const getContent = () => {
          if (loading) {
            return (
              <NoResults>
                <Loader size="small" inline />
              </NoResults>
            )
          }
          if (resultsContent) {
            return resultsContent
          }
          return <NoResults>{t('No results found')}</NoResults>
        }
        return (
          <>
            <CategoryContainer>
              <h4>{categoryContent}</h4>
              {getContent()}
            </CategoryContainer>

            {isLastSection && (
              <NavigationInfo>
                <Trans i18nKey="condExpr">
                  <Text.Span light>Use</Text.Span> <Arrow /> <Arrow upwards />{' '}
                  <Text.Span light>to navigate and</Text.Span>{' '}
                  <ReturnIcon>return</ReturnIcon>{' '}
                  <Text.Span light>
                    {excludeFiles
                      ? 'to select'
                      : 'to select, or right click to get more options'}
                  </Text.Span>
                </Trans>
              </NavigationInfo>
            )}

            <div className="desktop-upload" style={{ textAlign: 'center' }}>
              {props.multiple ? (
                <Trans i18nKey="another-spacing-1">
                  <span
                    style={{
                      color: textColor,
                    }}>
                    Drag and drop files here or
                  </span>{' '}
                  <BrowseButton
                    style={{
                      cursor: props.disabled ? 'not-allowed' : 'pointer',
                    }}>
                    browse
                  </BrowseButton>
                </Trans>
              ) : (
                <Trans i18nKey="another-spacing-2">
                  <span
                    style={{
                      color: textColor,
                    }}>
                    Drag and drop file here or
                  </span>{' '}
                  <BrowseButton
                    style={{
                      cursor: props.disabled ? 'not-allowed' : 'pointer',
                    }}>
                    browse
                  </BrowseButton>
                </Trans>
              )}
            </div>
          </>
        )
      }

      export default CategoryLayout
    `.trim()

    vol.fromJSON({
      '/src/components/DocumentFolders/Header/CategoryLayout.jsx': categoryLayoutJsx,
    })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.jsx'],
        // IMPORTANT: absolute output path so we can inspect memfs deterministically
        output: '/locales/{{language}}/{{namespace}}.json',
        defaultNS: 'translation',
      },
    }

    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as any

    // Run non-dry so files are written into memfs for assertions
    const updated = await runExtractor(config, { isDryRun: false }, logger)
    expect(updated).toBe(true)

    const warnCalls = (logger.warn as any).mock.calls.map((args: any[]) => args.join(' ')).join('\n')

    // Should NOT skip file and should NOT warn about ConditionalExpression anymore
    expect(warnCalls).not.toContain('Skipping file due to error:')
    expect(warnCalls).not.toContain('Failed to extract <Trans>')
    expect(warnCalls).not.toContain('Unrecognized expression in JSX placeholder: ConditionalExpression')

    // Verify extracted keys exist in emitted locale JSON files
    const fsSnapshot = vol.toJSON() as Record<string, string>
    const translationPath = '/locales/en/translation.json'
    expect(fsSnapshot[translationPath]).toBeTruthy()

    const translationJson = JSON.parse(fsSnapshot[translationPath]!)

    const expected = {
      condExpr:
        '<0>Use</0> <2></2> <4></4> <6>to navigate and</6> <8>return</8> <10>to select, or right click to get more options</10>',
      'No results found': 'No results found',
      'another-spacing-1': '<0>Drag and drop files here or</0> <2>browse</2>',
      'another-spacing-2': '<0>Drag and drop file here or</0> <2>browse</2>',
    }

    expect(translationJson).toMatchObject(expected)
    expect(Object.keys(translationJson).sort()).toEqual(Object.keys(expected).sort())
  })
})
