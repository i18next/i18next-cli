import { describe, it, expect } from 'vitest'
import { generateKeyFromContent, createKeyRegistry, sanitizeKey } from '../src/instrumenter/core/key-generator'

describe('key-generator', () => {
  describe('generateKeyFromContent', () => {
    it('converts "Welcome back" to "welcomeBack"', () => {
      expect(generateKeyFromContent('Welcome back')).toBe('welcomeBack')
    })

    it('converts "Hello, World!" to "helloWorld"', () => {
      expect(generateKeyFromContent('Hello, World!')).toBe('helloWorld')
    })

    it('converts "You have 3 items" to "youHave3Items"', () => {
      expect(generateKeyFromContent('You have 3 items')).toBe('youHave3Items')
    })

    it('converts "Click here to continue" to "clickHereToContinue"', () => {
      expect(generateKeyFromContent('Click here to continue')).toBe('clickHereToContinue')
    })

    it('handles single word', () => {
      expect(generateKeyFromContent('Welcome')).toBe('welcome')
    })

    it('handles empty string', () => {
      expect(generateKeyFromContent('')).toBe('key')
    })
  })

  describe('createKeyRegistry', () => {
    it('adds a new key without collision', () => {
      const registry = createKeyRegistry()
      const key = registry.add('welcomeBack', 'Welcome back')
      expect(key).toBe('welcomeBack')
      expect(registry.keys.get('welcomeBack')).toBe('Welcome back')
    })

    it('returns existing key for same content', () => {
      const registry = createKeyRegistry()
      registry.add('welcomeBack', 'Welcome back')
      const key = registry.add('welcomeBack', 'Welcome back')
      expect(key).toBe('welcomeBack')
    })

    it('handles collision by appending numeric suffix', () => {
      const registry = createKeyRegistry()
      const key1 = registry.add('welcome', 'Welcome to our app')
      const key2 = registry.add('welcome', 'Welcome to the site')
      expect(key1).toBe('welcome')
      expect(key2).toBe('welcome2')
    })

    it('handles multiple collisions', () => {
      const registry = createKeyRegistry()
      const key1 = registry.add('item', 'Item 1')
      const key2 = registry.add('item', 'Item 2')
      const key3 = registry.add('item', 'Item 3')
      expect(key1).toBe('item')
      expect(key2).toBe('item2')
      expect(key3).toBe('item3')
    })
  })

  describe('sanitizeKey', () => {
    it('removes invalid characters', () => {
      expect(sanitizeKey('hello@world!')).toBe('helloworld')
    })

    it('preserves dots, dashes, and underscores', () => {
      expect(sanitizeKey('hello.world-foo_bar')).toBe('hello.world-foo_bar')
    })

    it('handles keys starting with numbers', () => {
      expect(sanitizeKey('123key')).toBe('_123key')
    })

    it('preserves valid identifier keys', () => {
      expect(sanitizeKey('welcomeBack')).toBe('welcomeBack')
    })
  })
})
