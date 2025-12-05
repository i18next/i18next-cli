export type {
  I18nextToolkitConfig,
  Plugin,
  PluginContext,
  ExtractedKey,
  TranslationResult,
  ExtractedKeysMap,
  RenameKeyResult
} from './types'
export { defineConfig } from './config'
export {
  extract,
  findKeys,
  getTranslations,
  runExtractor
} from './extractor'

export { runLinter, recommendedAcceptedTags, recommendedAcceptedAttributes } from './linter'
export { runSyncer } from './syncer'
export { runStatus } from './status'
export { runTypesGenerator } from './types-generator'
export { runRenameKey } from './rename-key'
