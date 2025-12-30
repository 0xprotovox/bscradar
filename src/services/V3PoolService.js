// src/services/V3PoolService.js
// FIXED VERSION - Properly calculates and returns V3 pool prices

const { ethers } = require('ethers');
const { getProviderService } = require('./ProviderService');
const { getTokenService } = require('./TokenService');
const { getCacheService } = require('../utils/Cache');
const { getLogger } = require('../utils/Logger');
const { 
  UNISWAP_V3_FACTORY_ABI, 
  UNISWAP_V3_POOL_ABI,
  UNISWAP_V3_QUOTER_V2_ABI
} = require('../config/abis');
const { 
  CONTRACTS, 
  FEE_TIERS,
  COMMON_BASE_PAIRS,
  LIQUIDITY_THRESHOLDS 
} = require('../config/constants');

class V3PoolService {
  constructor() {
    this.providerService = getProviderService();
    this.tokenService = getTokenService();
    this.cache = getCacheService();
    this.logger = getLogger();
  }

  async findAllPools(tokenAddress) {
    const pools = [];
    
    for (const baseToken of COMMON_BASE_PAIRS) {
      if (baseToken.toLowerCase() === tokenAddress.toLowerCase()) {
        continue;
      }

      for (const feeTier of FEE_TIERS.V3) {
        try {
          const poolAddress = await this.getPoolAddress(tokenAddress, baseToken, feeTier);
          if (poolAddress && poolAddress !== ethers.ZeroAddress) {
            const poolData = await this.getPoolData(poolAddress);
            if (poolData && poolData.liquidity.status === 'ACTIVE') {
              pools.push(poolData);
              this.logger.info(
                `Found V3 pool: ${poolData.token0.symbol}/${poolData.token1.symbol} (${feeTier/10000}%)`
              );
            }
          }
        } catch (error) {
          this.logger.debug(`No V3 pool for ${tokenAddress}/${baseToken} at ${feeTier} tier`);
        }
      }
    }

    return pools;
  }

  async getPoolAddress(tokenA, tokenB, fee) {
    return this.providerService.executeWithRetry(async (provider) => {
      const factory = new ethers.Contract(
        CONTRACTS.UNISWAP_V3_FACTORY,
        UNISWAP_V3_FACTORY_ABI,
        provider
      );
      
      return await factory.getPool(tokenA, tokenB, fee);
    });
  }

  async getPoolData(poolAddress) {
    try {
      // IMPORTANT: Don't use cache during price fix testing
      // Comment this out temporarily to force fresh data
      /*
      const cached = this.cache.getPoolData(`v3_${poolAddress}`);
      if (cached) {
        this.logger.debug(`Using cached data for pool ${poolAddress}`);
        return cached;
      }
      */

      const poolData = await this.providerService.executeWithRetry(async (provider) => {
        const pool = new ethers.Contract(poolAddress, UNISWAP_V3_POOL_ABI, provider);
        
        const [token0, token1, fee, liquidity, slot0] = await Promise.all([
          pool.token0(),
          pool.token1(),
          pool.fee(),
          pool.liquidity(),
          pool.slot0(),
        ]);

        // Get token info
        const [token0Info, token1Info] = await Promise.all([
          this.tokenService.getTokenInfo(token0),
          this.tokenService.getTokenInfo(token1),
        ]);

        // Parse slot0 data
        const sqrtPriceX96 = slot0[0];
        const tick = slot0[1];

        // CRITICAL: Calculate price correctly
        const priceData = this.calculateV3Price(
          sqrtPriceX96,
          token0Info.decimals,
          token1Info.decimals,
          token0Info.symbol,
          token1Info.symbol
        );

        // Log for verification
        this.logger.info(`✅ V3 Pool ${poolAddress} Price:`);
        this.logger.info(`   ${token0Info.symbol}/${token1Info.symbol}`);
        this.logger.info(`   sqrtPriceX96: ${sqrtPriceX96.toString()}`);
        this.logger.info(`   token0Price: ${priceData.token0Price.toFixed(6)}`);
        this.logger.info(`   token1Price: ${priceData.token1Price.toFixed(6)}`);
        this.logger.info(`   priceRatio: ${priceData.priceRatio.toFixed(6)}`);

        // ✅ FIX: Get ACTUAL token balances from pool (not calculated from liquidity!)
        const tokenAmounts = await this.getActualTokenBalances(
          poolAddress,
          token0,
          token1,
          token0Info.decimals,
          token1Info.decimals,
          provider
        );

        // Estimate liquidity value using ACTUAL balances and pool price
        const liquidityData = await this.estimateLiquidity(
          token0,
          token1,
          tokenAmounts.amount0,
          tokenAmounts.amount1,
          token0Info.decimals,
          token1Info.decimals,
          liquidity,
          priceData.token1Price // Price of token0 in terms of token1
        );

        const data = {
          address: poolAddress.toLowerCase(),
          type: 'V3',
          version: 3,
          token0: token0Info,
          token1: token1Info,
          fee: Number(fee),
          feePercent: Number(fee) / 10000,
          liquidity: {
            ...liquidityData,
            raw: liquidity.toString(),
          },
          tick: Number(tick),
          sqrtPriceX96: sqrtPriceX96.toString(),
          // ENSURE price is included with correct structure
          price: {
            token0Price: priceData.token0Price,
            token1Price: priceData.token1Price,
            priceRatio: priceData.priceRatio,
            raw: priceData.raw
          },
          token0Amount: tokenAmounts.amount0String,
          token1Amount: tokenAmounts.amount1String,
          lastUpdated: new Date().toISOString(),
        };

        // Cache the result (optional during testing)
        // this.cache.setPoolData(`v3_${poolAddress}`, data);
        
        return data;
      });

      return poolData;
    } catch (error) {
      this.logger.error(`Failed to get V3 pool data for ${poolAddress}`, error);
      return null;
    }
  }

  // FIXED: Correct V3 price calculation with proper BigInt precision
  calculateV3Price(sqrtPriceX96, decimals0, decimals1, symbol0, symbol1) {
    try {
      // Convert to BigInt for precision-safe calculations
      let sqrtPriceX96BigInt;
      if (typeof sqrtPriceX96 === 'bigint') {
        sqrtPriceX96BigInt = sqrtPriceX96;
      } else if (typeof sqrtPriceX96 === 'string') {
        sqrtPriceX96BigInt = BigInt(sqrtPriceX96);
      } else {
        sqrtPriceX96BigInt = BigInt(Math.floor(Number(sqrtPriceX96)));
      }

      // Validate
      if (sqrtPriceX96BigInt === 0n) {
        this.logger.error(`Invalid sqrtPriceX96 value: ${sqrtPriceX96}`);
        return {
          token0Price: 0,
          token1Price: 0,
          priceRatio: 0,
          raw: 0
        };
      }

      // Use BigInt arithmetic for precision, then convert to Number at the end
      // Q96 = 2^96
      const Q96 = 2n ** 96n;

      // Calculate price = (sqrtPriceX96 / Q96)^2
      // To maintain precision: price = sqrtPriceX96^2 / Q96^2
      // We scale up first to preserve precision, then scale down

      // For decimal adjustment, we need to handle the difference
      const decimalDiff = decimals0 - decimals1;

      // Use scaled calculation: multiply by 10^18 for precision, then divide
      const PRECISION = 10n ** 18n;

      // sqrtPrice^2 calculation with precision
      // price = (sqrtPriceX96^2 * PRECISION) / (Q96^2)
      const sqrtPriceSquared = sqrtPriceX96BigInt * sqrtPriceX96BigInt;
      const q96Squared = Q96 * Q96;

      // Apply decimal adjustment in BigInt domain
      let priceScaled;
      if (decimalDiff >= 0) {
        // decimals0 >= decimals1: multiply
        const decimalMultiplier = 10n ** BigInt(decimalDiff);
        priceScaled = (sqrtPriceSquared * PRECISION * decimalMultiplier) / q96Squared;
      } else {
        // decimals0 < decimals1: divide
        const decimalDivisor = 10n ** BigInt(-decimalDiff);
        priceScaled = (sqrtPriceSquared * PRECISION) / (q96Squared * decimalDivisor);
      }

      // Convert to Number (this is safe now as we've scaled appropriately)
      const price = Number(priceScaled) / Number(PRECISION);

      // price = how many token1 per 1 token0
      const token1Price = price;
      const token0Price = price > 0 ? (1 / price) : 0;

      // Debug logging
      this.logger.debug(`V3 Price Calc for ${symbol0}/${symbol1}:`);
      this.logger.debug(`  sqrtPriceX96: ${sqrtPriceX96BigInt.toString()}`);
      this.logger.debug(`  decimalDiff: ${decimalDiff}`);
      this.logger.debug(`  price: ${price.toExponential(6)}`);
      this.logger.debug(`  token0Price: ${token0Price.toExponential(6)}`);
      this.logger.debug(`  token1Price: ${token1Price.toExponential(6)}`);

      return {
        token0Price: token0Price,  // Price of token0 in terms of token1
        token1Price: token1Price,  // Price of token1 in terms of token0
        priceRatio: token1Price,   // Default ratio (token1 per token0)
        raw: price                 // Raw price value
      };
    } catch (error) {
      this.logger.error(`V3 price calculation error: ${error.message}`, error);
      return {
        token0Price: 0,
        token1Price: 0,
        priceRatio: 0,
        raw: 0
      };
    }
  }

  /**
   * ✅ FIX: Get ACTUAL token balances from pool contract
   * This is the correct way to calculate V3 pool TVL!
   */
  async getActualTokenBalances(poolAddress, token0, token1, decimals0, decimals1, provider) {
    try {
      // Create token contracts
      const token0Contract = new ethers.Contract(
        token0,
        ['function balanceOf(address) external view returns (uint256)'],
        provider
      );
      const token1Contract = new ethers.Contract(
        token1,
        ['function balanceOf(address) external view returns (uint256)'],
        provider
      );

      // Get ACTUAL balances held in the pool
      const [balance0, balance1] = await Promise.all([
        token0Contract.balanceOf(poolAddress),
        token1Contract.balanceOf(poolAddress),
      ]);

      this.logger.info(`✅ Actual pool balances for ${poolAddress}:`);
      this.logger.info(`   Token0: ${ethers.formatUnits(balance0, decimals0)}`);
      this.logger.info(`   Token1: ${ethers.formatUnits(balance1, decimals1)}`);

      return {
        amount0: balance0,
        amount1: balance1,
        amount0String: ethers.formatUnits(balance0, decimals0),
        amount1String: ethers.formatUnits(balance1, decimals1),
      };
    } catch (error) {
      this.logger.error(`Failed to get actual token balances for pool ${poolAddress}`, error);
      // Fallback to zeros if balance reading fails
      return {
        amount0: 0n,
        amount1: 0n,
        amount0String: '0',
        amount1String: '0',
      };
    }
  }

  calculateTokenAmounts(liquidity, sqrtPriceX96, tick, decimals0, decimals1) {
    // Simplified calculation - in production you'd calculate based on tick ranges
    if (liquidity === 0n) {
      return {
        amount0: 0n,
        amount1: 0n,
        amount0String: '0',
        amount1String: '0',
      };
    }

    const Q96 = 2n ** 96n;

    // Calculate approximate amounts from liquidity
    // These are approximations - actual amounts depend on position ranges
    // Formula: amount0 = L / sqrt(P), amount1 = L * sqrt(P)
    try {
      const amount0 = (liquidity * Q96) / sqrtPriceX96;
      const amount1 = (liquidity * sqrtPriceX96) / Q96;

      return {
        amount0,
        amount1,
        amount0String: ethers.formatUnits(amount0, decimals0),
        amount1String: ethers.formatUnits(amount1, decimals1),
      };
    } catch (error) {
      return {
        amount0: 0n,
        amount1: 0n,
        amount0String: '0',
        amount1String: '0',
      };
    }
  }

  /**
   * Estimate liquidity using DexScreener/DexTools method:
   * Total = (Token0 Balance × Token0 Price) + (Token1 Balance × Token1 Price)
   * Where unknown token price is derived from pool price ratio
   *
   * @param {string} token0 - Token0 address
   * @param {string} token1 - Token1 address
   * @param {bigint} amount0 - Token0 balance in pool
   * @param {bigint} amount1 - Token1 balance in pool
   * @param {number} decimals0
   * @param {number} decimals1
   * @param {bigint} rawLiquidity - Raw liquidity from pool
   * @param {number} poolPriceRatio - Price of token0 in terms of token1 (from sqrtPriceX96)
   */
  async estimateLiquidity(token0, token1, amount0, amount1, decimals0, decimals1, rawLiquidity, poolPriceRatio = null) {
    let totalValueBNB = 0;
    let totalValueUSD = 0;

    const { getPriceService } = require('./PriceService');
    const priceService = getPriceService();
    const bnbPrice = priceService?.bnbPriceUSD || 3600;

    // Try to use PriceService with pool price ratio for accurate calculation
    try {
      totalValueUSD = priceService.calculatePoolValueUSD(
        token0,
        token1,
        amount0,
        amount1,
        decimals0,
        decimals1,
        poolPriceRatio // Pass price ratio for accurate token0 valuation
      );
      totalValueBNB = bnbPrice > 0 ? totalValueUSD / bnbPrice : 0;
    } catch (error) {
      // Fallback to basic estimation using pool price
      const amount0Num = Number(ethers.formatUnits(amount0, decimals0));
      const amount1Num = Number(ethers.formatUnits(amount1, decimals1));
      const hasLiquidity = rawLiquidity && rawLiquidity > 0n;

      if (hasLiquidity && (amount0Num > 0 || amount1Num > 0)) {
        // Check if token1 is a known price token (WBNB, stablecoin)
        if (token1.toLowerCase() === CONTRACTS.WBNB.toLowerCase()) {
          // Token1 is WBNB - calculate token0 value using pool price
          const token1ValueBNB = amount1Num;
          const token0ValueBNB = poolPriceRatio ? amount0Num * poolPriceRatio : amount1Num; // Use price or mirror
          totalValueBNB = token0ValueBNB + token1ValueBNB;
          totalValueUSD = totalValueBNB * bnbPrice;
        } else if (token0.toLowerCase() === CONTRACTS.WBNB.toLowerCase()) {
          // Token0 is WBNB
          const token0ValueBNB = amount0Num;
          const token1ValueBNB = poolPriceRatio && poolPriceRatio > 0 ? amount1Num / poolPriceRatio : amount0Num;
          totalValueBNB = token0ValueBNB + token1ValueBNB;
          totalValueUSD = totalValueBNB * bnbPrice;
        } else if (this.tokenService.isStablecoin(token1)) {
          // Token1 is stablecoin (USDC, USDT, etc.)
          const token1ValueUSD = amount1Num;
          const token0ValueUSD = poolPriceRatio ? amount0Num * poolPriceRatio : amount1Num;
          totalValueUSD = token0ValueUSD + token1ValueUSD;
          totalValueBNB = bnbPrice > 0 ? totalValueUSD / bnbPrice : 0;
        } else if (this.tokenService.isStablecoin(token0)) {
          // Token0 is stablecoin
          const token0ValueUSD = amount0Num;
          const token1ValueUSD = poolPriceRatio && poolPriceRatio > 0 ? amount1Num / poolPriceRatio : amount0Num;
          totalValueUSD = token0ValueUSD + token1ValueUSD;
          totalValueBNB = bnbPrice > 0 ? totalValueUSD / bnbPrice : 0;
        } else {
          // Neither token has known price - use rough estimate
          totalValueUSD = Math.max(amount0Num, amount1Num) * 0.1;
          totalValueBNB = bnbPrice > 0 ? totalValueUSD / bnbPrice : 0;
        }
      }
    }

    // Determine status - STRICT: require minimum USD liquidity for ACTIVE status
    // This prevents dust/empty pools from being marked tradeable
    let status = 'LOW_LIQUIDITY';
    if (totalValueUSD >= LIQUIDITY_THRESHOLDS.MIN_LIQUIDITY_USD) {
      status = 'ACTIVE';
    } else if (totalValueUSD >= 100) {
      // Between $100-$1000: mark as WARNING but still tradeable for small amounts
      status = 'WARNING_LIQUIDITY';
    }
    // Note: Removed token count fallback - USD value is the only reliable metric

    return {
      totalValueBNB,
      totalValueUSD,
      token0Amount: ethers.formatUnits(amount0, decimals0),
      token1Amount: ethers.formatUnits(amount1, decimals1),
      status,
    };
  }

  async getQuote(tokenIn, tokenOut, amountIn, fee) {
    try {
      return await this.providerService.executeWithRetry(async (provider) => {
        const quoter = new ethers.Contract(
          CONTRACTS.UNISWAP_V3_QUOTER_V2,
          UNISWAP_V3_QUOTER_V2_ABI,
          provider
        );

        try {
          const result = await quoter.quoteExactInputSingle.staticCall(
            tokenIn,
            tokenOut,
            fee,
            amountIn,
            0 // sqrtPriceLimitX96
          );

          return {
            amountOut: result[0] || result.amountOut,
            sqrtPriceX96After: result[1] || result.sqrtPriceX96After,
            gasEstimate: result[3] || result.gasEstimate,
          };
        } catch (quoterError) {
          this.logger.debug(`Quoter failed: ${quoterError.message}`);
          return null;
        }
      });
    } catch (error) {
      this.logger.debug('V3 quote failed', error.message);
      return null;
    }
  }

  async simulateSwap(poolAddress, tokenIn, amountIn) {
    try {
      const poolData = await this.getPoolData(poolAddress);
      if (!poolData) {
        throw new Error('Pool not found');
      }

      const tokenOut = tokenIn.toLowerCase() === poolData.token0.address.toLowerCase()
        ? poolData.token1.address
        : poolData.token0.address;

      const quote = await this.getQuote(
        tokenIn,
        tokenOut,
        amountIn,
        poolData.fee
      );

      if (!quote) {
        this.logger.debug('Quote failed, using basic estimation');
        
        const isToken0In = tokenIn.toLowerCase() === poolData.token0.address.toLowerCase();
        const price = isToken0In ? poolData.price.token1Price : poolData.price.token0Price;
        const estimatedOut = BigInt(Math.floor(Number(amountIn) * price));
        
        return {
          amountIn: amountIn.toString(),
          amountOut: estimatedOut.toString(),
          priceImpact: 0,
          executionPrice: price,
          gasEstimate: '150000',
        };
      }

      // Calculate price impact
      const currentPrice = poolData.price.priceRatio;
      const executionPrice = Number(quote.amountOut) / Number(amountIn);
      const priceImpact = Math.abs((executionPrice - currentPrice) / currentPrice) * 100;

      return {
        amountIn: amountIn.toString(),
        amountOut: quote.amountOut.toString(),
        priceImpact,
        executionPrice,
        gasEstimate: quote.gasEstimate?.toString() || '150000',
      };
    } catch (error) {
      this.logger.error('Failed to simulate V3 swap', error);
      throw error;
    }
  }
}

// Singleton instance
let v3PoolServiceInstance = null;

module.exports = {
  getV3PoolService: () => {
    if (!v3PoolServiceInstance) {
      v3PoolServiceInstance = new V3PoolService();
    }
    return v3PoolServiceInstance;
  },
};