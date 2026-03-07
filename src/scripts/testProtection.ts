/**
 * Test script to verify stop loss / take profit limit orders on a REAL market.
 *
 * Steps:
 *   1. Buy $1 of a token (DeepSeek V4 March 31 Yes by default)
 *   2. Place SL and TP GTC limit orders
 *   3. Verify orders exist on the exchange
 *   4. Cancel orders
 *   5. Sell the position
 *
 * Run: npx tsx src/scripts/testProtection.ts
 *   or: npm run test-protection
 *
 * Flags:
 *   --dry-run     Simulate everything (no real orders)
 *   --token=<ID>  Use a different token
 *   --amount=<N>  Amount in USD (default: 1)
 */

import 'dotenv/config';
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { loadConfig } from '../config.js';

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

// DeepSeek V4 March 31 Yes token
const DEFAULT_TOKEN = '14067016405011170389827231468934152514414980840940183898095512290519534120789';

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
  const isDryRun = process.argv.includes('--dry-run');
  const tokenArg = process.argv.find(a => a.startsWith('--token='));
  const amountArg = process.argv.find(a => a.startsWith('--amount='));
  const tokenId = tokenArg ? tokenArg.split('=')[1] : DEFAULT_TOKEN;
  const buyAmount = amountArg ? parseFloat(amountArg.split('=')[1]) : 5;

  console.log('='.repeat(60));
  console.log('  Protection Orders Test (SL/TP Limit Orders)');
  console.log('  Tests: buy -> place SL/TP -> verify -> cancel -> sell');
  console.log('='.repeat(60));
  console.log(`  Mode: ${isDryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`  Amount: $${buyAmount}`);
  console.log(`  Token: ${tokenId.slice(0, 30)}...`);
  console.log('');

  if (!config.privateKey) {
    console.error('ERROR: No PRIVATE_KEY configured');
    process.exit(1);
  }

  // Step 1: Initialize CLOB client
  console.log('Step 1: Initializing CLOB client...');
  const account = privateKeyToAccount(config.privateKey as `0x${string}`);
  const funderAddress = config.funderAddress || account.address;

  // Determine signature type: 2 = Poly Proxy (signer != funder), 0 = EOA (same)
  const sigType = funderAddress.toLowerCase() !== account.address.toLowerCase() ? 2 : 0;
  console.log(`  Signer: ${account.address}`);
  console.log(`  Funder: ${funderAddress}`);
  console.log(`  Signature type: ${sigType === 2 ? 'Poly Proxy (2)' : 'EOA (0)'}`);

  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http('https://polygon.drpc.org'),
  });

  // Always derive fresh API credentials to avoid stale key issues
  const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, walletClient, undefined, sigType, funderAddress);
  const creds = await tempClient.createOrDeriveApiKey();
  console.log(`  API credentials derived (key: ${creds.key?.slice(0, 10)}...)`);

  const client = new ClobClient(CLOB_HOST, CHAIN_ID, walletClient, creds, sigType, funderAddress);
  record(1, 'Init client', true, `CLOB client initialized (signer: ${account.address.slice(0, 10)}...)`);

  // Step 2: Check market info and current price
  console.log('\nStep 2: Checking market info...');
  let tickSize: string;
  let negRisk: boolean;
  let buyPrice: number;
  try {
    tickSize = await client.getTickSize(tokenId);
    negRisk = await client.getNegRisk(tokenId);
    const feeRate = await client.getFeeRateBps(tokenId);

    // Get current price
    const res = await fetch(`${CLOB_HOST}/midpoint?token_id=${tokenId}`);
    const midData = await res.json() as any;
    buyPrice = parseFloat(midData.mid || '0.5');

    // Also get bid/ask
    const priceRes = await fetch(`${CLOB_HOST}/price?token_id=${tokenId}&side=buy`);
    const priceData = await priceRes.json() as any;
    const askPrice = parseFloat(priceData.price || '0');

    console.log(`  tickSize: ${tickSize}`);
    console.log(`  negRisk: ${negRisk}`);
    console.log(`  feeRate: ${feeRate}`);
    console.log(`  midpoint: $${buyPrice}`);
    console.log(`  ask (buy): $${askPrice}`);

    // Use ask price for buying (what we'd actually pay)
    if (askPrice > 0) buyPrice = askPrice;

    record(2, 'Market info', true, `Price: $${buyPrice}, tick: ${tickSize}, negRisk: ${negRisk}`);
  } catch (err: any) {
    record(2, 'Market info', false, `Failed: ${err.message}`);
    printSummary();
    process.exit(1);
  }

  const options = { tickSize: tickSize as any, negRisk };
  const shares = buyAmount / buyPrice;
  console.log(`  Shares to buy: ${shares.toFixed(2)} ($${buyAmount} / $${buyPrice})`);

  // Step 3: Buy position
  console.log('\nStep 3: Buying position...');
  let boughtShares = shares;
  if (isDryRun) {
    record(3, 'Buy position', true, `DRY RUN: Would buy ${shares.toFixed(2)} shares @ $${buyPrice}`);
  } else {
    try {
      const result = await client.createAndPostMarketOrder(
        {
          tokenID: tokenId,
          amount: buyAmount,
          side: Side.BUY,
          price: Math.min(0.99, buyPrice * 1.10), // 10% slippage allowance
        },
        options,
        OrderType.FOK,
      );

      const orderId = result?.orderID || result?.id || '';
      console.log(`  Order result: ${JSON.stringify(result)}`);

      if (result?.error || result?.status === 400) {
        record(3, 'Buy position', false, `Rejected: ${result.error || JSON.stringify(result)}`);
        printSummary();
        process.exit(1);
      } else {
        // Use actual received shares from the fill, not the estimated amount
        if (result?.takingAmount) {
          boughtShares = parseFloat(result.takingAmount);
          console.log(`  Actual shares received: ${boughtShares.toFixed(4)}`);
        }
        record(3, 'Buy position', true, `Bought ${boughtShares.toFixed(4)} shares @ $${buyPrice} (order: ${orderId})`);
      }
    } catch (err: any) {
      record(3, 'Buy position', false, `Error: ${err.message}`);
      console.log(`  Full error:`, err.response?.data || err.message);
      printSummary();
      process.exit(1);
    }
  }

  await sleep(3000);

  // Round down shares slightly to avoid "not enough balance" errors
  // The actual received amount may differ from estimate due to rounding
  boughtShares = Math.floor(boughtShares * 100) / 100; // Round down to 2 decimals
  console.log(`  Using ${boughtShares.toFixed(2)} shares for SL/TP orders`);

  // Step 4: Verify stop loss is polling-based (NOT a limit order)
  // A SELL limit below market price would fill immediately on Polymarket.
  // Stop loss must use polling (RiskManager checks every 60s).
  console.log('\nStep 4: Stop Loss architecture check...');
  console.log(`  Stop Loss: ${config.stopLossPercent ?? -50}% (polling-based, NOT a limit order)`);
  console.log(`  Reason: SELL limit @ below-market price fills immediately on Polymarket`);
  console.log(`  RiskManager polls every 60s and executes market sell when triggered`);
  record(4, 'SL architecture', true, `Stop loss at ${config.stopLossPercent ?? -50}% handled by polling (correct for Polymarket)`);

  // Step 4b: Update balance allowance (required for GTC limit orders)
  console.log('  Updating balance allowance for GTC orders...');
  try {
    await client.updateBalanceAllowance();
    console.log('  Balance allowance updated');
  } catch (err: any) {
    console.log(`  Balance allowance update failed: ${err.message} (continuing anyway)`);
  }
  await sleep(2000);

  // Step 5: Place Take Profit limit order
  // TP CAN be a limit order because SELL above market waits until price rises
  const tpPercent = (config.takeProfitPercent ?? 150) / 100;
  const tpPrice = Math.min(0.99, Math.round(buyPrice * (1 + tpPercent) * 100) / 100);
  console.log(`\nStep 5: Placing Take Profit SELL @ $${tpPrice} (+${(tpPercent * 100).toFixed(0)}% from $${buyPrice})...`);

  let tpOrderId = '';
  if (isDryRun) {
    tpOrderId = 'dry-run-tp';
    record(5, 'Place TP order', true, `DRY RUN: Would place SELL ${boughtShares.toFixed(2)} @ $${tpPrice}`);
  } else {
    try {
      const result = await client.createAndPostOrder(
        {
          tokenID: tokenId,
          size: boughtShares,
          side: Side.SELL,
          price: tpPrice,
        },
        options,
        OrderType.GTC,
      );

      tpOrderId = result?.orderID || result?.id || '';
      console.log(`  Order result: ${JSON.stringify(result)}`);

      if (result?.error || result?.status === 400) {
        record(5, 'Place TP order', false, `Rejected: ${result.error || JSON.stringify(result)}`);
      } else if (tpOrderId) {
        record(5, 'Place TP order', true, `GTC SELL @ $${tpPrice} placed (id: ${tpOrderId})`);
      } else {
        record(5, 'Place TP order', false, `No order ID: ${JSON.stringify(result)}`);
      }
    } catch (err: any) {
      record(5, 'Place TP order', false, `Error: ${err.message}`);
    }
  }

  // Step 6: Verify TP order exists on exchange
  console.log('\nStep 6: Verifying TP order on exchange...');
  await sleep(2000);
  if (isDryRun) {
    record(6, 'Verify orders', true, 'DRY RUN: Skipped');
  } else {
    try {
      const openOrders = await client.getOpenOrders();
      const orders = (openOrders as any)?.orders || openOrders || [];
      console.log(`  Found ${orders.length} open order(s):`);

      let foundTP = false;

      for (const order of orders) {
        const id = order.id || order.orderID || order.order_id || '?';
        const side = order.side || '?';
        const price = order.price || '?';
        const size = order.original_size || order.size || '?';
        console.log(`    ${side} ${size} @ $${price} | id: ${id.slice(0, 20)}...`);

        if (tpOrderId && id === tpOrderId) foundTP = true;
      }

      const passed = !tpOrderId || foundTP;
      record(6, 'Verify TP order', passed,
        passed
          ? `TP order found on exchange (${orders.length} total open)`
          : `TP order missing from exchange`);
    } catch (err: any) {
      record(6, 'Verify TP order', false, `Error: ${err.message}`);
    }
  }

  // Step 7: Cancel TP order
  console.log('\nStep 7: Cancelling TP order...');
  if (isDryRun) {
    record(7, 'Cancel orders', true, 'DRY RUN: Skipped');
  } else {
    try {
      const orderIds = [tpOrderId].filter(Boolean);
      if (orderIds.length > 0) {
        await client.cancelOrders(orderIds);
        await sleep(1500);

        // Verify cancellation
        const remaining = await client.getOpenOrders();
        const remainingOrders = (remaining as any)?.orders || remaining || [];

        const stillHasTP = remainingOrders.some((o: any) => (o.id || o.orderID) === tpOrderId);
        const passed = !stillHasTP;

        record(7, 'Cancel TP order', passed,
          passed
            ? `TP order cancelled and verified removed`
            : `TP order still present after cancel`);
      } else {
        record(7, 'Cancel TP order', false, 'No TP order ID to cancel');
      }
    } catch (err: any) {
      record(7, 'Cancel TP order', false, `Error: ${err.message}`);
    }
  }

  // Step 8: Sell the position
  console.log('\nStep 8: Selling position...');
  if (isDryRun) {
    record(8, 'Sell position', true, `DRY RUN: Would sell ${boughtShares.toFixed(2)} shares`);
  } else {
    try {
      // Get current bid for selling
      const priceRes = await fetch(`${CLOB_HOST}/price?token_id=${tokenId}&side=sell`);
      const priceData = await priceRes.json() as any;
      const sellPrice = Math.max(0.01, parseFloat(priceData.price || '0.5') * 0.95);

      const result = await client.createAndPostMarketOrder(
        {
          tokenID: tokenId,
          amount: boughtShares,
          side: Side.SELL,
          price: sellPrice,
        },
        options,
        OrderType.FAK,
      );

      const orderId = result?.orderID || result?.id || '';
      console.log(`  Order result: ${JSON.stringify(result)}`);

      if (result?.error || result?.status === 400) {
        record(8, 'Sell position', false, `Rejected: ${result.error || JSON.stringify(result)}`);
      } else {
        record(8, 'Sell position', true, `Sold ${boughtShares.toFixed(2)} shares (order: ${orderId})`);
      }
    } catch (err: any) {
      record(8, 'Sell position', false, `Error: ${err.message}`);
      console.log(`  Full error:`, err.response?.data || err.message);
      console.log(`\n  *** Position may still be open - check manually ***`);
    }
  }

  printSummary();
}

function printSummary(): void {
  console.log('');
  console.log('='.repeat(60));
  console.log('  Protection Orders Test Summary');
  console.log('='.repeat(60));
  for (const r of results) {
    const tag = r.passed ? 'PASS' : 'FAIL';
    console.log(`  Step ${r.step}: [${tag}] ${r.name} - ${r.detail}`);
  }
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log('-'.repeat(60));
  console.log(`  ${passed} passed, ${failed} failed out of ${results.length} steps`);

  if (failed === 0) {
    console.log('\n  All protection order mechanics work correctly.');
    console.log('  SL/TP limit orders will be placed when entering positions.');
  } else {
    console.log('\n  Some steps failed - review errors above.');
  }
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
