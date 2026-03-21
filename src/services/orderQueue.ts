import { EventEmitter } from 'events';
import { Trade } from '../types/index.js';

export interface QueuedOrder {
  id: string;
  trade: Trade;
  walletAlias: string;
  walletAddress: string;
  amount: number;          // USD amount to trade
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped';
  reason?: string;         // Reason if skipped/failed
  createdAt: number;
  processedAt?: number;
  result?: any;
  retryCount: number;      // Number of retry attempts made
}

export interface OrderQueueConfig {
  maxConcurrent?: number;  // Max orders processing at once (default: 1)
  orderDelayMs?: number;   // Delay between orders (default: 1000ms)
  maxQueueSize?: number;   // Max pending orders (default: 100)
}

export class OrderQueue extends EventEmitter {
  private queue: QueuedOrder[] = [];
  private processing: Set<string> = new Set();
  private config: OrderQueueConfig;
  private isRunning = false;
  private orderIdCounter = 0;

  constructor(config: OrderQueueConfig = {}) {
    super();
    this.config = {
      maxConcurrent: config.maxConcurrent || 1,
      orderDelayMs: config.orderDelayMs || 1000,
      maxQueueSize: config.maxQueueSize || 100,
    };
  }

  // Add order to queue
  enqueue(
    trade: Trade,
    walletAlias: string,
    walletAddress: string,
    amount: number
  ): QueuedOrder | null {
    // Clean up completed/failed/skipped orders to prevent queue from filling up
    this.queue = this.queue.filter(o => o.status === 'pending' || o.status === 'processing');

    if (this.queue.length >= this.config.maxQueueSize!) {
      console.warn('[OrderQueue] Queue full, dropping order');
      return null;
    }

    // Check for duplicate orders (same asset + side within last 5 seconds)
    const isDuplicate = this.queue.some(
      o =>
        o.trade.asset === trade.asset &&
        o.trade.side === trade.side &&
        o.status === 'pending' &&
        Date.now() - o.createdAt < 5000
    );

    if (isDuplicate) {
      console.log('[OrderQueue] Duplicate order detected, skipping');
      return null;
    }

    const order: QueuedOrder = {
      id: `order-${++this.orderIdCounter}-${Date.now()}`,
      trade,
      walletAlias,
      walletAddress,
      amount,
      status: 'pending',
      createdAt: Date.now(),
      retryCount: 0,
    };

    this.queue.push(order);
    console.log(`[OrderQueue] Order queued: ${order.id} (${trade.side} ${trade.outcome})`);

    this.emit('enqueue', order);
    this.processNext();

    return order;
  }

  // Skip an order (e.g., we don't have the position to sell)
  skipOrder(orderId: string, reason: string): void {
    const order = this.queue.find(o => o.id === orderId);
    if (order && order.status === 'pending') {
      order.status = 'skipped';
      order.reason = reason;
      order.processedAt = Date.now();
      console.log(`[OrderQueue] Order skipped: ${orderId} - ${reason}`);
      this.emit('skip', order);
    }
  }

  // Process next order in queue
  private async processNext(): Promise<void> {
    if (!this.isRunning) return;
    if (this.processing.size >= this.config.maxConcurrent!) return;

    const nextOrder = this.queue.find(o => o.status === 'pending');
    if (!nextOrder) return;

    this.processing.add(nextOrder.id);
    nextOrder.status = 'processing';

    console.log(`[OrderQueue] Processing: ${nextOrder.id}`);
    this.emit('process', nextOrder);
  }

  // Mark order as completed
  completeOrder(orderId: string, result: any): void {
    const order = this.queue.find(o => o.id === orderId);
    if (order) {
      order.status = 'completed';
      order.result = result;
      order.processedAt = Date.now();
      this.processing.delete(orderId);
      console.log(`[OrderQueue] Completed: ${orderId}`);
      this.emit('complete', order);

      // Process next after delay
      setTimeout(() => this.processNext(), this.config.orderDelayMs);
    }
  }

  // Mark order as failed
  failOrder(orderId: string, error: string): void {
    const order = this.queue.find(o => o.id === orderId);
    if (order) {
      order.status = 'failed';
      order.reason = error;
      order.processedAt = Date.now();
      this.processing.delete(orderId);
      console.log(`[OrderQueue] Failed: ${orderId} - ${error}`);
      this.emit('fail', order);

      // Process next after delay
      setTimeout(() => this.processNext(), this.config.orderDelayMs);
    }
  }

  // Start processing queue
  start(): void {
    this.isRunning = true;
    console.log('[OrderQueue] Started');
    this.processNext();
  }

  // Stop processing (finish current, don't start new)
  stop(): void {
    this.isRunning = false;
    console.log('[OrderQueue] Stopped');
  }

  // Get queue status
  getStatus(): {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    skipped: number;
  } {
    return {
      pending: this.queue.filter(o => o.status === 'pending').length,
      processing: this.queue.filter(o => o.status === 'processing').length,
      completed: this.queue.filter(o => o.status === 'completed').length,
      failed: this.queue.filter(o => o.status === 'failed').length,
      skipped: this.queue.filter(o => o.status === 'skipped').length,
    };
  }

  // Get pending orders
  getPendingOrders(): QueuedOrder[] {
    return this.queue.filter(o => o.status === 'pending');
  }

  // Get recent orders (last N)
  getRecentOrders(limit: number = 10): QueuedOrder[] {
    return this.queue.slice(-limit);
  }

  // Clear completed/failed/skipped orders older than X ms
  cleanup(maxAgeMs: number = 3600000): void {
    const now = Date.now();
    this.queue = this.queue.filter(
      o =>
        o.status === 'pending' ||
        o.status === 'processing' ||
        (o.processedAt && now - o.processedAt < maxAgeMs)
    );
  }
}
