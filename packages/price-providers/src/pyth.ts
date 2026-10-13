import { notImplemented } from './errors.js'
import type { NormalizedPrice } from './types.js'

/** `Equity.US.<TICKER>/USD` feed IDs. */
export const PYTH_FEED_IDS: Readonly<Record<string, string>> = {
  AAPL: '49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688',
  MSFT: 'd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1',
  GOOGL: '5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6',
  AMZN: 'b5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a',
  NVDA: 'b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593',
  META: '78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe',
  TSLA: '16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1',
}

/**
 * Normalizes a Hermes `GET /v2/updates/price/{publish_time}` response. Session is regular when
 * the publish time falls between 09:30 ET and `closeTs` on the close's day. Pyth never labels an
 * official close.
 */
export function normalizePythUpdates(
  response: unknown,
  context: { closeTs: number },
): NormalizedPrice[] {
  return notImplemented(response, context)
}
