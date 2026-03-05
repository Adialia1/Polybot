/**
 * Trade filter service for blacklisting markets by keyword
 */

/**
 * Check if a market title contains any blacklisted keywords
 * @param title - The market title to check
 * @param blacklist - Array of keywords to block (case-insensitive)
 * @returns true if the market should be blocked, false otherwise
 */
export function isMarketBlacklisted(title: string, blacklist: string[]): boolean {
  if (!blacklist || blacklist.length === 0) {
    return false;
  }

  const titleLower = title.toLowerCase();

  for (const keyword of blacklist) {
    if (titleLower.includes(keyword.toLowerCase())) {
      return true;
    }
  }

  return false;
}

/**
 * Get the matching blacklist keyword for a market title
 * @param title - The market title to check
 * @param blacklist - Array of keywords to block (case-insensitive)
 * @returns The matching keyword or null if not blacklisted
 */
export function getMatchingBlacklistKeyword(title: string, blacklist: string[]): string | null {
  if (!blacklist || blacklist.length === 0) {
    return null;
  }

  const titleLower = title.toLowerCase();

  for (const keyword of blacklist) {
    if (titleLower.includes(keyword.toLowerCase())) {
      return keyword;
    }
  }

  return null;
}

/**
 * Check if a market title matches any whitelisted keywords
 * @param title - The market title to check
 * @param whitelist - Array of keywords to allow (case-insensitive)
 * @returns true if the market matches the whitelist (or whitelist is empty), false otherwise
 */
export function isMarketWhitelisted(title: string, whitelist: string[]): boolean {
  // If whitelist is empty, feature is disabled - allow all markets
  if (!whitelist || whitelist.length === 0) {
    return true;
  }

  const titleLower = title.toLowerCase();

  for (const keyword of whitelist) {
    if (titleLower.includes(keyword.toLowerCase())) {
      return true;
    }
  }

  return false;
}

/**
 * Get the matching whitelist keyword for a market title
 * @param title - The market title to check
 * @param whitelist - Array of keywords to allow (case-insensitive)
 * @returns The matching keyword or null if not whitelisted
 */
export function getMatchingWhitelistKeyword(title: string, whitelist: string[]): string | null {
  if (!whitelist || whitelist.length === 0) {
    return null;
  }

  const titleLower = title.toLowerCase();

  for (const keyword of whitelist) {
    if (titleLower.includes(keyword.toLowerCase())) {
      return keyword;
    }
  }

  return null;
}
