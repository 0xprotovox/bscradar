// src/middlewares/tokenRateLimit.js - Per-Token Rate Limiting

const { getLogger } = require('../utils/Logger');
const { SECURITY_CONFIG } = require('../config/security');

const logger = getLogger();

/**
 * Token-based rate limiter
 * Prevents abuse by limiting requests per token address
 */
class TokenRateLimiter {
  constructor() {
    this.tokenRequests = new Map(); // token -> { count, windowStart }
    this.ipTokenRequests = new Map(); // ip:token -> { count, windowStart }

    // Cleanup old entries every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  /**
   * Check if request should be rate limited
   * @param {string} tokenAddress - Token being requested
   * @param {string} ip - Client IP
   * @returns {object} Rate limit status
   */
  checkLimit(tokenAddress, ip) {
    const now = Date.now();
    const config = SECURITY_CONFIG.TOKEN_RATE_LIMIT;
    const token = tokenAddress?.toLowerCase();

    if (!token) {
      return { limited: false };
    }

    // Check global token limit (prevents DoS on single token)
    const globalLimit = this.checkGlobalTokenLimit(token, now, config);
    if (globalLimit.limited) {
      return globalLimit;
    }

    // Check per-IP-per-token limit (prevents single client abuse)
    const ipLimit = this.checkIpTokenLimit(token, ip, now, config);
    if (ipLimit.limited) {
      return ipLimit;
    }

    // Record the request
    this.recordRequest(token, ip, now);

    return {
      limited: false,
      remaining: config.MAX_REQUESTS_PER_TOKEN - this.getTokenCount(token, now, config.WINDOW_MS),
      resetIn: this.getResetTime(token, now, config.WINDOW_MS)
    };
  }

  /**
   * Check global rate limit for a token
   */
  checkGlobalTokenLimit(token, now, config) {
    const count = this.getTokenCount(token, now, config.WINDOW_MS);

    if (count >= config.MAX_REQUESTS_PER_TOKEN) {
      logger.warn(`Token rate limit hit: ${token} (${count}/${config.MAX_REQUESTS_PER_TOKEN})`);
      return {
        limited: true,
        reason: 'token_rate_limit',
        message: `Too many requests for this token. Try again in ${this.getResetTime(token, now, config.WINDOW_MS)}ms`,
        retryAfter: this.getResetTime(token, now, config.WINDOW_MS)
      };
    }

    return { limited: false };
  }

  /**
   * Check per-IP rate limit for a token
   */
  checkIpTokenLimit(token, ip, now, config) {
    const key = `${ip}:${token}`;
    const entry = this.ipTokenRequests.get(key);

    if (!entry) {
      return { limited: false };
    }

    const windowStart = entry.windowStart;
    if (now - windowStart > config.IP_WINDOW_MS) {
      return { limited: false };
    }

    if (entry.count >= config.MAX_REQUESTS_PER_IP_TOKEN) {
      logger.warn(`IP-Token rate limit hit: ${ip} -> ${token} (${entry.count}/${config.MAX_REQUESTS_PER_IP_TOKEN})`);
      return {
        limited: true,
        reason: 'ip_token_rate_limit',
        message: `You're requesting this token too frequently. Try again later.`,
        retryAfter: config.IP_WINDOW_MS - (now - windowStart)
      };
    }

    return { limited: false };
  }

  /**
   * Get current request count for token in window
   */
  getTokenCount(token, now, windowMs) {
    const entry = this.tokenRequests.get(token);
    if (!entry) return 0;
    if (now - entry.windowStart > windowMs) return 0;
    return entry.count;
  }

  /**
   * Get time until rate limit resets
   */
  getResetTime(token, now, windowMs) {
    const entry = this.tokenRequests.get(token);
    if (!entry) return 0;
    return Math.max(0, windowMs - (now - entry.windowStart));
  }

  /**
   * Record a request for rate limiting
   */
  recordRequest(token, ip, now) {
    const config = SECURITY_CONFIG.TOKEN_RATE_LIMIT;

    // Record global token request
    const tokenEntry = this.tokenRequests.get(token);
    if (!tokenEntry || now - tokenEntry.windowStart > config.WINDOW_MS) {
      this.tokenRequests.set(token, { count: 1, windowStart: now });
    } else {
      tokenEntry.count++;
    }

    // Record IP-token request
    const ipKey = `${ip}:${token}`;
    const ipEntry = this.ipTokenRequests.get(ipKey);
    if (!ipEntry || now - ipEntry.windowStart > config.IP_WINDOW_MS) {
      this.ipTokenRequests.set(ipKey, { count: 1, windowStart: now });
    } else {
      ipEntry.count++;
    }
  }

  /**
   * Cleanup old entries to prevent memory leaks
   */
  cleanup() {
    const now = Date.now();
    const config = SECURITY_CONFIG.TOKEN_RATE_LIMIT;

    // Cleanup token requests
    for (const [token, entry] of this.tokenRequests.entries()) {
      if (now - entry.windowStart > config.WINDOW_MS * 2) {
        this.tokenRequests.delete(token);
      }
    }

    // Cleanup IP-token requests
    for (const [key, entry] of this.ipTokenRequests.entries()) {
      if (now - entry.windowStart > config.IP_WINDOW_MS * 2) {
        this.ipTokenRequests.delete(key);
      }
    }
  }

  /**
   * Stop cleanup interval
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

// Singleton instance
const tokenRateLimiter = new TokenRateLimiter();

/**
 * Express middleware for token rate limiting
 */
const tokenRateLimitMiddleware = (req, res, next) => {
  // Extract token from various sources
  const token = req.body?.tokenAddress ||
                req.query?.token ||
                req.params?.token ||
                extractTokenFromPath(req.path);

  if (!token) {
    return next();
  }

  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const result = tokenRateLimiter.checkLimit(token, ip);

  if (result.limited) {
    res.setHeader('X-RateLimit-Reason', result.reason);
    res.setHeader('Retry-After', Math.ceil(result.retryAfter / 1000));

    return res.status(429).json({
      success: false,
      error: 'Rate limit exceeded',
      message: result.message,
      retryAfter: result.retryAfter
    });
  }

  // Add rate limit headers
  if (result.remaining !== undefined) {
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Reset', result.resetIn);
  }

  next();
};

/**
 * Extract token address from URL path
 */
function extractTokenFromPath(path) {
  // Match BSC addresses in path
  const match = path.match(/0x[a-fA-F0-9]{40}/);
  return match ? match[0] : null;
}

module.exports = {
  TokenRateLimiter,
  tokenRateLimiter,
  tokenRateLimitMiddleware
};
