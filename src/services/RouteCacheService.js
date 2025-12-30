// src/services/RouteCacheService.js
// Pre-caches routes for main token pairs to speed up routing

const { getLogger } = require('../utils/Logger');
const { getPoolAnalyzer } = require('./PoolAnalyzer');

// Main tokens to pre-cache routes for (BSC)
const MAIN_TOKENS = {
  WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  USDT: '0x55d398326f99059fF775485246999027B3197955',
  BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
  CAKE: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
};

// Token pairs to pre-cache (from → to)
const PAIRS_TO_CACHE = [
  ['WBNB', 'USDC'],
  ['WBNB', 'USDT'],
  ['WBNB', 'BUSD'],
  ['WBNB', 'CAKE'],
  ['USDC', 'WBNB'],
  ['USDC', 'USDT'],
  ['USDC', 'BUSD'],
  ['USDT', 'WBNB'],
  ['USDT', 'USDC'],
  ['USDT', 'BUSD'],
  ['BUSD', 'WBNB'],
  ['BUSD', 'USDC'],
  ['BUSD', 'USDT'],
  ['CAKE', 'WBNB'],
  ['CAKE', 'USDC'],
];

class RouteCacheService {
  constructor() {
    this.logger = getLogger();
    this.poolAnalyzer = getPoolAnalyzer();
    this.cache = new Map();
    this.cacheTTL = 10 * 60 * 1000; // 10 minutes
    this.refreshInterval = null;
    this.isRefreshing = false;
  }

  /**
   * Get cache key for a token pair
   */
  getCacheKey(tokenIn, tokenOut) {
    return `${tokenIn.toLowerCase()}-${tokenOut.toLowerCase()}`;
  }

  /**
   * Get best pool for a main token pair from cache
   */
  getBestPool(tokenIn, tokenOut) {
    const key = this.getCacheKey(tokenIn, tokenOut);
    const cached = this.cache.get(key);

    if (!cached) {
      return null;
    }

    // Check if cache is still valid
    if (Date.now() - cached.timestamp > this.cacheTTL) {
      this.cache.delete(key);
      return null;
    }

    return cached.pool;
  }

  /**
   * Get all cached pools for a token
   */
  getCachedPoolsForToken(tokenAddress) {
    const normalizedAddr = tokenAddress.toLowerCase();
    const pools = [];

    for (const [key, cached] of this.cache.entries()) {
      if (Date.now() - cached.timestamp > this.cacheTTL) {
        continue;
      }

      const [from, to] = key.split('-');
      if (from === normalizedAddr || to === normalizedAddr) {
        pools.push({
          ...cached.pool,
          direction: from === normalizedAddr ? 'out' : 'in',
          pairToken: from === normalizedAddr ? to : from,
        });
      }
    }

    return pools;
  }

  /**
   * Pre-cache routes for main token pairs
   */
  async refreshCache() {
    if (this.isRefreshing) {
      this.logger.debug('Route cache refresh already in progress');
      return;
    }

    this.isRefreshing = true;
    const startTime = Date.now();
    this.logger.info('🔄 Starting route cache refresh for main tokens...');

    // OPTIMIZATION: Get unique tokens and analyze them all in parallel
    const uniqueTokens = new Set();
    for (const [fromSymbol] of PAIRS_TO_CACHE) {
      if (MAIN_TOKENS[fromSymbol]) {
        uniqueTokens.add(fromSymbol);
      }
    }

    // Analyze all unique tokens in PARALLEL (not sequential!)
    const tokenAnalyses = {};
    const analysisPromises = [...uniqueTokens].map(async (symbol) => {
      try {
        const addr = MAIN_TOKENS[symbol];
        const analysis = await this.poolAnalyzer.analyzeToken(addr);
        return { symbol, addr, analysis };
      } catch (err) {
        this.logger.debug(`Failed to analyze ${symbol}: ${err.message}`);
        return { symbol, addr: MAIN_TOKENS[symbol], analysis: null };
      }
    });

    const analysisResults = await Promise.allSettled(analysisPromises);

    // Build lookup map from results
    for (const result of analysisResults) {
      if (result.status === 'fulfilled' && result.value.analysis) {
        tokenAnalyses[result.value.symbol] = result.value.analysis;
      }
    }

    this.logger.info(`📊 Analyzed ${Object.keys(tokenAnalyses).length}/${uniqueTokens.size} tokens in parallel`);

    // Now process pairs using cached analyses
    let successCount = 0;
    let failCount = 0;

    for (const [fromSymbol, toSymbol] of PAIRS_TO_CACHE) {
      const fromAddr = MAIN_TOKENS[fromSymbol];
      const toAddr = MAIN_TOKENS[toSymbol];

      if (!fromAddr || !toAddr) continue;

      const analysis = tokenAnalyses[fromSymbol];
      if (!analysis || !analysis.pools) {
        failCount++;
        continue;
      }

      // Find best pool for this pair
      const matchingPools = analysis.pools.filter(pool =>
        pool.pairToken?.address?.toLowerCase() === toAddr.toLowerCase() &&
        pool.liquidity?.status === 'ACTIVE'
      );

      if (matchingPools.length === 0) {
        failCount++;
        continue;
      }

      // Sort by liquidity and fee
      matchingPools.sort((a, b) => {
        const liquidityDiff = (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0);
        if (Math.abs(liquidityDiff) > 1000) return liquidityDiff;
        return (a.fee || 10000) - (b.fee || 10000);
      });

      const bestPool = matchingPools[0];
      const key = this.getCacheKey(fromAddr, toAddr);

      this.cache.set(key, {
        pool: {
          address: bestPool.address,
          protocol: bestPool.protocol,
          type: bestPool.type,
          fee: bestPool.fee,
          tickSpacing: bestPool.tickSpacing,
          liquidity: bestPool.liquidity,
          price: bestPool.price,
          fromSymbol,
          toSymbol,
        },
        timestamp: Date.now(),
      });

      successCount++;
      this.logger.debug(`✅ Cached ${fromSymbol} → ${toSymbol}: ${bestPool.protocol} ${bestPool.type}`);
    }

    const elapsed = Date.now() - startTime;
    this.isRefreshing = false;

    this.logger.info(`✅ Route cache refresh complete in ${elapsed}ms (was ~3000ms before parallelization)`, {
      cached: successCount,
      failed: failCount,
      totalPairs: PAIRS_TO_CACHE.length,
    });
  }

  /**
   * Start background cache refresh
   */
  startBackgroundRefresh(intervalMs = 10 * 60 * 1000) {
    // Initial refresh
    this.refreshCache().catch(err => {
      this.logger.error('Initial route cache refresh failed', { error: err.message });
    });

    // Schedule periodic refresh
    this.refreshInterval = setInterval(() => {
      this.refreshCache().catch(err => {
        this.logger.error('Route cache refresh failed', { error: err.message });
      });
    }, intervalMs);

    this.logger.info(`📦 Route cache service started (refresh every ${intervalMs / 1000}s)`);
  }

  /**
   * Stop background refresh
   */
  stopBackgroundRefresh() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
      this.logger.info('Route cache service stopped');
    }
  }

  /**
   * Get cache statistics
   */
  getStats() {
    let validCount = 0;
    let expiredCount = 0;
    const now = Date.now();

    for (const [key, cached] of this.cache.entries()) {
      if (now - cached.timestamp > this.cacheTTL) {
        expiredCount++;
      } else {
        validCount++;
      }
    }

    return {
      totalCached: this.cache.size,
      validEntries: validCount,
      expiredEntries: expiredCount,
      cacheTTL: this.cacheTTL,
      isRefreshing: this.isRefreshing,
    };
  }

  /**
   * Get all cached routes (for debugging/API)
   */
  getAllCachedRoutes() {
    const routes = [];
    const now = Date.now();

    for (const [key, cached] of this.cache.entries()) {
      const isExpired = now - cached.timestamp > this.cacheTTL;
      routes.push({
        pair: `${cached.pool.fromSymbol} → ${cached.pool.toSymbol}`,
        pool: cached.pool.address,
        protocol: `${cached.pool.protocol} ${cached.pool.type}`,
        fee: cached.pool.fee,
        tickSpacing: cached.pool.tickSpacing,
        liquidityUSD: cached.pool.liquidity?.usd,
        age: Math.round((now - cached.timestamp) / 1000),
        isExpired,
      });
    }

    return routes;
  }
}

// Singleton instance
let instance = null;

function getRouteCacheService() {
  if (!instance) {
    instance = new RouteCacheService();
  }
  return instance;
}

module.exports = {
  RouteCacheService,
  getRouteCacheService,
  MAIN_TOKENS,
  PAIRS_TO_CACHE,
};
