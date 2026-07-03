import {
  scrapeKamaClips,
  scrapeViralMms,
  scrapeDesiSexVdo,
  scrapeDesiBabe,
  scrapeDesiHub
} from './scraper.js';

async function runTests() {
  console.log('--- Starting Scraper Tests ---');

  console.log('\nTesting KamaClips...');
  const kama = await scrapeKamaClips();
  console.log(`KamaClips scraped ${kama.length} posts.`);
  if (kama.length > 0) console.log('Sample:', kama[0]);

  console.log('\nTesting ViralMMS...');
  const viral = await scrapeViralMms();
  console.log(`ViralMMS scraped ${viral.length} posts.`);
  if (viral.length > 0) console.log('Sample:', viral[0]);

  console.log('\nTesting DesiSexVdo...');
  const desisex = await scrapeDesiSexVdo();
  console.log(`DesiSexVdo scraped ${desisex.length} posts.`);
  if (desisex.length > 0) console.log('Sample:', desisex[0]);

  console.log('\nTesting DesiBabe...');
  const desibabe = await scrapeDesiBabe();
  console.log(`DesiBabe scraped ${desibabe.length} posts.`);
  if (desibabe.length > 0) console.log('Sample:', desibabe[0]);

  console.log('\nTesting DesiHub...');
  const desihub = await scrapeDesiHub();
  console.log(`DesiHub scraped ${desihub.length} posts.`);
  if (desihub.length > 0) console.log('Sample:', desihub[0]);

  console.log('\n--- Scraper Tests Finished ---');
}

runTests();
