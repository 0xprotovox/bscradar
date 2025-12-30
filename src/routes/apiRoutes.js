// src/routes/apiRoutes.js
const express = require('express');
const { getPoolAnalyzer } = require('../services/PoolAnalyzer');
const { getMultiHopRouterService } = require('../services/MultiHopRouterService');
const { getProviderService } = require('../services/ProviderService');
const { getCacheService } = require('../utils/Cache');
const { getLogger } = require('../utils/Logger');
const { ethers } = require('ethers');

const router = express.Router();
const poolAnalyzer = getPoolAnalyzer();
const multiHopRouter = getMultiHopRouterService();
const providerService = getProviderService();
const cacheService = getCacheService();
const { getRouteCacheService } = require('../services/RouteCacheService');
const routeCacheService = getRouteCacheService();
const logger = getLogger();

// ============ MIDDLEWARE ============
const validateAddress = (req, res, next) => {
  const { address, token } = req.params;
  const addr = address || token;
  
  if (!addr || !ethers.isAddress(addr)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid BSC address'
    });
  }
  
  if (address) req.params.address = ethers.getAddress(address);
  if (token) req.params.token = ethers.getAddress(token);
  next();
};

const validatePairAddresses = (req, res, next) => {
  const { tokenA, tokenB } = req.params;
  
  if (!ethers.isAddress(tokenA) || !ethers.isAddress(tokenB)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid token addresses'
    });
  }
  
  req.params.tokenA = ethers.getAddress(tokenA);
  req.params.tokenB = ethers.getAddress(tokenB);
  next();
};

// ============ MAIN ENDPOINTS ============

// GET /api/analyze/:token - Full token analysis
// Query params:
//   - refresh=true: Force refresh cache
//   - fast=true: Fast mode - returns only essential data (~200ms vs ~800ms)
//   - minLiquidity=1000: Filter pools with liquidity below threshold (default: 0)
router.get('/analyze/:token', validateAddress, async (req, res) => {
  try {
    const { token } = req.params;
    const { refresh = 'false', fast = 'false', minLiquidity = '0' } = req.query;
    const isFastMode = fast === 'true';
    const minLiquidityUSD = parseFloat(minLiquidity) || 0;

    if (refresh === 'true') {
      cacheService.clearTokenAnalysis(token);
    }

    logger.info(`API: Analyzing token ${token}${isFastMode ? ' (FAST MODE)' : ''}`);
    const analysis = await poolAnalyzer.analyzeToken(token);

    // Add multiHopInfo to bestPools.recommended for multi-hop Slipstream swaps
    const WBNB_ANALYZE = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'.toLowerCase();
    const stablecoinsAnalyze = [
      '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', // USDC
      '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', // BUSD
      '0x55d398326f99059fF775485246999027B3197955', // USDT
      '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3', // DAI
    ].map(a => a.toLowerCase());

    const recommended = analysis.bestPools?.recommended;
    if (recommended) {
      const pairAddr = recommended.pairToken?.address?.toLowerCase();
      if (recommended.tickSpacing && pairAddr !== WBNB_ANALYZE && stablecoinsAnalyze.includes(pairAddr)) {
        recommended.multiHopInfo = {
          intermediateToken: recommended.pairToken.address,
          firstLegTickSpacing: 1,
          secondLegTickSpacing: recommended.tickSpacing,
        };
        logger.info('Added multiHopInfo to recommended pool', recommended.multiHopInfo);
      }
    }

    // FAST MODE: Return minimal response for speed-critical applications
    if (isFastMode) {
      // Filter and limit pools
      let topPools = analysis.pools
        .filter(p => (p.liquidity?.usd || 0) >= minLiquidityUSD)
        .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))
        .slice(0, 5)
        .map(p => ({
          address: p.address,
          protocol: p.protocol,
          type: p.type,
          fee: p.fee,
          feePercent: p.feePercent,
          tickSpacing: p.tickSpacing,
          pair: p.pair,
          liquidity: p.liquidity,
          price: p.price
        }));

      return res.json({
        success: true,
        mode: 'fast',
        data: {
          token: analysis.token,
          pricing: analysis.pricing,
          bestPool: analysis.bestPools?.recommended ? {
            address: analysis.bestPools.recommended.address,
            protocol: analysis.bestPools.recommended.protocol,
            type: analysis.bestPools.recommended.type,
            fee: analysis.bestPools.recommended.fee,
            feePercent: analysis.bestPools.recommended.feePercent,
            tickSpacing: analysis.bestPools.recommended.tickSpacing,
            pair: analysis.bestPools.recommended.pair,
            pairToken: analysis.bestPools.recommended.pairToken,
            liquidity: analysis.bestPools.recommended.liquidity,
            price: analysis.bestPools.recommended.price,
            multiHopInfo: analysis.bestPools.recommended.multiHopInfo
          } : null,
          topPools,
          summary: {
            totalPools: analysis.pools.length,
            activePools: analysis.summary?.activePools || topPools.length
          }
        },
        cached: analysis.cached || false,
        performance: { totalMs: analysis.performance?.totalMs }
      });
    }

    // FULL MODE: Return complete analysis
    let filteredPools = analysis.pools;
    if (minLiquidityUSD > 0) {
      filteredPools = analysis.pools.filter(p => (p.liquidity?.usd || 0) >= minLiquidityUSD);
    }

    res.json({
      success: true,
      mode: 'full',
      data: { ...analysis, pools: filteredPools },
      cached: analysis.cached || false
    });
  } catch (error) {
    logger.error('API: Analysis failed', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/best-pool/:token - Get the best pool for a token
router.get('/best-pool/:token', validateAddress, async (req, res) => {
  try {
    const { token } = req.params;
    const { criteria = 'recommended', basePair, priceDirection = 'sell' } = req.query;
    
    const analysis = await poolAnalyzer.analyzeToken(token);
    
    let bestPool;
    
    // Filter by base pair if specified
    let pools = analysis.pools;
    if (basePair && ethers.isAddress(basePair)) {
      pools = pools.filter(p => 
        p.pairToken?.address?.toLowerCase() === basePair.toLowerCase()
      );
    }
    
    // Select best pool by criteria
    switch (criteria) {
      case 'liquidity':
        bestPool = pools.sort((a, b) => b.liquidity.usd - a.liquidity.usd)[0];
        break;
      
      case 'price':
        // For price criteria, consider if user is buying or selling the token
        // priceDirection: 'buy' means best price to buy token (lowest price)
        // priceDirection: 'sell' means best price to sell token (highest price)
        const activePools = pools.filter(p => 
          p.liquidity.status === 'ACTIVE' && p.price.ratio > 0
        );
        
        if (priceDirection === 'buy') {
          // Lowest price (best for buying)
          bestPool = activePools.sort((a, b) => a.price.ratio - b.price.ratio)[0];
        } else {
          // Highest price (best for selling)
          bestPool = activePools.sort((a, b) => b.price.ratio - a.price.ratio)[0];
        }
        break;
      
      case 'fee':
        bestPool = pools.sort((a, b) => a.fee - b.fee)[0];
        break;
      
      case 'v3':
        bestPool = pools.filter(p => p.type === 'V3')
                       .sort((a, b) => b.liquidity.usd - a.liquidity.usd)[0];
        break;
      
      case 'v2':
        bestPool = pools.filter(p => p.type === 'V2')
                       .sort((a, b) => b.liquidity.usd - a.liquidity.usd)[0];
        break;
      
      case 'balanced':
        // Balanced selection: good liquidity + reasonable fee + good price
        bestPool = pools
          .filter(p => p.liquidity.status === 'ACTIVE')
          .map(pool => {
            let score = 0;
            
            // Liquidity score (0-40 points)
            if (pool.liquidity.usd >= 100000) score += 40;
            else if (pool.liquidity.usd >= 50000) score += 30;
            else if (pool.liquidity.usd >= 10000) score += 20;
            else if (pool.liquidity.usd >= 1000) score += 10;
            
            // Fee score (0-30 points)
            if (pool.fee <= 100) score += 30;
            else if (pool.fee <= 500) score += 25;
            else if (pool.fee <= 3000) score += 15;
            else if (pool.fee <= 10000) score += 5;
            
            // Version score (0-10 points)
            if (pool.type === 'V3') score += 10;
            else score += 5;
            
            // Price score (0-20 points) - favor pools with prices close to average
            if (analysis.analysis.priceAnalysis) {
              const avgPrice = analysis.analysis.priceAnalysis.averagePrice;
              const priceDiff = Math.abs(pool.price.ratio - avgPrice) / avgPrice;
              if (priceDiff <= 0.01) score += 20;
              else if (priceDiff <= 0.05) score += 15;
              else if (priceDiff <= 0.10) score += 10;
              else if (priceDiff <= 0.20) score += 5;
            }
            
            return { ...pool, balanceScore: score };
          })
          .sort((a, b) => b.balanceScore - a.balanceScore)[0];
        break;
      
      default:
        bestPool = analysis.bestPools.recommended;
    }
    
    if (!bestPool) {
      return res.status(404).json({
        success: false,
        error: 'No suitable pool found',
        criteria,
        basePair,
        totalPools: analysis.summary.totalPools,
        activePools: pools.filter(p => p.liquidity.status === 'ACTIVE').length
      });
    }
    
    // Add additional info for price criteria
    if (criteria === 'price') {
      bestPool.priceInfo = {
        direction: priceDirection,
        currentPrice: bestPool.price.ratio,
        priceRange: analysis.analysis.priceAnalysis ? {
          min: analysis.analysis.priceAnalysis.minPrice,
          max: analysis.analysis.priceAnalysis.maxPrice,
          average: analysis.analysis.priceAnalysis.averagePrice
        } : null
      };
    }
    

    // For multi-hop: add tick spacing for both legs (WBNB->stablecoin->token)
    const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'.toLowerCase();
    const stablecoins = [
      '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
      '0x55d398326f99059fF775485246999027B3197955',
      '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3',
    ].map(a => a.toLowerCase());

    const pairAddr = bestPool.pairToken?.address?.toLowerCase();
    if (bestPool.tickSpacing && pairAddr !== WBNB && stablecoins.includes(pairAddr)) {
      bestPool.multiHopInfo = {
        intermediateToken: bestPool.pairToken.address,
        firstLegTickSpacing: 1,
        secondLegTickSpacing: bestPool.tickSpacing,
      };
    }
    res.json({
      success: true,
      pool: bestPool,
      criteria,
      basePair: basePair || 'any',
      ...(criteria === 'price' && { priceDirection })
    });
  } catch (error) {
    logger.error('API: Get best pool failed', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/quote - Get swap quote
router.post('/quote', async (req, res) => {
  try {
    const { tokenIn, tokenOut, amountIn, slippage = 0.5 } = req.body;
    
    // Validate inputs
    if (!ethers.isAddress(tokenIn) || !ethers.isAddress(tokenOut)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid token addresses'
      });
    }
    
    if (!amountIn || isNaN(amountIn) || Number(amountIn) <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid amount'
      });
    }
    
    logger.info(`API: Quote ${tokenIn} -> ${tokenOut}, amount: ${amountIn}`);
    
    const comparison = await poolAnalyzer.comparePoolsForSwap(
      tokenIn,
      tokenOut,
      ethers.parseEther(amountIn.toString())
    );
    
    if (!comparison.bestPool) {
      return res.status(404).json({
        success: false,
        error: 'No pool found for this pair',
        tokenIn: comparison.tokenIn,
        tokenOut: comparison.tokenOut
      });
    }
    
    // Calculate minimum amount out with slippage
    const amountOut = BigInt(comparison.bestPool.simulation.amountOut);
    const slippageFactor = 1 - (slippage / 100);
    const minAmountOut = (amountOut * BigInt(Math.floor(slippageFactor * 10000))) / 10000n;
    
    res.json({
      success: true,
      quote: {
        tokenIn: {
          address: comparison.tokenIn.address,
          symbol: comparison.tokenIn.symbol,
          amount: amountIn
        },
        tokenOut: {
          address: comparison.tokenOut.address,
          symbol: comparison.tokenOut.symbol,
          amount: ethers.formatUnits(amountOut, comparison.tokenOut.decimals || 18),
          minAmount: ethers.formatUnits(minAmountOut, comparison.tokenOut.decimals || 18)
        },
        pool: {
          address: comparison.bestPool.address,
          type: comparison.bestPool.type,
          fee: comparison.bestPool.fee
        },
        priceImpact: comparison.bestPool.simulation.priceImpact,
        executionPrice: comparison.bestPool.simulation.executionPrice,
        slippage: slippage
      },
      alternativePools: comparison.pools.slice(0, 3).map(pool => ({
        address: pool.address,
        type: pool.type,
        fee: pool.fee,
        amountOut: ethers.formatUnits(pool.simulation.amountOut, comparison.tokenOut.decimals || 18),
        priceImpact: pool.simulation.priceImpact
      }))
    });
  } catch (error) {
    logger.error('API: Quote failed', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/pools/:token - Get all pools for a token
router.get('/pools/:token', validateAddress, async (req, res) => {
  try {
    const { token } = req.params;
    const { type, minLiquidity = 0, limit = 20 } = req.query;
    
    const analysis = await poolAnalyzer.analyzeToken(token);
    
    let pools = analysis.pools;
    
    // Apply filters
    if (type) {
      pools = pools.filter(p => p.type.toLowerCase() === type.toLowerCase());
    }
    
    if (minLiquidity > 0) {
      pools = pools.filter(p => p.liquidity.usd >= Number(minLiquidity));
    }
    
    // Sort by liquidity and limit
    pools = pools
      .sort((a, b) => b.liquidity.usd - a.liquidity.usd)
      .slice(0, Number(limit));
    
    res.json({
      success: true,
      token: {
        address: analysis.token.address,
        symbol: analysis.token.symbol,
        name: analysis.token.name
      },
      count: pools.length,
      totalPools: analysis.summary.totalPools,
      pools: pools.map(pool => ({
        address: pool.address,
        type: pool.type,
        pair: pool.pair,
        pairToken: pool.pairToken,
        liquidity: pool.liquidity,
        fee: pool.fee,
        feePercent: pool.feePercent
      }))
    });
  } catch (error) {
    logger.error('API: Get pools failed', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/pair/:tokenA/:tokenB - Find direct pools between two tokens
router.get('/pair/:tokenA/:tokenB', validatePairAddresses, async (req, res) => {
  try {
    const { tokenA, tokenB } = req.params;
    
    logger.info(`API: Finding pools for pair ${tokenA} / ${tokenB}`);
    
    const [analysisA, analysisB] = await Promise.all([
      poolAnalyzer.analyzeToken(tokenA),
      poolAnalyzer.analyzeToken(tokenB)
    ]);
    
    // Find common pools
    const directPools = analysisA.pools.filter(poolA => 
      analysisB.pools.some(poolB => 
        poolA.address.toLowerCase() === poolB.address.toLowerCase()
      )
    );
    
    res.json({
      success: true,
      tokenA: {
        address: analysisA.token.address,
        symbol: analysisA.token.symbol
      },
      tokenB: {
        address: analysisB.token.address,
        symbol: analysisB.token.symbol
      },
      poolCount: directPools.length,
      pools: directPools.map(pool => ({
        address: pool.address,
        type: pool.type,
        fee: pool.fee,
        liquidity: pool.liquidity,
        price: pool.price
      }))
    });
  } catch (error) {
    logger.error('API: Find pair pools failed', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============ MULTI-HOP ROUTING ENDPOINTS ============

// POST /api/route - Find best route between two tokens (supports multi-hop)
router.post('/route', async (req, res) => {
  try {
    const { tokenIn, tokenOut, amountIn } = req.body;

    // Validate inputs
    if (!ethers.isAddress(tokenIn) || !ethers.isAddress(tokenOut)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid token addresses'
      });
    }

    if (!amountIn || isNaN(amountIn) || Number(amountIn) <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid amount'
      });
    }

    logger.info(`API: Finding route ${tokenIn} -> ${tokenOut}, amount: ${amountIn}`);

    const routeResult = await multiHopRouter.findBestRoute(
      tokenIn,
      tokenOut,
      ethers.parseEther(amountIn.toString()).toString()
    );

    res.json({
      success: true,
      route: routeResult.bestRoute,
      alternatives: routeResult.alternativeRoutes,
      timing: routeResult.timing
    });
  } catch (error) {
    logger.error('API: Route finding failed', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/route/:tokenIn/:tokenOut - Simple route lookup (no amount, just paths)
router.get('/route/:tokenIn/:tokenOut', validatePairAddresses, async (req, res) => {
  try {
    const tokenIn = req.params.tokenA; // validatePairAddresses normalizes to tokenA/tokenB
    const tokenOut = req.params.tokenB;
    const { amount = '1' } = req.query;

    logger.info(`API: Quick route lookup ${tokenIn} -> ${tokenOut}`);

    const routeResult = await multiHopRouter.findBestRoute(
      tokenIn,
      tokenOut,
      ethers.parseEther(amount).toString()
    );

    res.json({
      success: true,
      route: {
        type: routeResult.bestRoute.type,
        path: routeResult.bestRoute.path.map(t => t.symbol).join(' → '),
        pathAddresses: routeResult.bestRoute.path.map(t => t.address),
        legs: routeResult.bestRoute.legs.length,
        estimatedOutput: routeResult.bestRoute.estimatedOutputFormatted,
        priceImpact: routeResult.bestRoute.priceImpact,
        totalFees: routeResult.bestRoute.totalFees,
      },
      alternativeCount: routeResult.alternativeRoutes.length
    });
  } catch (error) {
    logger.error('API: Route lookup failed', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============ SMART RECOMMENDATION ENDPOINTS ============

// GET /api/smart-recommend/:token - Smart pool recommendation for specific trade size
// Query params: amount (trade size in USD), cached (use cache, default true)
router.get('/smart-recommend/:token', validateAddress, async (req, res) => {
  try {
    const { token } = req.params;
    const { amount = '1000', cached = 'true' } = req.query;

    const tradeAmountUSD = parseFloat(amount);
    if (isNaN(tradeAmountUSD) || tradeAmountUSD <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid amount parameter. Must be a positive number (USD value).'
      });
    }

    logger.info(`API: Smart recommendation for ${token}, trade size: $${tradeAmountUSD}`);

    const recommendation = await poolAnalyzer.getSmartRecommendation(
      token,
      tradeAmountUSD,
      cached === 'true'
    );

    if (recommendation.error) {
      return res.status(404).json({
        success: false,
        error: recommendation.error
      });
    }

    res.json({
      success: true,
      data: recommendation
    });
  } catch (error) {
    logger.error('API: Smart recommendation failed', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============ ULTRA-FAST SWAP ENDPOINT ============

// GET /api/swap-pool/:token - INSTANT pool recommendation for swap execution
// Uses ONLY cached data - call /api/analyze/:token first!
// Query params: eth (amount in BNB, default 0.01)
router.get('/swap-pool/:token', validateAddress, (req, res) => {
  try {
    const { token } = req.params;
    const { eth = '0.01' } = req.query;

    const tradeAmountBNB = parseFloat(eth);
    if (isNaN(tradeAmountBNB) || tradeAmountBNB <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid eth parameter. Must be a positive number.',
        fast: true
      });
    }

    // SYNC call - no await, pure cached data
    const result = poolAnalyzer.getSwapRecommendation(token, tradeAmountBNB);

    if (result.error) {
      const statusCode = result.error === 'TOKEN_NOT_CACHED' ? 428 : 404;
      return res.status(statusCode).json({
        success: false,
        ...result
      });
    }

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    logger.error('API: Swap pool recommendation failed', error);
    res.status(500).json({
      success: false,
      error: error.message,
      fast: true
    });
  }
});

// GET /api/trade-scenarios/:token - Compare best pools for different trade sizes
// Query params: sizes (comma-separated USD amounts, default: 100,1000,10000,50000)
router.get('/trade-scenarios/:token', validateAddress, async (req, res) => {
  try {
    const { token } = req.params;
    const { sizes = '100,1000,10000,50000' } = req.query;

    const tradeSizes = sizes.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n) && n > 0);

    if (tradeSizes.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid sizes parameter. Must be comma-separated positive numbers.'
      });
    }

    logger.info(`API: Trade scenarios for ${token}, sizes: ${tradeSizes.join(', ')}`);

    const scenarios = await poolAnalyzer.compareTradeScenarios(token, tradeSizes);

    if (scenarios.error) {
      return res.status(404).json({
        success: false,
        error: scenarios.error
      });
    }

    res.json({
      success: true,
      data: scenarios
    });
  } catch (error) {
    logger.error('API: Trade scenarios failed', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/split-trade/:token - Get split trade recommendation for large trades
// Query params: amount (trade size in USD)
// Returns single trade vs split trade comparison with safety analysis
router.get('/split-trade/:token', validateAddress, async (req, res) => {
  try {
    const { token } = req.params;
    const { amount } = req.query;

    const tradeAmountUSD = parseFloat(amount);
    if (isNaN(tradeAmountUSD) || tradeAmountUSD <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid amount parameter. Must be a positive number (USD value).'
      });
    }

    logger.info(`API: Split trade analysis for ${token}, amount: $${tradeAmountUSD}`);

    const splitAnalysis = await poolAnalyzer.calculateSplitTrade(token, tradeAmountUSD);

    if (splitAnalysis.error) {
      return res.status(404).json({
        success: false,
        error: splitAnalysis.error
      });
    }

    res.json({
      success: true,
      data: splitAnalysis
    });
  } catch (error) {
    logger.error('API: Split trade analysis failed', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============ UTILITY ENDPOINTS ============

// GET /api/health - Health check with details
router.get('/health', async (req, res) => {
  try {
    const providerHealth = await providerService.getHealthStatus();
    const cacheStats = cacheService.getStats();
    
    const healthyProviders = providerHealth.filter(p => p.health.healthy).length;
    
    res.json({
      success: true,
      status: healthyProviders > 0 ? 'healthy' : 'degraded',
      providers: {
        healthy: healthyProviders,
        total: providerHealth.length,
        details: providerHealth
      },
      cache: cacheStats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      status: 'unhealthy',
      error: error.message
    });
  }
});


// GET /api/prices - Get known token prices
router.get('/prices', (req, res) => {
  try {
    const { getPriceService } = require('../services/PriceService');
    const priceService = getPriceService();
    const priceInfo = priceService.getPriceInfo();
    
    res.json({
      success: true,
      ...priceInfo
    });
  } catch (error) {
    res.json({
      success: false,
      message: 'PriceService not available',
      error: error.message
    });
  }
});

// POST /api/prices - Update token prices (useful for testing)
router.post('/prices', (req, res) => {
  try {
    const { token, price } = req.body;
    
    if (!ethers.isAddress(token) || !price || price <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid token address or price'
      });
    }
    
    const { getPriceService } = require('../services/PriceService');
    const priceService = getPriceService();
    priceService.setTokenPrice(token, price);
    
    res.json({
      success: true,
      message: 'Price updated',
      token,
      price
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/cache/stats - Cache statistics
router.get('/cache/stats', (req, res) => {
  const stats = cacheService.getStats();
  const keys = cacheService.listCachedKeys();
  
  res.json({
    success: true,
    stats,
    cachedItems: {
      pools: keys.pools.length,
      prices: keys.prices.length,
      tokens: keys.tokens.length
    }
  });
});

// POST /api/cache/clear - Clear cache
router.post('/cache/clear', (req, res) => {
  const { type = 'all' } = req.body;
  
  switch(type) {
    case 'pools':
      cacheService.clearPoolCache();
      break;
    case 'prices':
      cacheService.clearPriceCache();
      break;
    default:
      cacheService.clearAll();
  }
  
  res.json({
    success: true,
    message: `Cache cleared: ${type}`
  });
});

// GET /api/docs - Comprehensive API documentation
router.get('/docs', (req, res) => {
  res.json({
    api: {
      name: 'BscRadar API',
      version: '2.1.0',
      description: 'High-performance stateless microservice for analyzing DEX liquidity pools on BSC Network. Supports PancakeSwap V2/V3 protocols.',
      baseUrl: '/api',
      network: 'BSC (Chain ID: 56)'
    },

    features: [
      'Multi-protocol pool discovery (PancakeSwap V2/V3)',
      'Real-time liquidity calculation using DexScreener method (actual token balances)',
      'Dynamic BNB price fetching from on-chain pools',
      'Multicall batching for high-performance data fetching',
      'Intelligent pool ranking and recommendation engine',
      'Swap simulation and quote generation',
      'In-memory caching with configurable TTL'
    ],

    endpoints: {
      // ============ ANALYSIS ENDPOINTS ============
      'GET /api/analyze/:token': {
        description: 'Get comprehensive analysis of all pools for a token',
        parameters: {
          token: { type: 'address', required: true, description: 'Token contract address (checksummed or lowercase)' }
        },
        queryParams: {
          refresh: { type: 'boolean', default: false, description: 'Force refresh cached data' }
        },
        response: {
          token: 'Token metadata (symbol, name, decimals, address)',
          pricing: 'Aggregated price data across all pools (USD, BNB)',
          summary: 'Pool counts by protocol and status',
          bestPools: 'Recommended pools by various criteria',
          pools: 'Array of all discovered pools with full data',
          analysis: 'Liquidity distribution and price analysis'
        },
        example: '/api/analyze/0x1111111111166b7fe7bd91427724b487980afc69'
      },

      'GET /api/best-pool/:token': {
        description: 'Get the optimal pool for a token based on specified criteria',
        parameters: {
          token: { type: 'address', required: true, description: 'Token contract address' }
        },
        queryParams: {
          criteria: {
            type: 'string',
            default: 'recommended',
            options: {
              recommended: 'Smart selection balancing liquidity, fees, and protocol',
              liquidity: 'Pool with highest USD liquidity',
              price: 'Pool with best price (combine with priceDirection)',
              fee: 'Pool with lowest trading fee',
              v2: 'Best PancakeSwap V2 pool by liquidity',
              v3: 'Best PancakeSwap V3 pool by liquidity',
              balanced: 'Weighted scoring of all factors'
            }
          },
          basePair: { type: 'address', optional: true, description: 'Filter by specific pair token (e.g., WBNB address)' },
          priceDirection: { type: 'string', options: ['buy', 'sell'], default: 'sell', description: 'For price criteria: buy=lowest price, sell=highest price' }
        },
        example: '/api/best-pool/0x1111111111166b7fe7bd91427724b487980afc69?criteria=liquidity'
      },

      'GET /api/pools/:token': {
        description: 'Get filtered list of pools for a token',
        parameters: {
          token: { type: 'address', required: true, description: 'Token contract address' }
        },
        queryParams: {
          type: { type: 'string', options: ['V2', 'V3'], optional: true, description: 'Filter by pool type' },
          minLiquidity: { type: 'number', optional: true, description: 'Minimum liquidity in USD' },
          limit: { type: 'number', default: 20, description: 'Maximum results to return' }
        },
        example: '/api/pools/0x1111111111166b7fe7bd91427724b487980afc69?type=V3&minLiquidity=10000'
      },

      // ============ TRADING ENDPOINTS ============
      'POST /api/quote': {
        description: 'Get swap quote with best execution path',
        body: {
          tokenIn: { type: 'address', required: true, description: 'Input token address' },
          tokenOut: { type: 'address', required: true, description: 'Output token address' },
          amountIn: { type: 'string', required: true, description: 'Input amount (in token units, e.g., "1.5")' },
          slippage: { type: 'number', default: 0.5, description: 'Slippage tolerance in percent' }
        },
        response: {
          quote: 'Best quote with expected output, minimum output, price impact',
          alternativePools: 'Other available pools with their quotes'
        },
        example: '{ "tokenIn": "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", "tokenOut": "0x1111111111166b7fe7bd91427724b487980afc69", "amountIn": "0.1", "slippage": 2 }'
      },

      'GET /api/pair/:tokenA/:tokenB': {
        description: 'Find all direct pools between two tokens',
        parameters: {
          tokenA: { type: 'address', required: true, description: 'First token address' },
          tokenB: { type: 'address', required: true, description: 'Second token address' }
        },
        example: '/api/pair/0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c/0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'
      },

      // ============ PRICE ENDPOINTS ============
      'GET /api/prices': {
        description: 'Get current known token prices (BNB, stablecoins, CAKE)',
        response: {
          bnbPriceUSD: 'Current BNB price in USD',
          basePrices: 'Map of token addresses to USD prices',
          lastUpdate: 'Timestamp of last price update'
        }
      },

      'POST /api/prices': {
        description: 'Manually set a token price (for testing)',
        body: {
          token: { type: 'address', required: true },
          price: { type: 'number', required: true, description: 'Price in USD' }
        }
      },

      // ============ UTILITY ENDPOINTS ============
      'GET /api/health': {
        description: 'Service health check with provider status',
        response: {
          status: 'healthy | degraded | unhealthy',
          providers: 'RPC provider health details',
          cache: 'Cache statistics'
        }
      },

      'GET /api/cache/stats': {
        description: 'Get detailed cache statistics',
        response: {
          stats: 'Hit/miss ratios for each cache type',
          cachedItems: 'Count of cached pools, prices, tokens'
        }
      },

      'POST /api/cache/clear': {
        description: 'Clear cached data',
        body: {
          type: { type: 'string', options: ['all', 'pools', 'prices'], default: 'all' }
        }
      }
    },

    dataModels: {
      Pool: {
        address: 'Pool contract address',
        protocol: 'PancakeSwap',
        type: 'V2 | V3',
        pair: 'Trading pair string (e.g., "CAKE/WBNB")',
        pairToken: 'Details of the paired token',
        fee: 'Fee in basis points (e.g., 3000 = 0.30%)',
        feePercent: 'Fee as percentage (e.g., 0.30)',
        liquidity: {
          status: 'ACTIVE | EMPTY',
          usd: 'Total value locked in USD',
          bnb: 'Total value locked in BNB',
          token0: 'Amount of token0 in pool',
          token1: 'Amount of token1 in pool'
        },
        price: {
          ratio: 'Price ratio from pool',
          inUSD: 'Token price in USD',
          inBNB: 'Token price in BNB',
          display: 'Formatted price string'
        }
      },

      TokenInfo: {
        address: 'Contract address',
        symbol: 'Token symbol',
        name: 'Token name',
        decimals: 'Token decimals'
      }
    },

    supportedProtocols: {
      'PancakeSwap V2': {
        factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
        type: 'Constant product AMM (x*y=k)',
        fee: '0.25% (fixed)'
      },
      'PancakeSwap V3': {
        factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
        type: 'Concentrated liquidity AMM',
        feeTiers: ['0.01% (100)', '0.05% (500)', '0.25% (2500)', '0.30% (3000)', '1.00% (10000)']
      }
    },

    knownTokens: {
      WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
      USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
      DAI: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3',
      USDT: '0x55d398326f99059fF775485246999027B3197955',
      CAKE: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82'
    },

    liquidityCalculation: {
      method: 'DexScreener/DexTools standard',
      formula: 'Total TVL = (Token0 Balance × Token0 Price) + (Token1 Balance × Token1 Price)',
      notes: [
        'V2 pools: Uses getReserves() for token amounts',
        'V3 pools: Uses actual ERC20 balanceOf() for accurate TVL (not liquidity estimates)',
        'Unknown token prices are derived from pool price ratios'
      ]
    },

    errorCodes: {
      400: 'Bad Request - Invalid address format or parameters',
      404: 'Not Found - No pools found for token/pair',
      500: 'Internal Server Error - RPC or processing failure'
    },

    rateLimit: {
      window: '60 seconds',
      maxRequests: 100,
      message: 'Rate limit applied per IP address'
    },

    examples: {
      'Analyze CAKE token': 'GET /api/analyze/0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
      'Get best WBNB pool for USDC': 'GET /api/best-pool/0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d?criteria=liquidity&basePair=0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
      'Find WBNB/USDC pools': 'GET /api/pair/0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c/0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      'Get swap quote': 'POST /api/quote with body { "tokenIn": "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", "tokenOut": "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", "amountIn": "1", "slippage": 0.5 }',
      'Force refresh analysis': 'GET /api/analyze/0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82?refresh=true'
    }
  });
});

// GET /api/route-cache - Get cached routes for main tokens
router.get('/route-cache', (req, res) => {
  try {
    const stats = routeCacheService.getStats();
    const routes = routeCacheService.getAllCachedRoutes();

    res.json({
      success: true,
      stats,
      routes,
    });
  } catch (err) {
    logger.error('Route cache fetch failed', { error: err.message });
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// POST /api/route-cache/refresh - Force refresh route cache
router.post('/route-cache/refresh', async (req, res) => {
  try {
    await routeCacheService.refreshCache();
    const stats = routeCacheService.getStats();
    const routes = routeCacheService.getAllCachedRoutes();

    res.json({
      success: true,
      message: 'Route cache refreshed',
      stats,
      routes,
    });
  } catch (err) {
    logger.error('Route cache refresh failed', { error: err.message });
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

module.exports = router;
