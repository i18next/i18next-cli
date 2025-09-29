import { describe, it, expect } from 'vitest'
import {
  setNestedValue,
  getNestedValue,
  getNestedKeys,
} from '../src/utils/nested-object'

describe('setNestedValue', () => {
  it('should set a simple nested value in an empty object', () => {
    const obj = {}
    setNestedValue(obj, 'a.b.c', 'value', '.')
    expect(obj).toEqual({ a: { b: { c: 'value' } } })
  })

  it('should set a value on an existing object', () => {
    const obj = { a: { b: { c: 'initial' } } }
    setNestedValue(obj, 'a.b.d', 'new value', '.')
    expect(obj).toEqual({ a: { b: { c: 'initial', d: 'new value' } } })
  })

  it('should set a flat key when keySeparator is false', () => {
    const obj = {}
    setNestedValue(obj, 'a.b.c', 'flat value', false)
    expect(obj).toEqual({ 'a.b.c': 'flat value' })
  })

  it('should create nested objects if the path is clear', () => {
    const obj = { user: { id: 1 } }
    setNestedValue(obj, 'user.profile.name', 'John', '.')
    expect(obj).toEqual({ user: { id: 1, profile: { name: 'John' } } })
  })

  it('should overwrite a primitive value if a key is directly assigned to its path', () => {
    const obj = { user: { name: 'Jane' } }
    setNestedValue(obj, 'user', 'overwritten', '.')
    expect(obj).toEqual({ user: 'overwritten' })
  })

  // --- Test for the specific bug fix ---
  it('should flatten a key when its parent path already exists as a primitive value', () => {
    const obj = {
      user: 'this is a string, not an object',
    }

    // Attempt to set a nested property on 'user'
    setNestedValue(obj, 'user.name', 'John Doe', '.')

    // The function should detect the conflict and "bail out", setting a flat key instead.
    expect(obj).toEqual({
      user: 'this is a string, not an object', // The original value is preserved
      'user.name': 'John Doe', // The new key is added as a flat key
    })
  })
})

describe('getNestedValue', () => {
  const nestedObj = { a: { b: { c: 100 } } }
  const flatObj = { 'a.b.c': 200 }

  it('should retrieve a deeply nested value', () => {
    expect(getNestedValue(nestedObj, 'a.b.c', '.')).toBe(100)
  })

  it('should retrieve a value from a flat object', () => {
    expect(getNestedValue(flatObj, 'a.b.c', false)).toBe(200)
  })

  it('should return undefined for a non-existent nested path', () => {
    expect(getNestedValue(nestedObj, 'a.x.y', '.')).toBeUndefined()
  })

  it('should return undefined for a non-existent flat key', () => {
    expect(getNestedValue(flatObj, 'a.x.y', false)).toBeUndefined()
  })
})

describe('getNestedKeys', () => {
  const obj = {
    user: {
      profile: { name: 'John', age: 30 },
      settings: { theme: 'dark' },
    },
    'app.version': '1.0.0',
  }

  it('should extract all keys from a nested object structure', () => {
    const keys = getNestedKeys(obj, '.')
    // Use toContain to be order-independent
    expect(keys).toContain('user.profile.name')
    expect(keys).toContain('user.profile.age')
    expect(keys).toContain('user.settings.theme')
    expect(keys).toContain('app.version')
    expect(keys.length).toBe(4)
  })

  it('should extract top-level keys when keySeparator is false', () => {
    const keys = getNestedKeys(obj, false)
    expect(keys).toContain('user')
    expect(keys).toContain('app.version')
    expect(keys.length).toBe(2)
  })

  it('should return an empty array for an empty object', () => {
    expect(getNestedKeys({}, '.')).toEqual([])
  })
})
