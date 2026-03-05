import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { StateManager } from './stateManager.js';
import { OrderQueue } from './orderQueue.js';

// Get package.json version
const __dirname = dirname(fileURLToPath(import.meta.url));
let packageVersion = '1.0.0';
try {
  const packageJson = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));
  packageVersion = packageJson.version || '1.0.0';
} catch {
  // Ignore - use default version
}

export interface HealthCheckConfig {
  port: number;
  stateManager: StateManager;
  orderQueue: OrderQueue;
}

export interface HealthStatus {
  status: 'running' | 'stopped';
  uptime: number;
  positions: number;
  lastTradeTime: number | null;
  queueStatus: {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
  };
  dailyPnL: number;
  version: string;
}

export interface PositionInfo {
  asset: string;
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  entryTime: number;
}

export class HealthCheckServer {
  private server: Server | null = null;
  private config: HealthCheckConfig;
  private startTime: number;
  private lastTradeTime: number | null = null;
  private isRunning = false;

  constructor(config: HealthCheckConfig) {
    this.config = config;
    this.startTime = Date.now();
  }

  /**
   * Start the health check HTTP server
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[HealthCheck] Port ${this.config.port} is already in use`);
        } else {
          console.error('[HealthCheck] Server error:', err.message);
        }
        reject(err);
      });

      this.server.listen(this.config.port, () => {
        this.isRunning = true;
        console.log(`[HealthCheck] Server started on port ${this.config.port}`);
        console.log(`[HealthCheck] Endpoints: /, /health, /positions`);
        resolve();
      });
    });
  }

  /**
   * Stop the health check server
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.isRunning = false;
          console.log('[HealthCheck] Server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Update the last trade time (call this when a trade is executed)
   */
  updateLastTradeTime(): void {
    this.lastTradeTime = Date.now();
  }

  /**
   * Handle incoming HTTP requests
   */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Set CORS headers for browser access
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Only allow GET requests
    if (req.method !== 'GET') {
      this.sendError(res, 405, 'Method Not Allowed');
      return;
    }

    // Route the request
    const url = req.url || '/';
    const path = url.split('?')[0]; // Remove query string

    try {
      switch (path) {
        case '/':
          this.handleRoot(res);
          break;
        case '/health':
          this.handleHealth(res);
          break;
        case '/positions':
          this.handlePositions(res);
          break;
        default:
          this.sendError(res, 404, 'Not Found');
      }
    } catch (err: any) {
      console.error('[HealthCheck] Error handling request:', err.message);
      this.sendError(res, 500, 'Internal Server Error');
    }
  }

  /**
   * Handle GET / - Simple status message
   */
  private handleRoot(res: ServerResponse): void {
    res.setHeader('Content-Type', 'text/plain');
    res.writeHead(200);
    res.end('Polybot is running');
  }

  /**
   * Handle GET /health - Detailed health status
   */
  private handleHealth(res: ServerResponse): void {
    const positions = this.config.stateManager.getAllPositions();
    const queueStatus = this.config.orderQueue.getStatus();
    const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);
    const dailyPnL = this.config.stateManager.getDailyPnL();

    const health: HealthStatus = {
      status: this.isRunning ? 'running' : 'stopped',
      uptime: uptimeSeconds,
      positions: positions.length,
      lastTradeTime: this.lastTradeTime,
      queueStatus: {
        pending: queueStatus.pending,
        processing: queueStatus.processing,
        completed: queueStatus.completed,
        failed: queueStatus.failed,
      },
      dailyPnL,
      version: packageVersion,
    };

    this.sendJson(res, 200, health);
  }

  /**
   * Handle GET /positions - List current positions
   */
  private handlePositions(res: ServerResponse): void {
    const positions = this.config.stateManager.getAllPositions();

    const positionInfos: PositionInfo[] = positions.map((pos) => ({
      asset: pos.asset,
      title: pos.title,
      outcome: pos.outcome,
      size: pos.size,
      avgPrice: pos.avgPrice,
      entryTime: pos.entryTime,
    }));

    this.sendJson(res, 200, {
      count: positionInfos.length,
      positions: positionInfos,
    });
  }

  /**
   * Send a JSON response
   */
  private sendJson(res: ServerResponse, statusCode: number, data: any): void {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(statusCode);
    res.end(JSON.stringify(data, null, 2));
  }

  /**
   * Send an error response
   */
  private sendError(res: ServerResponse, statusCode: number, message: string): void {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(statusCode);
    res.end(JSON.stringify({ error: message }));
  }
}
