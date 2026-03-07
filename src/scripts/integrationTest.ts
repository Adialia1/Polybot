/**
 * Comprehensive Integration Test Script
 *
 * Tests the full trading pipeline end-to-end:
 * 1. Finds a stable, liquid market on Polymarket
 * 2. Opens a real position ($1-2 BUY via copyTrade)
 * 3. Places GTC limit orders (stop loss + take profit)
 * 4. Verifies open orders exist
 * 5. Cancels all orders and verifies cancellation
 * 6. Sells the position to close out the test trade
 * 7. Reports PASS/FAIL for each step
 *
 * Usage:
 *   npx tsx src/scripts/integrationTest.ts          # Analysis-only (dry run)
 *   npx tsx src/scripts/integrationTest.ts --live    # Execute real trades
 *
 * Run via npm:
 *   npm run integration-test                         # Analysis-only
 *   npm run integration-test -- --live               # Execute real trades
 */

import 'dotenv/config';
import axios from 'axios';
import { Trader } from '../services/trader.js';
import { ClobApiClient } from '../api/clobApi.js';
import { loadConfig } from '../config.js';
import type { Trade } from '../types/index.js';

const GAMMA_API = 'https://gamma-api.polymarket.com';
const TRADE_AMOUNT_USD = 1; // Spend $1 on the test trade
const STOP_LOSS_PERCENT = 0.15; // 15% below entry
const TAKE_PROFIT_PERCENT = 0.25; // 25% above entry

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StepResult {
  step: number;
  name: string;
  passed: boolean;
  detail: string;
  durationMs: number;
}

const results: StepResult[] = [];

function record(step: number, name: string, passed: boolean, detail: string, durationMs: number): void {
  results.push({ step, name, passed, detail, durationMs });
  const tag = passed ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${detail}  (${durationMs}ms)`);
}

function printSummary(): void {
  console.log('');
  console.log('='.repeat(70));
  console.log('  Integration Test Summary');
  console.log('='.repeat(70));
  for (const r of results) {
    const tag = r.passed ? 'PASS' : 'FAIL';
    console.log(`  Step ${r.step}: [${tag}] ${r.name} — ${r.detail}  (${r.durationMs}ms)`);
  }
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log('-'.repeat(70));
  console.log(`  Total: ${passed} passed, ${failed} failed out of ${results.length} steps`);
  console.log('='.repeat(70));
}

/** Round a price to the nearest tick size */
function alignPrice(price: number, tickSize: string): number {
  const tick = parseFloat(tickSize);
  const aligned = Math.round(price / tick) * tick;
  // Clamp between 0.01 and 0.99 (valid Polymarket price range)
  return Math.max(tick, Math.min(1 - tick, parseFloat(aligned.toFixed(String(tick).split('.')[1]?.length || 2))));
}

/** Sleep for ms milliseconds */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Step 1 — Find a stable, liquid market
// ---------------------------------------------------------------------------

interface MarketCandidate {
  tokenId: string;
  question: string;
  outcome: string;
  bestBid: number;
  bestAsk: number;
  midPrice: number;
  spread: number;
  bidDepth: number; // total USD depth on bid side
  askDepth: number; // total USD depth on ask side
  tickSize: string;
}

async function findLiquidMarket(clobApi: ClobApiClient, config: any): Promise<MarketCandidate | null> {
  // Check if user provided a specific token ID
  const tokenArg = process.argv.find(a => a.startsWith('--token='));
  if (tokenArg) {
    const tokenId = tokenArg.split('=')[1];
    console.log(`  Using provided token ID: ${tokenId.slice(0, 30)}...`);
    return await checkSingleToken(clobApi, tokenId);
  }

  const candidates: MarketCandidate[] = [];

  // Strategy 1: Check tracked traders' positions for markets with active order books
  console.log('  Strategy 1: Checking tracked traders\' active positions...');
  const trackedWallets = config.wallets?.filter((w: any) => w.enabled) || [];

  for (const wallet of trackedWallets) {
    if (candidates.length >= 5) break;
    try {
      const res = await fetch(`https://data-api.polymarket.com/positions?user=${wallet.address.toLowerCase()}`);
      const positions: any[] = await res.json();
      console.log(`  ${wallet.alias}: ${positions.length} positions`);

      for (const pos of positions) {
        if (candidates.length >= 5) break;
        const candidate = await checkSingleToken(clobApi, pos.asset, pos.title, pos.outcome);
        if (candidate) candidates.push(candidate);
      }
    } catch {
      continue;
    }
  }

  if (candidates.length > 0) {
    console.log(`  Found ${candidates.length} candidates from trader positions`);
  } else {
    console.log('  No liquid markets found in trader positions');
  }

  // Strategy 2: Check Gamma API for active markets in various categories
  if (candidates.length === 0) {
    console.log('  Strategy 2: Searching Gamma API for active markets...');
    const tags = ['politics', 'crypto', 'sports', 'pop-culture', 'business', 'science'];

    for (const tag of tags) {
      if (candidates.length >= 3) break;
      try {
        const res = await fetch(
          `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=20&tag=${tag}`
        );
        const markets: any[] = await res.json();

        for (const market of markets) {
          if (candidates.length >= 3) break;
          const raw = market.clobTokenIds;
          if (raw === null || raw === undefined) continue;

          let tokenIds: string[];
          try {
            if (typeof raw === 'string' && raw.startsWith('[')) tokenIds = JSON.parse(raw);
            else if (typeof raw === 'string') tokenIds = raw.split(',').map((t: string) => t.trim());
            else tokenIds = raw;
          } catch { continue; }

          let outcomes: string[];
          try {
            outcomes = market.outcomes
              ? (typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes)
              : ['Yes', 'No'];
          } catch { outcomes = ['Yes', 'No']; }

          for (let i = 0; i < tokenIds.length; i++) {
            if (candidates.length >= 3) break;
            const candidate = await checkSingleToken(clobApi, tokenIds[i], market.question, outcomes[i]);
            if (candidate) candidates.push(candidate);
          }
        }
      } catch { continue; }
    }
  }

  if (candidates.length === 0) return null;

  // Sort by smallest spread, then highest depth
  candidates.sort((a, b) => {
    if (a.spread !== b.spread) return a.spread - b.spread;
    return (b.bidDepth + b.askDepth) - (a.bidDepth + a.askDepth);
  });

  return candidates[0];
}

async function checkSingleToken(
  clobApi: ClobApiClient,
  tokenId: string,
  title?: string,
  outcome?: string,
): Promise<MarketCandidate | null> {
  if (tokenId === undefined || tokenId.length < 10) return null;

  try {
    const book = await clobApi.getOrderBook(tokenId);
    if (book.bids.length === 0 || book.asks.length === 0) return null;

    const bestBid = parseFloat(book.bids[0].price);
    const bestAsk = parseFloat(book.asks[0].price);
    const midPrice = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;

    // Need mid-range price and reasonable spread for a test trade
    if (midPrice < 0.10 || midPrice > 0.90) return null;
    if (spread >= 0.20) return null;

    let bidDepth = 0;
    for (const level of book.bids) {
      bidDepth += parseFloat(level.size) * parseFloat(level.price);
    }
    let askDepth = 0;
    for (const level of book.asks) {
      askDepth += parseFloat(level.size) * parseFloat(level.price);
    }

    if (bidDepth < 1 || askDepth < 1) return null;

    const tickSize = (book as any).tick_size || '0.01';

    return {
      tokenId,
      question: title || 'Unknown',
      outcome: outcome || 'Unknown',
      bestBid,
      bestAsk,
      midPrice,
      spread,
      bidDepth,
      askDepth,
      tickSize,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const isLive = process.argv.includes('--live');
  const config = loadConfig();

  console.log('='.repeat(70));
  console.log('  Polymarket Integration Test');
  console.log('='.repeat(70));
  console.log(`  Mode:       ${isLive ? 'LIVE (real trades with real money)' : 'ANALYSIS ONLY (no trades executed)'}`);
  console.log(`  Amount:     $${TRADE_AMOUNT_USD}`);
  console.log(`  Stop Loss:  -${(STOP_LOSS_PERCENT * 100).toFixed(0)}%`);
  console.log(`  Take Profit: +${(TAKE_PROFIT_PERCENT * 100).toFixed(0)}%`);
  console.log('='.repeat(70));
  console.log('');

  if (!config.privateKey) {
    console.error('ERROR: No PRIVATE_KEY configured. Set it in .env or config.json.');
    process.exit(1);
  }

  // Shared API client
  const clobApi = new ClobApiClient();

  // Initialize Trader (always live internally — we gate execution with isLive flag)
  const trader = new Trader({
    privateKey: config.privateKey,
    funderAddress: config.funderAddress,
    dryRun: !isLive,
    apiCredentials:
      process.env.POLY_API_KEY && process.env.POLY_API_SECRET && process.env.POLY_PASSPHRASE
        ? {
            key: process.env.POLY_API_KEY,
            secret: process.env.POLY_API_SECRET,
            passphrase: process.env.POLY_PASSPHRASE,
          }
        : undefined,
  });

  // State we need to clean up on failure
  let boughtTokenId: string | null = null;
  let boughtShares = 0;
  let boughtPrice = 0;
  let boughtTitle = '';
  let ordersPlaced = false;

  try {
    // -----------------------------------------------------------------------
    // Step 0: Initialize Trader
    // -----------------------------------------------------------------------
    console.log('Step 0: Initializing Trader...');
    let t0 = Date.now();
    await trader.initialize();
    record(0, 'Initialize Trader', true, 'Trader initialized and CLOB client ready', Date.now() - t0);

    // -----------------------------------------------------------------------
    // Step 1: Find a liquid market
    // -----------------------------------------------------------------------
    console.log('\nStep 1: Finding a stable, liquid market...');
    t0 = Date.now();
    const market = await findLiquidMarket(clobApi, config);

    if (!market) {
      record(1, 'Find liquid market', false, 'No liquid market found. Sports markets may be between events. Use --token=<TOKEN_ID> to specify a market manually.', Date.now() - t0);
      printSummary();
      process.exit(1);
    }

    console.log(`  Selected market:`);
    console.log(`    Question:  ${market.question}`);
    console.log(`    Outcome:   ${market.outcome}`);
    console.log(`    Token ID:  ${market.tokenId.slice(0, 40)}...`);
    console.log(`    Best Bid:  $${market.bestBid.toFixed(4)}`);
    console.log(`    Best Ask:  $${market.bestAsk.toFixed(4)}`);
    console.log(`    Mid Price: $${market.midPrice.toFixed(4)}`);
    console.log(`    Spread:    $${market.spread.toFixed(4)}`);
    console.log(`    Bid Depth: $${market.bidDepth.toFixed(2)}`);
    console.log(`    Ask Depth: $${market.askDepth.toFixed(2)}`);
    console.log(`    Tick Size: ${market.tickSize}`);

    record(1, 'Find liquid market', true, `${market.question} [${market.outcome}] @ $${market.midPrice.toFixed(4)}, spread $${market.spread.toFixed(4)}`, Date.now() - t0);

    if (!isLive) {
      // In analysis mode, show what WOULD happen and stop
      console.log('\n--- Analysis Mode: Showing what would happen ---');

      const entryPrice = market.bestAsk;
      const estimatedShares = TRADE_AMOUNT_USD / entryPrice;
      const stopLossPrice = alignPrice(entryPrice * (1 - STOP_LOSS_PERCENT), market.tickSize);
      const takeProfitPrice = alignPrice(entryPrice * (1 + TAKE_PROFIT_PERCENT), market.tickSize);

      console.log(`\n  Step 2 (BUY):  Would buy $${TRADE_AMOUNT_USD} at ~$${entryPrice.toFixed(4)} = ~${estimatedShares.toFixed(2)} shares`);
      console.log(`  Step 3a (SL):  Would place SELL limit @ $${stopLossPrice.toFixed(4)} (${estimatedShares.toFixed(2)} shares)`);
      console.log(`  Step 3b (TP):  Would place SELL limit @ $${takeProfitPrice.toFixed(4)} (${estimatedShares.toFixed(2)} shares)`);
      console.log(`  Step 4:        Would verify 2 open orders`);
      console.log(`  Step 5:        Would cancel all orders and verify 0 remain`);
      console.log(`  Step 6:        Would sell ${estimatedShares.toFixed(2)} shares at bid ~$${market.bestBid.toFixed(4)}`);
      console.log(`\n  Estimated cost: ~$${(estimatedShares * (entryPrice - market.bestBid)).toFixed(4)} in spread`);

      console.log('\n  To execute for real, run with --live flag.');

      record(2, 'Buy position (dry run)', true, `Would buy $${TRADE_AMOUNT_USD} worth`, 0);
      record(3, 'Place limit orders (dry run)', true, `Would place SL@$${stopLossPrice.toFixed(4)} TP@$${takeProfitPrice.toFixed(4)}`, 0);
      record(4, 'Verify orders (dry run)', true, 'Would verify 2 open orders', 0);
      record(5, 'Cancel orders (dry run)', true, 'Would cancel all orders', 0);
      record(6, 'Sell position (dry run)', true, `Would sell ~${estimatedShares.toFixed(2)} shares`, 0);

      printSummary();
      return;
    }

    // -----------------------------------------------------------------------
    // Step 2: Buy $1 worth of shares via copyTrade
    // -----------------------------------------------------------------------
    console.log('\nStep 2: Buying position via copyTrade...');
    t0 = Date.now();

    // Build a synthetic Trade object to pass to copyTrade
    const syntheticTrade: Trade = {
      id: `integration-test-${Date.now()}`,
      proxyWallet: '0x0000000000000000000000000000000000000000',
      side: 'BUY',
      asset: market.tokenId,
      conditionId: '',
      size: String(TRADE_AMOUNT_USD / market.bestAsk),
      price: String(market.bestAsk), // Use best ask as the price (market buy)
      timestamp: Date.now(),
      title: market.question,
      slug: '',
      outcome: market.outcome,
      outcomeIndex: 0,
      transactionHash: '',
      eventSlug: '',
    };

    const buyResult = await trader.copyTrade(syntheticTrade, TRADE_AMOUNT_USD);

    if (!buyResult.success) {
      record(2, 'Buy position', false, `copyTrade failed: ${buyResult.error}`, Date.now() - t0);
      printSummary();
      process.exit(1);
    }

    boughtTokenId = market.tokenId;
    boughtPrice = buyResult.details?.price || market.bestAsk;
    boughtShares = buyResult.details?.size || (TRADE_AMOUNT_USD / boughtPrice);
    boughtTitle = market.question;

    console.log(`  Order ID: ${buyResult.orderId}`);
    console.log(`  Price:    $${boughtPrice.toFixed(4)}`);
    console.log(`  Shares:   ${boughtShares.toFixed(4)}`);

    record(2, 'Buy position', true, `Bought ~${boughtShares.toFixed(2)} shares @ $${boughtPrice.toFixed(4)} (order ${buyResult.orderId})`, Date.now() - t0);

    // Small delay to let the order settle on-chain
    console.log('  Waiting 2s for order to settle...');
    await sleep(2000);

    // -----------------------------------------------------------------------
    // Step 3: Place stop loss and take profit GTC limit orders
    // -----------------------------------------------------------------------
    console.log('\nStep 3: Placing stop loss and take profit limit orders...');
    t0 = Date.now();

    const stopLossPrice = alignPrice(boughtPrice * (1 - STOP_LOSS_PERCENT), market.tickSize);
    const takeProfitPrice = alignPrice(boughtPrice * (1 + TAKE_PROFIT_PERCENT), market.tickSize);

    console.log(`  Entry price:      $${boughtPrice.toFixed(4)}`);
    console.log(`  Stop loss price:  $${stopLossPrice.toFixed(4)} (-${(STOP_LOSS_PERCENT * 100).toFixed(0)}%)`);
    console.log(`  Take profit price: $${takeProfitPrice.toFixed(4)} (+${(TAKE_PROFIT_PERCENT * 100).toFixed(0)}%)`);
    console.log(`  Shares per order: ${boughtShares.toFixed(4)}`);

    // Place stop loss
    const slResult = await trader.placeLimitOrder(
      market.tokenId,
      'SELL',
      boughtShares,
      stopLossPrice,
    );

    if (!slResult.success) {
      record(3, 'Place limit orders', false, `Stop loss failed: ${slResult.error}`, Date.now() - t0);
      // Continue to cleanup
    } else {
      console.log(`  Stop loss order ID: ${slResult.orderId}`);
      ordersPlaced = true;
    }

    // Place take profit
    const tpResult = await trader.placeLimitOrder(
      market.tokenId,
      'SELL',
      boughtShares,
      takeProfitPrice,
    );

    if (!tpResult.success) {
      const msg = slResult.success
        ? `Take profit failed: ${tpResult.error} (stop loss succeeded)`
        : `Both orders failed: SL=${slResult.error}, TP=${tpResult.error}`;
      record(3, 'Place limit orders', false, msg, Date.now() - t0);
    } else {
      console.log(`  Take profit order ID: ${tpResult.orderId}`);
      ordersPlaced = true;

      record(3, 'Place limit orders', true, `SL@$${stopLossPrice.toFixed(4)} (${slResult.orderId}), TP@$${takeProfitPrice.toFixed(4)} (${tpResult.orderId})`, Date.now() - t0);
    }

    // Small delay for orders to register
    await sleep(1000);

    // -----------------------------------------------------------------------
    // Step 4: Verify open orders exist
    // -----------------------------------------------------------------------
    console.log('\nStep 4: Verifying open orders...');
    t0 = Date.now();

    const openOrders = await trader.getOpenOrders();
    console.log(`  Found ${openOrders.length} open order(s)`);

    if (openOrders.length > 0) {
      for (const order of openOrders) {
        const orderId = order.id || order.orderID || order.order_id || 'unknown';
        const orderSide = order.side || 'unknown';
        const orderPrice = order.price || 'unknown';
        const orderSize = order.original_size || order.size || 'unknown';
        console.log(`    Order: ${orderId} | ${orderSide} | $${orderPrice} | ${orderSize} shares`);
      }
    }

    // We expect at least the orders we placed (there may be others from previous activity)
    const expectedOrders = (slResult.success ? 1 : 0) + (tpResult.success ? 1 : 0);
    const orderCheckPassed = openOrders.length >= expectedOrders && expectedOrders > 0;

    record(
      4,
      'Verify open orders',
      orderCheckPassed,
      orderCheckPassed
        ? `Found ${openOrders.length} open orders (expected >= ${expectedOrders})`
        : `Found ${openOrders.length} open orders but expected >= ${expectedOrders}`,
      Date.now() - t0,
    );

    // -----------------------------------------------------------------------
    // Step 5: Cancel all orders and verify
    // -----------------------------------------------------------------------
    console.log('\nStep 5: Cancelling all orders...');
    t0 = Date.now();

    const cancelSuccess = await trader.cancelAllOrders();

    if (!cancelSuccess) {
      record(5, 'Cancel all orders', false, 'cancelAllOrders() returned false', Date.now() - t0);
    } else {
      // Wait a moment, then verify
      await sleep(1000);

      const remainingOrders = await trader.getOpenOrders();
      console.log(`  Orders remaining after cancel: ${remainingOrders.length}`);

      const cancelVerified = remainingOrders.length === 0;
      record(
        5,
        'Cancel all orders',
        cancelVerified,
        cancelVerified
          ? 'All orders cancelled and verified (0 remaining)'
          : `Cancel called but ${remainingOrders.length} orders still open`,
        Date.now() - t0,
      );
    }

    // -----------------------------------------------------------------------
    // Step 6: Sell the position to close out
    // -----------------------------------------------------------------------
    console.log('\nStep 6: Selling position to close out...');
    t0 = Date.now();

    // Re-fetch current bid price for the sell
    const currentSpread = await clobApi.getSpread(market.tokenId);
    const currentBid = parseFloat(currentSpread.bid);
    console.log(`  Current bid: $${currentBid.toFixed(4)}`);
    console.log(`  Selling ${boughtShares.toFixed(4)} shares`);

    if (currentBid <= 0) {
      record(6, 'Sell position', false, 'No bid available - cannot sell', Date.now() - t0);
    } else {
      const sellResult = await trader.sellPosition(
        market.tokenId,
        boughtShares,
        currentBid,
        boughtTitle,
      );

      if (sellResult.success) {
        const pnl = (currentBid - boughtPrice) * boughtShares;
        console.log(`  Sell order ID: ${sellResult.orderId}`);
        console.log(`  Estimated P&L: $${pnl.toFixed(4)}`);

        record(6, 'Sell position', true, `Sold ${boughtShares.toFixed(2)} shares @ ~$${currentBid.toFixed(4)} (order ${sellResult.orderId}), est P&L $${pnl.toFixed(4)}`, Date.now() - t0);

        // Clear state since we sold
        boughtTokenId = null;
      } else {
        record(6, 'Sell position', false, `sellPosition failed: ${sellResult.error}`, Date.now() - t0);
      }
    }
  } catch (error: any) {
    console.error(`\nUnexpected error: ${error.message}`);
    console.error(error.stack);

    // Record failure for whatever step we were on
    const lastStep = results.length > 0 ? results[results.length - 1].step + 1 : 0;
    record(lastStep, 'Unexpected error', false, error.message, 0);
  } finally {
    // -----------------------------------------------------------------------
    // Cleanup: ensure no dangling orders or positions
    // -----------------------------------------------------------------------
    if (isLive) {
      console.log('\n--- Cleanup ---');

      if (ordersPlaced) {
        try {
          console.log('  Cancelling any remaining orders...');
          await trader.cancelAllOrders();
          console.log('  Orders cancelled.');
        } catch (e: any) {
          console.error(`  Failed to cancel orders during cleanup: ${e.message}`);
        }
      }

      if (boughtTokenId) {
        try {
          console.log(`  Selling remaining position (${boughtShares.toFixed(4)} shares)...`);
          const currentSpread = await clobApi.getSpread(boughtTokenId);
          const currentBid = parseFloat(currentSpread.bid);
          if (currentBid > 0) {
            await trader.sellPosition(boughtTokenId, boughtShares, currentBid, boughtTitle);
            console.log('  Position sold during cleanup.');
          } else {
            console.error('  Cannot sell during cleanup: no bid available.');
          }
        } catch (e: any) {
          console.error(`  Failed to sell position during cleanup: ${e.message}`);
        }
      }
    }

    printSummary();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
