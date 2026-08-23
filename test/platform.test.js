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
  automaticEligibilityReason,
  bestWalmartMatchForAmazonProduct,
  candidateFingerprint,
  candidatePriority,
  calculateDeal,
  claimDiscordDelivery,
  dailyWalmartWindow,
  discordPayload,
  discordPayloads,
  emptyDiscordPayload,
  extractListingQuantities,
  hashStudentPassword,
  hasWalmartDealSignal,
  isExcludedProductType,
  isExcludedTargetBrand,
  isBlockedStorefrontBrand,
  isExcludedWalmartBrand,
  isRetryableProviderError,
  keepaInitialDelaySeconds,
  keepaProductCodeParams,
  keepaTitleSearchSelection,
  listingQuantitiesCompatible,
  listingVariantsCompatible,
  looksLikeBlockedWalmartPage,
  mergeBalancedCandidates,
  normalizeWalmartPayload,
  normalizeTargetPayload,
  parseTrackedSellers,
  productIdentityCompatible,
  productCodesCompatible,
  productFormsCompatible,
  salesVelocityManualReviewEntry,
  sanitizedRetryError,
  scrapingAntRequestOptions,
  selectUnseenCandidates,
  storefrontDiscordPayload,
  storefrontDiscordPayloads,
  upcTitleIdentityCompatible,
  verifyStudentPassword,
  walmartSearchUrl,
  walmartSourceUrls,
  walmartUrlsForDailyRun,
  walmartUrlsForWindow,
  withinBuyCostLimit,
} = await import('../lib/platform.js');

const automaticDeal = (overrides = {}) => ({
  matchMethod: 'UPC',
  upc: '001234567890',
  detailVerified: true,
  onlineAvailable: true,
  estimatedProfit: 5,
  ...overrides,
});

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
  assert.equal(analysisDelaySeconds(0, 20, 15, 0, 60), 0);
  assert.equal(analysisDelaySeconds(3, 20, 15, 0, 60), 15);
  assert.equal(analysisDelaySeconds(4, 20, 15, 0, 60), 45);
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

test('normalizes rendered Target clearance cards', () => {
  const [product] = normalizeTargetPayload(`
    <li data-test="ProductCard">
      <a href="/p/acme-widget/-/A-94747328" aria-label="Acme Widget 2 Pack">
        <img alt="Acme Widget 2 Pack" src="https://target.scene7.com/widget.jpg">
      </a>
      <h2>Acme Widget 2 Pack</h2>
      <span>$7.41</span><span>reg $12.99</span><button>Add to cart</button>
    </li>`);
  assert.equal(product.itemId, '94747328');
  assert.equal(product.currentPrice, 7.41);
  assert.equal(product.originalPrice, 12.99);
  assert.equal(product.onlineAvailable, true);
  assert.equal(product.sourceRetailer, 'Target');
});

test('extracts Target detail UPC and rejects configured private labels', () => {
  const [product] = normalizeTargetPayload({ item: {
    tcin: '94747328',
    product_description: { title: 'Cat & Jack Kids Shirt' },
    primary_barcode: '5010996396754',
    primary_brand: { name: 'Cat & Jack' },
    price: { current_retail: 7.41, reg_retail: 12.99 },
    fulfillment: { shipping_options: { availability_status: 'IN_STOCK' } },
  } });
  assert.equal(product.upc, '5010996396754');
  assert.equal(product.onlineAvailable, true);
  assert.equal(isExcludedTargetBrand(product), true);
});

test('merges Target identity and offer state by TCIN', () => {
  const [product] = normalizeTargetPayload({ state: [
    {
      tcin: '94747328', product_description: { title: 'Acme Card Game' },
      primary_barcode: '5010996396754', primary_brand: { name: 'Acme' },
    },
    {
      tcin: '94747328', title: 'Acme Card Game',
      price: { current_retail: 7.41, reg_retail: 12.99 },
      availability: 'IN_STOCK',
    },
  ] });
  assert.equal(product.upc, '5010996396754');
  assert.equal(product.currentPrice, 7.41);
  assert.equal(product.onlineAvailable, true);
});

test('preserves Walmart original price and UPC when present', () => {
  const [product] = normalizeWalmartPayload({ items: [{
    name: 'Acme Widget 12 Count', price: '$10.00', originalPrice: '$20.00',
    upc: '001234567890', url: '/ip/acme-widget/24680',
  }] });
  assert.equal(product.originalPrice, 20);
  assert.equal(product.upc, '001234567890');
});

test('reads Walmart search-card line price, was price, and deal badge', () => {
  const [product] = normalizeWalmartPayload({ items: [{
    name: 'Clearance Widget', canonicalUrl: '/ip/clearance-widget/24681',
    priceInfo: { linePrice: '$9.33', wasPrice: '$19.00', savingsAmt: 9.67 },
    badge: { key: 'REDUCED_PRICE' }, usItemId: '24681',
  }] });
  assert.equal(product.currentPrice, 9.33);
  assert.equal(product.originalPrice, 19);
  assert.equal(product.dealBadge, 'REDUCED_PRICE');
  assert.equal(hasWalmartDealSignal(product), true);
});

test('search HTML parses only authoritative result stacks, including an empty page', () => {
  const nextData = (items) => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { initialData: { searchResult: { itemStacks: [{ items }] } } } },
    analytics: { name: 'Bogus Recommended Product', price: 1, url: '/ip/bogus/99999' },
  })}</script>`;
  const valid = normalizeWalmartPayload(nextData([{
    name: 'Real Clearance Item', canonicalUrl: '/ip/real/11111',
    priceInfo: { linePrice: '$10.00', wasPrice: '$20.00' },
  }]));
  const empty = normalizeWalmartPayload(nextData([]));
  assert.deepEqual(valid.map((product) => product.itemId), ['11111']);
  assert.deepEqual(empty, []);
});

test('preserves explicit Walmart unavailability for the review funnel', () => {
  const [product] = normalizeWalmartPayload({ items: [{
    name: 'Unavailable Widget', price: 10, availabilityStatus: 'Out of stock',
    url: '/ip/unavailable-widget/12345',
  }] });
  assert.equal(product.onlineAvailable, false);
});

test('recognizes schema.org stock states from Walmart detail data', () => {
  const [available] = normalizeWalmartPayload({ items: [{
    name: 'Available Widget', price: 10, offers: {
      availability: 'https://schema.org/InStock', seller: { name: 'Walmart.com' },
    },
    url: '/ip/available-widget/11111',
  }] });
  const [unavailable] = normalizeWalmartPayload({ items: [{
    name: 'Unavailable Widget', price: 10,
    availabilityStatus: 'OUT_OF_STOCK', url: '/ip/unavailable-widget/22222',
  }] });
  assert.equal(available.onlineAvailable, true);
  assert.equal(available.seller, 'Walmart.com');
  assert.equal(unavailable.onlineAvailable, false);
});

test('extracts authoritative detail identity and selected variant fields', () => {
  const [product] = normalizeWalmartPayload({ items: [{
    name: 'Acme Mixer Model MX500, Red, 120 Volt', price: 49.99,
    originalPrice: 79.99, upc: '001234567890', usItemId: '24680',
    brand: { name: 'Acme' }, seller: { displayName: 'Walmart.com' },
    color: 'Red', size: 'Standard', modelNumber: 'MX500', availabilityStatus: 'IN_STOCK',
    url: '/ip/acme-mixer/24680',
  }] });
  assert.equal(product.upc, '001234567890');
  assert.equal(product.variantId, '24680');
  assert.equal(product.brand, 'Acme');
  assert.equal(product.seller, 'Walmart.com');
  assert.equal(product.onlineAvailable, true);
  assert.deepEqual(product.selectedVariant, {
    size: 'Standard', color: 'Red', model: 'MX500', voltage: 120,
  });
});

test('keeps visible Walmart title authoritative and stores URL slug as search context', () => {
  const [product] = normalizeWalmartPayload({ items: [{
    name: 'Nursery Center Playard with Animal Toys, Grey', price: 59.84,
    url: '/ip/Baby-Trend-Nursery-Center-Playard-Animal-Jubilee-Grey-Infant/507100242',
  }] });
  assert.equal(product.title, 'Nursery Center Playard with Animal Toys, Grey');
  assert.match(product.searchTitle, /Baby Trend.*Animal Jubilee/i);
});

test('does not inject URL slug numbers into quantity matching', () => {
  const [product] = normalizeWalmartPayload({ items: [{
    name: 'Bertolli Extra Virgin Olive Oil, 25.4 fl oz', price: 8,
    url: '/ip/Bertolli-Extra-Virgin-Olive-Oil-25-4-fl-oz/123456',
  }] });
  assert.deepEqual(extractListingQuantities(product.title).size_oz, [25.4]);
  assert.equal(product.title, 'Bertolli Extra Virgin Olive Oil, 25.4 fl oz');
});

test('rotates distinct real Walmart clearance feeds without fake deep pages', () => {
  const first = walmartUrlsForWindow(0);
  const second = walmartUrlsForWindow(1);
  const third = walmartUrlsForWindow(2);
  const wrapped = walmartUrlsForWindow(walmartSourceUrls().length);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(walmartSourceUrls().length, 23);
  assert.equal(first[0].includes('page='), false);
  assert.match(first[0], /\/shop\/savings/);
  assert.match(second[0], /\/shop\/deals\/clearance/);
  assert.match(third[0], /\/shop\/deals\/clearance\/toys/);
  assert.equal(wrapped[0], first[0]);
  for (const url of [...first, ...second, ...third]) {
    assert.equal(url.includes('page='), false);
    assert.match(url, /retailer_type%3AWalmart/);
  }
});

test('a windowed continuation batch can pull multiple consecutive pages, not just one', () => {
  const multi = walmartUrlsForWindow(0, 5);
  assert.equal(multi.length, 5);
  assert.deepEqual(multi, walmartSourceUrls().slice(0, 5));
  const wrappedMulti = walmartUrlsForWindow(walmartSourceUrls().length - 2, 5);
  assert.equal(wrappedMulti.length, 5);
  assert.equal(wrappedMulti[0], walmartSourceUrls().at(-2));
  assert.equal(wrappedMulti[2], walmartSourceUrls()[0]);
  const capped = walmartUrlsForWindow(0, walmartSourceUrls().length + 10);
  assert.equal(capped.length, walmartSourceUrls().length);
});

test('daily automation rotates real source feeds', () => {
  const aug7 = dailyWalmartWindow(Date.parse('2026-08-07T13:00:00Z'));
  const aug8 = dailyWalmartWindow(Date.parse('2026-08-08T13:00:00Z'));
  const aug9 = dailyWalmartWindow(Date.parse('2026-08-09T13:00:00Z'));
  assert.equal(aug8, (aug7 + 1) % walmartSourceUrls().length);
  assert.equal(aug9, (aug8 + 1) % walmartSourceUrls().length);
  for (const window of [aug7, aug8, aug9]) {
    const urls = walmartUrlsForWindow(window);
    assert.equal(urls[0].includes('page='), false);
    assert.equal(urls.length, 1);
  }
});

test('daily runs balance broad feeds with rotating clearance categories', () => {
  const aug11 = walmartUrlsForDailyRun(Date.parse('2026-08-11T13:00:00Z'));
  const aug12 = walmartUrlsForDailyRun(Date.parse('2026-08-12T13:00:00Z'));
  assert.equal(aug11.length, 6);
  assert.equal(aug11.filter((url) => /\/shop\/(?:savings|deals\/clearance)\?/.test(url)).length, 2);
  // Pinned category pages (video-games, electronics) run every day, ahead of
  // the rotating clearance-category pool, not competing with it for a slot.
  assert.ok(aug11.some((url) => url.includes('/cp/video-games/2636')));
  assert.ok(aug11.some((url) => url.includes('/cp/electronics/3944')));
  assert.equal(aug11.filter((url) => /\/shop\/deals\/clearance\//.test(url)).length, 2);
  assert.equal(new Set(aug11).size, 6);
  assert.notDeepEqual(aug11, aug12);
  for (const url of aug11) assert.equal(url.includes('page='), false);
  const categoryIndexes = aug11.slice(4).map((url) => walmartSourceUrls().indexOf(url));
  assert.ok(Math.max(...categoryIndexes) - Math.min(...categoryIndexes) >= 1);
});

test('balanced discovery cannot be monopolized by one feed', () => {
  const groups = [0, 1, 2].map((group) => Array.from({ length: 10 }, (_, index) => ({
    itemId: `${group}-${index}`, title: `Feed ${group} item ${index}`,
    currentPrice: 10, originalPrice: group === 0 ? 30 : 20,
  })));
  const selected = mergeBalancedCandidates(groups, 6);
  assert.equal(selected.length, 6);
  assert.deepEqual(
    [...new Set(selected.map((candidate) => candidate.itemId.split('-')[0]))].sort(),
    ['0', '1', '2'],
  );
  for (const group of ['0', '1', '2']) {
    assert.equal(selected.filter((candidate) => candidate.itemId.startsWith(`${group}-`)).length, 2);
  }
});

test('includes retailer-filtered Walmart clearance category feeds', () => {
  const sources = walmartSourceUrls();
  assert.equal(sources.filter((url) => /\/shop\/deals\/clearance\//.test(url)).length, 19);
  assert.ok(sources.some((url) => url.includes('/clearance/toys')));
  assert.ok(sources.some((url) => url.includes('/clearance/household-essentials')));
  for (const url of sources) assert.match(url, /retailer_type%3AWalmart/);
});

test('prioritizes discounted standardized products over variation-heavy products', () => {
  const discounted = {
    title: 'Acme Vitamin Tablets 60 Count', currentPrice: 10, originalPrice: 30, upc: '001234567890',
  };
  const variationHeavy = { title: 'Acme Women Shoe Size 8', currentPrice: 20 };
  assert.ok(candidatePriority(discounted) > candidatePriority(variationHeavy));
});

test('extreme apparel markdowns cannot outrank useful standardized markdowns', () => {
  const apparel = {
    title: "Carter's Baby Outfit Set, Sizes 0/3-24 Months",
    currentPrice: 4, originalPrice: 20, brand: "Carter's", seller: 'Walmart.com',
  };
  const standardized = {
    title: 'Crayola Marker Set, 10 Count', currentPrice: 5, originalPrice: 10,
    brand: 'Crayola', seller: 'Walmart.com',
  };
  assert.ok(candidatePriority(standardized) > candidatePriority(apparel));
});

test('prioritizes real markdowns and first-party branded inventory', () => {
  const firstPartyMarkdown = {
    title: 'Crayola Marker Set 24 Count', currentPrice: 8, originalPrice: 16,
    brand: 'Crayola', seller: 'Walmart.com', onlineAvailable: true,
  };
  const marketplaceFullPrice = {
    title: 'Generic Marker Set 24 Count', currentPrice: 8,
    seller: 'Third Party Store', onlineAvailable: true,
  };
  assert.ok(candidatePriority(firstPartyMarkdown) > candidatePriority(marketplaceFullPrice));
});

test('enforces the global Walmart buy-cost ceiling', () => {
  assert.equal(withinBuyCostLimit(150), true);
  assert.equal(withinBuyCostLimit(150.01), false);
});

test('applies tighter per-category buy-cost ceilings for pinned category pages', () => {
  const videoGamesUrl = 'https://www.walmart.com/cp/video-games/2636?facet=retailer_type%3AWalmart';
  const electronicsUrl = 'https://www.walmart.com/cp/electronics/3944?facet=retailer_type%3AWalmart';
  assert.equal(withinBuyCostLimit(40, videoGamesUrl), true);
  assert.equal(withinBuyCostLimit(40.01, videoGamesUrl), false);
  assert.equal(withinBuyCostLimit(90, electronicsUrl), true);
  assert.equal(withinBuyCostLimit(90.01, electronicsUrl), false);
  // A source with no override falls back to the global ceiling, not the
  // tighter category ones.
  assert.equal(withinBuyCostLimit(150, 'https://www.walmart.com/shop/deals/clearance/toys'), true);
});

test('filters Walmart private labels without excluding national brands', () => {
  assert.equal(isExcludedWalmartBrand({ title: 'No Boundaries Women Graphic Tee' }), true);
  assert.equal(isExcludedWalmartBrand({ title: 'Pen+Gear Yellow Sticky Notes' }), true);
  assert.equal(isExcludedWalmartBrand({ title: 'Crayola Broad Line Markers' }), false);
  assert.equal(isExcludedWalmartBrand({ title: 'Madden NFL 26 for PlayStation 5' }), false);
});

test('globally blocks restricted national brands before downstream analysis', () => {
  assert.equal(isExcludedWalmartBrand({ title: 'LEGO Creator Building Set' }), true);
  assert.equal(isExcludedWalmartBrand({ title: 'Barbie Fashionistas Doll' }), true);
  assert.equal(isExcludedWalmartBrand({ title: 'Monster High Clawdeen Wolf Doll' }), true);
  assert.equal(isExcludedWalmartBrand({ title: 'Apple USB-C to Lightning Cable' }), true);
  assert.equal(isExcludedWalmartBrand({ title: 'BISSELL CrossWave Floor Cleaner' }), true);
  assert.equal(isExcludedWalmartBrand({ title: 'Little People Barbie Dream Plane' }), true);
});

test('identifies variation-heavy apparel for risk labeling', () => {
  assert.equal(isExcludedProductType('Time and Tru Women Underwire One Piece Swimsuit'), true);
  assert.equal(isExcludedProductType('Tide Laundry Detergent Pods'), false);
});

test('rejects conflicting apparel construction styles', () => {
  assert.equal(listingVariantsCompatible(
    'Hanes Underwear Boxer Briefs 3-Pack Comfort Flex Fit Stretch Mesh',
    'Hanes Underwear Boxer Briefs 3-Pack Comfort Flex Fit Total Support Pouch',
  ), false);
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

test('rejects products with explicitly different voltage', () => {
  const result = listingQuantitiesCompatible(
    'Peg Perego John Deere Mini Tractor 6 Volt Ride on Toy',
    'Peg Perego John Deere Ground Force 12 volt Ride-On Tractor',
  );
  assert.equal(result.compatible, false);
  assert.equal(result.category, 'voltage_v');
});

test('accepts equivalent units and rejects different package sizes', () => {
  assert.equal(listingQuantitiesCompatible('Dog Food 2 lb Bag', 'Dog Food, 32 oz').compatible, true);
  assert.equal(listingQuantitiesCompatible('Shampoo 12 fl oz', 'Shampoo 24 fluid ounces').compatible, false);
  assert.equal(listingQuantitiesCompatible('Markers 3 Pack', 'Markers Pack of 3').compatible, true);
});

test('normalizes retailer count wording such as each and colors', () => {
  assert.equal(listingQuantitiesCompatible(
    'Crayola Broad Line Markers, 10 Ct',
    'Crayola Broad Line Markers, Classic Colors 10 Each',
  ).compatible, true);
  assert.equal(listingQuantitiesCompatible(
    'Crayola Crayons, 24 Count',
    'Crayola Crayons 24 Colors',
  ).compatible, true);
});

test('normalizes nested count and pack-of-one metadata to the sellable count', () => {
  assert.deepEqual(extractListingQuantities('Face Masks 5 Count (Pack of 1)').outer_count, [5]);
  assert.equal(listingQuantitiesCompatible(
    'Body Restore Collagen Face Mask, 5 Pack',
    'Body Restore Collagen Face Sheet Mask 5 Pack 5 Count (Pack of 1)',
  ).compatible, true);
  assert.equal(listingQuantitiesCompatible(
    'Single Sticky Note Pad, 100 Sheets',
    'Sticky Notes, 18 Pack, 100 Count per Pad',
  ).compatible, false);
});

test('accepts equivalent total volume grouped as multipack versus one package', () => {
  const result = listingQuantitiesCompatible(
    'Jarritos Mexican Cola Soda, 12.5 fl oz, 12 Pack',
    'Jarritos Mexican Cola Soda, 150 fl oz (Pack of 1)',
  );
  assert.equal(result.compatible, true);
});

test('UPC mode can tolerate a missing unit size but never a missing outer pack', () => {
  assert.equal(listingQuantitiesCompatible(
    'Bertolli Extra Virgin Olive Oil',
    'Bertolli Extra Virgin Olive Oil, 16.9 fl oz',
    null,
    { allowMissingUnitSize: true },
  ).compatible, true);
  assert.equal(listingQuantitiesCompatible(
    'Better Office Products Blue Paper Folder',
    'Better Office Products Blue Paper Folders, 50 Pack',
    null,
    { allowMissingUnitSize: true },
  ).compatible, false);
});

test('recognizes retailer multiplier notation as an outer pack count', () => {
  const result = listingQuantitiesCompatible(
    'Reveal Wet Cat Food Variety in Broth 12 x 2.47oz Cans',
    'Reveal Wet Cat Food 12-Pack 2.47 oz Cans',
  );
  assert.equal(result.compatible, true);
  assert.deepEqual(result.walmart.outer_count, [12]);
});

test('rejects a single cleaner matched to a multi-size Amazon bundle', () => {
  assert.equal(listingQuantitiesCompatible(
    'Weiman Daily Cooktop Cleaner Spray, 12 fl oz',
    'Weiman Cooktop Cleaner 10 Ounce and Daily Cleaner 12 Ounce Bundle',
  ).compatible, false);
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

test('rejects craft kits with different piece and rubber-band quantities', () => {
  assert.equal(listingQuantitiesCompatible(
    'Rainbow Loom 1200 Piece Rubber Band Bracelet Kit',
    'Rainbow Loom Mega Set with 7000 Rubber Bands',
  ).compatible, false);
  assert.equal(listingQuantitiesCompatible(
    'Rainbow Loom Glow Party Bands',
    'Rainbow Loom Treasure Box with 7000 Rubber Bands',
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

test('UPC-confirmed title identity tolerates manufacturer and product-line brand aliases', () => {
  assert.equal(upcTitleIdentityCompatible(
    'Disney Pixar Cars Transforming Mack Playset, 2-in-1 Toy Truck & Tune-Up Station',
    'Mattel Disney and Pixar Cars Transforming Mack Playset',
  ), true);
  assert.equal(upcTitleIdentityCompatible(
    'Fisher-Price Little People School Bus Musical Toddler Toy Vehicle with 2 Figures',
    'Fisher-Price Little People School Bus Toddler Toy',
  ), true);
  assert.equal(upcTitleIdentityCompatible(
    'Bitzee Interactive Digital Toy with 30 Characters Inside',
    'Bitzee Digital Pet Toy',
  ), true);
  assert.equal(upcTitleIdentityCompatible(
    'Crayola Crayons, 24 Count, Classic Colors',
    'CRAYON 24PK BX',
  ), true);
  assert.equal(upcTitleIdentityCompatible(
    'Baby Trend Nursery Center Playard Animal Jubilee Grey Infant',
    'Baby Trend Retreat Nursery Center Playard Bassinet Storage Robin',
  ), false);
});

test('Keepa external-code lookup uses the product code endpoint parameters', () => {
  const params = keepaProductCodeParams('0012-3456-7890');
  assert.deepEqual(params, { domain: 1, code: '001234567890', stats: 30, history: 0 });
  assert.equal('term' in params, false);
  assert.equal('asin' in params, false);
});

test('Keepa title-search fallback builds a bounded Product Finder selection', () => {
  const selection = keepaTitleSearchSelection('  Acme Widget Deluxe 3 Pack  ', 7);
  assert.deepEqual(selection, {
    title: 'Acme Widget Deluxe 3 Pack',
    perPage: 7,
    sort: [['current_SALES', 'asc']],
  });
  const longTerm = 'x'.repeat(500);
  assert.equal(keepaTitleSearchSelection(longTerm, 5).title.length, 200);
});

test('detects a Walmart anti-bot interstitial that returned HTTP 200', () => {
  assert.equal(looksLikeBlockedWalmartPage('<html><body>Robot or human? Please verify.</body></html>'), true);
  assert.equal(looksLikeBlockedWalmartPage('<html><body>Access to this page has been denied</body></html>'), true);
  assert.equal(looksLikeBlockedWalmartPage('short'), true);
  assert.equal(looksLikeBlockedWalmartPage(`<html>${'<!-- padding -->'.repeat(200)}<script id="__NEXT_DATA__">{}</script></html>`), false);
  assert.equal(looksLikeBlockedWalmartPage(null), false);
  assert.equal(looksLikeBlockedWalmartPage({ items: [] }), false);
});

test('canonical English identity can match a localized Walmart title safely', () => {
  const localized = 'Versace Eros Eau de Toilette, Colonia para Hombre, 3.4 fl oz';
  const canonical = 'Versace Eros Eau de Toilette Cologne for Men 3.4 fl oz';
  const amazon = 'Versace Eros Eau de Toilette for Men 3.4 Fl Oz';
  assert.equal(productIdentityCompatible(canonical, amazon, 'Versace', 'Versace'), true);
  assert.equal(listingQuantitiesCompatible(localized, amazon).compatible, true);
});

test('rejects fragrance flanker conflicts before Gemini adjudication', () => {
  assert.equal(productIdentityCompatible(
    'Jimmy Choo Man Ice Eau de Toilette 3.3 oz',
    'Jimmy Choo Man Intense Eau de Toilette 3.3 oz',
    'Jimmy Choo',
    'Jimmy Choo',
  ), true);
  assert.equal(listingVariantsCompatible(
    'Jimmy Choo Man Ice Eau de Toilette 3.3 oz',
    'Jimmy Choo Man Intense Eau de Toilette 3.3 oz',
  ), false);
  assert.equal(listingVariantsCompatible('Jimmy Choo Man Ice', 'Jimmy Choo Man Blue'), false);
  assert.equal(listingVariantsCompatible('Jimmy Choo Man Ice', 'Jimmy Choo Man Aqua'), false);
});

test('Fuggler names require UPC identity because title overlap is insufficient', () => {
  assert.equal(productIdentityCompatible(
    'Fuggler Fugglercorns Wrinkle McStinkles 9 Inch Plush',
    'Fuggler Fugglercorns Mr Screech 9 Inch Plush',
    'Fuggler',
    'Fuggler',
  ), true);
});

test('rejects related products with different named models and styles', () => {
  assert.equal(productIdentityCompatible(
    'Baby Trend Nursery Center Playard Animal Jubilee Grey Infant',
    'Baby Trend Retreat Nursery Center Playard Bassinet Storage Robin',
    'Baby Trend',
    'Baby Trend',
  ), false);
  assert.equal(productIdentityCompatible(
    'Schylling NeeDoh Nice Cream Cone Sensory Squeeze Toy Colors May Vary',
    'Schylling NeeDoh Gumdrop Textured Sensory Toy Colors May Vary',
    'Schylling',
    'Schylling',
  ), false);
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

test('rejects explicit condition and flavor conflicts but treats one-sided model data as unknown', () => {
  assert.equal(listingVariantsCompatible(
    'Titleist Pro V1 Mint Quality Golf Balls',
    'Titleist Pro V1 Used Quality Golf Balls',
  ), false);
  assert.equal(listingVariantsCompatible(
    'Gel Max Flavor Fusion Warheads Watermelon Youth',
    'Gel Max Flavor Fusion ICEE Drip Youth',
  ), false);
  assert.equal(listingVariantsCompatible(
    'Logitech Wireless Keyboard and Mouse Combo',
    'Logitech MK345 Wireless Keyboard and Mouse Combo',
  ), true);
  assert.equal(listingVariantsCompatible(
    'Logitech Silent Wireless Mouse Blue',
    'Logitech M550 Wireless Mouse Blue',
  ), true);
  assert.equal(listingVariantsCompatible(
    'Logitech MK345 Wireless Keyboard and Mouse Combo',
    'Logitech MK545 Wireless Keyboard and Mouse Combo',
  ), false);
});

test('rejects mismatched named product sizes', () => {
  assert.equal(listingVariantsCompatible(
    'Nylabone Power Chew Original Bone, Medium, 1 Count',
    'Nylabone Power Chew Textured Bone, X-Large',
  ), false);
  assert.equal(listingVariantsCompatible(
    'Nylabone Power Chew Original Bone, Medium',
    'Nylabone Power Chew Original Textured Bone, Medium',
  ), true);
  assert.equal(listingVariantsCompatible(
    'Peg Perego John Deere Mini Tractor 6 Volt Ride on Toy',
    'Peg Perego John Deere Ground Force Extra-Large 12 volt Ride-On Tractor',
  ), false);
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
  assert.equal(productCodesCompatible(null, { upcList: ['001234567890'] }), false);
  assert.equal(productCodesCompatible('001234567890', { upcList: [], eanList: [] }), false);
});

test('Fuggler UPC can only select the same coded Amazon product', () => {
  assert.equal(productCodesCompatible('193052099532', {
    upcList: ['193052099532'], eanList: [],
  }), true);
  assert.equal(productCodesCompatible('193052099532', {
    upcList: ['193052099549'], eanList: [],
  }), false);
});

test('routes missing identity, stock, UPC, and variants away from automatic delivery', () => {
  const base = { title: 'Acme Widget', detailVerified: true, onlineAvailable: true, upc: '123456789012', variantId: '42' };
  assert.equal(automaticEligibilityReason({ ...base, detailVerified: false }), 'walmart_detail_unverified');
  assert.equal(automaticEligibilityReason({ ...base, onlineAvailable: false }), 'walmart_unavailable');
  assert.equal(automaticEligibilityReason({ ...base, upc: null }), 'missing_upc');
  assert.equal(automaticEligibilityReason({ ...base, title: 'Acme Shirt Size Large' }), 'unverified_variant');
  assert.equal(automaticEligibilityReason({
    ...base, title: 'Acme Shirt Size Large', selectedVariant: { size: 'Large' },
  }), null);
  assert.equal(automaticEligibilityReason(base), null);
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

test('cooldown selection backfills past seen products before applying the detail limit', () => {
  const candidates = Array.from({ length: 75 }, (_, index) => ({ itemId: String(index) }));
  const seen = candidates.map((_, index) => index < 35);
  const selected = selectUnseenCandidates(candidates, seen, 50);
  assert.equal(selected.length, 40);
  assert.equal(selected[0].itemId, '35');
  assert.equal(selected.at(-1).itemId, '74');

  const largerPool = Array.from({ length: 120 }, (_, index) => ({ itemId: String(index) }));
  const largerSeen = largerPool.map((_, index) => index < 35);
  const backfilled = selectUnseenCandidates(largerPool, largerSeen, 50);
  assert.equal(backfilled.length, 50);
  assert.equal(backfilled.at(-1).itemId, '84');
});

test('classifies provider throttling and temporary failures as retryable', () => {
  assert.equal(isRetryableProviderError({ response: { status: 429 } }), true);
  assert.equal(isRetryableProviderError({ response: { status: 503 } }), true);
  assert.equal(isRetryableProviderError({ response: { status: 400 } }), false);
  assert.equal(isRetryableProviderError({ code: 'ECONNABORTED' }), true);
});

test('a bare 403 is permanent (quota exhaustion) unless a caller has tagged it retryable', () => {
  assert.equal(isRetryableProviderError({ response: { status: 403 } }), false);
  assert.equal(isRetryableProviderError({ response: { status: 403 }, retryable: true }), true);
});

test('a priced match with no velocity signal becomes a manual-review entry, not a silent discard', () => {
  const candidate = {
    itemId: '123', title: 'Acme Widget', walmartUrl: 'https://www.walmart.com/ip/123',
    currentPrice: 9.99, upc: '001234567890', variantId: '123', seller: 'Walmart.com',
  };
  const diagnostic = {
    asin: 'B000000000', amazonTitle: 'Acme Widget', amazonPrice: 24.99, roi: 150, estimatedProfit: 8.5,
  };
  const entry = salesVelocityManualReviewEntry(candidate, diagnostic);
  assert.equal(entry.reason, 'missing_sales_velocity');
  assert.equal(entry.matchMethod, 'MANUAL_REVIEW');
  assert.equal(entry.asin, 'B000000000');
  assert.equal(entry.amazonUrl, 'https://www.amazon.com/dp/B000000000');
  assert.equal(entry.roi, 150);
});

test('ScrapingAnt uses cheap static US requests before browser escalation', () => {
  const target = 'https://www.walmart.com/shop/deals/clearance';
  const staticRequest = scrapingAntRequestOptions(target, false);
  const browserRequest = scrapingAntRequestOptions(target, true);
  assert.deepEqual(staticRequest.params, {
    url: target, browser: 'false', proxy_type: 'datacenter', proxy_country: 'US',
  });
  assert.equal(browserRequest.params.browser, 'true');
  assert.ok(browserRequest.timeout > staticRequest.timeout);
});

test('sanitizes retryable provider failures before they reach Vercel logs', () => {
  const original = {
    message: 'https://provider.test/?api_key=secret', code: 'ECONNABORTED',
    response: { status: 429, config: { params: { api_key: 'secret' } } },
  };
  const sanitized = sanitizedRetryError(original, 'Walmart detail lookup');
  assert.equal(sanitized.message, 'Walmart detail lookup temporarily failed (429)');
  assert.deepEqual(sanitized.response, { status: 429 });
  assert.equal(JSON.stringify(sanitized).includes('secret'), false);
});

test('calculates estimated profit and flags policy status as unverified', () => {
  const deal = calculateDeal(
    {
      itemId: '1', title: 'Widget', currentPrice: 10,
      walmartUrl: 'https://walmart.com/ip/1', upc: '001234567890',
    },
    { brand: 'Acme', cleanSearchTerm: 'Acme Widget', estimatedPackCount: 1 },
    {
      asin: 'B012345678', title: 'Acme Widget', brand: 'Acme', monthlySold: 500,
      stats: { buyBoxPrice: 3000 }, upcList: ['001234567890'],
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
  const deals = Array.from({ length: 8 }, (_, index) => automaticDeal({
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
    automaticDeal({ asin: 'B000000001', brand: 'Blocked', currentPrice: 5, roi: 80, estimatedMonthlySales: 300 }),
    automaticDeal({ asin: 'B000000002', brand: 'Acme', currentPrice: 20, roi: 80, estimatedMonthlySales: 300 }),
    automaticDeal({ asin: 'B000000003', brand: 'Acme', currentPrice: 8, roi: 80, estimatedMonthlySales: 300 }),
  ], students, 10, 'run-1');
  assert.deepEqual(assignments.a.map((deal) => deal.asin), ['B000000003']);
});

test('allocation enforces the global 60 percent ROI floor', () => {
  const students = [{ id: 'a', minRoi: 50, minMonthlySales: 200, maxCost: 100, excludedBrands: [] }];
  const assignments = allocateDeals([
    automaticDeal({ asin: 'LOW', brand: 'Acme', currentPrice: 10, roi: 59.9, estimatedMonthlySales: 500 }),
    automaticDeal({ asin: 'PASS', brand: 'Acme', currentPrice: 10, roi: 60, estimatedMonthlySales: 500 }),
  ], students, 10, 'run-roi');
  assert.deepEqual(assignments.a.map((deal) => deal.asin), ['PASS']);
});

test('allocation requires estimated net profit strictly above one dollar', () => {
  const students = [{ id: 'a', minRoi: 60, minMonthlySales: 200, maxCost: 100, excludedBrands: [] }];
  const assignments = allocateDeals([
    automaticDeal({ asin: 'LOSS', brand: 'Acme', currentPrice: 10, roi: 100, estimatedProfit: 1, estimatedMonthlySales: 500 }),
    automaticDeal({ asin: 'PROFIT', brand: 'Acme', currentPrice: 10, roi: 100, estimatedProfit: 1.01, estimatedMonthlySales: 500 }),
  ], students, 10, 'run-profit');
  assert.deepEqual(assignments.a.map((deal) => deal.asin), ['PROFIT']);
});

test('allocation revalidates exact listing identity before delivery', () => {
  const students = [{ id: 'a', minRoi: 60, minMonthlySales: 200, maxCost: 100, excludedBrands: [] }];
  const assignments = allocateDeals([automaticDeal({
    asin: 'WRONG', brand: 'Baby Trend', currentPrice: 50, roi: 100,
    estimatedProfit: 10, estimatedMonthlySales: 500,
    title: 'Baby Trend Nursery Center Playard Animal Jubilee Grey Infant',
    amazonTitle: 'Baby Trend Retreat Nursery Center Playard Bassinet Storage Robin',
  })], students, 10, 'run-revalidate');
  assert.deepEqual(assignments.a, []);
});

test('Discord cards include the mandatory manual IP warning', () => {
  const payload = discordPayload({ name: 'Student' }, [{
    amazonTitle: 'Widget', amazonUrl: 'https://amazon.com/dp/B012345678',
    walmartUrl: 'https://walmart.com/ip/1', asin: 'B012345678', currentPrice: 10,
    amazonPrice: 30, estimatedProfit: 10, roi: 100, estimatedMonthlySales: 500,
  }]);
  assert.match(payload.embeds[0].fields.at(-1).value, /not verified by Keepa/i);
});

test('Discord delivery splits ten deals into bounded messages', () => {
  const deal = {
    amazonTitle: 'Example', amazonUrl: 'https://amazon.com/dp/example', currentPrice: 10,
    amazonPrice: 20, roi: 100, estimatedProfit: 4, estimatedMonthlySales: 300,
    asin: 'EXAMPLE', walmartUrl: 'https://walmart.com/ip/example', imageUrl: '',
  };
  const payloads = discordPayloads({ name: 'Student' }, Array.from({ length: 10 }, () => deal));
  assert.deepEqual(payloads.map((payload) => payload.embeds.length), [4, 4, 2]);
});

test('concurrent and retried Discord workers receive only one delivery claim', async () => {
  const values = new Map();
  const fakeRedis = {
    async get(key) { return values.get(key) || null; },
    async set(key, value, options = {}) {
      if (options.nx && values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    },
  };
  const claims = await Promise.all(Array.from({ length: 8 }, () =>
    claimDiscordDelivery(fakeRedis, 'run-1', 'student-1', 60)));
  assert.equal(claims.filter((claim) => claim === 'claimed').length, 1);
  assert.equal(claims.filter((claim) => claim === 'in_progress').length, 7);
  values.set('run:run-1:delivered:student-1', true);
  assert.equal(await claimDiscordDelivery(fakeRedis, 'run-1', 'student-1', 60), 'delivered');
});

test('zero-deal Discord message reports candidates searched', () => {
  const payload = emptyDiscordPayload({ name: 'Student' }, { candidateCount: 47, failedCandidates: 3 });
  assert.equal(payload.content, '47 products searched, nothing found.');
  assert.deepEqual(payload.embeds, []);
});

test('parses tracked Amazon sellers with optional labels', () => {
  assert.deepEqual(
    parseTrackedSellers('A2L77EE7U53NWQ:Amazon Warehouse, A1B2C3D4E5F6G7'),
    [
      { sellerId: 'A2L77EE7U53NWQ', label: 'Amazon Warehouse' },
      { sellerId: 'A1B2C3D4E5F6G7', label: 'A1B2C3D4E5F6G7' },
    ],
  );
  assert.deepEqual(parseTrackedSellers(''), []);
  assert.deepEqual(parseTrackedSellers(undefined), []);
});

test('builds a retailer-filtered Walmart search URL', () => {
  const url = walmartSearchUrl('Skil 20V battery charger');
  assert.match(url, /^https:\/\/www\.walmart\.com\/search\?/);
  assert.match(url, /q=Skil\+20V\+battery\+charger/);
  assert.match(url, /retailer_type%3AWalmart/);
});

test('finds the best economically-qualifying Walmart match for a tracked Amazon product', () => {
  const amazonProduct = {
    asin: 'B0C4K91FHR',
    title: 'SKIL PWR CORE 20 20V Battery and Charger Starter Kit, Includes 4.0 Ah Battery-CB5196B-11',
    brand: 'Skil',
    upcList: ['195532200568'],
    eanList: [],
    stats: { current: [9900, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1] },
    monthlySold: 100,
    fbaFees: { pickAndPackFee: 500 },
    referralFeePercentage: 15,
  };
  const walmartCandidates = [
    {
      title: 'Skil CB5196B-11 20V PWRCORE 20 Battery and Charger Starter Kit (4 Ah)',
      currentPrice: 53.19,
      upc: '195532200568',
      variantId: '14059371010',
      walmartUrl: 'https://www.walmart.com/ip/14059371010',
      onlineAvailable: true,
    },
    {
      title: 'Completely Unrelated Kitchen Sponge',
      currentPrice: 3,
      upc: '000000000000',
      variantId: 'x',
      walmartUrl: 'https://www.walmart.com/ip/x',
      onlineAvailable: true,
    },
  ];
  const best = bestWalmartMatchForAmazonProduct(amazonProduct, walmartCandidates);
  assert.ok(best);
  assert.equal(best.asin, 'B0C4K91FHR');
  assert.equal(best.currentPrice, 53.19);
  assert.ok(best.roi > 60);
});

test('storefront Discord cards distinguish a qualified match from a plain new-listing alert', () => {
  const matched = {
    asin: 'B0C4K91FHR', amazonTitle: 'Skil Battery Kit', amazonUrl: 'https://amazon.com/dp/B0C4K91FHR',
    amazonPrice: 99, imageUrl: null,
    walmartMatch: {
      currentPrice: 53.19, roi: 86.1, estimatedProfit: 22.18, walmartUrl: 'https://walmart.com/ip/1',
    },
  };
  const unmatched = {
    asin: 'B0OTHER', amazonTitle: 'Some Other Product', amazonUrl: 'https://amazon.com/dp/B0OTHER',
    amazonPrice: 15, imageUrl: null, walmartMatch: null,
  };
  const payload = storefrontDiscordPayload('Acme Storefront', [matched, unmatched]);
  assert.match(payload.content, /NEW LISTING/);
  assert.match(payload.content, /Acme Storefront/);
  assert.equal(payload.embeds[0].color, 0xf1c40f);
  assert.ok(payload.embeds[0].fields.some((f) => f.name === 'Walmart cost'));
  assert.equal(payload.embeds[1].color, 0x3498db);
  assert.ok(payload.embeds[1].fields.some((f) => f.name === 'Sourcing match'));
});

test('storefront Discord delivery splits into bounded messages', () => {
  const listing = { asin: 'X', amazonTitle: 'Item', amazonUrl: 'https://amazon.com/dp/X', amazonPrice: 10, walmartMatch: null };
  const payloads = storefrontDiscordPayloads('Acme', Array.from({ length: 9 }, () => listing));
  assert.equal(payloads.length, 3);
  assert.equal(payloads.reduce((sum, p) => sum + p.embeds.length, 0), 9);
  assert.match(payloads[0].content, /Part 1 of 3/);
});

test('storefront tracking never alerts on gated/high-IP-risk brands by default', () => {
  assert.equal(isBlockedStorefrontBrand({ title: 'Nike Air Max 90 Running Shoes', brand: 'Nike' }), true);
  assert.equal(isBlockedStorefrontBrand({ title: 'Hot Wheels Monster Trucks 5-Pack', brand: '' }), true);
  assert.equal(isBlockedStorefrontBrand({ title: 'Milwaukee M18 Cordless Drill Kit' }), true);
  assert.equal(isBlockedStorefrontBrand({ title: 'Generic Widget 12 Pack', brand: 'Acme' }), false);
});
