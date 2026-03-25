/**
 * Mock for react-i18next.
 * The `t()` function returns the translation key as-is, making assertions predictable.
 *
 * Usage: import this file at the top of component test files.
 *   import '../mocks/i18n'
 */

import { vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
  Trans: ({ children }: { children: React.ReactNode }) => children,
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}))
