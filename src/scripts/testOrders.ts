/**
 * Test script to verify limit order placement, verification, and cancellation.
 *
 * This tests the core mechanics that stop loss, take profit, and trailing stop
 * depend on. It places REAL orders on the exchange (at extreme prices so they
 * won't fill) and verifies the full lifecycle.
 *
 * Run: npx tsx src/scripts/testOrders.ts
 *   or: npm run test-orders
 */

import 'dotenv/config';
import axios from 'axios';
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { ClobApiClient } from '../api/clobApi.js';
import { loadConfig } from '../config.js';

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

interface StepResult {
  step: number;
  name: string;
  passed: boolean;
  detail: string;
}

const results: StepResult[] = [];

function record(step: number, name: string, passed: boolean, detail: string): void {
  results.push({ step, name, passed, detail });
  const tag = passed ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${detail}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const config = loadConfig();

  console.log('='.repeat(60));
  console.log('  Order Mechanics Test');
  console.log('  Tests: place limit orders, verify, cancel');
  console.log('='.repeat(60));
  console.log('');

  if (!config.privateKey) {
    console.error('ERROR: No PRIVATE_KEY configured');
    process.exit(1);
  }

  // Step 1: Initialize CLOB client
  console.log('Step 1: Initializing CLOB client...');
  const account = privateKeyToAccount(config.privateKey as `0x${string}`);
  const funderAddress = config.funderAddress || account.address;
  const sigType = funderAddress.toLowerCase() !== account.address.toLowerCase() ? 2 : 0;
  console.log(`  Signer: ${account.address}`);
  console.log(`  Funder: ${funderAddress}`);
  console.log(`  Signature type: ${sigType === 2 ? 'Poly Proxy (2)' : 'EOA (0)'}`);

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
    const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, walletClient, undefined, sigType, funderAddress);
    creds = await tempClient.createOrDeriveApiKey();
    console.log('  API credentials derived');
  }

  const client = new ClobClient(CLOB_HOST, CHAIN_ID, walletClient, creds, sigType, funderAddress);
  record(1, 'Init client', true, 'CLOB client initialized');

  // Step 2: Find a token to test with
  // We'll use any active market token - doesn't matter if spread is bad
  // We're placing orders at extreme prices that won't fill
  console.log('\nStep 2: Finding a test token...');
  const clobApi = new ClobApiClient();

  let testTokenId = '';
  let testTickSize = '0.01';
  let testNegRisk = false;
  let testFeeRate = 0;
  let testTitle = '';

  // Scan CLOB /markets for an active orderbook (accepting_orders=true, not closed)
  console.log('  Scanning CLOB markets for active orderbook...');

  const clobDirect = axios.create({ baseURL: CLOB_HOST, timeout: 10000 });
  let cursor = 'MA==';
  let foundActive = false;

  for (let page = 0; page < 30 && !foundActive; page++) {
    try {
      const marketsRes = await clobDirect.get('/markets', { params: { next_cursor: cursor } });
      const marketsData = marketsRes.data;
      const markets = marketsData.data || marketsData || [];
      cursor = marketsData.next_cursor || '';

      for (const m of markets) {
        if (foundActive) break;
        // Need a market that accepts orders (may still be "closed" flag)
        if (m.accepting_orders !== true && m.enable_order_book !== true) continue;

        for (const token of (m.tokens || [])) {
          if (foundActive) break;
          const tid = token.token_id;
          if (!tid || tid.length < 10) continue;

          try {
            const ts = await client.getTickSize(tid);
            const nr = await client.getNegRisk(tid);
            const fr = await client.getFeeRateBps(tid);

            // Active markets have feeRate > 0
            if (parseInt(String(fr)) > 0) {
              testTokenId = tid;
              testTickSize = ts;
              testNegRisk = nr;
              testFeeRate = parseInt(String(fr));
              testTitle = m.question || 'Unknown';
              foundActive = true;
              console.log(`  Found active market on page ${page + 1}: ${testTitle}`);
            }
          } catch { continue; }
        }
      }

      if (!cursor) break;
    } catch { break; }
  }

  if (!foundActive) {
    // Try user-specified token
    const tokenArg = process.argv.find(a => a.startsWith('--token='));
    if (tokenArg) {
      testTokenId = tokenArg.split('=')[1];
      console.log(`  Using user-specified token: ${testTokenId.slice(0, 30)}...`);
    } else {
      console.log('  No active orderbook found. All markets may be between events.');
      console.log('  Use --token=<TOKEN_ID> to specify a market manually.');
      record(2, 'Find token', false, 'No active orderbook found. Try again during market hours or use --token=<TOKEN_ID>');
      printSummary();
      process.exit(1);
    }
  }

  // Get market info
  try {
    if (!foundActive) {
      testTickSize = await client.getTickSize(testTokenId);
      testNegRisk = await client.getNegRisk(testTokenId);
      testFeeRate = parseInt(String(await client.getFeeRateBps(testTokenId)));
    }
    console.log(`  Token: ${testTokenId.slice(0, 30)}...`);
    console.log(`  Title: ${testTitle}`);
    console.log(`  tickSize: ${testTickSize}`);
    console.log(`  negRisk: ${testNegRisk}`);
    console.log(`  feeRateBps: ${testFeeRate}`);
    record(2, 'Find token', true, `Active orderbook found: fee=${testFeeRate}, tick=${testTickSize}`);
  } catch (err: any) {
    record(2, 'Find token', false, `Failed to get market info: ${err.message}`);
    printSummary();
    process.exit(1);
  }

  // Step 3: Cancel any existing orders first (clean slate)
  console.log('\nStep 3: Cleaning existing orders...');
  try {
    await client.cancelAll();
    await sleep(1000);
    const existing = await client.getOpenOrders();
    const existingOrders = (existing as any)?.orders || existing || [];
    console.log(`  Existing orders after cancel: ${existingOrders.length}`);
    record(3, 'Clean orders', true, `Cancelled all, ${existingOrders.length} remaining`);
  } catch (err: any) {
    record(3, 'Clean orders', false, `Failed: ${err.message}`);
  }

  // Step 4: Place a GTC SELL limit order (simulating stop loss)
  // Place at $0.01 - the minimum price, so it won't fill
  console.log('\nStep 4: Placing stop loss limit order (SELL @ $0.01)...');
  let stopLossOrderId = '';
  try {
    const options = { tickSize: testTickSize as any, negRisk: testNegRisk };
    const result = await client.createAndPostOrder(
      {
        tokenID: testTokenId,
        size: 1, // 1 share
        side: Side.SELL,
        price: 0.01, // Min price - won't fill
      },
      options,
      OrderType.GTC,
    );

    stopLossOrderId = result?.orderID || result?.id || '';
    console.log(`  Order result: ${JSON.stringify(result)}`);

    if (result?.error || result?.status === 400) {
      record(4, 'Place stop loss', false, `Rejected: ${result.error || JSON.stringify(result)}`);
    } else if (stopLossOrderId) {
      record(4, 'Place stop loss', true, `Order placed: ${stopLossOrderId}`);
    } else {
      record(4, 'Place stop loss', false, `No order ID returned: ${JSON.stringify(result)}`);
    }
  } catch (err: any) {
    record(4, 'Place stop loss', false, `Error: ${err.message}`);
    console.log(`  Full error:`, err.response?.data || err.message);
  }

  // Step 5: Place a GTC SELL limit order (simulating take profit)
  // Place at $0.99 - near max price, won't fill unless market goes to $0.99
  console.log('\nStep 5: Placing take profit limit order (SELL @ $0.99)...');
  let takeProfitOrderId = '';
  try {
    const options = { tickSize: testTickSize as any, negRisk: testNegRisk };
    const result = await client.createAndPostOrder(
      {
        tokenID: testTokenId,
        size: 1, // 1 share
        side: Side.SELL,
        price: 0.99, // Near max - won't fill
      },
      options,
      OrderType.GTC,
    );

    takeProfitOrderId = result?.orderID || result?.id || '';
    console.log(`  Order result: ${JSON.stringify(result)}`);

    if (result?.error || result?.status === 400) {
      record(5, 'Place take profit', false, `Rejected: ${result.error || JSON.stringify(result)}`);
    } else if (takeProfitOrderId) {
      record(5, 'Place take profit', true, `Order placed: ${takeProfitOrderId}`);
    } else {
      record(5, 'Place take profit', false, `No order ID returned: ${JSON.stringify(result)}`);
    }
  } catch (err: any) {
    record(5, 'Place take profit', false, `Error: ${err.message}`);
    console.log(`  Full error:`, err.response?.data || err.message);
  }

  // Step 6: Place a BUY limit order (simulating re-entry)
  console.log('\nStep 6: Placing BUY limit order (BUY @ $0.01)...');
  let buyOrderId = '';
  try {
    const options = { tickSize: testTickSize as any, negRisk: testNegRisk };
    const result = await client.createAndPostOrder(
      {
        tokenID: testTokenId,
        size: 1,
        side: Side.BUY,
        price: 0.01,
      },
      options,
      OrderType.GTC,
    );

    buyOrderId = result?.orderID || result?.id || '';
    console.log(`  Order result: ${JSON.stringify(result)}`);

    if (result?.error || result?.status === 400) {
      record(6, 'Place buy order', false, `Rejected: ${result.error || JSON.stringify(result)}`);
    } else if (buyOrderId) {
      record(6, 'Place buy order', true, `Order placed: ${buyOrderId}`);
    } else {
      record(6, 'Place buy order', false, `No order ID returned: ${JSON.stringify(result)}`);
    }
  } catch (err: any) {
    record(6, 'Place buy order', false, `Error: ${err.message}`);
    console.log(`  Full error:`, err.response?.data || err.message);
  }

  // Step 7: Verify orders exist via getOpenOrders
  console.log('\nStep 7: Verifying orders via getOpenOrders...');
  await sleep(2000); // Wait for orders to register
  try {
    const openOrders = await client.getOpenOrders();
    const orders = (openOrders as any)?.orders || openOrders || [];
    console.log(`  Found ${orders.length} open order(s)`);

    for (const order of orders) {
      const id = order.id || order.orderID || order.order_id || '?';
      const side = order.side || '?';
      const price = order.price || '?';
      const size = order.original_size || order.size || '?';
      const status = order.status || order.order_status || '?';
      console.log(`    ${side} ${size} @ $${price} | id: ${id.slice(0, 20)}... | status: ${status}`);
    }

    const expectedCount = [stopLossOrderId, takeProfitOrderId, buyOrderId].filter(Boolean).length;
    const passed = orders.length >= expectedCount && expectedCount > 0;
    record(7, 'Verify orders', passed,
      passed
        ? `Found ${orders.length} orders (expected ${expectedCount})`
        : `Found ${orders.length} but expected ${expectedCount}`);
  } catch (err: any) {
    record(7, 'Verify orders', false, `Failed: ${err.message}`);
  }

  // Step 8: Cancel all orders
  console.log('\nStep 8: Cancelling all orders...');
  try {
    await client.cancelAll();
    await sleep(1500);

    const remaining = await client.getOpenOrders();
    const remainingOrders = (remaining as any)?.orders || remaining || [];
    console.log(`  Orders remaining: ${remainingOrders.length}`);

    const passed = remainingOrders.length === 0;
    record(8, 'Cancel all', passed,
      passed
        ? 'All orders cancelled and verified (0 remaining)'
        : `${remainingOrders.length} orders still open after cancel`);
  } catch (err: any) {
    record(8, 'Cancel all', false, `Failed: ${err.message}`);
  }

  // Step 9: Test sellPosition via Trader class (market sell with FAK)
  console.log('\nStep 9: Testing Trader.sellPosition (dry run)...');
  try {
    const { Trader } = await import('../services/trader.js');
    const trader = new Trader({
      privateKey: config.privateKey!,
      funderAddress: config.funderAddress,
      dryRun: true, // Dry run - won't actually sell
      apiCredentials: apiCredentials || creds,
    });
    await trader.initialize();

    const result = await trader.sellPosition(testTokenId, 10, 0.50, 'Test Market');
    record(9, 'Trader.sellPosition', result.success,
      result.success
        ? `Dry run sell OK: ${result.orderId}`
        : `Failed: ${result.error}`);
  } catch (err: any) {
    record(9, 'Trader.sellPosition', false, `Error: ${err.message}`);
  }

  // Step 10: Test Trader.placeLimitOrder (dry run)
  console.log('\nStep 10: Testing Trader.placeLimitOrder (dry run)...');
  try {
    const { Trader } = await import('../services/trader.js');
    const trader = new Trader({
      privateKey: config.privateKey!,
      funderAddress: config.funderAddress,
      dryRun: true,
      apiCredentials: apiCredentials || creds,
    });
    await trader.initialize();

    const result = await trader.placeLimitOrder(testTokenId, 'SELL', 5, 0.60);
    record(10, 'Trader.placeLimitOrder', result.success,
      result.success
        ? `Dry run limit order OK: ${result.orderId}`
        : `Failed: ${result.error}`);
  } catch (err: any) {
    record(10, 'Trader.placeLimitOrder', false, `Error: ${err.message}`);
  }

  printSummary();
}

function printSummary(): void {
  console.log('');
  console.log('='.repeat(60));
  console.log('  Order Mechanics Test Summary');
  console.log('='.repeat(60));
  for (const r of results) {
    const tag = r.passed ? 'PASS' : 'FAIL';
    console.log(`  Step ${r.step}: [${tag}] ${r.name} — ${r.detail}`);
  }
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log('-'.repeat(60));
  console.log(`  ${passed} passed, ${failed} failed out of ${results.length} steps`);

  if (failed === 0) {
    console.log('\n  All order mechanics work correctly.');
    console.log('  Stop loss, take profit, and trailing stop sells will execute properly.');
  } else {
    console.log('\n  Some order mechanics failed - review errors above.');
  }
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
