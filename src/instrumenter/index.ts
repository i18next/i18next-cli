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
} from '../types.js'
export { runInstrumenter, writeExtractedKeys } from './core/instrumenter.js'
export { detectCandidate } from './core/string-detector.js'
export { generateKeyFromContent, createKeyRegistry } from './core/key-generator.js'
export { transformFile, generateDiff } from './core/transformer.js'
