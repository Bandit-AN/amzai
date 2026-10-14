// Protected seller IDs supplied by the operator. Labels and URL formatting
// must never provide a way around the same policy used by both interfaces.
export const blockedStorefrontIds = Object.freeze([
  'A13JAOVCSKO2RZ',
  'A1M3BPO406QRM2',
  'AIQ9T97M1LEFC',
  'A23NXM0C8CNVH6',
  'A3FJ0GUIE0S5CG',
  'A27U6Q3KXGY8H3',
  'A19662HMW9QPL7',
  'A2B91NEL33MV8Y',
  'A2O11WR0T300KP',
  'A2UT56ZZF8U7WN',
  'A6BXXELHM94Z0',
  'A1DIV7RK386GWB',
  'A1IUEBFQG312AT',
  'A1F4AR58F6S488',
]);

export function isBlockedStorefront(id) {
  return blockedStorefrontIds.includes(String(id || '').trim().toUpperCase());
}

export function assertStorefrontAllowed(id) {
  if (!isBlockedStorefront(id)) return;
  const error = new Error('This storefront is protected and cannot be tracked in Buy Box Bandit.');
  error.code = 'STOREFRONT_BLOCKED';
  throw error;
}
