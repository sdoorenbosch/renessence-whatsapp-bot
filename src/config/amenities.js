/**
 * What slippers cost at reception. The bot told a guest "complimentary towels
 * and slippers" (Livia, 26 Oct 2026); the team: a towel and a bathrobe are
 * provided, slippers are not — guests bring their own or buy a pair at
 * reception. One place for the price: the prompt rule reads it, and
 * tests/livia-slippers.test.js ties the knowledge-base sentences to it.
 */
const SLIPPERS_PRICE_CENTS = 450;

/** "€4.50" for English text, slippersPrice(',') → "€4,50" for Dutch. */
const slippersPrice = (decimal = '.') => `€${(SLIPPERS_PRICE_CENTS / 100).toFixed(2).replace('.', decimal)}`;

module.exports = { SLIPPERS_PRICE_CENTS, slippersPrice };
