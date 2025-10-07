// src/index.ts
import { runExtractor, extract } from './extractor/core/extractor'
import { findKeys } from './extractor/core/key-finder'
import { getTranslations } from './extractor/core/translation-manager'
import { ASTVisitors } from './extractor/core/ast-visitors'
import type { PluginContext } from './types'

export {
  runExtractor,
  extract,
  findKeys,
  getTranslations,
  ASTVisitors,
  PluginContext,
}
