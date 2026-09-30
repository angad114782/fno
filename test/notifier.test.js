const test = require('node:test');
const assert = require('node:assert/strict');
const notifier = require('../src/services/notifier');

test('WhatsApp template params: har line ek param, baaki aakhri me, HTML/newline hata ke', () => {
  const text = ['📡 <b>BUY PE</b> NIFTY @ 22850', 'NIFTY 22850 PE (2026-09-30)', 'Entry ~120 | SL 105', 'Lots 1', 'Score 6', '<i>SL zaroor</i>'].join('\n');
  const p = notifier.templateParams(text, 5);
  assert.equal(p.length, 5);
  assert.equal(p[0], '📡 BUY PE NIFTY @ 22850');
  assert.equal(p[4], 'Score 6 · SL zaroor');
  assert.ok(p.every((x) => !/[\n\t<>]/.test(x) && !/ {5,}/.test(x)));
  // Kam lines -> khali param nahi (WhatsApp reject karta hai)
  assert.deepEqual(notifier.templateParams('Ek line', 3), ['Ek line', '-', '-']);
  assert.equal(notifier.templateParams('A &amp; B &lt;x&gt;', 1)[0], 'A & B <x>');
});
