import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.File ??= class File {};
const { emailContainsOrder, extractShipmentUpdate, messageText } = await import('../lib/email-tracking.js');

test('matches an email only to its normalized retailer order number', () => {
  const text = { subject: 'Your Walmart order 2000123-456789 has shipped', body: 'Track your package.' };
  assert.equal(emailContainsOrder(text, '2000123-456789'), true);
  assert.equal(emailContainsOrder(text, '2000123-000000'), false);
});

test('extracts UPS tracking and in-transit status', () => {
  const result = extractShipmentUpdate({
    subject: 'Your order has shipped',
    body: 'Your package is on the way. Tracking number 1Z999AA10123456784.',
  });
  assert.equal(result.carrier, 'UPS');
  assert.equal(result.trackingNumber, '1Z999AA10123456784');
  assert.equal(result.status, 'in_transit');
});

test('does not confuse a future delivery sentence with completed delivery', () => {
  const result = extractShipmentUpdate({
    subject: 'Delivery update',
    body: 'Your order will be delivered tomorrow.',
  });
  assert.notEqual(result.status, 'delivered');
});

test('does not treat an unlabeled numeric order ID as a FedEx tracking code', () => {
  const result = extractShipmentUpdate({
    subject: 'Order 123456789012 has shipped',
    body: 'We are preparing your shipment.',
  });
  assert.equal(result.trackingNumber, null);
});

test('decodes nested Gmail MIME payloads', () => {
  const encoded = Buffer.from('<p>Order 1234 has shipped &amp; is on the way.</p>').toString('base64url');
  const parsed = messageText({ payload: {
    headers: [{ name: 'Subject', value: 'Shipping confirmation' }],
    parts: [{ mimeType: 'text/html', body: { data: encoded } }],
  } });
  assert.equal(parsed.subject, 'Shipping confirmation');
  assert.match(parsed.body, /Order 1234 has shipped & is on the way/);
});
