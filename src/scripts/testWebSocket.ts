import 'dotenv/config';
import { MarketWebSocket, BookUpdate, PriceChange, LastTradePrice } from '../api/websocket.js';

// ─── Configuration ──────────────────────────────────────────────────────────────

const DEFAULT_DURATION_MS = 3 * 60 * 1000; // 3 minutes
const RECONNECT_TEST_DELAY_MS = 10_000;     // wait 10s before forcing reconnect test
const REPORT_INTERVAL_MS = 30_000;          // print interim report every 30s

// Token IDs from the Polymarket Gamma API or state.json fallback
const FALLBACK_TOKEN_IDS = [
  '48040927501874008361167368490592511032357843436930790016695118825261334611440',
  '61614949248879815471703043435658956034185585174853675233049401571635965207598',
  '35316813595944370347964536993579642141498574537035296375250234585182532489784',
];

// ─── Stats Tracking ─────────────────────────────────────────────────────────────

interface TestStats {
  startTime: number;
  endTime: number;
  connectionStartTime: number;
  totalMessages: number;
  messagesByType: Record<string, number>;
  pingSent: number;
  pongReceived: number;
  disconnections: number;
  reconnections: number;
  reconnectTimesMs: number[];
  intentionalDisconnectTested: boolean;
  intentionalReconnectTimeMs: number | null;
  errors: string[];
  lastMessageTime: number;
  longestGapMs: number;
  prevMessageTime: number;
}

function createStats(): TestStats {
  const now = Date.now();
  return {
    startTime: now,
    endTime: 0,
    connectionStartTime: now,
    totalMessages: 0,
    messagesByType: {
      book: 0,
      price_change: 0,
      last_trade_price: 0,
      unknown: 0,
    },
    pingSent: 0,
    pongReceived: 0,
    disconnections: 0,
    reconnections: 0,
    reconnectTimesMs: [],
    intentionalDisconnectTested: false,
    intentionalReconnectTimeMs: null,
    errors: [],
    lastMessageTime: now,
    longestGapMs: 0,
    prevMessageTime: now,
  };
}

// ─── Fetch Active Token IDs ─────────────────────────────────────────────────────

async function fetchActiveTokenIds(): Promise<string[]> {
  try {
    console.log('[Test] Fetching active markets from Gamma API...');
    const res = await fetch(
      'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=5'
    );
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const markets = await res.json();
    const tokenIds: string[] = [];

    for (const market of markets) {
      if (market.clobTokenIds) {
        // clobTokenIds can be a JSON string or an array
        let ids: string[];
        if (typeof market.clobTokenIds === 'string') {
          ids = JSON.parse(market.clobTokenIds);
        } else {
          ids = market.clobTokenIds;
        }
        for (const id of ids) {
          tokenIds.push(id);
          if (tokenIds.length >= 3) break;
        }
      }
      if (tokenIds.length >= 3) break;
    }

    if (tokenIds.length > 0) {
      console.log(`[Test] Found ${tokenIds.length} active token IDs from API`);
      return tokenIds;
    }
    throw new Error('No token IDs found in API response');
  } catch (error) {
    console.log(`[Test] API fetch failed (${error}), using fallback token IDs`);
    return FALLBACK_TOKEN_IDS;
  }
}

// ─── Reporting ──────────────────────────────────────────────────────────────────

function printInterimReport(stats: TestStats, elapsed: number): void {
  const elapsedSec = (elapsed / 1000).toFixed(0);
  const msgRate = stats.totalMessages > 0
    ? (stats.totalMessages / (elapsed / 1000)).toFixed(2)
    : '0';

  console.log('');
  console.log(`--- Interim Report (${elapsedSec}s elapsed) ---`);
  console.log(`  Messages received: ${stats.totalMessages} (${msgRate}/sec)`);
  console.log(`  By type: book=${stats.messagesByType.book} | price_change=${stats.messagesByType.price_change} | last_trade_price=${stats.messagesByType.last_trade_price} | unknown=${stats.messagesByType.unknown}`);
  console.log(`  Ping/Pong cycles: ${stats.pingSent} sent / ${stats.pongReceived} received`);
  console.log(`  Disconnections: ${stats.disconnections} | Reconnections: ${stats.reconnections}`);
  console.log(`  Longest message gap: ${(stats.longestGapMs / 1000).toFixed(1)}s`);
  console.log('');
}

function printFinalReport(stats: TestStats, tokenIds: string[]): void {
  const durationMs = stats.endTime - stats.startTime;
  const durationSec = durationMs / 1000;
  const durationMin = (durationSec / 60).toFixed(1);
  const msgRate = stats.totalMessages > 0
    ? (stats.totalMessages / durationSec).toFixed(2)
    : '0';
  const avgReconnectMs = stats.reconnectTimesMs.length > 0
    ? (stats.reconnectTimesMs.reduce((a, b) => a + b, 0) / stats.reconnectTimesMs.length).toFixed(0)
    : 'N/A';

  // Calculate effective uptime (total duration minus reconnect times)
  const totalDowntimeMs = stats.reconnectTimesMs.reduce((a, b) => a + b, 0);
  const uptimePercent = ((1 - totalDowntimeMs / durationMs) * 100).toFixed(2);

  console.log('');
  console.log('='.repeat(60));
  console.log('  WebSocket Stability Test - Final Report');
  console.log('='.repeat(60));
  console.log('');

  console.log('  Test Configuration:');
  console.log(`    Duration:       ${durationMin} minutes (${durationSec.toFixed(0)}s)`);
  console.log(`    Token IDs:      ${tokenIds.length}`);
  console.log(`    Ping interval:  9 seconds`);
  console.log('');

  console.log('  Connection Stability:');
  console.log(`    Uptime:              ${uptimePercent}%`);
  console.log(`    Total downtime:      ${(totalDowntimeMs / 1000).toFixed(1)}s`);
  console.log(`    Disconnections:      ${stats.disconnections}`);
  console.log(`    Auto-reconnections:  ${stats.reconnections}`);
  console.log(`    Avg reconnect time:  ${avgReconnectMs}ms`);
  if (stats.reconnectTimesMs.length > 0) {
    console.log(`    Reconnect times:     [${stats.reconnectTimesMs.map(t => `${t.toFixed(0)}ms`).join(', ')}]`);
  }
  console.log('');

  console.log('  Message Statistics:');
  console.log(`    Total messages:      ${stats.totalMessages}`);
  console.log(`    Message rate:        ${msgRate} msg/sec`);
  console.log(`    Longest gap:         ${(stats.longestGapMs / 1000).toFixed(1)}s`);
  console.log(`    By type:`);
  console.log(`      book:              ${stats.messagesByType.book}`);
  console.log(`      price_change:      ${stats.messagesByType.price_change}`);
  console.log(`      last_trade_price:  ${stats.messagesByType.last_trade_price}`);
  console.log(`      unknown:           ${stats.messagesByType.unknown}`);
  console.log('');

  console.log('  Ping/Pong Health:');
  console.log(`    Pings sent:          ${stats.pingSent}`);
  console.log(`    Pongs received:      ${stats.pongReceived}`);
  const expectedPings = Math.floor(durationSec / 9);
  console.log(`    Expected pings:      ~${expectedPings}`);
  const pingHealth = stats.pingSent > 0
    ? ((stats.pongReceived / stats.pingSent) * 100).toFixed(1)
    : 'N/A';
  console.log(`    Pong response rate:  ${pingHealth}%`);
  console.log('');

  console.log('  Reconnection Test:');
  if (stats.intentionalDisconnectTested) {
    console.log(`    Intentional disconnect: TESTED`);
    console.log(`    Reconnect time:         ${stats.intentionalReconnectTimeMs?.toFixed(0)}ms`);
    console.log(`    Result:                 ${stats.intentionalReconnectTimeMs !== null ? 'PASS' : 'FAIL'}`);
  } else {
    console.log(`    Intentional disconnect: NOT TESTED (test too short)`);
  }
  console.log('');

  if (stats.errors.length > 0) {
    console.log('  Errors:');
    for (const err of stats.errors) {
      console.log(`    - ${err}`);
    }
    console.log('');
  }

  // Overall verdict
  const isHealthy =
    stats.pongReceived > 0 &&
    stats.totalMessages > 0 &&
    parseFloat(uptimePercent) > 95;

  console.log('  ' + '-'.repeat(56));
  if (isHealthy) {
    console.log('  VERDICT: PASS - WebSocket connection is stable');
  } else {
    console.log('  VERDICT: FAIL - WebSocket connection has issues');
    if (stats.totalMessages === 0) {
      console.log('    - No messages received (are the token IDs active?)');
    }
    if (stats.pongReceived === 0) {
      console.log('    - No pong responses received');
    }
    if (parseFloat(uptimePercent) <= 95) {
      console.log(`    - Uptime ${uptimePercent}% is below 95% threshold`);
    }
  }
  console.log('='.repeat(60));
}

// ─── Main Test Runner ───────────────────────────────────────────────────────────

async function runTest(): Promise<void> {
  // Parse duration from command line args (in minutes)
  const durationArg = process.argv[2];
  const durationMin = durationArg ? parseFloat(durationArg) : DEFAULT_DURATION_MS / 60_000;
  const durationMs = durationMin * 60_000;

  console.log('='.repeat(60));
  console.log('  WebSocket Stability Test');
  console.log('='.repeat(60));
  console.log(`  Duration: ${durationMin} minutes`);
  console.log(`  Start time: ${new Date().toISOString()}`);
  console.log('');

  // Fetch active token IDs
  const tokenIds = await fetchActiveTokenIds();
  console.log('[Test] Using token IDs:');
  for (const id of tokenIds) {
    console.log(`  - ${id.substring(0, 20)}...${id.substring(id.length - 10)}`);
  }
  console.log('');

  const stats = createStats();
  const ws = new MarketWebSocket();

  // ── Monkey-patch the WebSocket to intercept ping/pong ──
  // We need to track ping sends. The MarketWebSocket sends 'PING' text
  // and expects a '"PONG"' reply. We intercept via the raw ws 'send' events.
  const origConnect = ws.connect.bind(ws);
  let rawWs: any = null;
  let disconnectTime: number | null = null;
  let intentionalClose = false;

  // Override connect to intercept the underlying WebSocket
  ws.connect = async function (): Promise<void> {
    await origConnect();

    // Access the private ws property
    rawWs = (ws as any).ws;

    if (rawWs) {
      const origSend = rawWs.send.bind(rawWs);
      rawWs.send = (data: any, ...args: any[]) => {
        if (data === 'PING') {
          stats.pingSent++;
        }
        return origSend(data, ...args);
      };

      // Intercept incoming messages for PONG counting
      const origListeners = rawWs.listeners('message');
      rawWs.removeAllListeners('message');

      rawWs.on('message', (data: Buffer) => {
        const raw = data.toString();
        if (raw === 'PONG') {
          stats.pongReceived++;
        }
        // Call original listeners
        for (const listener of origListeners) {
          listener(data);
        }
      });

      // Track close events for reconnect timing
      rawWs.on('close', () => {
        if (!intentionalClose) {
          stats.disconnections++;
        }
        disconnectTime = Date.now();
      });
    }
  };

  // ── Set up event handlers ──
  ws.on('book', (_event: BookUpdate) => {
    stats.totalMessages++;
    stats.messagesByType.book++;
    trackMessageGap(stats);
  });

  ws.on('price_change', (_event: PriceChange) => {
    stats.totalMessages++;
    stats.messagesByType.price_change++;
    trackMessageGap(stats);
  });

  ws.on('last_trade_price', (_event: LastTradePrice) => {
    stats.totalMessages++;
    stats.messagesByType.last_trade_price++;
    trackMessageGap(stats);
  });

  ws.on('unknown', (_event: any) => {
    stats.totalMessages++;
    stats.messagesByType.unknown++;
    trackMessageGap(stats);
  });

  // ── Connect ──
  console.log('[Test] Connecting to WebSocket...');
  try {
    await ws.connect();
    stats.connectionStartTime = Date.now();
    console.log('[Test] Connected successfully');
  } catch (error) {
    console.error('[Test] Failed to connect:', error);
    stats.errors.push(`Initial connection failed: ${error}`);
    stats.endTime = Date.now();
    printFinalReport(stats, tokenIds);
    process.exit(1);
  }

  // ── Subscribe to assets ──
  console.log(`[Test] Subscribing to ${tokenIds.length} assets...`);
  ws.subscribeToAssets(tokenIds);

  // ── Interim reports ──
  const reportInterval = setInterval(() => {
    const elapsed = Date.now() - stats.startTime;
    printInterimReport(stats, elapsed);
  }, REPORT_INTERVAL_MS);

  // ── Intentional reconnection test ──
  let reconnectTestDone = false;
  const reconnectTestTimer = setTimeout(async () => {
    if (durationMs < RECONNECT_TEST_DELAY_MS + 15_000) {
      console.log('[Test] Skipping reconnection test (duration too short)');
      return;
    }

    console.log('');
    console.log('[Test] === RECONNECTION TEST ===');
    console.log('[Test] Intentionally closing WebSocket...');

    intentionalClose = true;
    stats.intentionalDisconnectTested = true;
    const closeTime = Date.now();

    // Force-close the underlying WebSocket
    const internalWs = (ws as any).ws;
    if (internalWs) {
      // Re-enable reconnection (disconnect() sets shouldReconnect = false)
      // Instead, directly close the raw ws to trigger auto-reconnect
      (ws as any).shouldReconnect = true;
      internalWs.close();
    }

    // Wait for reconnection (poll every 500ms, max 30s)
    const maxWait = 30_000;
    const pollInterval = 500;
    let waited = 0;

    const checkReconnect = setInterval(async () => {
      waited += pollInterval;

      if (ws.isConnected()) {
        const reconnectTimeMs = Date.now() - closeTime;
        stats.intentionalReconnectTimeMs = reconnectTimeMs;
        stats.reconnections++;
        stats.reconnectTimesMs.push(reconnectTimeMs);
        console.log(`[Test] Reconnected after intentional close in ${reconnectTimeMs}ms`);
        console.log('[Test] Re-subscribing to assets...');
        ws.subscribeToAssets(tokenIds);

        // Re-intercept the new underlying WebSocket
        rawWs = (ws as any).ws;
        if (rawWs) {
          const origSend = rawWs.send.bind(rawWs);
          rawWs.send = (data: any, ...args: any[]) => {
            if (data === 'PING') {
              stats.pingSent++;
            }
            return origSend(data, ...args);
          };

          const origListeners = rawWs.listeners('message');
          rawWs.removeAllListeners('message');
          rawWs.on('message', (msgData: Buffer) => {
            const raw = msgData.toString();
            if (raw === 'PONG') {
              stats.pongReceived++;
            }
            for (const listener of origListeners) {
              listener(msgData);
            }
          });
        }

        intentionalClose = false;
        reconnectTestDone = true;
        clearInterval(checkReconnect);
        console.log('[Test] === RECONNECTION TEST COMPLETE ===');
        console.log('');
        return;
      }

      if (waited >= maxWait) {
        console.log('[Test] Reconnection test FAILED - timed out after 30s');
        stats.errors.push('Intentional reconnection test timed out');
        intentionalClose = false;
        reconnectTestDone = true;
        clearInterval(checkReconnect);
        return;
      }
    }, pollInterval);
  }, RECONNECT_TEST_DELAY_MS);

  // ── Main test duration timer ──
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, durationMs);
  });

  // ── Clean up ──
  clearInterval(reportInterval);
  clearTimeout(reconnectTestTimer);
  stats.endTime = Date.now();

  console.log('');
  console.log('[Test] Test duration complete. Disconnecting...');
  ws.disconnect();

  // Print final report
  printFinalReport(stats, tokenIds);

  process.exit(0);
}

function trackMessageGap(stats: TestStats): void {
  const now = Date.now();
  const gap = now - stats.prevMessageTime;
  if (gap > stats.longestGapMs && stats.totalMessages > 1) {
    stats.longestGapMs = gap;
  }
  stats.prevMessageTime = now;
  stats.lastMessageTime = now;
}

// ── Entry point ─────────────────────────────────────────────────────────────────

runTest().catch((error) => {
  console.error('[Test] Fatal error:', error);
  process.exit(1);
});
