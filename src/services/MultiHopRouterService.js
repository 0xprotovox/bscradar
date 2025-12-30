// src/services/MultiHopRouterService.js
// Multi-hop route finding service for token-to-token swaps

const { ethers } = require('ethers');
const { getPoolAnalyzer } = require('./PoolAnalyzer');
const { getPriceService } = require('./PriceService');
const { getLogger } = require('../utils/Logger');

// Common intermediate tokens on BSC
const INTERMEDIATES = {
  WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  USDT: '0x55d398326f99059fF775485246999027B3197955',
  BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
  DAI: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3',
  CAKE: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
};

// Primary intermediates for 3-hop routing (most liquid)
const PRIMARY_INTERMEDIATES = ['WBNB', 'USDC', 'USDT'];

// Secondary intermediates that may need 3-hop (ecosystem tokens)
const SECONDARY_INTERMEDIATES = ['CAKE'];

// Normalize addresses for comparison
const normalizeAddress = (addr) => addr?.toLowerCase();

class MultiHopRouterService {
  constructor() {
    this.poolAnalyzer = getPoolAnalyzer();
    this.priceService = getPriceService();
    this.logger = getLogger();
  }

  /**
   * Find the best route between two tokens
   * @param {string} tokenIn - Input token address
   * @param {string} tokenOut - Output token address
   * @param {string} amountIn - Amount of tokenIn (in wei)
   * @returns {Object} Best route with legs and estimated output
   */
  async findBestRoute(tokenIn, tokenOut, amountIn) {
    const startTime = Date.now();
    tokenIn = ethers.getAddress(tokenIn);
    tokenOut = ethers.getAddress(tokenOut);

    this.logger.info(`🔍 Finding best route: ${tokenIn.slice(0,10)}... -> ${tokenOut.slice(0,10)}...`);

    // Check if either token is a common intermediate (direct swap possible)
    const isDirectSwap = this.isDirectSwapPossible(tokenIn, tokenOut);

    // Analyze both tokens in parallel
    const [tokenInAnalysis, tokenOutAnalysis] = await Promise.all([
      this.poolAnalyzer.analyzeToken(tokenIn).catch(err => {
        this.logger.warn(`Failed to analyze tokenIn: ${err.message}`);
        return null;
      }),
      this.poolAnalyzer.analyzeToken(tokenOut).catch(err => {
        this.logger.warn(`Failed to analyze tokenOut: ${err.message}`);
        return null;
      }),
    ]);

    if (!tokenInAnalysis || !tokenOutAnalysis) {
      throw new Error('Failed to analyze one or both tokens');
    }

    // Find common intermediates between the two tokens
    const routes = [];

    // Try each intermediate token
    for (const [name, intermediateAddr] of Object.entries(INTERMEDIATES)) {
      const route = await this.evaluateRoute(
        tokenIn,
        tokenOut,
        intermediateAddr,
        name,
        tokenInAnalysis,
        tokenOutAnalysis,
        amountIn
      );

      if (route) {
        routes.push(route);
      }
    }

    // Also check if direct swap is possible (tokens share a pool)
    const directRoute = await this.evaluateDirectRoute(
      tokenIn,
      tokenOut,
      tokenInAnalysis,
      tokenOutAnalysis,
      amountIn
    );

    if (directRoute) {
      routes.push(directRoute);
    }

    // If no good 2-hop routes found, try 3-hop routes through CAKE ecosystem
    // e.g., TOKEN → WBNB → CAKE → TOKEN2
    if (routes.length === 0 || (routes.length > 0 && routes[0].score < 50)) {
      this.logger.info('🔄 Trying 3-hop routes through secondary intermediates...');

      for (const primaryName of PRIMARY_INTERMEDIATES) {
        for (const secondaryName of SECONDARY_INTERMEDIATES) {
          const threeHopRoute = await this.evaluate3HopRoute(
            tokenIn,
            tokenOut,
            INTERMEDIATES[primaryName],
            primaryName,
            INTERMEDIATES[secondaryName],
            secondaryName,
            tokenInAnalysis,
            tokenOutAnalysis,
            amountIn
          );

          if (threeHopRoute) {
            routes.push(threeHopRoute);
          }
        }
      }
    }

    if (routes.length === 0) {
      throw new Error('No valid route found between tokens');
    }

    // Sort routes by SCORE (highest first) - score considers liquidity, fees, and directness
    // Score is more reliable than estimatedOutput which uses simplified math
    routes.sort((a, b) => {
      const aScore = a.score || 0;
      const bScore = b.score || 0;
      return bScore - aScore;
    });

    const bestRoute = routes[0];
    const elapsed = Date.now() - startTime;

    this.logger.info(`✅ Best route found in ${elapsed}ms: ${bestRoute.path.map(t => t.symbol).join(' → ')}`);
    this.logger.info(`   Estimated output: ${bestRoute.estimatedOutput} ${bestRoute.path[bestRoute.path.length - 1].symbol}`);
    this.logger.info(`   Price impact: ${bestRoute.priceImpact}%`);

    return {
      bestRoute,
      alternativeRoutes: routes.slice(1, 4), // Top 3 alternatives
      timing: {
        totalMs: elapsed,
        routesEvaluated: routes.length,
      },
    };
  }

  /**
   * Evaluate a 2-leg route through an intermediate token
   */
  async evaluateRoute(tokenIn, tokenOut, intermediate, intermediateName, tokenInAnalysis, tokenOutAnalysis, amountIn) {
    const normalizedIntermediate = normalizeAddress(intermediate);
    const normalizedTokenIn = normalizeAddress(tokenIn);
    const normalizedTokenOut = normalizeAddress(tokenOut);

    // Skip if tokenIn or tokenOut IS the intermediate
    if (normalizedTokenIn === normalizedIntermediate || normalizedTokenOut === normalizedIntermediate) {
      return null;
    }

    // Find leg 1: tokenIn -> intermediate
    const leg1Pool = this.findBestPoolForPair(tokenInAnalysis.pools, intermediate);
    if (!leg1Pool) {
      this.logger.debug(`No pool found for ${tokenInAnalysis.token.symbol} -> ${intermediateName}`);
      return null;
    }

    // Find leg 2: intermediate -> tokenOut
    const leg2Pool = this.findBestPoolForPair(tokenOutAnalysis.pools, intermediate);
    if (!leg2Pool) {
      this.logger.debug(`No pool found for ${intermediateName} -> ${tokenOutAnalysis.token.symbol}`);
      return null;
    }

    // Calculate estimated output through both legs
    const leg1Output = this.estimateSwapOutput(leg1Pool, amountIn, true);
    const leg2Output = this.estimateSwapOutput(leg2Pool, leg1Output.amountOut, false);

    // Calculate total price impact
    const totalPriceImpact = (leg1Output.priceImpact || 0) + (leg2Output.priceImpact || 0);

    return {
      type: 'multi-hop',
      path: [
        { address: tokenIn, symbol: tokenInAnalysis.token.symbol, decimals: tokenInAnalysis.token.decimals },
        { address: intermediate, symbol: intermediateName, decimals: this.getIntermediateDecimals(intermediateName) },
        { address: tokenOut, symbol: tokenOutAnalysis.token.symbol, decimals: tokenOutAnalysis.token.decimals },
      ],
      legs: [
        {
          tokenIn: tokenIn,
          tokenOut: intermediate,
          pool: {
            address: leg1Pool.address,
            protocol: leg1Pool.protocol,
            type: leg1Pool.type,
            fee: leg1Pool.fee,
            tickSpacing: leg1Pool.tickSpacing,
            liquidity: leg1Pool.liquidity,
          },
          estimatedOutput: leg1Output.amountOut,
          priceImpact: leg1Output.priceImpact,
        },
        {
          tokenIn: intermediate,
          tokenOut: tokenOut,
          pool: {
            address: leg2Pool.address,
            protocol: leg2Pool.protocol,
            type: leg2Pool.type,
            fee: leg2Pool.fee,
            tickSpacing: leg2Pool.tickSpacing,
            liquidity: leg2Pool.liquidity,
          },
          estimatedOutput: leg2Output.amountOut,
          priceImpact: leg2Output.priceImpact,
        },
      ],
      estimatedOutput: leg2Output.amountOut,
      estimatedOutputFormatted: ethers.formatUnits(
        BigInt(Math.floor(parseFloat(leg2Output.amountOut))),
        tokenOutAnalysis.token.decimals
      ),
      priceImpact: totalPriceImpact.toFixed(4),
      intermediateToken: {
        address: intermediate,
        symbol: intermediateName,
      },
      totalFees: leg1Pool.fee + leg2Pool.fee,
      score: this.calculateRouteScore(leg1Pool, leg2Pool, totalPriceImpact),
    };
  }

  /**
   * Evaluate a 3-leg route: tokenIn → primary → secondary → tokenOut
   * Used for ecosystem tokens like CAKE that connect to other ecosystem tokens
   * e.g., TOKEN → WBNB → CAKE → TOKEN2
   */
  async evaluate3HopRoute(tokenIn, tokenOut, primaryIntermediate, primaryName, secondaryIntermediate, secondaryName, tokenInAnalysis, tokenOutAnalysis, amountIn) {
    const normalizedPrimary = normalizeAddress(primaryIntermediate);
    const normalizedSecondary = normalizeAddress(secondaryIntermediate);
    const normalizedTokenIn = normalizeAddress(tokenIn);
    const normalizedTokenOut = normalizeAddress(tokenOut);

    // Skip if any token IS the intermediate
    if (normalizedTokenIn === normalizedPrimary || normalizedTokenIn === normalizedSecondary ||
        normalizedTokenOut === normalizedPrimary || normalizedTokenOut === normalizedSecondary ||
        normalizedPrimary === normalizedSecondary) {
      return null;
    }

    try {
      // Leg 1: tokenIn → primaryIntermediate (e.g., TOKEN → WBNB)
      const leg1Pool = this.findBestPoolForPair(tokenInAnalysis.pools, primaryIntermediate);
      if (!leg1Pool) {
        this.logger.debug(`3-hop: No pool for ${tokenInAnalysis.token.symbol} → ${primaryName}`);
        return null;
      }

      // Get secondary token analysis for leg 2
      const secondaryAnalysis = await this.poolAnalyzer.analyzeToken(secondaryIntermediate).catch(() => null);
      if (!secondaryAnalysis) {
        this.logger.debug(`3-hop: Failed to analyze ${secondaryName}`);
        return null;
      }

      // Leg 2: primaryIntermediate → secondaryIntermediate (e.g., WBNB → CAKE)
      const leg2Pool = this.findBestPoolForPair(secondaryAnalysis.pools, primaryIntermediate);
      if (!leg2Pool) {
        this.logger.debug(`3-hop: No pool for ${primaryName} → ${secondaryName}`);
        return null;
      }

      // Leg 3: secondaryIntermediate → tokenOut (e.g., CAKE → TOKEN2)
      const leg3Pool = this.findBestPoolForPair(tokenOutAnalysis.pools, secondaryIntermediate);
      if (!leg3Pool) {
        this.logger.debug(`3-hop: No pool for ${secondaryName} → ${tokenOutAnalysis.token.symbol}`);
        return null;
      }

      // Calculate outputs through all legs
      const leg1Output = this.estimateSwapOutput(leg1Pool, amountIn, true);
      const leg2Output = this.estimateSwapOutput(leg2Pool, leg1Output.amountOut, false);
      const leg3Output = this.estimateSwapOutput(leg3Pool, leg2Output.amountOut, false);

      // Calculate total price impact
      const totalPriceImpact = (leg1Output.priceImpact || 0) + (leg2Output.priceImpact || 0) + (leg3Output.priceImpact || 0);

      this.logger.info(`🔗 3-hop route found: ${tokenInAnalysis.token.symbol} → ${primaryName} → ${secondaryName} → ${tokenOutAnalysis.token.symbol}`);

      return {
        type: '3-hop',
        path: [
          { address: tokenIn, symbol: tokenInAnalysis.token.symbol, decimals: tokenInAnalysis.token.decimals },
          { address: primaryIntermediate, symbol: primaryName, decimals: this.getIntermediateDecimals(primaryName) },
          { address: secondaryIntermediate, symbol: secondaryName, decimals: this.getIntermediateDecimals(secondaryName) },
          { address: tokenOut, symbol: tokenOutAnalysis.token.symbol, decimals: tokenOutAnalysis.token.decimals },
        ],
        legs: [
          {
            tokenIn: tokenIn,
            tokenOut: primaryIntermediate,
            pool: {
              address: leg1Pool.address,
              protocol: leg1Pool.protocol,
              type: leg1Pool.type,
              fee: leg1Pool.fee,
              tickSpacing: leg1Pool.tickSpacing,
              liquidity: leg1Pool.liquidity,
            },
            estimatedOutput: leg1Output.amountOut,
            priceImpact: leg1Output.priceImpact,
          },
          {
            tokenIn: primaryIntermediate,
            tokenOut: secondaryIntermediate,
            pool: {
              address: leg2Pool.address,
              protocol: leg2Pool.protocol,
              type: leg2Pool.type,
              fee: leg2Pool.fee,
              tickSpacing: leg2Pool.tickSpacing,
              liquidity: leg2Pool.liquidity,
            },
            estimatedOutput: leg2Output.amountOut,
            priceImpact: leg2Output.priceImpact,
          },
          {
            tokenIn: secondaryIntermediate,
            tokenOut: tokenOut,
            pool: {
              address: leg3Pool.address,
              protocol: leg3Pool.protocol,
              type: leg3Pool.type,
              fee: leg3Pool.fee,
              tickSpacing: leg3Pool.tickSpacing,
              liquidity: leg3Pool.liquidity,
            },
            estimatedOutput: leg3Output.amountOut,
            priceImpact: leg3Output.priceImpact,
          },
        ],
        estimatedOutput: leg3Output.amountOut,
        estimatedOutputFormatted: ethers.formatUnits(
          BigInt(Math.floor(parseFloat(leg3Output.amountOut))),
          tokenOutAnalysis.token.decimals
        ),
        priceImpact: totalPriceImpact.toFixed(4),
        intermediateTokens: [
          { address: primaryIntermediate, symbol: primaryName },
          { address: secondaryIntermediate, symbol: secondaryName },
        ],
        totalFees: leg1Pool.fee + leg2Pool.fee + leg3Pool.fee,
        score: this.calculate3HopRouteScore(leg1Pool, leg2Pool, leg3Pool, totalPriceImpact),
      };
    } catch (err) {
      this.logger.debug(`3-hop route evaluation failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Calculate score for 3-hop routes (penalized compared to 2-hop)
   */
  calculate3HopRouteScore(leg1Pool, leg2Pool, leg3Pool, priceImpact) {
    let score = 70; // Start lower than 2-hop routes

    // Minimum liquidity across all legs
    const minLiquidity = Math.min(
      leg1Pool.liquidity?.usd || 0,
      leg2Pool.liquidity?.usd || 0,
      leg3Pool.liquidity?.usd || 0
    );

    if (minLiquidity >= 100000) score += 25;
    else if (minLiquidity >= 50000) score += 15;
    else if (minLiquidity >= 10000) score += 5;

    // Fee score (3 legs means more fees)
    const totalFee = (leg1Pool.fee || 3000) + (leg2Pool.fee || 3000) + (leg3Pool.fee || 3000);
    if (totalFee <= 1000) score += 15;
    else if (totalFee <= 6000) score += 10;
    else if (totalFee <= 10000) score += 5;

    // Price impact penalty (higher for 3-hop)
    score -= priceImpact * 7;

    return Math.max(0, score);
  }

  /**
   * Evaluate direct route (if tokens share a common pool)
   */
  async evaluateDirectRoute(tokenIn, tokenOut, tokenInAnalysis, tokenOutAnalysis, amountIn) {
    // Find ALL pools between tokenIn and tokenOut, then pick the best one
    const directPools = tokenInAnalysis.pools.filter(pool =>
      normalizeAddress(pool.pairToken?.address) === normalizeAddress(tokenOut) &&
      pool.liquidity?.status === 'ACTIVE'
    );

    if (directPools.length === 0) {
      return null;
    }

    // Sort by liquidity (highest first), then by fee (lowest first)
    directPools.sort((a, b) => {
      const liquidityDiff = (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0);
      if (Math.abs(liquidityDiff) > 1000) return liquidityDiff;
      return (a.fee || 10000) - (b.fee || 10000);
    });

    const directPool = directPools[0];
    this.logger.info(`📍 Direct pool found: ${tokenInAnalysis.token.symbol} → ${tokenOutAnalysis.token.symbol} via ${directPool.protocol} ${directPool.type} (Liq: $${(directPool.liquidity?.usd || 0).toFixed(0)})`);

    const output = this.estimateSwapOutput(directPool, amountIn, true);

    return {
      type: 'direct',
      path: [
        { address: tokenIn, symbol: tokenInAnalysis.token.symbol, decimals: tokenInAnalysis.token.decimals },
        { address: tokenOut, symbol: tokenOutAnalysis.token.symbol, decimals: tokenOutAnalysis.token.decimals },
      ],
      legs: [
        {
          tokenIn: tokenIn,
          tokenOut: tokenOut,
          pool: {
            address: directPool.address,
            protocol: directPool.protocol,
            type: directPool.type,
            fee: directPool.fee,
            tickSpacing: directPool.tickSpacing,
            liquidity: directPool.liquidity,
          },
          estimatedOutput: output.amountOut,
          priceImpact: output.priceImpact,
        },
      ],
      estimatedOutput: output.amountOut,
      estimatedOutputFormatted: ethers.formatUnits(
        BigInt(Math.floor(parseFloat(output.amountOut))),
        tokenOutAnalysis.token.decimals
      ),
      priceImpact: (output.priceImpact || 0).toFixed(4),
      totalFees: directPool.fee,
      score: this.calculateRouteScore(directPool, null, output.priceImpact || 0),
    };
  }

  /**
   * Find the best pool for swapping with a specific pair token
   */
  findBestPoolForPair(pools, pairTokenAddress) {
    const normalizedPair = normalizeAddress(pairTokenAddress);

    // Filter pools that match the pair token
    const matchingPools = pools.filter(pool =>
      normalizeAddress(pool.pairToken?.address) === normalizedPair &&
      pool.liquidity?.status === 'ACTIVE'
    );

    if (matchingPools.length === 0) {
      return null;
    }

    // Sort by liquidity (highest first), then by fee (lowest first)
    matchingPools.sort((a, b) => {
      const liquidityDiff = (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0);
      if (Math.abs(liquidityDiff) > 1000) return liquidityDiff;
      return (a.fee || 10000) - (b.fee || 10000);
    });

    return matchingPools[0];
  }

  /**
   * Estimate swap output amount (simplified calculation)
   */
  estimateSwapOutput(pool, amountIn, isTokenInFirst) {
    const amountInNum = typeof amountIn === 'string' ? parseFloat(amountIn) : amountIn;

    // Get pool liquidity
    const liquidityUSD = pool.liquidity?.usd || 0;

    // Simple price impact estimation based on swap size vs liquidity
    // This is a simplified model - real implementation should use pool math
    const swapValueUSD = amountInNum * (pool.price?.usd || 0) / 1e18; // Assuming 18 decimals
    const priceImpact = liquidityUSD > 0 ? (swapValueUSD / liquidityUSD) * 100 : 10;

    // Calculate output based on price ratio and fee
    const feePercent = (pool.fee || 3000) / 1000000; // Convert basis points
    const priceRatio = pool.price?.ratio || 1;

    // Adjust for which direction we're swapping
    const effectivePrice = isTokenInFirst ? priceRatio : (1 / priceRatio);

    // Output = input * price * (1 - fee) * (1 - priceImpact)
    const amountOut = amountInNum * effectivePrice * (1 - feePercent) * (1 - priceImpact / 100);

    return {
      amountOut: amountOut.toString(),
      priceImpact: Math.min(priceImpact, 50), // Cap at 50%
    };
  }

  /**
   * Calculate route score for ranking
   */
  calculateRouteScore(leg1Pool, leg2Pool, priceImpact) {
    let score = 100;

    // Liquidity score (higher is better) - with tiered bonuses
    const minLiquidity = leg2Pool
      ? Math.min(leg1Pool.liquidity?.usd || 0, leg2Pool.liquidity?.usd || 0)
      : (leg1Pool.liquidity?.usd || 0);

    if (minLiquidity >= 10000000) score += 50;       // $10M+ = big bonus
    else if (minLiquidity >= 1000000) score += 40;   // $1M+
    else if (minLiquidity >= 100000) score += 30;    // $100K+
    else if (minLiquidity >= 50000) score += 20;
    else if (minLiquidity >= 10000) score += 10;

    // Fee score (lower is better)
    const totalFee = (leg1Pool.fee || 3000) + (leg2Pool?.fee || 0);
    if (totalFee <= 500) score += 20;
    else if (totalFee <= 3000) score += 10;
    else if (totalFee <= 10000) score += 5;

    // Price impact penalty
    score -= priceImpact * 5;

    // Direct route bonus - SIGNIFICANT bonus for direct swaps
    // Direct swaps are faster, cheaper (1 fee vs 2), and have less slippage
    if (!leg2Pool) score += 40;

    return Math.max(0, score);
  }

  /**
   * Check if direct swap is possible (one token is a common base)
   */
  isDirectSwapPossible(tokenIn, tokenOut) {
    const intermediateAddresses = Object.values(INTERMEDIATES).map(normalizeAddress);
    return intermediateAddresses.includes(normalizeAddress(tokenIn)) ||
           intermediateAddresses.includes(normalizeAddress(tokenOut));
  }

  /**
   * Get decimals for intermediate tokens
   */
  getIntermediateDecimals(symbol) {
    const decimals = {
      WBNB: 18,
      USDC: 18, // BSC USDC is 18 decimals
      USDT: 18, // BSC USDT is 18 decimals
      BUSD: 18,
      DAI: 18,
      CAKE: 18,
    };
    return decimals[symbol] || 18;
  }
}

// Singleton instance
let instance = null;

function getMultiHopRouterService() {
  if (!instance) {
    instance = new MultiHopRouterService();
  }
  return instance;
}

module.exports = {
  MultiHopRouterService,
  getMultiHopRouterService,
  INTERMEDIATES,
  PRIMARY_INTERMEDIATES,
  SECONDARY_INTERMEDIATES,
};
