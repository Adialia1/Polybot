import 'dotenv/config';

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';

async function findMarket() {
  const searchTerm = process.argv[2];

  if (!searchTerm) {
    console.log('Usage: npm run find-market <search-term>');
    console.log('Example: npm run find-market "trump"');
    process.exit(1);
  }

  console.log(`Searching for markets: "${searchTerm}"...\n`);

  const response = await fetch(
    `${GAMMA_API}/markets?closed=false&_limit=5&question_like=${encodeURIComponent(searchTerm)}`
  );

  if (!response.ok) {
    console.error('Failed to fetch markets');
    process.exit(1);
  }

  const markets = await response.json();

  if (markets.length === 0) {
    console.log('No markets found.');
    process.exit(0);
  }

  console.log(`Found ${markets.length} markets:\n`);

  for (let i = 0; i < markets.length; i++) {
    const market = markets[i];
    console.log(`${i + 1}. ${market.question}`);

    // Fetch detailed market info from CLOB API
    if (market.clobTokenIds) {
      const tokenIds = market.clobTokenIds.split(',');
      const outcomes = market.outcomes ? JSON.parse(market.outcomes) : ['Yes', 'No'];

      for (let j = 0; j < tokenIds.length; j++) {
        const tokenId = tokenIds[j];
        const outcome = outcomes[j] || `Outcome ${j + 1}`;

        // Get price from CLOB
        try {
          const priceRes = await fetch(`${CLOB_API}/price?token_id=${tokenId}&side=buy`);
          const priceData = await priceRes.json();
          const price = priceData.price ? `$${parseFloat(priceData.price).toFixed(2)}` : 'N/A';
          console.log(`   → ${outcome}: ${price}`);
        } catch {
          console.log(`   → ${outcome}: (price unavailable)`);
        }
        console.log(`     Token: ${tokenId}`);
      }
    }
    console.log('');
  }

  console.log('To place a test trade:');
  console.log('npm run test-trade <token-id> BUY 1');
}

findMarket().catch(console.error);
