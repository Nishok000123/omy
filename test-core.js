import assert from 'node:assert';
import { getShortVideoId, videoDownloadUrls } from './core.js';

function runTests() {
  console.log('--- Starting Core Tests ---');
  let testsPassed = 0;
  let testsFailed = 0;

  function runTest(name, testFn) {
    try {
      testFn();
      console.log(`✅ [PASS] ${name}`);
      testsPassed++;
    } catch (error) {
      console.error(`❌ [FAIL] ${name}`);
      console.error(error);
      testsFailed++;
    }
  }

  // Clear videoDownloadUrls before tests to ensure clean state
  videoDownloadUrls.clear();

  runTest('Falsy URLs return null', () => {
    assert.strictEqual(getShortVideoId(''), null);
    assert.strictEqual(getShortVideoId(null), null);
    assert.strictEqual(getShortVideoId(undefined), null);

    // ensure nothing was added
    assert.strictEqual(videoDownloadUrls.size, 0);
  });

  runTest('Valid URL returns correct ID and stores it', () => {
    const url = 'https://example.com/video.mp4';
    const id = getShortVideoId(url);

    // Check ID format
    assert.match(id, /^v\d+$/);

    // Check if it's stored correctly
    assert.strictEqual(videoDownloadUrls.get(id), url);
    assert.strictEqual(videoDownloadUrls.size, 1);
  });

  runTest('Pruning logic works correctly when size > 10000', () => {
    // Fill up to exactly 10000
    for (let i = 0; i < 9999; i++) { // one is already there from the previous test
      getShortVideoId(`https://example.com/video${i}.mp4`);
    }

    assert.strictEqual(videoDownloadUrls.size, 10000);

    // Adding one more should trigger pruning
    getShortVideoId('https://example.com/trigger_prune.mp4');

    // It should prune 2000 items, leaving 10001 - 2000 = 8001
    // Actually, in the code:
    // keys.length > 10000
    // so if length becomes 10001
    // it deletes keys[0] to keys[1999]
    assert.strictEqual(videoDownloadUrls.size, 8001);
  });

  console.log(`--- Core Tests Finished: ${testsPassed} passed, ${testsFailed} failed ---`);

  if (testsFailed > 0) {
    process.exit(1);
  }
}

runTests();
