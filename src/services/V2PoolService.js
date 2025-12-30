// src/services/V2PoolService.js

const { ethers } = require('ethers');
const { getProviderService } = require('./ProviderService');
const { getTokenService } = require('./TokenService');
const { getCacheService } = require('../utils/Cache');
const { getLogger } = require('../utils/Logger');
const {
  PANCAKESWAP_V2_FACTORY_ABI,
  PANCAKESWAP_V2_PAIR_ABI
} = require('../config/abis');
const { 
  CONTRACTS, 
  COMMON_BASE_PAIRS,
  LIQUIDITY_THRESHOLDS 
} = require('../config/constants');

class V2PoolService {
  constructor() {
    this.providerService = getProviderService();
    this.tokenService = getTokenService();
    this.cache = getCacheService();
    this.logger = getLogger();
  }

  async findAllPools(tokenAddress) {
    const pools = [];
    
    // Check against common base pairs
    for (const baseToken of COMMON_BASE_PAIRS) {
      if (baseToken.toLowerCase() === tokenAddress.toLowerCase()) {
        continue; // Skip if checking token against itself
      }

      try {
        const poolAddress = await this.getPairAddress(tokenAddress, baseToken);
        if (poolAddress && poolAddress !== ethers.ZeroAddress) {
          const poolData = await this.getPoolData(poolAddress);
          if (poolData) {
            pools.push(poolData);
            this.logger.info(`Found V2 pool: ${poolData.token0.symbol}/${poolData.token1.symbol}`);
          }
        }
      } catch (error) {
        this.logger.debug(`No V2 pool for ${tokenAddress} with ${baseToken}`);
      }
    }

    return pools;
  }

  async getPairAddress(tokenA, tokenB) {
    return this.providerService.executeWithRetry(async (provider) => {
      const factory = new ethers.Contract(
        CONTRACTS.PANCAKESWAP_V2_FACTORY,
        PANCAKESWAP_V2_FACTORY_ABI,
        provider
      );
      
      return await factory.getPair(tokenA, tokenB);
    });
  }

  async getPoolData(poolAddress) {
    try {
      // Check cache
      const cached = this.cache.getPoolData(`v2_${poolAddress}`);
      if (cached) {
        return cached;
      }

      const poolData = await this.providerService.executeWithRetry(async (provider) => {
        const pair = new ethers.Contract(poolAddress, PANCAKESWAP_V2_PAIR_ABI, provider);
        
        const [token0, token1, reserves, totalSupply] = await Promise.all([
          pair.token0(),
          pair.token1(),
          pair.getReserves(),
          pair.totalSupply(),
        ]);

        // Get token info
        const [token0Info, token1Info] = await Promise.all([
          this.tokenService.getTokenInfo(token0),
          this.tokenService.getTokenInfo(token1),
        ]);

        // Calculate liquidity
        const reserve0 = reserves[0];
        const reserve1 = reserves[1];
        
        // Format reserves
        const token0Amount = ethers.formatUnits(reserve0, token0Info.decimals);
        const token1Amount = ethers.formatUnits(reserve1, token1Info.decimals);

        // Calculate prices
        const priceData = this.calculateV2Price(
          reserve0,
          reserve1,
          token0Info.decimals,
          token1Info.decimals
        );

        // Estimate liquidity in USD/BNB (simplified)
        const liquidityData = await this.estimateLiquidity(
          token0,
          token1,
          reserve0,
          reserve1,
          token0Info.decimals,
          token1Info.decimals
        );

        const data = {
          address: poolAddress.toLowerCase(),
          type: 'V2',
          version: 2,
          token0: token0Info,
          token1: token1Info,
          reserves: {
            reserve0: reserve0.toString(),
            reserve1: reserve1.toString(),
          },
          token0Amount,
          token1Amount,
          totalSupply: totalSupply.toString(),
          price: priceData,
          liquidity: liquidityData,
          fee: 0.003, // 0.3% fixed for V2
          lastUpdated: new Date().toISOString(),
        };

        // Cache the result
        this.cache.setPoolData(`v2_${poolAddress}`, data);
        
        return data;
      });

      return poolData;
    } catch (error) {
      this.logger.error(`Failed to get V2 pool data for ${poolAddress}`, error);
      return null;
    }
  }

  calculateV2Price(reserve0, reserve1, decimals0, decimals1) {
    // Convert to BigInt if not already
    const reserve0BigInt = typeof reserve0 === 'bigint' ? reserve0 : BigInt(reserve0.toString());
    const reserve1BigInt = typeof reserve1 === 'bigint' ? reserve1 : BigInt(reserve1.toString());

    if (reserve0BigInt === 0n || reserve1BigInt === 0n) {
      return {
        token0Price: 0,
        token1Price: 0,
        priceRatio: 0,
      };
    }

    // Use BigInt arithmetic for precision, then convert at the end
    // Price = reserve1 / reserve0 * 10^(decimals0 - decimals1)
    // For precision: multiply by 10^18 first, then divide

    const PRECISION = 10n ** 18n;
    const decimalDiff = decimals0 - decimals1;

    // Calculate price0In1 = reserve1 / reserve0 * 10^(decimals0 - decimals1)
    // Scaled: (reserve1 * PRECISION * 10^decimalDiff) / reserve0
    let price0In1Scaled;
    let price1In0Scaled;

    if (decimalDiff >= 0) {
      const decimalMultiplier = 10n ** BigInt(decimalDiff);
      price0In1Scaled = (reserve1BigInt * PRECISION * decimalMultiplier) / reserve0BigInt;
      price1In0Scaled = (reserve0BigInt * PRECISION) / (reserve1BigInt * decimalMultiplier);
    } else {
      const decimalDivisor = 10n ** BigInt(-decimalDiff);
      price0In1Scaled = (reserve1BigInt * PRECISION) / (reserve0BigInt * decimalDivisor);
      price1In0Scaled = (reserve0BigInt * PRECISION * decimalDivisor) / reserve1BigInt;
    }

    // Convert to Number (safe now as we've scaled appropriately)
    const price0In1 = Number(price0In1Scaled) / Number(PRECISION);
    const price1In0 = Number(price1In0Scaled) / Number(PRECISION);

    return {
      token0Price: price0In1,  // Price of token0 in terms of token1
      token1Price: price1In0,  // Price of token1 in terms of token0
      priceRatio: price0In1,   // Default ratio
    };
  }

/**
 * Estimate liquidity using DexScreener/DexTools method for V2 pools
 * For V2, reserve ratio = price ratio, so we calculate directly
 */
async estimateLiquidity(token0, token1, reserve0, reserve1, decimals0, decimals1) {
  let totalValueBNB = 0;
  let totalValueUSD = 0;

  const { getPriceService } = require('./PriceService');
  const priceService = getPriceService();
  const bnbPrice = priceService?.bnbPriceUSD || 3600;

  // For V2, the price ratio IS the reserve ratio
  const amount0 = Number(ethers.formatUnits(reserve0, decimals0));
  const amount1 = Number(ethers.formatUnits(reserve1, decimals1));
  const poolPriceRatio = amount0 > 0 ? amount1 / amount0 : 0; // token0 price in token1

  // Try to use PriceService with pool price ratio
  try {
    totalValueUSD = priceService.calculatePoolValueUSD(
      token0,
      token1,
      reserve0,
      reserve1,
      decimals0,
      decimals1,
      poolPriceRatio // Pass the derived price ratio
    );
    totalValueBNB = bnbPrice > 0 ? totalValueUSD / bnbPrice : 0;
  } catch (error) {
    // Fallback: manually calculate based on known tokens
    const basePrices = priceService?.basePrices || {};
    const token0Price = basePrices[token0.toLowerCase()] || 0;
    const token1Price = basePrices[token1.toLowerCase()] || 0;

    if (token0Price > 0 && token1Price > 0) {
      // Both have known prices
      totalValueUSD = (amount0 * token0Price) + (amount1 * token1Price);
    } else if (token0Price > 0) {
      // Token0 has price (e.g., CAKE, WBNB)
      const token0Value = amount0 * token0Price;
      const derivedToken1Price = amount1 > 0 ? (amount0 / amount1) * token0Price : 0;
      const token1Value = amount1 * derivedToken1Price;
      totalValueUSD = token0Value + token1Value;
    } else if (token1Price > 0) {
      // Token1 has price
      const token1Value = amount1 * token1Price;
      const derivedToken0Price = amount0 > 0 ? (amount1 / amount0) * token1Price : 0;
      const token0Value = amount0 * derivedToken0Price;
      totalValueUSD = token0Value + token1Value;
    } else if (token0.toLowerCase() === CONTRACTS.WBNB.toLowerCase()) {
      totalValueBNB = amount0 * 2;
      totalValueUSD = totalValueBNB * bnbPrice;
    } else if (token1.toLowerCase() === CONTRACTS.WBNB.toLowerCase()) {
      totalValueBNB = amount1 * 2;
      totalValueUSD = totalValueBNB * bnbPrice;
    } else if (this.tokenService.isStablecoin(token0)) {
      totalValueUSD = amount0 * 2;
    } else if (this.tokenService.isStablecoin(token1)) {
      totalValueUSD = amount1 * 2;
    }
    totalValueBNB = bnbPrice > 0 ? totalValueUSD / bnbPrice : 0;
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
    token0Amount: ethers.formatUnits(reserve0, decimals0),
    token1Amount: ethers.formatUnits(reserve1, decimals1),
    status,
    raw: reserve0.toString(),
  };
}

  async getAmountOut(amountIn, reserveIn, reserveOut) {
    // PancakeSwap V2 formula (Uniswap V2 compatible)
    const amountInWithFee = amountIn * 997n;
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn * 1000n + amountInWithFee;
    return numerator / denominator;
  }

  async simulateSwap(poolAddress, tokenIn, amountIn) {
    try {
      const poolData = await this.getPoolData(poolAddress);
      if (!poolData) {
        throw new Error('Pool not found');
      }

      const isToken0In = tokenIn.toLowerCase() === poolData.token0.address.toLowerCase();
      const reserveIn = isToken0In 
        ? BigInt(poolData.reserves.reserve0)
        : BigInt(poolData.reserves.reserve1);
      const reserveOut = isToken0In
        ? BigInt(poolData.reserves.reserve1)
        : BigInt(poolData.reserves.reserve0);

      const amountInBN = BigInt(amountIn);
      const amountOut = await this.getAmountOut(amountInBN, reserveIn, reserveOut);

      // Calculate price impact
      const priceImpact = this.calculatePriceImpact(
        amountInBN,
        amountOut,
        reserveIn,
        reserveOut
      );

      return {
        amountIn: amountIn.toString(),
        amountOut: amountOut.toString(),
        priceImpact,
        executionPrice: Number(amountOut) / Number(amountInBN),
      };
    } catch (error) {
      this.logger.error(`Failed to simulate V2 swap`, error);
      throw error;
    }
  }

  calculatePriceImpact(amountIn, amountOut, reserveIn, reserveOut) {
    const exactQuote = (Number(amountIn) * Number(reserveOut)) / Number(reserveIn);
    const priceImpact = ((exactQuote - Number(amountOut)) / exactQuote) * 100;
    return Math.max(0, priceImpact);
  }
}

// Singleton instance
let v2PoolServiceInstance = null;

module.exports = {
  getV2PoolService: () => {
    if (!v2PoolServiceInstance) {
      v2PoolServiceInstance = new V2PoolService();
    }
    return v2PoolServiceInstance;
  },
};
