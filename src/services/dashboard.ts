import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { StateManager, TraderStats } from './stateManager.js';
import { OrderQueue } from './orderQueue.js';
import { ClobApiClient } from '../api/clobApi.js';
import { Trader } from './trader.js';

// Get package.json version
const __dirname = dirname(fileURLToPath(import.meta.url));
let packageVersion = '1.0.0';
try {
  const packageJson = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));
  packageVersion = packageJson.version || '1.0.0';
} catch {
  // Ignore - use default version
}

export interface DashboardConfig {
  port: number;
  stateManager: StateManager;
  orderQueue: OrderQueue;
  clobApi: ClobApiClient;
  trader: Trader | null;
  dryRun: boolean;
}

export interface DashboardCallbacks {
  onPause: () => void;
  onResume: () => void;
  onForceSell: (asset: string) => Promise<{ success: boolean; error?: string }>;
}

export class DashboardServer {
  private server: Server | null = null;
  private config: DashboardConfig;
  private callbacks: DashboardCallbacks;
  private startTime: number;
  private lastTradeTime: number | null = null;
  private isRunning = false;
  private isPaused = false;

  constructor(config: DashboardConfig, callbacks: DashboardCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
    this.startTime = Date.now();
  }

  /**
   * Start the dashboard HTTP server
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[Dashboard] Port ${this.config.port} is already in use`);
        } else {
          console.error('[Dashboard] Server error:', err.message);
        }
        reject(err);
      });

      this.server.listen(this.config.port, () => {
        this.isRunning = true;
        console.log(`[Dashboard] Web dashboard started on http://localhost:${this.config.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the dashboard server
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.isRunning = false;
          console.log('[Dashboard] Server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Update the last trade time
   */
  updateLastTradeTime(): void {
    this.lastTradeTime = Date.now();
  }

  /**
   * Get/set paused state
   */
  getIsPaused(): boolean {
    return this.isPaused;
  }

  setIsPaused(paused: boolean): void {
    this.isPaused = paused;
  }

  /**
   * Handle incoming HTTP requests
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url || '/';
    const path = url.split('?')[0];

    try {
      // API routes
      if (path.startsWith('/api/')) {
        await this.handleApiRequest(req, res, path);
        return;
      }

      // Serve dashboard HTML
      if (path === '/' && req.method === 'GET') {
        this.serveDashboard(res);
        return;
      }

      this.sendError(res, 404, 'Not Found');
    } catch (err: any) {
      console.error('[Dashboard] Error handling request:', err.message);
      this.sendError(res, 500, 'Internal Server Error');
    }
  }

  /**
   * Handle API requests
   */
  private async handleApiRequest(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    // GET endpoints
    if (req.method === 'GET') {
      switch (path) {
        case '/api/status':
          await this.handleStatus(res);
          return;
        case '/api/positions':
          await this.handlePositions(res);
          return;
        case '/api/trades':
          this.handleTrades(res);
          return;
        case '/api/stats':
          this.handleStats(res);
          return;
      }
    }

    // POST endpoints
    if (req.method === 'POST') {
      if (path === '/api/pause') {
        this.handlePause(res);
        return;
      }
      if (path === '/api/resume') {
        this.handleResume(res);
        return;
      }
      if (path.startsWith('/api/sell/')) {
        const asset = decodeURIComponent(path.slice('/api/sell/'.length));
        await this.handleForceSell(res, asset);
        return;
      }
    }

    this.sendError(res, 404, 'API endpoint not found');
  }

  /**
   * GET /api/status - Bot status
   */
  private async handleStatus(res: ServerResponse): Promise<void> {
    const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);
    const queueStatus = this.config.orderQueue.getStatus();
    const dailyPnL = this.config.stateManager.getDailyPnL();
    const positions = this.config.stateManager.getAllPositions();

    this.sendJson(res, 200, {
      status: this.isPaused ? 'paused' : 'running',
      uptime: uptimeSeconds,
      uptimeFormatted: this.formatUptime(uptimeSeconds),
      positionCount: positions.length,
      lastTradeTime: this.lastTradeTime,
      lastTradeFormatted: this.lastTradeTime ? this.formatTimeAgo(this.lastTradeTime) : 'Never',
      queueStatus,
      dailyPnL: dailyPnL.toFixed(2),
      dailyPnLDate: this.config.stateManager.getDailyPnLDate(),
      version: packageVersion,
      dryRun: this.config.dryRun,
    });
  }

  /**
   * GET /api/positions - Current positions with P&L
   */
  private async handlePositions(res: ServerResponse): Promise<void> {
    const positions = this.config.stateManager.getAllPositions();
    const positionsWithPnL = [];

    for (const pos of positions) {
      let currentPrice = pos.avgPrice;
      let pnl = 0;
      let pnlPercent = 0;

      try {
        const midpoint = await this.config.clobApi.getMidpoint(pos.asset);
        currentPrice = parseFloat(midpoint);
        pnl = (currentPrice - pos.avgPrice) * pos.size;
        pnlPercent = ((currentPrice - pos.avgPrice) / pos.avgPrice) * 100;
      } catch {
        // Use entry price if we can't fetch current price
      }

      positionsWithPnL.push({
        asset: pos.asset,
        title: pos.title,
        outcome: pos.outcome,
        size: pos.size.toFixed(2),
        avgPrice: pos.avgPrice.toFixed(4),
        currentPrice: currentPrice.toFixed(4),
        pnl: pnl.toFixed(2),
        pnlPercent: pnlPercent.toFixed(1),
        entryTime: pos.entryTime,
        entryTimeFormatted: this.formatTimeAgo(pos.entryTime),
        walletAlias: pos.walletAlias || 'Unknown',
      });
    }

    this.sendJson(res, 200, {
      count: positionsWithPnL.length,
      positions: positionsWithPnL,
    });
  }

  /**
   * GET /api/trades - Recent trades
   */
  private handleTrades(res: ServerResponse): void {
    const orders = this.config.stateManager.getRecentOrders(20);

    const trades = orders.map(order => ({
      id: order.id,
      side: order.side,
      asset: order.asset,
      amount: order.amount.toFixed(2),
      status: order.status,
      walletAlias: order.walletAlias,
      createdAt: order.createdAt,
      createdAtFormatted: this.formatTimeAgo(order.createdAt),
      processedAt: order.processedAt,
    })).reverse(); // Most recent first

    this.sendJson(res, 200, {
      count: trades.length,
      trades,
    });
  }

  /**
   * GET /api/stats - Daily P&L, trader stats
   */
  private handleStats(res: ServerResponse): void {
    const stats = this.config.stateManager.getStats();
    const dailyPnL = this.config.stateManager.getDailyPnL();
    const dailyPnLDate = this.config.stateManager.getDailyPnLDate();
    const traderStats = this.config.stateManager.getAllTraderStats();

    // Calculate total P&L from all traders
    let totalPnL = 0;
    let totalTrades = 0;
    let totalWins = 0;
    let totalLosses = 0;

    const traderStatsArray: Array<{
      alias: string;
      pnl: string;
      trades: number;
      winRate: string;
      avgHoldTime: string;
    }> = [];

    for (const [alias, traderStat] of Object.entries(traderStats)) {
      totalPnL += traderStat.totalPnL;
      totalTrades += traderStat.totalTrades;
      totalWins += traderStat.wins;
      totalLosses += traderStat.losses;

      traderStatsArray.push({
        alias,
        pnl: traderStat.totalPnL.toFixed(2),
        trades: traderStat.totalTrades,
        winRate: traderStat.totalTrades > 0
          ? ((traderStat.wins / traderStat.totalTrades) * 100).toFixed(1)
          : '0.0',
        avgHoldTime: StateManager.formatHoldTime(traderStat.avgHoldTimeMs),
      });
    }

    const overallWinRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : '0.0';

    this.sendJson(res, 200, {
      dailyPnL: dailyPnL.toFixed(2),
      dailyPnLDate,
      totalPnL: totalPnL.toFixed(2),
      totalTrades,
      totalWins,
      totalLosses,
      winRate: overallWinRate,
      botStats: {
        totalTrades: stats.totalTrades,
        successfulTrades: stats.successfulTrades,
        failedTrades: stats.failedTrades,
        totalVolume: stats.totalVolume.toFixed(2),
        startTime: stats.startTime,
        runningSince: this.formatTimeAgo(stats.startTime),
      },
      traderStats: traderStatsArray,
    });
  }

  /**
   * POST /api/pause - Pause the bot
   */
  private handlePause(res: ServerResponse): void {
    if (this.isPaused) {
      this.sendJson(res, 200, { success: true, message: 'Bot is already paused' });
      return;
    }

    this.isPaused = true;
    this.callbacks.onPause();
    console.log('[Dashboard] Bot paused via dashboard');
    this.sendJson(res, 200, { success: true, message: 'Bot paused' });
  }

  /**
   * POST /api/resume - Resume the bot
   */
  private handleResume(res: ServerResponse): void {
    if (!this.isPaused) {
      this.sendJson(res, 200, { success: true, message: 'Bot is already running' });
      return;
    }

    this.isPaused = false;
    this.callbacks.onResume();
    console.log('[Dashboard] Bot resumed via dashboard');
    this.sendJson(res, 200, { success: true, message: 'Bot resumed' });
  }

  /**
   * POST /api/sell/:asset - Force sell a position
   */
  private async handleForceSell(res: ServerResponse, asset: string): Promise<void> {
    if (!asset) {
      this.sendError(res, 400, 'Asset ID is required');
      return;
    }

    const position = this.config.stateManager.getPosition(asset);
    if (!position) {
      this.sendError(res, 404, 'Position not found');
      return;
    }

    console.log(`[Dashboard] Force sell requested for ${position.title}`);

    try {
      const result = await this.callbacks.onForceSell(asset);
      if (result.success) {
        this.sendJson(res, 200, { success: true, message: `Sold ${position.title}` });
      } else {
        this.sendError(res, 500, result.error || 'Failed to sell position');
      }
    } catch (err: any) {
      this.sendError(res, 500, err.message || 'Failed to sell position');
    }
  }

  /**
   * Serve the dashboard HTML
   */
  private serveDashboard(res: ServerResponse): void {
    const html = this.generateDashboardHtml();
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200);
    res.end(html);
  }

  /**
   * Generate the dashboard HTML with inline CSS and JS
   */
  private generateDashboardHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Polybot Dashboard</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f0f0f;
      color: #e0e0e0;
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      flex-wrap: wrap;
      gap: 16px;
    }
    h1 {
      font-size: 24px;
      font-weight: 600;
      color: #fff;
    }
    .header-info {
      display: flex;
      gap: 16px;
      align-items: center;
      flex-wrap: wrap;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 500;
    }
    .badge-running {
      background: rgba(34, 197, 94, 0.2);
      color: #22c55e;
    }
    .badge-paused {
      background: rgba(234, 179, 8, 0.2);
      color: #eab308;
    }
    .badge-dry-run {
      background: rgba(59, 130, 246, 0.2);
      color: #3b82f6;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      animation: pulse 2s infinite;
    }
    .dot-running {
      background: #22c55e;
    }
    .dot-paused {
      background: #eab308;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .btn {
      padding: 8px 16px;
      border-radius: 6px;
      border: none;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-pause {
      background: #eab308;
      color: #000;
    }
    .btn-pause:hover {
      background: #ca8a04;
    }
    .btn-resume {
      background: #22c55e;
      color: #000;
    }
    .btn-resume:hover {
      background: #16a34a;
    }
    .btn-sell {
      background: #ef4444;
      color: #fff;
      padding: 4px 10px;
      font-size: 12px;
    }
    .btn-sell:hover {
      background: #dc2626;
    }
    .btn-sell:disabled {
      background: #444;
      color: #888;
      cursor: not-allowed;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .stat-card {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      padding: 16px;
    }
    .stat-label {
      font-size: 12px;
      color: #888;
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .stat-value {
      font-size: 24px;
      font-weight: 600;
      color: #fff;
    }
    .stat-value.positive {
      color: #22c55e;
    }
    .stat-value.negative {
      color: #ef4444;
    }
    .section {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      margin-bottom: 24px;
      overflow: hidden;
    }
    .section-header {
      padding: 16px 20px;
      border-bottom: 1px solid #2a2a2a;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .section-title {
      font-size: 16px;
      font-weight: 600;
    }
    .section-count {
      font-size: 13px;
      color: #888;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      padding: 12px 16px;
      text-align: left;
      border-bottom: 1px solid #2a2a2a;
    }
    th {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #888;
      font-weight: 500;
    }
    tr:last-child td {
      border-bottom: none;
    }
    .market-title {
      font-weight: 500;
      color: #fff;
      max-width: 300px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .outcome-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
    }
    .outcome-yes {
      background: rgba(34, 197, 94, 0.2);
      color: #22c55e;
    }
    .outcome-no {
      background: rgba(239, 68, 68, 0.2);
      color: #ef4444;
    }
    .side-buy {
      color: #22c55e;
    }
    .side-sell {
      color: #ef4444;
    }
    .status-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
    }
    .status-completed {
      background: rgba(34, 197, 94, 0.2);
      color: #22c55e;
    }
    .status-failed {
      background: rgba(239, 68, 68, 0.2);
      color: #ef4444;
    }
    .status-processing {
      background: rgba(234, 179, 8, 0.2);
      color: #eab308;
    }
    .status-pending {
      background: rgba(59, 130, 246, 0.2);
      color: #3b82f6;
    }
    .empty-state {
      padding: 40px 20px;
      text-align: center;
      color: #666;
    }
    .refresh-info {
      text-align: center;
      padding: 12px;
      color: #666;
      font-size: 12px;
    }
    .trader-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 12px;
      padding: 16px;
    }
    .trader-card {
      background: #252525;
      border-radius: 8px;
      padding: 12px;
    }
    .trader-name {
      font-weight: 600;
      color: #fff;
      margin-bottom: 8px;
    }
    .trader-stat-row {
      display: flex;
      justify-content: space-between;
      font-size: 13px;
      margin-bottom: 4px;
    }
    .loading {
      opacity: 0.5;
    }
    @media (max-width: 768px) {
      body {
        padding: 12px;
      }
      .stats-grid {
        grid-template-columns: repeat(2, 1fr);
      }
      th, td {
        padding: 8px 12px;
        font-size: 13px;
      }
      .market-title {
        max-width: 150px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Polybot Dashboard</h1>
      <div class="header-info">
        <span class="badge badge-running" id="statusBadge">
          <span class="dot dot-running" id="statusDot"></span>
          <span id="statusText">Running</span>
        </span>
        <span class="badge badge-dry-run" id="dryRunBadge" style="display: none;">
          Dry Run
        </span>
        <button class="btn btn-pause" id="pauseBtn" onclick="togglePause()">Pause</button>
      </div>
    </header>

    <div class="stats-grid" id="statsGrid">
      <div class="stat-card">
        <div class="stat-label">Uptime</div>
        <div class="stat-value" id="uptimeStat">--</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Positions</div>
        <div class="stat-value" id="positionsStat">0</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Daily P&L</div>
        <div class="stat-value" id="dailyPnlStat">$0.00</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total P&L</div>
        <div class="stat-value" id="totalPnlStat">$0.00</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Win Rate</div>
        <div class="stat-value" id="winRateStat">0%</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Last Trade</div>
        <div class="stat-value" id="lastTradeStat" style="font-size: 16px;">Never</div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <span class="section-title">Open Positions</span>
        <span class="section-count" id="positionsCount">0 positions</span>
      </div>
      <div id="positionsContent">
        <div class="empty-state">Loading positions...</div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <span class="section-title">Recent Trades</span>
        <span class="section-count" id="tradesCount">0 trades</span>
      </div>
      <div id="tradesContent">
        <div class="empty-state">Loading trades...</div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <span class="section-title">Trader Performance</span>
      </div>
      <div class="trader-stats" id="traderStats">
        <div class="empty-state">Loading trader stats...</div>
      </div>
    </div>

    <div class="refresh-info">
      Auto-refreshing every 10 seconds | <span id="lastUpdate">--</span>
    </div>
  </div>

  <script>
    let isPaused = false;

    async function fetchData() {
      try {
        const [statusRes, positionsRes, tradesRes, statsRes] = await Promise.all([
          fetch('/api/status'),
          fetch('/api/positions'),
          fetch('/api/trades'),
          fetch('/api/stats')
        ]);

        const status = await statusRes.json();
        const positions = await positionsRes.json();
        const trades = await tradesRes.json();
        const stats = await statsRes.json();

        updateStatus(status);
        updatePositions(positions);
        updateTrades(trades);
        updateStats(stats);

        document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString();
      } catch (err) {
        console.error('Failed to fetch data:', err);
      }
    }

    function updateStatus(status) {
      isPaused = status.status === 'paused';

      const badge = document.getElementById('statusBadge');
      const dot = document.getElementById('statusDot');
      const text = document.getElementById('statusText');
      const btn = document.getElementById('pauseBtn');
      const dryRunBadge = document.getElementById('dryRunBadge');

      if (isPaused) {
        badge.className = 'badge badge-paused';
        dot.className = 'dot dot-paused';
        text.textContent = 'Paused';
        btn.textContent = 'Resume';
        btn.className = 'btn btn-resume';
      } else {
        badge.className = 'badge badge-running';
        dot.className = 'dot dot-running';
        text.textContent = 'Running';
        btn.textContent = 'Pause';
        btn.className = 'btn btn-pause';
      }

      if (status.dryRun) {
        dryRunBadge.style.display = 'inline-flex';
      }

      document.getElementById('uptimeStat').textContent = status.uptimeFormatted;
      document.getElementById('positionsStat').textContent = status.positionCount;
      document.getElementById('lastTradeStat').textContent = status.lastTradeFormatted;

      const dailyPnl = parseFloat(status.dailyPnL);
      const dailyPnlEl = document.getElementById('dailyPnlStat');
      dailyPnlEl.textContent = (dailyPnl >= 0 ? '+' : '') + '$' + status.dailyPnL;
      dailyPnlEl.className = 'stat-value ' + (dailyPnl >= 0 ? 'positive' : 'negative');
    }

    function updatePositions(data) {
      document.getElementById('positionsCount').textContent = data.count + ' positions';

      const container = document.getElementById('positionsContent');

      if (data.positions.length === 0) {
        container.innerHTML = '<div class="empty-state">No open positions</div>';
        return;
      }

      let html = '<table><thead><tr><th>Market</th><th>Outcome</th><th>Size</th><th>Entry</th><th>Current</th><th>P&L</th><th>Trader</th><th>Action</th></tr></thead><tbody>';

      for (const pos of data.positions) {
        const pnl = parseFloat(pos.pnl);
        const pnlClass = pnl >= 0 ? 'positive' : 'negative';
        const outcomeClass = pos.outcome.toLowerCase() === 'yes' ? 'outcome-yes' : 'outcome-no';

        html += '<tr>';
        html += '<td class="market-title" title="' + escapeHtml(pos.title) + '">' + escapeHtml(pos.title) + '</td>';
        html += '<td><span class="outcome-badge ' + outcomeClass + '">' + pos.outcome + '</span></td>';
        html += '<td>' + pos.size + '</td>';
        html += '<td>$' + pos.avgPrice + '</td>';
        html += '<td>$' + pos.currentPrice + '</td>';
        html += '<td class="' + pnlClass + '">' + (pnl >= 0 ? '+' : '') + '$' + pos.pnl + ' (' + (pnl >= 0 ? '+' : '') + pos.pnlPercent + '%)</td>';
        html += '<td>' + pos.walletAlias + '</td>';
        html += '<td><button class="btn btn-sell" onclick="forceSell(\\'' + encodeURIComponent(pos.asset) + '\\')">Sell</button></td>';
        html += '</tr>';
      }

      html += '</tbody></table>';
      container.innerHTML = html;
    }

    function updateTrades(data) {
      document.getElementById('tradesCount').textContent = data.count + ' trades';

      const container = document.getElementById('tradesContent');

      if (data.trades.length === 0) {
        container.innerHTML = '<div class="empty-state">No recent trades</div>';
        return;
      }

      let html = '<table><thead><tr><th>Time</th><th>Side</th><th>Amount</th><th>Status</th><th>Trader</th></tr></thead><tbody>';

      for (const trade of data.trades) {
        const sideClass = trade.side === 'BUY' ? 'side-buy' : 'side-sell';
        const statusClass = 'status-' + trade.status;

        html += '<tr>';
        html += '<td>' + trade.createdAtFormatted + '</td>';
        html += '<td class="' + sideClass + '">' + trade.side + '</td>';
        html += '<td>$' + trade.amount + '</td>';
        html += '<td><span class="status-badge ' + statusClass + '">' + trade.status + '</span></td>';
        html += '<td>' + trade.walletAlias + '</td>';
        html += '</tr>';
      }

      html += '</tbody></table>';
      container.innerHTML = html;
    }

    function updateStats(stats) {
      const totalPnl = parseFloat(stats.totalPnL);
      const totalPnlEl = document.getElementById('totalPnlStat');
      totalPnlEl.textContent = (totalPnl >= 0 ? '+' : '') + '$' + stats.totalPnL;
      totalPnlEl.className = 'stat-value ' + (totalPnl >= 0 ? 'positive' : 'negative');

      document.getElementById('winRateStat').textContent = stats.winRate + '%';

      const container = document.getElementById('traderStats');

      if (stats.traderStats.length === 0) {
        container.innerHTML = '<div class="empty-state">No trader data yet</div>';
        return;
      }

      let html = '';
      for (const trader of stats.traderStats) {
        const pnl = parseFloat(trader.pnl);
        const pnlClass = pnl >= 0 ? 'positive' : 'negative';

        html += '<div class="trader-card">';
        html += '<div class="trader-name">' + escapeHtml(trader.alias) + '</div>';
        html += '<div class="trader-stat-row"><span>P&L</span><span class="' + pnlClass + '">' + (pnl >= 0 ? '+' : '') + '$' + trader.pnl + '</span></div>';
        html += '<div class="trader-stat-row"><span>Trades</span><span>' + trader.trades + '</span></div>';
        html += '<div class="trader-stat-row"><span>Win Rate</span><span>' + trader.winRate + '%</span></div>';
        html += '<div class="trader-stat-row"><span>Avg Hold</span><span>' + trader.avgHoldTime + '</span></div>';
        html += '</div>';
      }

      container.innerHTML = html;
    }

    async function togglePause() {
      const btn = document.getElementById('pauseBtn');
      btn.disabled = true;

      try {
        const endpoint = isPaused ? '/api/resume' : '/api/pause';
        const res = await fetch(endpoint, { method: 'POST' });
        const data = await res.json();

        if (data.success) {
          await fetchData();
        } else {
          alert('Failed: ' + (data.error || 'Unknown error'));
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }

      btn.disabled = false;
    }

    async function forceSell(asset) {
      if (!confirm('Are you sure you want to force sell this position?')) {
        return;
      }

      try {
        const res = await fetch('/api/sell/' + asset, { method: 'POST' });
        const data = await res.json();

        if (data.success) {
          alert('Position sold successfully');
          await fetchData();
        } else {
          alert('Failed to sell: ' + (data.error || 'Unknown error'));
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    // Initial fetch
    fetchData();

    // Auto-refresh every 10 seconds
    setInterval(fetchData, 10000);
  </script>
</body>
</html>`;
  }

  /**
   * Format uptime in human-readable format
   */
  private formatUptime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    }
    return `${secs}s`;
  }

  /**
   * Format timestamp as time ago
   */
  private formatTimeAgo(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);

    if (seconds < 60) {
      return `${seconds}s ago`;
    }
    if (seconds < 3600) {
      const minutes = Math.floor(seconds / 60);
      return `${minutes}m ago`;
    }
    if (seconds < 86400) {
      const hours = Math.floor(seconds / 3600);
      return `${hours}h ago`;
    }
    const days = Math.floor(seconds / 86400);
    return `${days}d ago`;
  }

  /**
   * Send JSON response
   */
  private sendJson(res: ServerResponse, statusCode: number, data: any): void {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(statusCode);
    res.end(JSON.stringify(data, null, 2));
  }

  /**
   * Send error response
   */
  private sendError(res: ServerResponse, statusCode: number, message: string): void {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(statusCode);
    res.end(JSON.stringify({ error: message }));
  }
}
