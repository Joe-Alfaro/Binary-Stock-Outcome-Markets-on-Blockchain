// Loaded with `--import` before any test file, so React and Testing Library see a DOM at import time.
import { JSDOM, VirtualConsole } from 'jsdom'

// axe probes canvas for icon fonts; jsdom has no canvas, and the warning is noise.
const virtualConsole = new VirtualConsole()
virtualConsole.on('jsdomError', (error) => {
  if (!error.message.includes('HTMLCanvasElement')) console.error(error)
})

const dom = new JSDOM(
  '<!doctype html><html lang="en"><head><title>Meridian</title></head><body></body></html>',
  {
    url: 'http://localhost/',
    pretendToBeVisual: true,
    virtualConsole,
  },
)

const globals = [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'HTMLSelectElement',
  'HTMLFormElement',
  'DocumentFragment',
  'MutationObserver',
  'getComputedStyle',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'PointerEvent',
  'FocusEvent',
  'InputEvent',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const

const source = dom.window as unknown as Record<string, unknown>
globals.forEach((key) => {
  if (source[key] === undefined) return
  Object.defineProperty(globalThis, key, { value: source[key], configurable: true, writable: true })
})

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
