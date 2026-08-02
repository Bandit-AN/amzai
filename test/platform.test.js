import assert from 'node:assert/strict';
import test from 'node:test';

process.env.GEMINI_KEY = 'test-key';
process.env.MINIMUM_ROI = '50';
process.env.MINIMUM_MONTHLY_SALES = '200';

const {
  allocateDeals,
  calculateDeal,
  discordPayload,
  normalizeWalmartPayload,
} = await import('../lib/platform.js');

test('normalizes and deduplicates Walmart candidates by item ID', () => {
  const products = normalizeWalmartPayload({ items: [
    { name: 'Acme Widget', price: '$9.99', url: '/ip/acme-widget/12345', image: 'https://i5.walmartimages.com/a.jpg' },
    { title: 'Acme Widget', currentPrice: 9.99, walmartUrl: '/ip/acme-widget/12345' },
  ] });
  assert.equal(products.length, 1);
  assert.equal(products[0].itemId, '12345');
  assert.equal(products[0].currentPrice, 9.99);
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
  assert.equal(deal.roi, 100);
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
