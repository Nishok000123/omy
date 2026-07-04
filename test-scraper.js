import assert from 'assert';
import {
  normalizeUrl,
  scrapeKamaClips,
  scrapeViralMms,
  scrapeDesiSexVdo,
  scrapeDesiBabe,
  scrapeDesiHub,
  scrapeDesiBF,
  scrapeDesiLeak49,
  scrapeMastiRaja,
  getCached,
  setCached,
  cache,
  CACHE_TTL
} from './scraper.js';

function runNormalizeUrlTests() {
  console.log('\n--- Testing normalizeUrl ---');
  const base = 'https://example.com';
  let passed = 0;
  let failed = 0;

  const testCases = [
    // Falsy inputs
    { input: null, expected: null, desc: 'null input' },
    { input: undefined, expected: null, desc: 'undefined input' },
    { input: '', expected: null, desc: 'empty string input' },

    // Normal URLs
    { input: 'https://example.com/video.mp4', expected: 'https://example.com/video.mp4', desc: 'normal absolute URL' },

    // Protocol-relative URLs
    { input: '//example.com/video.mp4', expected: 'https://example.com/video.mp4', desc: 'protocol-relative URL' },

    // Absolute path URLs
    { input: '/video.mp4', expected: 'https://example.com/video.mp4', desc: 'absolute path URL' },

    // downloaddirect.xyz edge cases
    {
      input: 'https://downloaddirect.xyz/embed/12345-uuid',
      expected: 'https://video.downloaddirect.xyz/12345-uuid.mp4',
      desc: 'downloaddirect.xyz extraction'
    },
    {
      input: 'https://downloaddirect.xyz/embed/12345-uuid?query=1',
      expected: 'https://video.downloaddirect.xyz/12345-uuid.mp4',
      desc: 'downloaddirect.xyz extraction ignoring query string'
    },
    {
      input: 'https://downloaddirect.xyz/embed/12345-uuid#hash',
      expected: 'https://video.downloaddirect.xyz/12345-uuid.mp4',
      desc: 'downloaddirect.xyz extraction ignoring hash fragment'
    }
  ];

  for (const { input, expected, desc } of testCases) {
    try {
      assert.strictEqual(normalizeUrl(input, base), expected);
      passed++;
    } catch (err) {
      console.error(`❌ Failed: ${desc}\n   Expected: ${expected}\n   Actual:   ${err.actual}`);
      failed++;
    }
  }

  console.log(`normalizeUrl tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

async function testScraper(name, fn, ...args) {
  console.log(`\nTesting ${name}...`);
  try {
    const start = Date.now();
    const results = await fn(...args);
    const duration = Date.now() - start;
    console.log(`${name} scraped ${results.length} posts in ${duration}ms.`);
    if (results.length > 0) {
      console.log('Sample:', JSON.stringify(results[0], null, 2));
    }
  } catch (err) {
    console.error(`Error testing ${name}:`, err.message);
  }
}

function testCacheExpiry() {
  console.log('\n--- Testing Cache Expiry ---');
  const testKey = 'test_cache_key';
  const testData = { data: 'test_data' };

  try {
    // Test 1: Happy path (cache hit before TTL)
    setCached(testKey, testData);
    let result = getCached(testKey);
    if (!result || result.data !== 'test_data') throw new Error('Cache hit failed');
    console.log('✓ Cache hit before TTL passed');

    // Test 2: Edge case (cache exactly at TTL)
    const now = Date.now();
    cache[testKey].timestamp = now - CACHE_TTL;
    result = getCached(testKey);
    if (result !== null) throw new Error('Cache hit exactly at TTL should return null');
    console.log('✓ Cache edge case (exactly at TTL) passed');

    // Test 3: Expired condition (cache after TTL)
    cache[testKey].timestamp = now - CACHE_TTL - 1;
    result = getCached(testKey);
    if (result !== null) throw new Error('Cache expired condition failed');
    console.log('✓ Cache expired condition passed');

    // Cleanup
    delete cache[testKey];
    console.log('Cache tests passed successfully.');
  } catch (err) {
    console.error('Error testing cache expiry:', err.message);
  }
}

async function runTests() {
  console.log('--- Starting Scraper Tests ---');

  runNormalizeUrlTests();

  await testScraper('KamaClips', scrapeKamaClips);
  await testScraper('ViralMMS', scrapeViralMms);
  await testScraper('DesiSexVdo', scrapeDesiSexVdo);
  await testScraper('DesiBabe', scrapeDesiBabe);
  await testScraper('DesiHub', scrapeDesiHub);
  await testScraper('DesiBF', scrapeDesiBF);
  await testScraper('DesiLeak49', scrapeDesiLeak49);
  await testScraper('MastiRaja', scrapeMastiRaja);

  console.log('\n--- Testing Search (Tamil) ---');
  await testScraper('MastiRaja Search', scrapeMastiRaja, 1, 'Tamil');

  console.log('\n--- Scraper Tests Finished ---');
}

runTests();
