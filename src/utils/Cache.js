// src/utils/Cache.js
// Thread-safe cache with atomic operations and proper locking

const NodeCache = require('node-cache');
const { getLogger } = require('./Logger');
const { API_CONFIG } = require('../config/constants');

class CacheService {
  constructor() {
    this.logger = getLogger();

    // Locks for atomic operations (prevents race conditions)
    this.locks = new Map();

    // Main cache for pool data
    this.poolCache = new NodeCache({
      stdTTL: API_CONFIG.CACHE_TTL,
      checkperiod: 120,
      useClones: false,
    });

    // Price cache with shorter TTL
    this.priceCache = new NodeCache({
      stdTTL: API_CONFIG.PRICE_CACHE_TTL,
      checkperiod: 60,
      useClones: false,
    });

    // Token metadata cache with longer TTL
    this.tokenCache = new NodeCache({
      stdTTL: 3600, // 1 hour
      checkperiod: 600,
      useClones: false,
    });

    this.setupEventListeners();
  }

  /**
   * Acquire a lock for atomic cache operations
   * Prevents race conditions when multiple requests try to update same key
   */
  async acquireLock(key, timeout = 5000) {
    const startTime = Date.now();
    while (this.locks.has(key)) {
      if (Date.now() - startTime > timeout) {
        this.logger.warn(`Lock timeout for key: ${key}, forcing cleanup `);
        // CRITICAL FIX: Delete stuck lock to prevent memory leak
        this.locks.delete(key);
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    this.locks.set(key, Date.now());
    return true;
  }

  /**
   * Release a lock
   */
  releaseLock(key) {
    this.locks.delete(key);
  }

  /**
   * Get or set cache with atomic operation (prevents thundering herd)
   * If key doesn't exist, calls fetchFn to get value and caches it
   */
  async getOrSet(cache, key, fetchFn, ttl) {
    // First, try to get existing value (no lock needed for read)
    const existing = cache.get(key);
    if (existing !== undefined) {
      return existing;
    }

    // Acquire lock for this key to prevent multiple concurrent fetches
    const lockAcquired = await this.acquireLock(key);
    if (!lockAcquired) {
      // Lock timeout - try to get value anyway (might have been set by another request)
      return cache.get(key);
    }

    try {
      // Double-check after acquiring lock (another request might have set it)
      const doubleCheck = cache.get(key);
      if (doubleCheck !== undefined) {
        return doubleCheck;
      }

      // Fetch the value
      const value = await fetchFn();

      // Set in cache
      if (value !== undefined && value !== null) {
        cache.set(key, value, ttl);
      }

      return value;
    } finally {
      this.releaseLock(key);
    }
  }

  setupEventListeners() {
    this.poolCache.on('expired', (key, value) => {
      this.logger.debug(`Pool cache expired: ${key}`);
    });

    this.priceCache.on('expired', (key, value) => {
      this.logger.debug(`Price cache expired: ${key}`);
    });
  }

  /**
   * Sanitize cache key to prevent injection attacks
   * Only allows alphanumeric, underscore, and 0x prefix for addresses
   */
  sanitizeKey(key) {
    if (typeof key !== 'string') {
      throw new Error('Cache key must be a string');
    }
    // Remove any non-alphanumeric characters except underscore and 0x prefix
    const sanitized = key.toLowerCase().replace(/[^a-z0-9_x]/g, '');
    if (sanitized.length === 0) {
      throw new Error('Invalid cache key');
    }
    // Limit key length to prevent memory issues
    if (sanitized.length > 100) {
      throw new Error('Cache key too long');
    }
    return sanitized;
  }

  /**
   * Validate BSC address format
   */
  validateAddress(address) {
    if (typeof address !== 'string') {
      throw new Error('Address must be a string');
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      throw new Error('Invalid BSC address format');
    }
    return address.toLowerCase();
  }

  /**
   * Validate pool cache key - accepts either raw address or prefixed key (v2_, v3_)
   */
  validatePoolKey(key) {
    if (typeof key !== 'string') {
      throw new Error('Pool key must be a string');
    }
    // Accept prefixed keys like v2_0x..., v3_0x...
    const prefixedPattern = /^(v2_|v3_)0x[a-fA-F0-9]{40}$/;
    // Also accept raw addresses
    const rawAddressPattern = /^0x[a-fA-F0-9]{40}$/;

    if (!prefixedPattern.test(key) && !rawAddressPattern.test(key)) {
      throw new Error('Invalid pool key format');
    }
    return key.toLowerCase();
  }

  // Pool cache methods with validation
  getPoolData(poolKey) {
    const key = this.validatePoolKey(poolKey);
    return this.poolCache.get(key);
  }

  setPoolData(poolKey, data, ttl = API_CONFIG.CACHE_TTL) {
    const key = this.validatePoolKey(poolKey);
    return this.poolCache.set(key, data, ttl);
  }

  // Atomic get-or-fetch for pool data
  async getOrFetchPoolData(poolKey, fetchFn, ttl = API_CONFIG.CACHE_TTL) {
    const key = this.validatePoolKey(poolKey);
    return this.getOrSet(this.poolCache, key, fetchFn, ttl);
  }

  // Price cache methods with validation
  getPriceData(tokenAddress) {
    const key = this.validateAddress(tokenAddress);
    return this.priceCache.get(key);
  }

  setPriceData(tokenAddress, data, ttl = API_CONFIG.PRICE_CACHE_TTL) {
    const key = this.validateAddress(tokenAddress);
    return this.priceCache.set(key, data, ttl);
  }

  // Atomic get-or-fetch for price data
  async getOrFetchPriceData(tokenAddress, fetchFn, ttl = API_CONFIG.PRICE_CACHE_TTL) {
    const key = this.validateAddress(tokenAddress);
    return this.getOrSet(this.priceCache, key, fetchFn, ttl);
  }

  // Token cache methods with validation
  getTokenData(tokenAddress) {
    const key = this.validateAddress(tokenAddress);
    return this.tokenCache.get(key);
  }

  setTokenData(tokenAddress, data) {
    const key = this.validateAddress(tokenAddress);
    return this.tokenCache.set(key, data);
  }

  // Atomic get-or-fetch for token data
  async getOrFetchTokenData(tokenAddress, fetchFn, ttl = 3600) {
    const key = this.validateAddress(tokenAddress);
    return this.getOrSet(this.tokenCache, key, fetchFn, ttl);
  }

  // Analysis cache methods with validation
  getAnalysis(tokenAddress) {
    const address = this.validateAddress(tokenAddress);
    const key = `analysis_${address}`;
    return this.poolCache.get(key);
  }

  setAnalysis(tokenAddress, data, ttl = API_CONFIG.CACHE_TTL) {
    const address = this.validateAddress(tokenAddress);
    const key = `analysis_${address}`;
    return this.poolCache.set(key, data, ttl);
  }

  // Atomic get-or-fetch for analysis data
  async getOrFetchAnalysis(tokenAddress, fetchFn, ttl = API_CONFIG.CACHE_TTL) {
    const address = this.validateAddress(tokenAddress);
    const key = `analysis_${address}`;
    return this.getOrSet(this.poolCache, key, fetchFn, ttl);
  }

  // Clear cache for specific token with validation
  clearTokenAnalysis(tokenAddress) {
    const address = this.validateAddress(tokenAddress);

    // Clear analysis cache
    const analysisKey = `analysis_${address}`;
    this.poolCache.del(analysisKey);

    // Clear token data
    this.tokenCache.del(address);

    // Clear price data
    this.priceCache.del(address);

    // Clear all pool data related to this token
    // FIXED: Use proper key matching to prevent substring collisions
    // e.g., WBNB address 0x4200...0006 should NOT match keys containing that as substring
    const allKeys = this.poolCache.keys();
    const normalizedAddress = address.toLowerCase();
    const poolKeysToDelete = allKeys.filter(key => {
      const keyLower = key.toLowerCase();
      // Match exact address boundaries: key starts/ends with address or has delimiter before/after
      return keyLower === normalizedAddress ||
             keyLower.startsWith(`${normalizedAddress}_`) ||
             keyLower.endsWith(`_${normalizedAddress}`) ||
             keyLower.includes(`_${normalizedAddress}_`) ||
             keyLower.startsWith(`analysis_${normalizedAddress}`) ||
             keyLower.startsWith(`pool_${normalizedAddress}`) ||
             keyLower.startsWith(`route_${normalizedAddress}`);
    });

    if (poolKeysToDelete.length > 0) {
      this.poolCache.del(poolKeysToDelete);
    }

    this.logger.info(`Cleared all cache for token: ${address}`);
  }

  // NEW: Clear all V2/V3 pool caches
  clearAllPoolCaches() {
    const allKeys = this.poolCache.keys();
    const poolKeys = allKeys.filter(key => 
      key.startsWith('v2_') || key.startsWith('v3_') || key.includes('analysis_')
    );
    
    if (poolKeys.length > 0) {
      this.poolCache.del(poolKeys);
      this.logger.info(`Cleared ${poolKeys.length} pool cache entries`);
    }
  }

  // Clear specific cache
  clearPoolCache() {
    this.poolCache.flushAll();
    this.logger.info('Pool cache cleared');
  }

  clearPriceCache() {
    this.priceCache.flushAll();
    this.logger.info('Price cache cleared');
  }

  clearAll() {
    this.poolCache.flushAll();
    this.priceCache.flushAll();
    this.tokenCache.flushAll();
    this.logger.info('All caches cleared');
  }

  // Get cache statistics
  getStats() {
    return {
      pools: {
        keys: this.poolCache.keys().length,
        hits: this.poolCache.getStats().hits,
        misses: this.poolCache.getStats().misses,
      },
      prices: {
        keys: this.priceCache.keys().length,
        hits: this.priceCache.getStats().hits,
        misses: this.priceCache.getStats().misses,
      },
      tokens: {
        keys: this.tokenCache.keys().length,
        hits: this.tokenCache.getStats().hits,
        misses: this.tokenCache.getStats().misses,
      },
    };
  }

  // List all cached keys
  listCachedKeys() {
    return {
      pools: this.poolCache.keys(),
      prices: this.priceCache.keys(),
      tokens: this.tokenCache.keys()
    };
  }

  /**
   * Get cache hit rate for performance monitoring
   */
  getHitRate() {
    const poolStats = this.poolCache.getStats();
    const priceStats = this.priceCache.getStats();
    const tokenStats = this.tokenCache.getStats();

    const calculateRate = (hits, misses) => {
      const total = hits + misses;
      return total > 0 ? (hits / total * 100).toFixed(2) : 0;
    };

    return {
      pools: {
        hitRate: calculateRate(poolStats.hits, poolStats.misses),
        hits: poolStats.hits,
        misses: poolStats.misses,
      },
      prices: {
        hitRate: calculateRate(priceStats.hits, priceStats.misses),
        hits: priceStats.hits,
        misses: priceStats.misses,
      },
      tokens: {
        hitRate: calculateRate(tokenStats.hits, tokenStats.misses),
        hits: tokenStats.hits,
        misses: tokenStats.misses,
      },
    };
  }

  /**
   * Warm cache with common tokens and prices
   * Call this on startup to pre-populate frequently accessed data
   */
  async warmCache(tokenService, priceService) {
    this.logger.info('Starting cache warming...');
    const startTime = Date.now();

    try {
      // Common BSC tokens to pre-cache
      const commonTokens = [
        '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
        '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', // USDC
        '0x55d398326f99059fF775485246999027B3197955', // USDT
        '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', // BUSD
        '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3', // DAI
        '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', // CAKE
      ];

      // Pre-fetch token info in parallel
      if (tokenService) {
        const tokenPromises = commonTokens.map(async (address) => {
          try {
            const tokenInfo = await tokenService.getTokenInfo(address);
            this.setTokenData(address, tokenInfo);
            return true;
          } catch (error) {
            this.logger.debug(`Failed to warm cache for token ${address}: ${error.message}`);
            return false;
          }
        });

        const tokenResults = await Promise.all(tokenPromises);
        const successCount = tokenResults.filter(r => r).length;
        this.logger.info(`Warmed ${successCount}/${commonTokens.length} token caches`);
      }

      // Fetch current BNB price
      if (priceService && typeof priceService.fetchTokenPricesFromChain === 'function') {
        try {
          await priceService.fetchTokenPricesFromChain();
          this.logger.info('Price cache warmed with current BNB/CAKE prices');
        } catch (error) {
          this.logger.warn(`Failed to warm price cache: ${error.message}`);
        }
      }

      const duration = Date.now() - startTime;
      this.logger.info(`Cache warming completed in ${duration}ms`);

      return {
        success: true,
        duration,
        tokensWarmed: commonTokens.length,
      };
    } catch (error) {
      this.logger.error('Cache warming failed:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Pre-analyze main tokens on startup for instant response
   * These are frequently traded tokens that users query often
   */
  async warmAnalysisCache(poolAnalyzer) {
    this.logger.info('Starting analysis cache warming for main tokens...');
    const startTime = Date.now();

    // Main tokens to pre-analyze (frequently traded on BSC)
    const mainTokens = [
      { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC' },
      { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT' },
      { address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', symbol: 'BUSD' },
      { address: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3', symbol: 'DAI' },
      { address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', symbol: 'CAKE' },
    ];

    let successCount = 0;

    // Analyze tokens sequentially to avoid overwhelming RPC
    for (const token of mainTokens) {
      try {
        this.logger.info(`Pre-analyzing ${token.symbol}...`);
        await poolAnalyzer.analyzeToken(token.address);
        successCount++;
        this.logger.info(`✅ ${token.symbol} analysis cached`);
      } catch (error) {
        this.logger.warn(`Failed to pre-analyze ${token.symbol}: ${error.message}`);
      }
    }

    const duration = Date.now() - startTime;
    this.logger.info(`Analysis cache warming completed: ${successCount}/${mainTokens.length} tokens in ${duration}ms`);

    return {
      success: successCount > 0,
      duration,
      tokensAnalyzed: successCount,
      totalTokens: mainTokens.length,
    };
  }

  /**
   * Set optimal TTLs based on data type
   * Prices: short TTL (30s) - change frequently
   * Tokens: long TTL (1h) - metadata rarely changes
   * Pools: medium TTL (5min) - liquidity changes moderately
   */
  getOptimalTTL(dataType) {
    const ttls = {
      price: 30,      // 30 seconds - prices are volatile
      token: 3600,    // 1 hour - token metadata is static
      pool: 300,      // 5 minutes - pool data changes moderately
      analysis: 180,  // 3 minutes - full analysis results
    };
    return ttls[dataType] || 300;
  }
}

// Singleton instance
let cacheInstance = null;

module.exports = {
  getCacheService: () => {
    if (!cacheInstance) {
      cacheInstance = new CacheService();
    }
    return cacheInstance;
  },
};
