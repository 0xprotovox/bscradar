// src/routes/poolRoutes.js

const express = require('express');
const { getPoolAnalyzer } = require('../services/PoolAnalyzer');
const { getProviderService } = require('../services/ProviderService');
const { getCacheService } = require('../utils/Cache');
const { getLogger } = require('../utils/Logger');
const { ethers } = require('ethers');

const router = express.Router();
const poolAnalyzer = getPoolAnalyzer();
const providerService = getProviderService();
const cacheService = getCacheService();
const logger = getLogger();

// Middleware for validating BSC addresses
const validateAddress = (req, res, next) => {
  const { address } = req.params;
  
  if (!address || !ethers.isAddress(address)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid BSC address',
    });
  }
  
  req.params.address = ethers.getAddress(address); // Checksum address
  next();
};

// GET /api/analyze/:address - Analyze all pools for a token
router.get('/analyze/:address', validateAddress, async (req, res) => {
  try {
    const { address } = req.params;
    const { refresh } = req.query;
    
    // Clear cache if refresh requested
    if (refresh === 'true') {
      cacheService.clearAll();
    }
    
    logger.info(`API: Analyzing token ${address}`);
    
    const analysis = await poolAnalyzer.analyzeToken(address);
    
    res.json({
      success: true,
      data: analysis,
    });
  } catch (error) {
    logger.error('API: Analysis failed', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// GET /api/pools/:address - Get all pools for a token (simpler response)
router.get('/pools/:address', validateAddress, async (req, res) => {
  try {
    const { address } = req.params;
    
    const analysis = await poolAnalyzer.analyzeToken(address);
    
    // Return simplified pool list
    const pools = analysis.pools.map(pool => ({
      address: pool.address,
      type: pool.type,
      pair: pool.pair,
      liquidity: pool.liquidity.usd,
      fee: pool.fee,
      price: pool.price.ratio,
    }));
    
    res.json({
      success: true,
      token: analysis.token.symbol,
      count: pools.length,
      pools,
    });
  } catch (error) {
    logger.error('API: Get pools failed', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// GET /api/best-pool/:address - Get the best pool for a token
router.get('/best-pool/:address', validateAddress, async (req, res) => {
  try {
    const { address } = req.params;
    const { criteria } = req.query; // liquidity, price, or recommended
    
    const analysis = await poolAnalyzer.analyzeToken(address);
    
    let bestPool;
    switch (criteria) {
      case 'liquidity':
        bestPool = analysis.bestPools.byLiquidity;
        break;
      case 'price':
        bestPool = analysis.bestPools.byPrice;
        break;
      default:
        bestPool = analysis.bestPools.recommended;
    }
    
    if (!bestPool) {
      return res.status(404).json({
        success: false,
        error: 'No suitable pool found',
      });
    }
    
    res.json({
      success: true,
      criteria: criteria || 'recommended',
      pool: bestPool,
    });
  } catch (error) {
    logger.error('API: Get best pool failed', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// POST /api/quote - Get swap quote
router.post('/quote', async (req, res) => {
  try {
    const { tokenIn, tokenOut, amountIn } = req.body;
    
    // Validate inputs
    if (!ethers.isAddress(tokenIn) || !ethers.isAddress(tokenOut)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid token addresses',
      });
    }
    
    if (!amountIn || isNaN(amountIn) || Number(amountIn) <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid amount',
      });
    }
    
    logger.info(`API: Quote request ${tokenIn} -> ${tokenOut}, amount: ${amountIn}`);
    
    const comparison = await poolAnalyzer.comparePoolsForSwap(
      tokenIn,
      tokenOut,
      ethers.parseEther(amountIn.toString())
    );
    
    if (!comparison.bestPool) {
      return res.status(404).json({
        success: false,
        error: 'No pool found for this pair',
      });
    }
    
    res.json({
      success: true,
      tokenIn: comparison.tokenIn,
      tokenOut: comparison.tokenOut,
      amountIn,
      bestPool: comparison.bestPool ? {
        address: comparison.bestPool.address,
        type: comparison.bestPool.type,
        amountOut: ethers.formatUnits(
          comparison.bestPool.simulation.amountOut,
          comparison.tokenOut.decimals || 18
        ),
        priceImpact: comparison.bestPool.simulation.priceImpact,
        executionPrice: comparison.bestPool.simulation.executionPrice,
      } : null,
      allPools: comparison.pools.map(pool => ({
        address: pool.address,
        type: pool.type,
        fee: pool.fee || pool.feePercent,
        amountOut: ethers.formatUnits(
          pool.simulation.amountOut,
          comparison.tokenOut.decimals || 18
        ),
        priceImpact: pool.simulation.priceImpact,
      })),
    });
  } catch (error) {
    logger.error('API: Quote failed', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// GET /api/find-pools/:tokenA/:tokenB - Find pools without quotes
router.get('/find-pools/:tokenA/:tokenB', async (req, res) => {
  try {
    const { tokenA, tokenB } = req.params;
    
    if (!ethers.isAddress(tokenA) || !ethers.isAddress(tokenB)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid token addresses',
      });
    }
    
    logger.info(`API: Finding pools for ${tokenA} / ${tokenB}`);
    
    // Find pools without simulating swaps
    const [analysisA, analysisB] = await Promise.all([
      poolAnalyzer.analyzeToken(tokenA),
      poolAnalyzer.analyzeToken(tokenB)
    ]);
    
    // Find common pools
    const directPools = analysisA.pools.filter(poolA => {
      return analysisB.pools.some(poolB => 
        poolA.address.toLowerCase() === poolB.address.toLowerCase()
      );
    });
    
    res.json({
      success: true,
      tokenA: analysisA.token,
      tokenB: analysisB.token,
      directPools: directPools.length,
      pools: directPools.map(pool => ({
        address: pool.address,
        type: pool.type,
        pair: pool.pair,
        fee: pool.fee,
        liquidity: pool.liquidity.usd,
        status: pool.liquidity.status
      }))
    });
  } catch (error) {
    logger.error('API: Find pools failed', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// GET /api/health - Health check
router.get('/health', async (req, res) => {
  try {
    const providerHealth = await providerService.getHealthStatus();
    const cacheStats = cacheService.getStats();
    
    res.json({
      success: true,
      status: 'healthy',
      providers: providerHealth,
      cache: cacheStats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      status: 'unhealthy',
      error: error.message,
    });
  }
});

// GET /api/cache/stats - Cache statistics
router.get('/cache/stats', (req, res) => {
  const stats = cacheService.getStats();
  
  res.json({
    success: true,
    stats,
  });
});

// POST /api/cache/clear - Clear cache
router.post('/cache/clear', (req, res) => {
  cacheService.clearAll();
  
  res.json({
    success: true,
    message: 'Cache cleared successfully',
  });
});

module.exports = router;