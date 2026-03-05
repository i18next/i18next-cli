// src/index.ts
import { runExtractor, extract } from './extractor/core/extractor.js'
import { findKeys } from './extractor/core/key-finder.js'
import { getTranslations } from './extractor/core/translation-manager.js'
import { ASTVisitors } from './extractor/core/ast-visitors.js'
import type { PluginContext } from './types.js'

export {
  runExtractor,
  extract,
  findKeys,
  getTranslations,
  ASTVisitors,
  PluginContext,
}
