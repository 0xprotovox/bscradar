// src/index.js
require('dotenv').config();
const Application = require('./app');
const { getLogger } = require('./utils/Logger');
const { getProviderService } = require('./services/ProviderService');
const { getCacheService } = require('./utils/Cache');
const { getTokenService } = require('./services/TokenService');
const { getPriceService } = require('./services/PriceService');
const { getPoolAnalyzer } = require('./services/PoolAnalyzer');
const { getRouteCacheService } = require('./services/RouteCacheService');

const logger = getLogger();

// Global error handlers to prevent crashes from unhandled errors
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection:', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  // Don't exit - let the process continue but log the error
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error.message);
  console.error('Stack:', error.stack);
  logger.error(`Uncaught Exception: ${error.message} - ${error.stack}`);
  // For uncaught exceptions, we should exit after cleanup
  // Give time for logging to complete
  setTimeout(() => {
    process.exit(1);
  }, 1000);
});

async function startServer() {
  try {
    logger.info('Starting Pool Analyzer API Microservice...');

    // Test provider connection
    logger.info('Testing provider connection...');
    const providerService = getProviderService();
    const health = await providerService.testProviderHealth();

    if (!health.healthy) {
      throw new Error('Provider health check failed');
    }

    logger.info(`✅ Provider connected. Block number: ${health.blockNumber}`);

    // Warm the cache with common tokens and prices
    logger.info('Warming cache...');
    const cacheService = getCacheService();
    const tokenService = getTokenService();
    const priceService = getPriceService();
    const warmResult = await cacheService.warmCache(tokenService, priceService);
    if (warmResult.success) {
      logger.info(`✅ Cache warmed in ${warmResult.duration}ms`);
    }

    // Start the application
    const app = new Application();
    const server = app.start();

    // Pre-analyze main tokens in background (don't block server)
    const poolAnalyzer = getPoolAnalyzer();
    setImmediate(async () => {
      logger.info('Starting background analysis pre-cache for main tokens...');
      const analysisResult = await cacheService.warmAnalysisCache(poolAnalyzer);
      if (analysisResult.success) {
        logger.info(`✅ Main tokens pre-analyzed: ${analysisResult.tokensAnalyzed}/${analysisResult.totalTokens} in ${analysisResult.duration}ms`);
      }
    });

    // Start route cache service for main token pairs (10 min refresh)
    const routeCacheService = getRouteCacheService();
    routeCacheService.startBackgroundRefresh(10 * 60 * 1000);

    // Graceful shutdown
    const shutdown = (signal) => {
      logger.info(`${signal} signal received: closing HTTP server`);
      // CRITICAL FIX: Stop background services
      try { routeCacheService.stopBackgroundRefresh(); } catch (e) {}
      app.stop();
      // Give time for cleanup
      setTimeout(() => {
        process.exit(0);
      }, 1000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error) {
    logger.error('Failed to start server', error);
    process.exit(1);
  }
}

// Start the server
startServer();
