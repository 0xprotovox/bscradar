// src/config/security.js - Security Configuration

/**
 * Security configuration for Pool Analyzer API
 *
 * Environment Variables:
 * - API_KEYS: Comma-separated list of API keys (e.g., "key1:name1:tier,key2:name2:tier")
 * - ALLOWED_ORIGINS: Comma-separated list of allowed CORS origins
 * - AUTH_MODE: 'strict' (block without key) or 'soft' (warn but allow)
 */

const SECURITY_CONFIG = {
  // Authentication mode: 'strict' blocks requests without valid API key
  // 'soft' allows requests but logs warnings (for migration period)
  AUTH_MODE: process.env.AUTH_MODE || 'soft',

  // API Keys - format: key:name:tier:rateLimit
  // In production, load from secure storage (AWS Secrets Manager, etc.)
  API_KEYS: parseApiKeys(process.env.API_KEYS || getDefaultKeys()),

  // Default rate limit for authenticated clients
  DEFAULT_RATE_LIMIT: parseInt(process.env.DEFAULT_RATE_LIMIT) || 100,

  // Rate limit for unauthenticated/free tier
  FREE_RATE_LIMIT: parseInt(process.env.FREE_RATE_LIMIT) || 20,

  // Allowed CORS origins
  ALLOWED_ORIGINS: parseOrigins(process.env.ALLOWED_ORIGINS),

  // Token-based rate limiting
  TOKEN_RATE_LIMIT: {
    WINDOW_MS: parseInt(process.env.TOKEN_RATE_WINDOW) || 60000, // 1 minute
    MAX_REQUESTS_PER_TOKEN: parseInt(process.env.TOKEN_RATE_MAX) || 30, // Max requests per token globally
    IP_WINDOW_MS: parseInt(process.env.TOKEN_IP_RATE_WINDOW) || 60000, // 1 minute
    MAX_REQUESTS_PER_IP_TOKEN: parseInt(process.env.TOKEN_IP_RATE_MAX) || 10, // Max requests per IP per token
  },

  // Price validation settings
  PRICE_VALIDATION: {
    ENABLED: process.env.PRICE_VALIDATION !== 'false',
    MAX_PRICE_USD: parseFloat(process.env.MAX_PRICE_USD) || 1000000000, // $1B max
    MIN_PRICE_USD: parseFloat(process.env.MIN_PRICE_USD) || 0.0000000001, // $0.0000000001 min
    MIN_CONFIDENCE: parseFloat(process.env.MIN_PRICE_CONFIDENCE) || 0.3,
    OUTLIER_THRESHOLD: parseFloat(process.env.PRICE_OUTLIER_THRESHOLD) || 0.5, // 50% deviation
  },

  // Request logging
  LOGGING: {
    LOG_AUTH_FAILURES: process.env.LOG_AUTH_FAILURES !== 'false',
    LOG_RATE_LIMITS: process.env.LOG_RATE_LIMITS !== 'false',
    LOG_CORS_BLOCKS: process.env.LOG_CORS_BLOCKS !== 'false',
  }
};

/**
 * Parse API keys from environment variable
 * Format: "key1:name1:tier1:rateLimit1,key2:name2:tier2:rateLimit2"
 */
function parseApiKeys(keysString) {
  if (!keysString) return [];

  return keysString.split(',').map(keyStr => {
    const parts = keyStr.trim().split(':');
    return {
      key: parts[0],
      name: parts[1] || 'default',
      tier: parts[2] || 'standard',
      rateLimit: parseInt(parts[3]) || 100,
      enabled: true
    };
  }).filter(k => k.key);
}

/**
 * Get default API keys for development
 */
function getDefaultKeys() {
  // In development, use these default keys
  // In production, MUST be set via environment variable
  if (process.env.NODE_ENV === 'production') {
    console.warn('WARNING: No API_KEYS configured in production!');
    return '';
  }

  return [
    'dev-key-001:development:premium:1000',
    'test-key-001:testing:standard:100',
    'bscradar-internal:internal:unlimited:10000'
  ].join(',');
}

/**
 * Parse CORS origins from environment variable
 */
function parseOrigins(originsString) {
  if (!originsString) {
    // Default allowed origins
    return [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3002',
      'http://localhost:3003',
      'http://localhost:5173', // Vite dev server
      'http://127.0.0.1:3000',
      'http://127.0.0.1:5173',
      // Local network access (for development on LAN)
      'http://192.168.1.3:5173',
      'http://192.168.1.3:3000',
      '*.192.168.1.*', // Any local network IP
      // Add your production domains here
      // 'https://app.bscradar.io',
      // 'https://*.bscradar.io'
    ];
  }

  // If set to '*', allow all origins (not recommended for production)
  if (originsString.trim() === '*') {
    return ['*'];
  }

  return originsString.split(',').map(o => o.trim()).filter(Boolean);
}

module.exports = {
  SECURITY_CONFIG
};
