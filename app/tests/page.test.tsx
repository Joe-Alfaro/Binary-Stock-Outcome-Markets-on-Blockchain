import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import HomePage from '../app/page'

describe('HomePage', () => {
  it('renders the heading', () => {
    const html = renderToStaticMarkup(<HomePage />)
    assert.match(html, /<h1>Meridian<\/h1>/)
  })
})
