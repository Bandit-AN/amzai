import assert from 'node:assert/strict';
import test from 'node:test';

process.env.GEMINI_KEY = 'test-key';
process.env.MINIMUM_ROI = '50';
process.env.MINIMUM_MONTHLY_SALES = '200';
process.env.WALMART_TARGET_URLS = 'https://www.walmart.com/shop/savings?facet=retailer_type%3AWalmart';
globalThis.File ??= class File {};

const {
  analysisDelaySeconds,
  allocateDeals,
  candidateFingerprint,
  candidatePriority,
  calculateDeal,
  discordPayload,
  emptyDiscordPayload,
  extractListingQuantities,
  hashStudentPassword,
  isExcludedProductType,
  isRetryableProviderError,
  keepaInitialDelaySeconds,
  listingQuantitiesCompatible,
  listingVariantsCompatible,
  normalizeWalmartPayload,
  productIdentityCompatible,
  productCodesCompatible,
  productFormsCompatible,
  verifyStudentPassword,
  walmartSourceUrls,
  walmartUrlsForWindow,
  withinBuyCostLimit,
} = await import('../lib/platform.js');

test('student passwords are hashed and verified without storing plaintext', async () => {
  const encoded = await hashStudentPassword('safe-test-password', '00112233445566778899aabbccddeeff');
  assert.doesNotMatch(encoded, /safe-test-password/);
  assert.equal(await verifyStudentPassword('safe-test-password', encoded), true);
  assert.equal(await verifyStudentPassword('wrong-password', encoded), false);
});

test('spaces Keepa jobs for keyword search plus product details', () => {
  assert.equal(analysisDelaySeconds(0, 1, 12), 0);
  assert.equal(analysisDelaySeconds(1, 1, 12), 720);
  assert.equal(analysisDelaySeconds(2, 1, 12), 1440);
  assert.equal(analysisDelaySeconds(1, 20, 12), 36);
  assert.equal(analysisDelaySeconds(1, 1, 12, 120), 840);
  assert.equal(keepaInitialDelaySeconds(-9, 1, 12), 1260);
  assert.equal(keepaInitialDelaySeconds(60, 1, 12), 0);
});

test('normalizes and deduplicates Walmart candidates by item ID', () => {
  const products = normalizeWalmartPayload({ items: [
    { name: 'Acme Widget', price: '$9.99', url: '/ip/acme-widget/12345', image: 'https://i5.walmartimages.com/a.jpg' },
    { title: 'Acme Widget', currentPrice: 9.99, walmartUrl: '/ip/acme-widget/12345' },
  ] });
  assert.equal(products.length, 1);
  assert.equal(products[0].itemId, '12345');
  assert.equal(products[0].currentPrice, 9.99);
});

test('preserves Walmart original price and UPC when present', () => {
  const [product] = normalizeWalmartPayload({ items: [{
    name: 'Acme Widget 12 Count', price: '$10.00', originalPrice: '$20.00',
    upc: '001234567890', url: '/ip/acme-widget/24680',
  }] });
  assert.equal(product.originalPrice, 20);
  assert.equal(product.upc, '001234567890');
});

test('rotates distinct Walmart feeds before moving deeper', () => {
  const first = walmartUrlsForWindow(0);
  const second = walmartUrlsForWindow(1);
  const fifth = walmartUrlsForWindow(4);
  assert.equal(first.length, 6);
  assert.equal(second.length, 6);
  assert.equal(walmartSourceUrls().length, 4);
  assert.equal(first[0].includes('page='), false);
  assert.match(first[5], /page=6/);
  assert.match(first[0], /\/shop\/savings/);
  assert.match(second[0], /\/shop\/deals\/clearance/);
  assert.match(walmartUrlsForWindow(2)[0], /\/shop\/deals\/new-deals/);
  assert.match(walmartUrlsForWindow(3)[0], /\/shop\/deals\/trending/);
  assert.match(fifth[0], /page=7/);
  for (const url of [...first, ...second]) assert.match(url, /retailer_type%3AWalmart/);
});

test('prioritizes discounted standardized products over variation-heavy products', () => {
  const discounted = {
    title: 'Acme Vitamin Tablets 60 Count', currentPrice: 10, originalPrice: 30, upc: '001234567890',
  };
  const variationHeavy = { title: 'Acme Women Shoe Size 8', currentPrice: 20 };
  assert.ok(candidatePriority(discounted) > candidatePriority(variationHeavy));
});

test('enforces the global Walmart buy-cost ceiling', () => {
  assert.equal(withinBuyCostLimit(150), true);
  assert.equal(withinBuyCostLimit(150.01), false);
});

test('identifies variation-heavy apparel for risk labeling', () => {
  assert.equal(isExcludedProductType('Time and Tru Women Underwire One Piece Swimsuit'), true);
  assert.equal(isExcludedProductType('Tide Laundry Detergent Pods'), false);
});

test('does not concatenate repeated Walmart price text', () => {
  const products = normalizeWalmartPayload({ items: [
    {
      name: 'Repeated Price Widget',
      price: '$19.96 current price $19.96',
      url: '/ip/repeated-price-widget/67890',
    },
    {
      name: 'Comma Price Widget',
      price: '$1,299.99',
      url: '/ip/comma-price-widget/67891',
    },
  ] });
  assert.equal(products[0].currentPrice, 19.96);
  assert.equal(products[1].currentPrice, 1299.99);
});

test('rejects Amazon listings with a different item count', () => {
  assert.deepEqual(extractListingQuantities('Starface Pimple Patches - 32 Count').outer_count, [32]);
  const result = listingQuantitiesCompatible(
    'Starface Hydro-Star Pimple Patches - 32 Count',
    'Starface Hydro-Star Party Pack Pimple Patch, 96 ct',
  );
  assert.equal(result.compatible, false);
  assert.equal(result.category, 'outer_count');
});

test('accepts equivalent units and rejects different package sizes', () => {
  assert.equal(listingQuantitiesCompatible('Dog Food 2 lb Bag', 'Dog Food, 32 oz').compatible, true);
  assert.equal(listingQuantitiesCompatible('Shampoo 12 fl oz', 'Shampoo 24 fluid ounces').compatible, false);
  assert.equal(listingQuantitiesCompatible('Markers 3 Pack', 'Markers Pack of 3').compatible, true);
});

test('rejects mismatched outer packs even when inner sheet counts match', () => {
  assert.equal(listingQuantitiesCompatible(
    'Pen+Gear 3-Inch by 3-Inch Yellow Sticky Notes, 100 Sheets',
    'Amazon Basics Sticky Notes, Yellow, 18-Pack, 100 Sheets per Pad',
  ).compatible, false);
  assert.equal(listingQuantitiesCompatible(
    'Zbar Iced Oatmeal Cookie Snack Bars, 6ct',
    'Zbar Iced Oatmeal Cookie Snacks (24 Pack)',
  ).compatible, false);
  assert.equal(listingQuantitiesCompatible(
    'Better Office Products Blue Paper Folder',
    'Better Office Products Blue Paper Folders, 50 Pack',
  ).compatible, false);
});

test('rejects mismatched component quantities', () => {
  const result = listingQuantitiesCompatible(
    'Zevo Compact Flying Insect Trap - 1 Plug In Device & 1 Cartridge',
    'Zevo Flying Insect Trap, 2 Devices and 4 Cartridges',
  );
  assert.equal(result.compatible, false);
  assert.equal(['device', 'cartridge'].includes(result.category), true);
});

test('rejects an Amazon count absent from a Walmart single-item listing', () => {
  assert.equal(listingQuantitiesCompatible(
    'Purina Busy Bone Dog Treats for Small Dogs, 6.5 oz',
    'Purina Busy Bone Dog Chew Treats, 60 ct Pouch',
  ).compatible, false);
});

test('uses Keepa numberOfItems when the Amazon title omits pack size', () => {
  assert.equal(listingQuantitiesCompatible(
    'Better Office Products Blue Paper Folder',
    'Better Office Products Blue Paper Folders',
    50,
  ).compatible, false);
});

test('rejects similar product titles from different brands', () => {
  assert.equal(productIdentityCompatible(
    'Time and Tru Women Underwire One Piece Swimsuit',
    'SUUKSESS Women Underwire One Piece Swimsuit',
    'Time and Tru',
    'SUUKSESS',
  ), false);
});

test('accepts normalized matching brands with meaningful title overlap', () => {
  assert.equal(productIdentityCompatible(
    'Coca-Cola Zero Sugar Orange Vanilla Soda',
    'Coca Cola Zero Sugar Orange Vanilla Soft Drink',
    'Coca-Cola',
    'Coca Cola',
  ), true);
});

test('rejects conflicting colors and product versions', () => {
  assert.equal(listingVariantsCompatible(
    'Anker PowerLine Select+ Lightning Cable, 6 ft, Black',
    'Anker Powerline II Lightning Cable, 6 ft, White',
  ), false);
  assert.equal(listingVariantsCompatible(
    'Anker PowerLine II Lightning Cable, 6 ft, Black',
    'Anker Powerline II Lightning Cable, 6 feet, Black',
  ), true);
});

test('rejects a movie matched to playback hardware', () => {
  assert.equal(productFormsCompatible(
    'The Shallows 4K Ultra HD + Blu-ray Movie',
    'Sony 4K Ultra HD Home Theater Blu-ray DVD Player',
  ), false);
});

test('compares oz and fluid-ounce variants as the same product size', () => {
  assert.equal(listingQuantitiesCompatible(
    'Versace Bright Crystal Perfume, 3 Fluid Ounces',
    'Versace Bright Crystal Eau de Toilette, 6.7 oz',
  ).compatible, false);
  assert.equal(listingQuantitiesCompatible(
    'Dolce & Gabbana Light Blue, 3.4 oz',
    'Dolce & Gabbana Light Blue, 3.4 fl oz',
  ).compatible, true);
});

test('requires Walmart UPC to agree with Keepa product codes when available', () => {
  assert.equal(productCodesCompatible('0848061064360', {
    upcList: ['848061064360'], eanList: ['0848061064360'],
  }), true);
  assert.equal(productCodesCompatible('001234567890', {
    upcList: ['848061064360'],
  }), false);
});

test('treats explicit pack size as outer quantity instead of inner count', () => {
  assert.deepEqual(
    extractListingQuantities('Sticky Notes, 18 Pack, 100 Count per Pad').outer_count,
    [18],
  );
});

test('does not reject listings when neither title provides comparable quantities', () => {
  assert.equal(listingQuantitiesCompatible('Acme Blue Widget', 'Acme Widget, Blue').compatible, true);
});

test('candidate cooldown fingerprint changes when the Walmart price changes', () => {
  const candidate = { itemId: '123', title: 'Acme Widget', currentPrice: 10 };
  assert.equal(candidateFingerprint(candidate), candidateFingerprint({ ...candidate }));
  assert.notEqual(candidateFingerprint(candidate), candidateFingerprint({ ...candidate, currentPrice: 9 }));
});

test('classifies provider throttling and temporary failures as retryable', () => {
  assert.equal(isRetryableProviderError({ response: { status: 429 } }), true);
  assert.equal(isRetryableProviderError({ response: { status: 503 } }), true);
  assert.equal(isRetryableProviderError({ response: { status: 400 } }), false);
});

test('calculates estimated profit and flags policy status as unverified', () => {
  const deal = calculateDeal(
    { itemId: '1', title: 'Widget', currentPrice: 10, walmartUrl: 'https://walmart.com/ip/1' },
    { brand: 'Acme', cleanSearchTerm: 'Acme Widget', estimatedPackCount: 1 },
    {
      asin: 'B012345678', title: 'Acme Widget', brand: 'Acme', monthlySold: 500,
      stats: { buyBoxPrice: 3000 },
      fbaFees: { pickAndPackFee: 400 }, referralFeePercentage: 15,
    },
  );
  assert.equal(deal.amazonPrice, 30);
  assert.equal(deal.estimatedFees, 10);
  assert.equal(deal.estimatedProfit, 10);
  assert.equal(deal.roi, 200);
  assert.equal(deal.policyStatus, 'UNVERIFIED');
});

test('strict allocation never assigns an ASIN more than once', () => {
  const students = [
    { id: 'a', minRoi: 50, minMonthlySales: 200, maxCost: 100, excludedBrands: [] },
    { id: 'b', minRoi: 50, minMonthlySales: 200, maxCost: 100, excludedBrands: [] },
  ];
  const deals = Array.from({ length: 8 }, (_, index) => ({
    asin: `B00000000${index}`, itemId: String(index), brand: 'Acme', currentPrice: 10,
    roi: 60 + index, estimatedMonthlySales: 250 + index,
  }));
  deals.push({ ...deals[0] });
  const assignments = allocateDeals(deals, students, 3, 'run-1');
  const assigned = Object.values(assignments).flat();
  assert.equal(assigned.length, 6);
  assert.equal(new Set(assigned.map((deal) => deal.asin)).size, 6);
  assert.equal(assignments.a.length, 3);
  assert.equal(assignments.b.length, 3);
});

test('allocation respects per-student maximum cost and excluded brands', () => {
  const students = [
    { id: 'a', minRoi: 50, minMonthlySales: 200, maxCost: 10, excludedBrands: ['blocked'] },
  ];
  const assignments = allocateDeals([
    { asin: 'B000000001', brand: 'Blocked', currentPrice: 5, roi: 80, estimatedMonthlySales: 300 },
    { asin: 'B000000002', brand: 'Acme', currentPrice: 20, roi: 80, estimatedMonthlySales: 300 },
    { asin: 'B000000003', brand: 'Acme', currentPrice: 8, roi: 80, estimatedMonthlySales: 300 },
  ], students, 10, 'run-1');
  assert.deepEqual(assignments.a.map((deal) => deal.asin), ['B000000003']);
});

test('Discord cards include the mandatory manual IP warning', () => {
  const payload = discordPayload({ name: 'Student' }, [{
    amazonTitle: 'Widget', amazonUrl: 'https://amazon.com/dp/B012345678',
    walmartUrl: 'https://walmart.com/ip/1', asin: 'B012345678', currentPrice: 10,
    amazonPrice: 30, estimatedProfit: 10, roi: 100, estimatedMonthlySales: 500,
  }]);
  assert.match(payload.embeds[0].fields.at(-1).value, /not verified by Keepa/i);
});

test('zero-deal Discord message reports analysis errors', () => {
  const payload = emptyDiscordPayload({ name: 'Student' }, { candidateCount: 47, failedCandidates: 3 });
  assert.match(payload.content, /no products passed/i);
  assert.match(payload.content, /47 Walmart candidates/);
  assert.match(payload.content, /3 API or matching errors/);
  assert.deepEqual(payload.embeds, []);
});
