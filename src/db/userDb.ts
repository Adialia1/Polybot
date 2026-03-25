import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '../../data/users.db');

// Encryption helpers for private keys
const ALGORITHM = 'aes-256-gcm';

function getEncryptionKey(): Buffer {
  const masterKey = process.env.ENCRYPTION_KEY || process.env.TELEGRAM_BOT_TOKEN || 'polybot-default-key-change-me';
  return scryptSync(masterKey, 'polybot-salt', 32);
}

function encrypt(text: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decrypt(encryptedText: string): string {
  const key = getEncryptionKey();
  const [ivHex, authTagHex, encrypted] = encryptedText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export interface UserRecord {
  chatId: string;
  username: string | null;
  createdAt: string;
  isActive: boolean;
}

export interface UserWallet {
  id: number;
  chatId: string;
  walletAddress: string;
  encryptedPrivateKey: string;
  funderAddress: string | null;
  signatureType: number;
  alias: string;
  isDefault: boolean;
  createdAt: string;
}

export interface UserTrackedWallet {
  id: number;
  chatId: string;
  walletAddress: string;
  alias: string;
  allocation: number;
  enabled: boolean;
}

export interface UserSettings {
  chatId: string;
  enableTrading: boolean;
  dryRun: boolean;
  userAccountSize: number;
  maxPositionSize: number;
  minTradeSize: number;
  maxPercentagePerTrade: number;
  minProbability: number;
  maxProbability: number;
  maxOpenPositions: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  trailingStopPercent: number;
  orderSlippagePercent: number;
  copySells: boolean;
  maxHoldTimeHours: number;
  dailyLossLimit: number;
  maxPositionValue: number;
  conflictStrategy: string;
  blacklistKeywords: string;
  whitelistKeywords: string;
}

const DEFAULT_SETTINGS: Omit<UserSettings, 'chatId'> = {
  enableTrading: false,
  dryRun: true,
  userAccountSize: 30,
  maxPositionSize: 10,
  minTradeSize: 1,
  maxPercentagePerTrade: 20,
  minProbability: 0.05,
  maxProbability: 0.95,
  maxOpenPositions: 0,
  stopLossPercent: -25,
  takeProfitPercent: 100,
  trailingStopPercent: 15,
  orderSlippagePercent: 15,
  copySells: true,
  maxHoldTimeHours: 0,
  dailyLossLimit: 0,
  maxPositionValue: 0,
  conflictStrategy: 'first',
  blacklistKeywords: '',
  whitelistKeywords: '',
};

export class UserDb {
  private db: Database.Database;

  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        chat_id TEXT PRIMARY KEY,
        username TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        is_active INTEGER DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS user_wallets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL REFERENCES users(chat_id),
        wallet_address TEXT NOT NULL,
        encrypted_private_key TEXT NOT NULL,
        funder_address TEXT,
        signature_type INTEGER DEFAULT 2,
        alias TEXT DEFAULT 'Main',
        is_default INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS user_tracked_wallets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL REFERENCES users(chat_id),
        wallet_address TEXT NOT NULL,
        alias TEXT NOT NULL,
        allocation INTEGER DEFAULT 100,
        enabled INTEGER DEFAULT 1,
        UNIQUE(chat_id, wallet_address)
      );

      CREATE TABLE IF NOT EXISTS user_settings (
        chat_id TEXT PRIMARY KEY REFERENCES users(chat_id),
        enable_trading INTEGER DEFAULT 0,
        dry_run INTEGER DEFAULT 1,
        user_account_size REAL DEFAULT 30,
        max_position_size REAL DEFAULT 10,
        min_trade_size REAL DEFAULT 1,
        max_percentage_per_trade REAL DEFAULT 20,
        min_probability REAL DEFAULT 0.05,
        max_probability REAL DEFAULT 0.95,
        max_open_positions INTEGER DEFAULT 0,
        stop_loss_percent REAL DEFAULT -25,
        take_profit_percent REAL DEFAULT 100,
        trailing_stop_percent REAL DEFAULT 15,
        order_slippage_percent REAL DEFAULT 15,
        copy_sells INTEGER DEFAULT 1,
        max_hold_time_hours REAL DEFAULT 0,
        daily_loss_limit REAL DEFAULT 0,
        max_position_value REAL DEFAULT 0,
        conflict_strategy TEXT DEFAULT 'first',
        blacklist_keywords TEXT DEFAULT '',
        whitelist_keywords TEXT DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS user_state (
        chat_id TEXT PRIMARY KEY REFERENCES users(chat_id),
        state_json TEXT DEFAULT '{}'
      );
    `);
  }

  // ===== Users =====

  ensureUser(chatId: string, username?: string): void {
    this.db.prepare(`
      INSERT INTO users (chat_id, username) VALUES (?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET username = COALESCE(?, username)
    `).run(chatId, username || null, username || null);

    // Ensure settings row exists
    this.db.prepare(`
      INSERT OR IGNORE INTO user_settings (chat_id) VALUES (?)
    `).run(chatId);

    // Ensure state row exists
    this.db.prepare(`
      INSERT OR IGNORE INTO user_state (chat_id) VALUES (?)
    `).run(chatId);
  }

  getAllActiveUsers(): UserRecord[] {
    return this.db.prepare(`
      SELECT chat_id as chatId, username, created_at as createdAt, is_active as isActive
      FROM users WHERE is_active = 1
    `).all() as UserRecord[];
  }

  // ===== Wallets =====

  addWallet(chatId: string, privateKey: string, walletAddress: string, funderAddress?: string, alias?: string, signatureType?: number): number {
    const encryptedKey = encrypt(privateKey);
    const isDefault = this.getWallets(chatId).length === 0 ? 1 : 0;

    const result = this.db.prepare(`
      INSERT INTO user_wallets (chat_id, wallet_address, encrypted_private_key, funder_address, signature_type, alias, is_default)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(chatId, walletAddress.toLowerCase(), encryptedKey, funderAddress || null, signatureType ?? 2, alias || 'Main', isDefault);

    return result.lastInsertRowid as number;
  }

  getWallets(chatId: string): UserWallet[] {
    return this.db.prepare(`
      SELECT id, chat_id as chatId, wallet_address as walletAddress,
             encrypted_private_key as encryptedPrivateKey, funder_address as funderAddress,
             signature_type as signatureType, alias, is_default as isDefault, created_at as createdAt
      FROM user_wallets WHERE chat_id = ?
    `).all(chatId) as UserWallet[];
  }

  getDefaultWallet(chatId: string): UserWallet | undefined {
    return this.db.prepare(`
      SELECT id, chat_id as chatId, wallet_address as walletAddress,
             encrypted_private_key as encryptedPrivateKey, funder_address as funderAddress,
             signature_type as signatureType, alias, is_default as isDefault, created_at as createdAt
      FROM user_wallets WHERE chat_id = ? AND is_default = 1
    `).get(chatId) as UserWallet | undefined;
  }

  decryptPrivateKey(encryptedKey: string): string {
    return decrypt(encryptedKey);
  }

  removeWallet(chatId: string, walletId: number): boolean {
    const result = this.db.prepare(`
      DELETE FROM user_wallets WHERE id = ? AND chat_id = ?
    `).run(walletId, chatId);
    return result.changes > 0;
  }

  setDefaultWallet(chatId: string, walletId: number): void {
    this.db.prepare(`UPDATE user_wallets SET is_default = 0 WHERE chat_id = ?`).run(chatId);
    this.db.prepare(`UPDATE user_wallets SET is_default = 1 WHERE id = ? AND chat_id = ?`).run(walletId, chatId);
  }

  // ===== Tracked Wallets =====

  addTrackedWallet(chatId: string, address: string, alias: string, allocation: number = 100): number {
    const result = this.db.prepare(`
      INSERT INTO user_tracked_wallets (chat_id, wallet_address, alias, allocation)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_id, wallet_address) DO UPDATE SET alias = ?, allocation = ?, enabled = 1
    `).run(chatId, address.toLowerCase(), alias, allocation, alias, allocation);
    return result.lastInsertRowid as number;
  }

  getTrackedWallets(chatId: string): UserTrackedWallet[] {
    return this.db.prepare(`
      SELECT id, chat_id as chatId, wallet_address as walletAddress, alias, allocation, enabled
      FROM user_tracked_wallets WHERE chat_id = ?
    `).all(chatId) as UserTrackedWallet[];
  }

  removeTrackedWallet(chatId: string, walletId: number): boolean {
    const result = this.db.prepare(`
      DELETE FROM user_tracked_wallets WHERE id = ? AND chat_id = ?
    `).run(walletId, chatId);
    return result.changes > 0;
  }

  toggleTrackedWallet(chatId: string, walletId: number): boolean {
    this.db.prepare(`
      UPDATE user_tracked_wallets SET enabled = CASE WHEN enabled = 1 THEN 0 ELSE 1 END
      WHERE id = ? AND chat_id = ?
    `).run(walletId, chatId);
    const wallet = this.db.prepare(`SELECT enabled FROM user_tracked_wallets WHERE id = ?`).get(walletId) as any;
    return wallet?.enabled === 1;
  }

  // ===== Settings =====

  getSettings(chatId: string): UserSettings {
    const row = this.db.prepare(`
      SELECT chat_id as chatId, enable_trading as enableTrading, dry_run as dryRun,
             user_account_size as userAccountSize, max_position_size as maxPositionSize,
             min_trade_size as minTradeSize, max_percentage_per_trade as maxPercentagePerTrade,
             min_probability as minProbability, max_probability as maxProbability,
             max_open_positions as maxOpenPositions, stop_loss_percent as stopLossPercent,
             take_profit_percent as takeProfitPercent, trailing_stop_percent as trailingStopPercent,
             order_slippage_percent as orderSlippagePercent, copy_sells as copySells,
             max_hold_time_hours as maxHoldTimeHours, daily_loss_limit as dailyLossLimit,
             max_position_value as maxPositionValue, conflict_strategy as conflictStrategy,
             blacklist_keywords as blacklistKeywords, whitelist_keywords as whitelistKeywords
      FROM user_settings WHERE chat_id = ?
    `).get(chatId) as UserSettings | undefined;

    if (!row) {
      return { chatId, ...DEFAULT_SETTINGS };
    }

    // Convert SQLite integers to booleans
    return {
      ...row,
      enableTrading: !!row.enableTrading,
      dryRun: !!row.dryRun,
      copySells: !!row.copySells,
    };
  }

  updateSetting(chatId: string, key: string, value: any): void {
    // Map camelCase to snake_case column names
    const columnMap: Record<string, string> = {
      enableTrading: 'enable_trading',
      dryRun: 'dry_run',
      userAccountSize: 'user_account_size',
      maxPositionSize: 'max_position_size',
      minTradeSize: 'min_trade_size',
      maxPercentagePerTrade: 'max_percentage_per_trade',
      minProbability: 'min_probability',
      maxProbability: 'max_probability',
      maxOpenPositions: 'max_open_positions',
      stopLossPercent: 'stop_loss_percent',
      takeProfitPercent: 'take_profit_percent',
      trailingStopPercent: 'trailing_stop_percent',
      orderSlippagePercent: 'order_slippage_percent',
      copySells: 'copy_sells',
      maxHoldTimeHours: 'max_hold_time_hours',
      dailyLossLimit: 'daily_loss_limit',
      maxPositionValue: 'max_position_value',
      conflictStrategy: 'conflict_strategy',
      blacklistKeywords: 'blacklist_keywords',
      whitelistKeywords: 'whitelist_keywords',
    };

    const column = columnMap[key];
    if (!column) throw new Error(`Unknown setting: ${key}`);

    // Convert booleans to integers for SQLite
    const dbValue = typeof value === 'boolean' ? (value ? 1 : 0) : value;

    this.db.prepare(`UPDATE user_settings SET ${column} = ? WHERE chat_id = ?`).run(dbValue, chatId);
  }

  // ===== User State (positions, orders, stats) =====

  getUserState(chatId: string): any {
    const row = this.db.prepare(`SELECT state_json FROM user_state WHERE chat_id = ?`).get(chatId) as any;
    try {
      return row ? JSON.parse(row.state_json) : {};
    } catch {
      return {};
    }
  }

  saveUserState(chatId: string, state: any): void {
    this.db.prepare(`
      UPDATE user_state SET state_json = ? WHERE chat_id = ?
    `).run(JSON.stringify(state), chatId);
  }

  close(): void {
    this.db.close();
  }
}
