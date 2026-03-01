export type {
  InstrumenterOptions,
  CandidateString,
  TransformResult,
  FileInstrumentationResult,
  InstrumentationResults,
  ComponentBoundary,
  FileScanResult,
  LanguageChangeSite,
  CustomCandidateScorer,
  InstrumentPluginContext,
  InstrumenterPlugin
} from '../types'
export { runInstrumenter, writeExtractedKeys } from './core/instrumenter'
export { detectCandidate } from './core/string-detector'
export { generateKeyFromContent, createKeyRegistry } from './core/key-generator'
export { transformFile, generateDiff } from './core/transformer'
