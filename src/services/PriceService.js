// src/services/PriceService.js - BSC Price Oracle
// BscRadar - Real-time price fetching for BSC tokens

const { ethers } = require('ethers');
const { getLogger } = require('../utils/Logger');
const { CONTRACTS, DEFAULT_PRICES, KNOWN_TOKEN_PRICES } = require('../config/constants');

class PriceService {
  constructor() {
    this.logger = getLogger();

    // Base prices in USD (stablecoins and known tokens)
    this.basePrices = {
      // Major assets - use constants
      [CONTRACTS.WBNB.toLowerCase()]: DEFAULT_PRICES.BNB,
      // Stablecoins - always $1
      [CONTRACTS.USDC.toLowerCase()]: 1.00,
      [CONTRACTS.BUSD.toLowerCase()]: 1.00,
      [CONTRACTS.DAI.toLowerCase()]: 1.00,
      [CONTRACTS.USDT.toLowerCase()]: 1.00,
      // CAKE token (approximate price)
      [CONTRACTS.CAKE.toLowerCase()]: 2.50,
    };

    // BNB price in USD - will be fetched dynamically
    this.bnbPriceUSD = DEFAULT_PRICES.BNB;
    this.lastPriceUpdate = Date.now();
    this.priceUpdateInterval = 60000;
    this.fetchLock = false; // CRITICAL FIX: Prevents concurrent price fetches // Update every 60 seconds
    this.providerService = null; // Will be set lazily to avoid circular dependency
  }

  // Get current BNB price
  getBNBPrice() {
    return this.bnbPriceUSD;
  }

  /**
   * Check if prices are stale and need refresh
   * Returns true if prices are older than 30 seconds
   */
  arePricesStale() {
    const STALE_THRESHOLD = 30000; // 30 seconds
    return Date.now() - this.lastPriceUpdate > STALE_THRESHOLD;
  }

  /**
   * Calculate price from sqrtPriceX96 using BigInt for precision
   * @param {bigint|string} sqrtPriceX96 - The sqrtPriceX96 value from slot0
   * @param {number} decimals0 - Decimals of token0
   * @param {number} decimals1 - Decimals of token1
   * @returns {number} Price of token0 in terms of token1
   */
  calculateSqrtPriceToPrice(sqrtPriceX96, decimals0, decimals1) {
    try {
      // Convert to BigInt
      const sqrtPriceX96BigInt = typeof sqrtPriceX96 === 'bigint'
        ? sqrtPriceX96
        : BigInt(sqrtPriceX96.toString());

      if (sqrtPriceX96BigInt === 0n) {
        return 0;
      }

      // Q96 = 2^96
      const Q96 = 2n ** 96n;
      const PRECISION = 10n ** 18n;

      // Calculate price = (sqrtPriceX96 / Q96)^2
      const sqrtPriceSquared = sqrtPriceX96BigInt * sqrtPriceX96BigInt;
      const q96Squared = Q96 * Q96;

      // Apply decimal adjustment
      const decimalDiff = decimals0 - decimals1;
      let priceScaled;

      if (decimalDiff >= 0) {
        const decimalMultiplier = 10n ** BigInt(decimalDiff);
        priceScaled = (sqrtPriceSquared * PRECISION * decimalMultiplier) / q96Squared;
      } else {
        const decimalDivisor = 10n ** BigInt(-decimalDiff);
        priceScaled = (sqrtPriceSquared * PRECISION) / (q96Squared * decimalDivisor);
      }

      return Number(priceScaled) / Number(PRECISION);
    } catch (error) {
      this.logger.error(`Failed to calculate price from sqrtPriceX96: ${error.message}`);
      return 0;
    }
  }

  // Lazy load provider service to avoid circular dependency
  getProviderService() {
    if (!this.providerService) {
      const { getProviderService } = require('./ProviderService');
      this.providerService = getProviderService();
    }
    return this.providerService;
  }

  // Fetch real-time token prices from chain
  async fetchTokenPricesFromChain() {
    try {
      const now = Date.now();
      // Only fetch if price is older than update interval
      if (now - this.lastPriceUpdate < this.priceUpdateInterval) {
        return { bnb: this.bnbPriceUSD, cake: this.basePrices[CONTRACTS.CAKE.toLowerCase()] };
      }

      // Prevent concurrent price fetches
      if (this.fetchLock) {
        return { bnb: this.bnbPriceUSD, cake: this.basePrices[CONTRACTS.CAKE.toLowerCase()] };
      }
      this.fetchLock = true;

      this.logger.info('Fetching real-time prices from BSC chain...');

      const provider = this.getProviderService();

      // PancakeSwap V3 pools for price discovery
      const WBNB_USDT_POOL = '0x36696169C63e42cd08ce11f5deeBbCeBae652050'; // WBNB/USDT on PancakeSwap V3
      const CAKE_WBNB_POOL = '0x133B3D95bAD5405D14d53473671200e9342896BF'; // CAKE/WBNB on PancakeSwap V3
      const MULTICALL3 = CONTRACTS.MULTICALL3;

      const poolInterface = new ethers.Interface([
        'function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)',
        'function token0() view returns (address)'
      ]);

      const multicallInterface = new ethers.Interface([
        'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) returns (tuple(bool success, bytes returnData)[])'
      ]);

      // Build multicall for price queries
      const calls = [
        { target: WBNB_USDT_POOL, allowFailure: true, callData: poolInterface.encodeFunctionData('slot0', []) },
        { target: WBNB_USDT_POOL, allowFailure: true, callData: poolInterface.encodeFunctionData('token0', []) },
        { target: CAKE_WBNB_POOL, allowFailure: true, callData: poolInterface.encodeFunctionData('slot0', []) },
        { target: CAKE_WBNB_POOL, allowFailure: true, callData: poolInterface.encodeFunctionData('token0', []) },
      ];

      let bnbPrice = this.bnbPriceUSD;
      let cakePrice = this.basePrices[CONTRACTS.CAKE.toLowerCase()] || 2.50;

      try {
        const results = await provider.executeWithRetry(async (prov) => {
          const multicall = new ethers.Contract(MULTICALL3, multicallInterface, prov);
          return await multicall.aggregate3.staticCall(calls);
        });

        // Decode WBNB/USDT price
        if (results[0].success && results[1].success) {
          const slot0 = poolInterface.decodeFunctionResult('slot0', results[0].returnData);
          const token0 = poolInterface.decodeFunctionResult('token0', results[1].returnData)[0];
          const price = this.calculateSqrtPriceToPrice(slot0[0], 18, 18);
          const usdtAddress = CONTRACTS.USDT.toLowerCase();
          bnbPrice = token0.toLowerCase() === usdtAddress ? 1 / price : price;
        }

        // Decode CAKE/WBNB price and convert to USD
        if (results[2].success && results[3].success && bnbPrice > 0) {
          const slot0 = poolInterface.decodeFunctionResult('slot0', results[2].returnData);
          const token0 = poolInterface.decodeFunctionResult('token0', results[3].returnData)[0];
          const priceInBNB = this.calculateSqrtPriceToPrice(slot0[0], 18, 18);
          const cakeAddress = CONTRACTS.CAKE.toLowerCase();
          const cakePriceInBNB = token0.toLowerCase() === cakeAddress ? priceInBNB : 1 / priceInBNB;
          cakePrice = cakePriceInBNB * bnbPrice;
        }
      } catch (err) {
        this.logger.warn('Multicall price fetch failed, using cached prices:', err.message);
      }

      this.fetchLock = false;

      // Update BNB price (validate reasonable range for BSC)
      if (bnbPrice && bnbPrice > 0 && isFinite(bnbPrice) && bnbPrice > 100 && bnbPrice < 2000) {
        this.bnbPriceUSD = bnbPrice;
        this.basePrices[CONTRACTS.WBNB.toLowerCase()] = bnbPrice;
        this.logger.info(`✓ BNB price updated to $${bnbPrice.toFixed(2)}`);
      }

      // Update CAKE price
      if (cakePrice && cakePrice > 0 && isFinite(cakePrice) && cakePrice > 0.1 && cakePrice < 100) {
        this.basePrices[CONTRACTS.CAKE.toLowerCase()] = cakePrice;
        this.logger.info(`✓ CAKE price updated to $${cakePrice.toFixed(4)}`);
      }

      this.lastPriceUpdate = now;
      return { bnb: bnbPrice, cake: cakePrice };
    } catch (error) {
      this.logger.error('Failed to fetch prices from chain, using cached prices:', error.message);
      return { bnb: this.bnbPriceUSD, cake: this.basePrices[CONTRACTS.CAKE.toLowerCase()] };
    }
  }

  // Legacy method for backwards compatibility
  async fetchBNBPriceFromChain() {
    const prices = await this.fetchTokenPricesFromChain();
    return prices.bnb;
  }
  
  // Calculate token price in both BNB and USD based on pool data
  calculateTokenPrices(targetTokenAddress, pairTokenAddress, poolPrice, isToken0) {
    const result = {
      priceInPairToken: 0,
      priceInBNB: 0,
      priceInUSD: 0,
      pairTokenSymbol: '',
      calculationMethod: 'none'
    };
    
    // Get pair token price in USD if known
    const pairTokenPriceUSD = this.basePrices[pairTokenAddress.toLowerCase()];
    
    // poolPrice represents how many pairTokens per 1 targetToken
    result.priceInPairToken = poolPrice;
    
    // If pair token is WBNB
    if (pairTokenAddress.toLowerCase() === CONTRACTS.WBNB.toLowerCase()) {
      result.priceInBNB = poolPrice;
      result.priceInUSD = poolPrice * this.bnbPriceUSD;
      result.pairTokenSymbol = 'WBNB';
      result.calculationMethod = 'direct-bnb';
    }
    // If pair token is a stablecoin (USDC, USDT, DAI)
    else if (pairTokenPriceUSD === 1.00) {
      result.priceInUSD = poolPrice;
      result.priceInBNB = poolPrice / this.bnbPriceUSD;
      result.pairTokenSymbol = this.getTokenSymbol(pairTokenAddress);
      result.calculationMethod = 'direct-stable';
    }
    // If pair token has known USD price
    else if (pairTokenPriceUSD) {
      result.priceInUSD = poolPrice * pairTokenPriceUSD;
      result.priceInBNB = result.priceInUSD / this.bnbPriceUSD;
      result.pairTokenSymbol = this.getTokenSymbol(pairTokenAddress);
      result.calculationMethod = 'calculated';
    }
    // Unknown pair token - can't calculate USD/BNB
    else {
      result.priceInBNB = 0;
      result.priceInUSD = 0;
      result.pairTokenSymbol = 'UNKNOWN';
      result.calculationMethod = 'unavailable';
    }
    
    return result;
  }
  
  // Enhanced pool value calculation with multiple price formats
  calculatePoolPrices(pool, targetTokenAddress) {
    const isToken0 = pool.token0?.address?.toLowerCase() === targetTokenAddress.toLowerCase();
    const targetToken = isToken0 ? pool.token0 : pool.token1;
    const pairToken = isToken0 ? pool.token1 : pool.token0;

    // Get the price ratio from pool
    let priceRatio = 0;

    // For V3 pools (PancakeSwap V3)
    if (pool.type === 'V3' && pool.price) {
      priceRatio = isToken0 ? pool.price.token1Price : pool.price.token0Price;
    }
    // For V2 pools (PancakeSwap V2)
    else if (pool.type === 'V2' && pool.price) {
      priceRatio = pool.price.ratio || (isToken0 ? pool.price.token1Price : pool.price.token0Price);
    }
    // Fallback: try to get ratio from price object
    else if (pool.price) {
      priceRatio = pool.price.ratio || (isToken0 ? pool.price.token1Price : pool.price.token0Price) || 0;
    }

    // Calculate comprehensive prices
    const prices = this.calculateTokenPrices(
      targetToken.address,
      pairToken.address,
      priceRatio,
      isToken0
    );

    return {
      tokenSymbol: targetToken.symbol,
      pairTokenSymbol: pairToken.symbol,
      priceInPairToken: prices.priceInPairToken,
      priceInBNB: prices.priceInBNB,
      priceInUSD: prices.priceInUSD,
      displayPrice: this.formatPriceDisplay(prices),
      calculationMethod: prices.calculationMethod
    };
  }
  
  // Format price for display
  formatPriceDisplay(prices) {
    const parts = [];
    
    if (prices.priceInUSD > 0) {
      parts.push(`$${this.formatNumber(prices.priceInUSD)}`);
    }
    
    if (prices.priceInBNB > 0) {
      parts.push(`${this.formatNumber(prices.priceInBNB)} BNB`);
    }
    
    if (parts.length === 0 && prices.priceInPairToken > 0) {
      parts.push(`${this.formatNumber(prices.priceInPairToken)} ${prices.pairTokenSymbol || 'tokens'}`);
    }
    
    return parts.join(' / ') || 'Price unavailable';
  }
  
  // Format numbers for display
  formatNumber(num) {
    if (num === 0) return '0';
    if (num < 0.000001) return num.toExponential(2);
    if (num < 0.01) return num.toFixed(6);
    if (num < 1) return num.toFixed(4);
    if (num < 1000) return num.toFixed(2);
    return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  
  getTokenSymbol(address) {
    const symbols = {
      [CONTRACTS.WBNB.toLowerCase()]: 'WBNB',
      [CONTRACTS.USDC.toLowerCase()]: 'USDC',
      [CONTRACTS.USDT.toLowerCase()]: 'USDT',
      [CONTRACTS.DAI.toLowerCase()]: 'DAI',
      [CONTRACTS.BUSD.toLowerCase()]: 'BUSD',
      [CONTRACTS.CAKE.toLowerCase()]: 'CAKE',
    };
    return symbols[address.toLowerCase()] || 'UNKNOWN';
  }

  /**
   * Calculate total pool value in USD based on token amounts
   * Uses DexScreener/DexTools method:
   * Total = (PairToken Balance × Price) + (TargetToken Balance × Derived Price)
   *
   * @param {string} token0Address
   * @param {string} token1Address
   * @param {bigint|string} amount0 - Raw amount with decimals
   * @param {bigint|string} amount1 - Raw amount with decimals
   * @param {number} decimals0
   * @param {number} decimals1
   * @param {number} poolPriceRatio - Optional: price of token0 in terms of token1 from pool
   */
  calculatePoolValueUSD(token0Address, token1Address, amount0, amount1, decimals0, decimals1, poolPriceRatio = null) {
    try {
      const amount0Formatted = Number(ethers.formatUnits(amount0, decimals0));
      const amount1Formatted = Number(ethers.formatUnits(amount1, decimals1));

      const token0Price = this.basePrices[token0Address.toLowerCase()] || 0;
      const token1Price = this.basePrices[token1Address.toLowerCase()] || 0;

      let totalValueUSD = 0;

      // If we have prices for both tokens, calculate directly
      if (token0Price > 0 && token1Price > 0) {
        totalValueUSD = (amount0Formatted * token0Price) + (amount1Formatted * token1Price);
      }
      // If only token1 has a known price (e.g., USDC, WBNB)
      // Calculate token0 price from pool ratio and add both values
      else if (token1Price > 0) {
        const token1Value = amount1Formatted * token1Price;

        // Derive token0 price from pool if we have the ratio
        // poolPriceRatio = price of token0 in terms of token1
        if (poolPriceRatio && poolPriceRatio > 0) {
          const derivedToken0Price = poolPriceRatio * token1Price;
          const token0Value = amount0Formatted * derivedToken0Price;
          totalValueUSD = token0Value + token1Value;
        } else {
          // Fallback: estimate from reserves ratio if no pool price
          // token0Price ≈ (amount1 / amount0) * token1Price
          if (amount0Formatted > 0) {
            const estimatedToken0Price = (amount1Formatted / amount0Formatted) * token1Price;
            const token0Value = amount0Formatted * estimatedToken0Price;
            totalValueUSD = token0Value + token1Value;
          } else {
            // Only token1 has value
            totalValueUSD = token1Value;
          }
        }
      }
      // If only token0 has a known price
      else if (token0Price > 0) {
        const token0Value = amount0Formatted * token0Price;

        // Derive token1 price from pool if we have the ratio
        // token1Price = token0Price / poolPriceRatio
        if (poolPriceRatio && poolPriceRatio > 0) {
          const derivedToken1Price = token0Price / poolPriceRatio;
          const token1Value = amount1Formatted * derivedToken1Price;
          totalValueUSD = token0Value + token1Value;
        } else {
          // Fallback: estimate from reserves ratio
          if (amount1Formatted > 0) {
            const estimatedToken1Price = (amount0Formatted / amount1Formatted) * token0Price;
            const token1Value = amount1Formatted * estimatedToken1Price;
            totalValueUSD = token0Value + token1Value;
          } else {
            totalValueUSD = token0Value;
          }
        }
      }

      return totalValueUSD;
    } catch (error) {
      this.logger.error('Failed to calculate pool value in USD', error);
      return 0;
    }
  }

  // Calculate aggregate price from multiple pools
  calculateAggregatePrice(pools, tokenAddress) {
    const prices = {
      avgPriceUSD: 0,
      avgPriceBNB: 0,
      minPriceUSD: Infinity,
      maxPriceUSD: 0,
      minPriceBNB: Infinity,
      maxPriceBNB: 0,
      pricesByPair: {}
    };

    // ✅ FIXED: Use WEIGHTED average by liquidity instead of simple average
    // This prevents low-liquidity pools with bad prices from skewing the result
    let totalWeightedUSD = 0;
    let totalWeightedBNB = 0;
    let totalLiquidityUSD = 0;
    let totalLiquidityBNB = 0;

    // First pass: collect all pool prices and track by pair
    const poolsWithPrices = [];

    for (const pool of pools) {
      const poolPrices = this.calculatePoolPrices(pool, tokenAddress);
      const liquidityUSD = pool.liquidity?.usd || 0;
      const liquidityBNB = pool.liquidity?.eth || 0;

      // Track prices by pair token
      const pairKey = poolPrices.pairTokenSymbol;
      if (!prices.pricesByPair[pairKey]) {
        prices.pricesByPair[pairKey] = [];
      }
      prices.pricesByPair[pairKey].push({
        poolAddress: pool.address,
        price: poolPrices.priceInPairToken,
        priceUSD: poolPrices.priceInUSD,
        priceBNB: poolPrices.priceInBNB
      });

      poolsWithPrices.push({
        ...poolPrices,
        liquidityUSD,
        liquidityBNB
      });

      // Track min/max
      if (poolPrices.priceInUSD > 0) {
        prices.minPriceUSD = Math.min(prices.minPriceUSD, poolPrices.priceInUSD);
        prices.maxPriceUSD = Math.max(prices.maxPriceUSD, poolPrices.priceInUSD);
      }
      if (poolPrices.priceInBNB > 0) {
        prices.minPriceBNB = Math.min(prices.minPriceBNB, poolPrices.priceInBNB);
        prices.maxPriceBNB = Math.max(prices.maxPriceBNB, poolPrices.priceInBNB);
      }
    }

    // ✅ Filter outliers: Remove prices that are >10x or <0.1x the median
    const validUSDPrices = poolsWithPrices.filter(p => p.priceInUSD > 0).map(p => p.priceInUSD).sort((a, b) => a - b);
    const validBNBPrices = poolsWithPrices.filter(p => p.priceInBNB > 0).map(p => p.priceInBNB).sort((a, b) => a - b);

    const medianUSD = validUSDPrices.length > 0 ? validUSDPrices[Math.floor(validUSDPrices.length / 2)] : 0;
    const medianBNB = validBNBPrices.length > 0 ? validBNBPrices[Math.floor(validBNBPrices.length / 2)] : 0;

    // Second pass: calculate weighted average (excluding outliers)
    for (const pool of poolsWithPrices) {
      // USD price with outlier filter
      if (pool.priceInUSD > 0 && pool.liquidityUSD > 0) {
        // ✅ Only include if price is within 10x of median (filters bad data)
        if (medianUSD === 0 || (pool.priceInUSD >= medianUSD * 0.1 && pool.priceInUSD <= medianUSD * 10)) {
          totalWeightedUSD += pool.priceInUSD * pool.liquidityUSD;
          totalLiquidityUSD += pool.liquidityUSD;
        }
      }

      // BNB price with outlier filter
      if (pool.priceInBNB > 0 && pool.liquidityBNB > 0) {
        // ✅ Only include if price is within 10x of median (filters bad data)
        if (medianBNB === 0 || (pool.priceInBNB >= medianBNB * 0.1 && pool.priceInBNB <= medianBNB * 10)) {
          totalWeightedBNB += pool.priceInBNB * pool.liquidityBNB;
          totalLiquidityBNB += pool.liquidityBNB;
        }
      }
    }

    // Calculate weighted averages
    if (totalLiquidityUSD > 0) {
      prices.avgPriceUSD = totalWeightedUSD / totalLiquidityUSD;
    }
    if (totalLiquidityBNB > 0) {
      prices.avgPriceBNB = totalWeightedBNB / totalLiquidityBNB;
    }

    // Clean up infinities
    if (prices.minPriceUSD === Infinity) prices.minPriceUSD = 0;
    if (prices.minPriceBNB === Infinity) prices.minPriceBNB = 0;

    return prices;
  }
  
  // Set current BNB price in USD
  setBNBPrice(priceUSD) {
    this.bnbPriceUSD = priceUSD;
    this.lastPriceUpdate = Date.now();
    this.logger.info(`BNB price updated to $${priceUSD}`);
  }

  // Set price for a specific token (useful for testing and manual updates)
  setTokenPrice(tokenAddress, priceUSD) {
    this.basePrices[tokenAddress.toLowerCase()] = priceUSD;
    this.lastPriceUpdate = Date.now();
    this.logger.info(`Token ${tokenAddress} price updated to $${priceUSD}`);
  }
  
  // Get price info
  getPriceInfo() {
    return {
      bnbPriceUSD: this.bnbPriceUSD,
      knownTokens: Object.keys(this.basePrices).length,
      lastUpdate: new Date(this.lastPriceUpdate).toISOString(),
      basePrices: this.basePrices
    };
  }
}

// Singleton instance
let priceServiceInstance = null;

module.exports = {
  getPriceService: () => {
    if (!priceServiceInstance) {
      priceServiceInstance = new PriceService();
    }
    return priceServiceInstance;
  },
};
