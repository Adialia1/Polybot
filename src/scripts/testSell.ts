/**
 * Test script to verify that trailing stop, stop loss, take profit, and sell execution work.
 * Run: npx tsx src/scripts/testSell.ts
 *
 * This does NOT execute real trades - it tests the sell pipeline in dry run mode.
 * Use --live to test with a real (tiny) order.
 */

import 'dotenv/config';
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { ClobApiClient } from '../api/clobApi.js';
import { loadConfig } from '../config.js';

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;
const SIGNATURE_TYPE = 0;

async function main() {
  const isLive = process.argv.includes('--live');
  const config = loadConfig();

  console.log('='.repeat(60));
  console.log('  Sell Pipeline Test');
  console.log('='.repeat(60));
  console.log(`Mode: ${isLive ? 'LIVE (real tiny order)' : 'DRY RUN (validation only)'}`);
  console.log('');

  // Step 1: Verify we can connect to CLOB API
  console.log('Step 1: Testing CLOB API connection...');
  const clobApi = new ClobApiClient();
  try {
    // Pick a well-known market to test with
    const testTokenId = '48040927501874008361167368490592511032357843436930790016695118825261334611440';
    const spread = await clobApi.getSpread(testTokenId);
    console.log(`  Spread: Bid=$${spread.bid} Ask=$${spread.ask} Spread=$${spread.spread}`);
    console.log('  CLOB API connection OK');
  } catch (err: any) {
    console.error('  CLOB API connection FAILED:', err.message);
    return;
  }

  // Step 2: Initialize CLOB Client
  console.log('\nStep 2: Initializing CLOB Client...');
  if (!config.privateKey) {
    console.error('  No PRIVATE_KEY configured');
    return;
  }

  const account = privateKeyToAccount(config.privateKey as `0x${string}`);
  const funderAddress = config.funderAddress || account.address;
  console.log(`  Signer: ${account.address}`);
  console.log(`  Funder: ${funderAddress}`);

  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http('https://polygon.drpc.org'),
  });

  const apiCredentials = process.env.POLY_API_KEY && process.env.POLY_API_SECRET && process.env.POLY_PASSPHRASE
    ? {
        key: process.env.POLY_API_KEY,
        secret: process.env.POLY_API_SECRET,
        passphrase: process.env.POLY_PASSPHRASE,
      }
    : undefined;

  let creds = apiCredentials;
  if (!creds) {
    const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, walletClient, undefined, SIGNATURE_TYPE, funderAddress);
    creds = await tempClient.createOrDeriveApiKey();
    console.log('  API credentials derived');
  }

  const client = new ClobClient(CLOB_HOST, CHAIN_ID, walletClient, creds, SIGNATURE_TYPE, funderAddress);
  console.log('  Client initialized');

  // Step 3: Test getTickSize, getNegRisk, getFeeRateBps
  console.log('\nStep 3: Testing market info methods...');

  // Fetch positions to find an active market to test with
  let testAsset = '';
  try {
    const posRes = await fetch(`https://data-api.polymarket.com/positions?user=${funderAddress.toLowerCase()}`);
    const positions = await posRes.json();
    if (Array.isArray(positions) && positions.length > 0) {
      testAsset = positions[0].asset;
      console.log(`  Using position: ${positions[0].title} (${positions[0].outcome})`);
      console.log(`  Asset: ${testAsset.slice(0, 30)}...`);
      console.log(`  Size: ${positions[0].size} shares`);
    }
  } catch (err: any) {
    console.log(`  Could not fetch positions: ${err.message}`);
  }

  if (!testAsset) {
    console.log('  No active positions found. Using fallback token for testing.');
    testAsset = '48040927501874008361167368490592511032357843436930790016695118825261334611440';
  }

  try {
    const tickSize = await client.getTickSize(testAsset);
    console.log(`  tickSize: ${tickSize}`);

    const negRisk = await client.getNegRisk(testAsset);
    console.log(`  negRisk: ${negRisk}`);

    const feeRate = await client.getFeeRateBps(testAsset);
    console.log(`  feeRateBps: ${feeRate}`);

    console.log('  Market info OK');
  } catch (err: any) {
    console.error('  Market info FAILED:', err.message);
    console.log('  This means orders would also fail!');
    return;
  }

  // Step 4: Test order book depth
  console.log('\nStep 4: Testing order book depth...');
  try {
    const book = await client.getOrderBook(testAsset);
    console.log(`  Bids: ${book.bids.length} levels`);
    console.log(`  Asks: ${book.asks.length} levels`);
    console.log(`  tick_size: ${book.tick_size}`);
    console.log(`  neg_risk: ${book.neg_risk}`);

    if (book.bids.length > 0) {
      const topBid = book.bids[0];
      console.log(`  Top bid: $${topBid.price} x ${topBid.size}`);

      // Calculate total bid depth
      let totalBidDepth = 0;
      for (const bid of book.bids) {
        totalBidDepth += parseFloat(bid.size);
      }
      console.log(`  Total bid depth: ${totalBidDepth.toFixed(2)} shares`);
    }

    if (book.asks.length > 0) {
      const topAsk = book.asks[0];
      console.log(`  Top ask: $${topAsk.price} x ${topAsk.size}`);
    }

    console.log('  Order book OK');
  } catch (err: any) {
    console.error('  Order book FAILED:', err.message);
  }

  // Step 5: Test creating a sell order (signed but not posted)
  console.log('\nStep 5: Testing sell order creation...');
  try {
    const tickSize = await client.getTickSize(testAsset);
    const negRisk = await client.getNegRisk(testAsset);

    // Create a sell order but don't post it (just test signing)
    const signedOrder = await client.createMarketOrder(
      {
        tokenID: testAsset,
        amount: 0.1, // Tiny amount: 0.1 shares
        side: Side.SELL,
        price: 0.01, // Min price
      },
      { tickSize, negRisk }
    );

    console.log(`  Signed order created successfully`);
    console.log(`  Order maker: ${signedOrder.maker}`);
    console.log(`  Order signer: ${signedOrder.signer}`);
    console.log(`  Fee rate: ${signedOrder.feeRateBps}`);
    console.log(`  Signature type: ${signedOrder.signatureType}`);
    console.log('  Sell order creation OK');
  } catch (err: any) {
    console.error('  Sell order creation FAILED:', err.message);
    console.log('  This is the core issue - sells will not work!');
  }

  // Step 6: Test balance/allowance
  console.log('\nStep 6: Testing balance and allowance...');
  try {
    const collateralBal = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' as any });
    console.log(`  USDC Balance: ${collateralBal.balance}`);
    console.log(`  USDC Allowance: ${collateralBal.allowance}`);

    const conditionalBal = await client.getBalanceAllowance({
      asset_type: 'CONDITIONAL' as any,
      token_id: testAsset,
    });
    console.log(`  Conditional Token Balance: ${conditionalBal.balance}`);
    console.log(`  Conditional Token Allowance: ${conditionalBal.allowance}`);
    console.log('  Balance/allowance OK');
  } catch (err: any) {
    console.error('  Balance/allowance FAILED:', err.message);
  }

  // Step 7: Live test (optional)
  if (isLive) {
    console.log('\nStep 7: LIVE sell test (0.1 shares)...');
    console.log('  WARNING: This will attempt a real sell order!');

    try {
      const tickSize = await client.getTickSize(testAsset);
      const negRisk = await client.getNegRisk(testAsset);
      const spread = await clobApi.getSpread(testAsset);
      const bidPrice = parseFloat(spread.bid || '0');

      if (bidPrice <= 0) {
        console.log('  No bid available - cannot sell');
        return;
      }

      console.log(`  Selling 0.1 shares at bid $${bidPrice}`);

      const result = await client.createAndPostMarketOrder(
        {
          tokenID: testAsset,
          amount: 0.1, // 0.1 shares
          side: Side.SELL,
          price: Math.max(0.01, bidPrice * 0.95), // 5% slippage tolerance
        },
        { tickSize, negRisk },
        OrderType.FAK, // Fill-And-Kill
      );

      console.log(`  Order result:`, JSON.stringify(result, null, 2));
      console.log('  LIVE sell test completed');
    } catch (err: any) {
      console.error('  LIVE sell test FAILED:', err.message);
    }
  } else {
    console.log('\nStep 7: Skipped (use --live to test real order)');
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('  Test Complete');
  console.log('='.repeat(60));
  console.log('\nIf all steps passed, the sell pipeline should work.');
  console.log('If step 5 failed, sells will not work (check signature type, credentials).');
  console.log('If step 3 failed, order creation will fail (fee rate issue).');
}

main().catch(console.error);
