import { describe, expect, test } from 'bun:test'
import { telegramTextChunks } from '../src/router.js'

describe('Telegram response formatting', () => {
  test('splits long Claude answers without losing text', () => {
    const text = 'x'.repeat(8_001)
    const chunks = telegramTextChunks(text)
    expect(chunks).toHaveLength(3)
    expect(chunks.every(chunk => chunk.length <= 4_000)).toBe(true)
    expect(chunks.join('')).toBe(text)
    expect(telegramTextChunks('')).toEqual([])
  })
})
