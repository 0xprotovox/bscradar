// src/services/PoolAnalyzer.js - OPTIMIZED WITH MULTICALL

const { ethers } = require('ethers');
const { getV2PoolService } = require('./V2PoolService');
const { getV3PoolService } = require('./V3PoolService');
// PancakeSwap V2/V3 pool analyzer for BSC network
const { getTokenService } = require('./TokenService');
const { getPoolDiscoveryService } = require('./PoolDiscoveryService');
const { getMulticallService } = require('./MulticallService');
const { getPriceService } = require('./PriceService');
const { getCacheService } = require('../utils/Cache');
const { getLogger } = require('../utils/Logger');
const { LIQUIDITY_THRESHOLDS } = require('../config/constants');

class PoolAnalyzer {
  constructor() {
    // PancakeSwap V2/V3 services (Uniswap-compatible)
    this.v2PoolService = getV2PoolService();
    this.v3PoolService = getV3PoolService();

    // Common services
    this.tokenService = getTokenService();
    this.discoveryService = getPoolDiscoveryService();
    this.multicallService = getMulticallService();
    this.priceService = getPriceService();
    this.cache = getCacheService();
    this.inFlightRequests = new Map(); // Request deduplication: stores pending promises
    this.logger = getLogger();
  }

  async analyzeToken(tokenAddress, forceRefresh = false) {
    try {
      const startTime = Date.now();
      tokenAddress = ethers.getAddress(tokenAddress);

      // Check cache first (before deduplication check)
      if (!forceRefresh) {
        const cached = this.cache.getAnalysis(tokenAddress);
        if (cached) {
          this.logger.info(`Using cached analysis for ${tokenAddress}`);
          const cacheAge = cached.meta?.timestamp ? Date.now() - new Date(cached.meta.timestamp).getTime() : 0;
          return {
            ...cached,
            meta: {
              ...cached.meta,
              cached: true,
              cacheAgeMs: cacheAge,
              cacheAgeSec: Math.round(cacheAge / 1000),
              fresh: cacheAge < 60000 // Fresh if < 60 seconds
            }
          };
        }
      } else {
        this.clearAllCachesForToken(tokenAddress);
      }

      // REQUEST DEDUPLICATION: If there's an in-flight request for this token, wait for it
      const inFlightKey = `${tokenAddress}:${forceRefresh}`;
      if (this.inFlightRequests.has(inFlightKey)) {
        this.logger.info(`🔄 Deduplicating request for ${tokenAddress} - waiting for in-flight analysis`);
        const result = await this.inFlightRequests.get(inFlightKey);
        return {
          ...result,
          meta: {
            ...result.meta,
            deduplicated: true,
            waitedForInFlight: true
          }
        };
      }

      // Create promise for this analysis and store it
      const analysisPromise = this._performAnalysis(tokenAddress, forceRefresh, startTime);
      this.inFlightRequests.set(inFlightKey, analysisPromise);

      try {
        const result = await analysisPromise;
        return result;
      } finally {
        // Clean up the in-flight request
        this.inFlightRequests.delete(inFlightKey);
      }
    } catch (error) {
      this.logger.error(`Analysis failed for ${tokenAddress}:`, error);
      throw error;
    }
  }

  // Internal method that performs the actual analysis
  async _performAnalysis(tokenAddress, forceRefresh, startTime) {
    try {
      this.logger.info(`⏱️ Starting token analysis: ${tokenAddress}`);

      // Track performance timing
      const timing = {
        total: 0,
        tokenInfo: 0,
        poolDiscovery: 0,
        poolFormatting: 0,
        priceCalculation: 0,
        poolAnalysis: 0,
        poolSelection: 0
      };

      // OPTIMIZED: Only fetch prices if they're stale (>30s old)
      const step1Start = Date.now();
      const pricesStale = this.priceService.arePricesStale?.() ?? true;

      const [tokenInfo] = await Promise.all([
        this.tokenService.getTokenInfo(tokenAddress),
        // Only fetch prices if stale (saves ~150ms when prices are fresh)
        pricesStale ? this.priceService.fetchTokenPricesFromChain().catch(err => {
          this.logger.warn('Price fetch failed, using cached prices', err);
        }) : Promise.resolve()
      ]);
      timing.tokenInfo = Date.now() - step1Start;
      this.logger.info(`⏱️ [${timing.tokenInfo}ms] Token info${pricesStale ? ' + prices' : ''} fetched`);
      this.logger.info(`Token: ${tokenInfo.symbol} (${tokenInfo.name})`);

      // Discover all pools (PancakeSwap V2/V3) with graceful degradation
      const step2Start = Date.now();
      const { pools: allPools, protocolStatus } = await this.discoverAllPools(tokenAddress);
      timing.poolDiscovery = Date.now() - step2Start;
      this.logger.info(`⏱️ [${timing.poolDiscovery}ms] Pool discovery + data fetching completed`);
      this.logger.info(`Found ${allPools.length} total pools across all protocols`);

      // Check for partial results (graceful degradation)
      const failedProtocols = Object.entries(protocolStatus)
        .filter(([_, status]) => status.status === 'failed')
        .map(([name, status]) => ({ name, error: status.error }));
      const hasPartialResults = failedProtocols.length > 0;

      // Format pools with comprehensive pricing
      const step3Start = Date.now();
      const formattedPools = this.formatPoolsWithPricing(allPools, tokenAddress);
      timing.poolFormatting = Date.now() - step3Start;
      this.logger.info(`⏱️ [${timing.poolFormatting}ms] Pool formatting completed`);

      // OPTIMIZATION: Run independent operations in parallel
      const step4Start = Date.now();
      const aggregatePrices = this.priceService.calculateAggregatePrice(formattedPools, tokenAddress);
      const bestPools = this.selectBestPools(formattedPools); // Can run parallel with aggregatePrices
      timing.priceCalculation = Date.now() - step4Start;
      this.logger.info(`⏱️ [${timing.priceCalculation}ms] Aggregate price + best pool selection completed`);

      // Analyze pools (depends on aggregatePrices)
      const step5Start = Date.now();
      const analysis = this.analyzePoolData(formattedPools, tokenInfo, aggregatePrices);
      timing.poolAnalysis = Date.now() - step5Start;
      this.logger.info(`⏱️ [${timing.poolAnalysis}ms] Pool analysis completed`);

      // Pool selection already done above
      timing.poolSelection = 0;

      // Count by protocol and type
      const protocolBreakdown = this.getProtocolBreakdown(allPools);

      // Calculate total timing
      const totalTime = Date.now() - startTime;
      timing.total = totalTime;

      // Generate comprehensive warnings (including protocol failures)
      const warnings = this.generateWarnings({
        bestPools,
        formattedPools,
        aggregatePrices,
        pricesStale,
        timing,
        protocolStatus,
        hasPartialResults
      });

      // Create comprehensive result with enhanced UX
      const result = {
        token: tokenInfo,
        pricing: {
          currentPrice: {
            usd: aggregatePrices.avgPriceUSD,
            bnb: aggregatePrices.avgPriceBNB,
            displayPrice: this.priceService.formatPriceDisplay({
              priceInUSD: aggregatePrices.avgPriceUSD,
              priceInBNB: aggregatePrices.avgPriceBNB
            })
          },
          priceRange: {
            usd: {
              min: aggregatePrices.minPriceUSD,
              max: aggregatePrices.maxPriceUSD,
              spread: aggregatePrices.maxPriceUSD - aggregatePrices.minPriceUSD
            },
            bnb: {
              min: aggregatePrices.minPriceBNB,
              max: aggregatePrices.maxPriceBNB,
              spread: aggregatePrices.maxPriceBNB - aggregatePrices.minPriceBNB
            }
          },
          pricesByPair: aggregatePrices.pricesByPair
        },
        summary: {
          totalPools: allPools.length,
          activePools: formattedPools.filter(p => p.liquidity.status === 'ACTIVE').length,
          protocols: protocolBreakdown
        },
        bestPools,
        pools: formattedPools,
        analysis,

        // Enhanced UX: Performance timing breakdown
        performance: {
          totalMs: timing.total,
          breakdown: {
            tokenInfo: timing.tokenInfo,
            poolDiscovery: timing.poolDiscovery,
            poolFormatting: timing.poolFormatting,
            priceCalculation: timing.priceCalculation,
            poolAnalysis: timing.poolAnalysis,
            poolSelection: timing.poolSelection
          },
          grade: timing.total < 500 ? 'A+' : timing.total < 1000 ? 'A' : timing.total < 2000 ? 'B' : 'C'
        },

        // Enhanced UX: Cache metadata
        meta: {
          timestamp: new Date().toISOString(),
          cached: false,
          cacheKey: tokenAddress,
          ttlSeconds: 300,
          bnbPrice: this.priceService.getBNBPrice(),
          pricesStale: pricesStale,
          // Graceful degradation: protocol status and partial results flag
          partialResults: hasPartialResults,
          protocolStatus
        },

        // Enhanced UX: Warning System
        warnings
      };

      // Cache the result
      this.cache.setAnalysis(tokenAddress, result);

      this.logger.info(`⏱️ ✅ TOTAL ANALYSIS TIME: ${timing.total}ms (Grade: ${result.performance.grade})`);

      return result;
    } catch (error) {
      this.logger.error(`Failed to analyze token ${tokenAddress}`, error);
      throw error;
    }
  }

  clearAllCachesForToken(tokenAddress) {
    this.cache.clearTokenAnalysis(tokenAddress);
    this.logger.info(`Cleared all caches for token ${tokenAddress}`);
  }

  async discoverAllPools(tokenAddress) {
    const processedPools = new Set();

    this.logger.info(`Starting comprehensive pool discovery for ${tokenAddress}`);

    // Use the enhanced discovery service (PancakeSwap V2/V3)
    const discoveryStart = Date.now();
    const discoveredPools = await this.discoveryService.findAllPoolsForToken(tokenAddress);
    this.logger.info(`  ⏱️ [${Date.now() - discoveryStart}ms] Pool discovery completed - found ${discoveredPools.length} potential pools`);

    // Filter out duplicate pools
    const uniquePools = discoveredPools.filter(poolInfo => {
      const poolKey = `${poolInfo.protocol}_${poolInfo.type}_${poolInfo.address.toLowerCase()}`;
      if (processedPools.has(poolKey)) return false;
      processedPools.add(poolKey);
      return true;
    });
    this.logger.info(`  ⏱️ Filtered to ${uniquePools.length} unique pools`);

    // Use Multicall for batch pool data fetching - MUCH faster!
    const fetchStart = Date.now();
    const { pools: poolDataResults, protocolStatus } = await this.batchFetchPoolData(uniquePools);
    this.logger.info(`  ⏱️ [${Date.now() - fetchStart}ms] Multicall pool data fetching completed (${uniquePools.length} pools)`);

    // Filter out null results and pools without liquidity
    const allPools = poolDataResults.filter(poolData => {
      if (!poolData) return false;

      const hasLiquidity =
        (poolData.liquidity && poolData.liquidity.raw !== '0') ||
        (poolData.reserves && (poolData.reserves.reserve0 !== '0' || poolData.reserves.reserve1 !== '0')) ||
        (poolData.liquidity && poolData.liquidity.status === 'ACTIVE');

      if (hasLiquidity) {
        this.logger.info(
          `✔ ${poolData.protocol || 'PancakeSwap'} ${poolData.type} pool: ${poolData.token0.symbol}/${poolData.token1.symbol} ` +
          `($${poolData.liquidity.totalValueUSD?.toFixed(2) || 'N/A'})`
        );
        return true;
      }
      return false;
    });

    // Return both pools and protocol status for graceful degradation
    return { pools: allPools, protocolStatus };
  }

  /**
   * Batch fetch pool data using Multicall - single RPC call for all pools!
   * OPTIMIZED: Fetches V3 pool data AND balances in parallel to reduce latency
   * ENHANCED: Returns protocol status for graceful degradation
   */
  async batchFetchPoolData(pools) {
    // Initialize protocol status tracking for graceful degradation
    const protocolStatus = {
      pancakeswapV2: { status: 'skipped', pools: 0, error: null },
      pancakeswapV3: { status: 'skipped', pools: 0, error: null }
    };

    if (!pools || pools.length === 0) {
      return { pools: [], protocolStatus };
    }

    // Separate pools by type for batch processing
    const v2Pools = pools.filter(p => p.type === 'V2');
    const v3Pools = pools.filter(p => p.type === 'V3');

    this.logger.info(`  Batch fetching: ${v2Pools.length} V2, ${v3Pools.length} V3`);

    // Update initial pool counts
    protocolStatus.pancakeswapV2.pools = v2Pools.length;
    protocolStatus.pancakeswapV3.pools = v3Pools.length;

    try {
      // Fetch all pool types in parallel using Multicall with detailed error tracking
      const [v2Result, v3Result] = await Promise.all([
        v2Pools.length > 0
          ? this.multicallService.batchGetV2PoolData(v2Pools.map(p => p.address))
              .then(data => ({ data, error: null }))
              .catch(err => ({ data: [], error: err.message }))
          : { data: [], error: null },
        v3Pools.length > 0
          ? this.multicallService.batchGetV3PoolData(v3Pools.map(p => p.address))
              .then(data => ({ data, error: null }))
              .catch(err => ({ data: [], error: err.message }))
          : { data: [], error: null },
      ]);

      // Extract data and update protocol status
      const v2Data = v2Result.data;
      const v3Data = v3Result.data;

      // Update protocol status based on results
      protocolStatus.pancakeswapV2.status = v2Pools.length === 0 ? 'skipped' : v2Result.error ? 'failed' : 'success';
      protocolStatus.pancakeswapV2.error = v2Result.error;
      protocolStatus.pancakeswapV2.returned = v2Data.length;

      protocolStatus.pancakeswapV3.status = v3Pools.length === 0 ? 'skipped' : v3Result.error ? 'failed' : 'success';
      protocolStatus.pancakeswapV3.error = v3Result.error;
      protocolStatus.pancakeswapV3.returned = v3Data.length;

      // Log any failures
      Object.entries(protocolStatus).forEach(([protocol, status]) => {
        if (status.status === 'failed') {
          this.logger.warn(`⚠️ Protocol ${protocol} failed: ${status.error}`);
        }
      });

      // Now fetch V3 balances using the ACTUAL token addresses from pool data
      // This must happen AFTER pool data fetch to get correct token addresses
      let v3Balances = {};
      if (v3Data.length > 0) {
        try {
          const balanceData = await this.multicallService.batchGetPoolBalances(v3Data);
          for (const b of balanceData) {
            v3Balances[b.address.toLowerCase()] = { balance0: b.balance0, balance1: b.balance1 };
          }
          this.logger.info(`  Fetched actual balances for ${v3Data.length} V3 pools`);
        } catch (err) {
          this.logger.warn(`Failed to fetch V3 pool balances: ${err.message}`);
        }
      }

      // Attach actual balances to V3 pool data
      for (const pool of v3Data) {
        const balances = v3Balances[pool.address.toLowerCase()];
        if (balances) {
          pool.actualBalance0 = balances.balance0;
          pool.actualBalance1 = balances.balance1;
        }
      }

      // Get all unique token addresses for batch token info fetch
      const allTokenAddresses = new Set();
      [...v2Data, ...v3Data].forEach(pool => {
        if (pool.token0) allTokenAddresses.add(pool.token0);
        if (pool.token1) allTokenAddresses.add(pool.token1);
      });

      // Batch fetch token info (with fallback to empty object on failure)
      let tokenInfo = {};
      try {
        tokenInfo = await this.multicallService.batchGetTokenInfo([...allTokenAddresses]);
      } catch (tokenInfoError) {
        this.logger.warn(`Token info batch failed, using fallback: ${tokenInfoError.message}`);
        // Create fallback token info with unknown values
        for (const addr of allTokenAddresses) {
          tokenInfo[addr.toLowerCase()] = { address: addr, name: 'Unknown', symbol: 'UNKNOWN', decimals: 18 };
        }
      }

      // OPTIMIZATION: Enrich ALL pools in PARALLEL (was sequential for loops)
      const enrichmentPromises = [];

      // Prepare V2 pool enrichments
      for (let i = 0; i < v2Data.length; i++) {
        const poolData = v2Data[i];
        const poolInfo = v2Pools.find(p => p.address.toLowerCase() === poolData.address.toLowerCase());
        if (poolData && poolInfo) {
          enrichmentPromises.push(this.enrichPoolData(poolData, poolInfo, tokenInfo, 'V2', 'PancakeSwap'));
        }
      }

      // Prepare V3 pool enrichments
      for (let i = 0; i < v3Data.length; i++) {
        const poolData = v3Data[i];
        const poolInfo = v3Pools.find(p => p.address.toLowerCase() === poolData.address.toLowerCase());
        if (poolData && poolInfo) {
          enrichmentPromises.push(this.enrichPoolData(poolData, poolInfo, tokenInfo, 'V3', 'PancakeSwap'));
        }
      }

      // Execute ALL enrichments in parallel
      const enrichedPools = await Promise.all(enrichmentPromises);

      // If any pool type returned empty (multicall failed), fetch those sequentially
      const missingPools = [];
      if (v2Pools.length > 0 && v2Data.length === 0) missingPools.push(...v2Pools);
      if (v3Pools.length > 0 && v3Data.length === 0) missingPools.push(...v3Pools);

      if (missingPools.length > 0) {
        this.logger.info(`  Fetching ${missingPools.length} missing pools sequentially`);
        const sequentialResults = await this.fallbackSequentialFetch(missingPools);
        enrichedPools.push(...sequentialResults.filter(p => p !== null));
      }

      // Return both pools and protocol status for graceful degradation
      return { pools: enrichedPools, protocolStatus };
    } catch (error) {
      this.logger.warn(`Multicall batch fetch failed, falling back to sequential: ${error.message}`);
      // On complete failure, return fallback with all protocols marked as failed
      const fallbackPools = await this.fallbackSequentialFetch(pools);
      Object.keys(protocolStatus).forEach(protocol => {
        if (protocolStatus[protocol].pools > 0) {
          protocolStatus[protocol].status = 'failed';
          protocolStatus[protocol].error = error.message;
        }
      });
      return { pools: fallbackPools, protocolStatus };
    }
  }

  /**
   * Enrich pool data with token info and liquidity calculations
   */
  async enrichPoolData(poolData, poolInfo, tokenInfo, type, protocol) {
    const token0Info = tokenInfo[poolData.token0?.toLowerCase()] || { symbol: 'UNKNOWN', decimals: 18, name: 'Unknown' };
    const token1Info = tokenInfo[poolData.token1?.toLowerCase()] || { symbol: 'UNKNOWN', decimals: 18, name: 'Unknown' };

    const enriched = {
      address: poolData.address,
      type,
      protocol,
      token0: {
        address: poolData.token0,
        ...token0Info,
      },
      token1: {
        address: poolData.token1,
        ...token1Info,
      },
    };

    // Handle V2 style pools (reserves)
    if (type === 'V2') {
      enriched.reserves = {
        reserve0: poolData.reserve0?.toString() || '0',
        reserve1: poolData.reserve1?.toString() || '0',
      };
      enriched.fee = poolInfo.fee || 2500; // PancakeSwap V2 default 0.25%
      enriched.feePercent = enriched.fee / 10000; // fee is in basis points (2500 = 0.25%)

      // Calculate liquidity from reserves
      const reserve0Num = Number(ethers.formatUnits(poolData.reserve0 || 0n, token0Info.decimals));
      const reserve1Num = Number(ethers.formatUnits(poolData.reserve1 || 0n, token1Info.decimals));

      const { totalValueUSD, totalValueBNB } = this.calculatePoolValue(
        reserve0Num, reserve1Num, token0Info, token1Info
      );

      // Determine status based on USD value - STRICT threshold
      let status = 'LOW_LIQUIDITY';
      if (totalValueUSD >= 1000) {
        status = 'ACTIVE';
      } else if (totalValueUSD >= 100) {
        status = 'WARNING_LIQUIDITY';
      } else if (totalValueUSD <= 0 && reserve0Num <= 0 && reserve1Num <= 0) {
        status = 'EMPTY';
      }

      enriched.liquidity = {
        raw: (poolData.reserve0 || 0n).toString(),
        token0Amount: reserve0Num.toString(),
        token1Amount: reserve1Num.toString(),
        totalValueUSD,
        totalValueBNB,
        status,
      };
    }
    // Handle V3 style pools (liquidity + slot0)
    else if (type === 'V3') {
      enriched.fee = poolData.fee || poolInfo.fee || 2500; // PancakeSwap V3 common fee tier
      enriched.feePercent = enriched.fee / 10000; // fee is in basis points (2500 = 0.25%)
      enriched.sqrtPriceX96 = poolData.slot0?.sqrtPriceX96?.toString() || '0';
      enriched.tick = Number(poolData.slot0?.tick) || 0;

      const liquidityRaw = poolData.liquidity || 0n;

      // ✅ V3 RUGGED POOL DETECTION: Check for extreme tick values or zero liquidity
      const MAX_TICK = 887272;
      const MIN_TICK = -887272;
      const TICK_BOUNDARY_THRESHOLD = 100;
      const tick = enriched.tick;
      const isTickAtBoundary = tick >= (MAX_TICK - TICK_BOUNDARY_THRESHOLD) ||
                                tick <= (MIN_TICK + TICK_BOUNDARY_THRESHOLD);
      const isZeroLiquidity = !liquidityRaw || liquidityRaw === 0n || liquidityRaw.toString() === '0';

      if (isTickAtBoundary || isZeroLiquidity) {
        this.logger.warn(`⚠️ V3 Pool ${poolData.address} RUGGED: tick=${tick}, liquidity=${liquidityRaw}`);
        enriched.isRugged = true;
        enriched.rugReason = isZeroLiquidity ? 'Zero liquidity' : `Tick at boundary (${tick})`;
        enriched.liquidity = {
          raw: '0',
          token0Amount: '0',
          token1Amount: '0',
          totalValueUSD: 0,
          totalValueBNB: 0,
          status: 'RUGGED',
        };
        return enriched;
      }

      // Calculate approximate token amounts from V3 liquidity
      const { token0Amount, token1Amount, totalValueUSD, totalValueBNB } =
        this.calculateV3PoolValue(poolData, token0Info, token1Info);

      // Determine status based on USD value - STRICT threshold
      let status = 'LOW_LIQUIDITY';
      if (totalValueUSD >= 1000) {
        status = 'ACTIVE';
      } else if (totalValueUSD >= 100) {
        status = 'WARNING_LIQUIDITY';
      } else if (liquidityRaw <= 0n) {
        status = 'EMPTY';
      }

      enriched.liquidity = {
        raw: liquidityRaw.toString(),
        token0Amount: token0Amount.toString(),
        token1Amount: token1Amount.toString(),
        totalValueUSD,
        totalValueBNB,
        status,
      };
    }

    return enriched;
  }

  /**
   * Calculate pool value for V2-style pools using DexScreener/DexTools method
   * Total = (Token0 Balance × Token0 Price) + (Token1 Balance × Token1 Price)
   * Where unknown token price is derived from reserves ratio
   */
  calculatePoolValue(reserve0, reserve1, token0Info, token1Info) {
    const bnbPrice = this.priceService.getBNBPrice();
    const basePrices = this.priceService.basePrices || {};

    const token0Address = token0Info.address?.toLowerCase() || '';
    const token1Address = token1Info.address?.toLowerCase() || '';

    // Get known prices for tokens
    const token0Price = basePrices[token0Address] || 0;
    const token1Price = basePrices[token1Address] || 0;

    let totalValueUSD = 0;
    let totalValueBNB = 0;

    // DexScreener method: calculate both token values and sum them
    if (token0Price > 0 && token1Price > 0) {
      // Both tokens have known prices
      totalValueUSD = (reserve0 * token0Price) + (reserve1 * token1Price);
    } else if (token0Price > 0) {
      // Token0 has price (e.g., WBNB, CAKE, stablecoin)
      const token0Value = reserve0 * token0Price;
      // Derive token1 price from reserve ratio
      const derivedToken1Price = reserve0 > 0 ? (reserve0 / reserve1) * token0Price : 0;
      const token1Value = reserve1 * derivedToken1Price;
      totalValueUSD = token0Value + token1Value;
    } else if (token1Price > 0) {
      // Token1 has price
      const token1Value = reserve1 * token1Price;
      // Derive token0 price from reserve ratio
      const derivedToken0Price = reserve1 > 0 ? (reserve1 / reserve0) * token1Price : 0;
      const token0Value = reserve0 * derivedToken0Price;
      totalValueUSD = token0Value + token1Value;
    }
    // If no known prices, leave as 0

    totalValueBNB = bnbPrice > 0 ? totalValueUSD / bnbPrice : 0;

    return { totalValueUSD, totalValueBNB };
  }

  /**
   * Calculate pool value for V3-style pools using DexScreener/DexTools method
   * Uses ACTUAL token balances (ERC20 balanceOf) NOT liquidity estimates!
   * This is how DexScreener calculates TVL - by reading actual pool balances
   */
  calculateV3PoolValue(poolData, token0Info, token1Info) {
    const bnbPrice = this.priceService.getBNBPrice();
    const basePrices = this.priceService.basePrices || {};

    const token0Address = token0Info.address?.toLowerCase() || '';
    const token1Address = token1Info.address?.toLowerCase() || '';

    // Get known prices for tokens
    const token0Price = basePrices[token0Address] || 0;
    const token1Price = basePrices[token1Address] || 0;

    const sqrtPriceX96 = poolData.slot0?.sqrtPriceX96 || 0n;

    let token0Amount = 0;
    let token1Amount = 0;
    let totalValueUSD = 0;
    let totalValueBNB = 0;

    // CRITICAL: Use ACTUAL token balances from ERC20 balanceOf (DexScreener method)
    // This is the correct way to calculate TVL for V3 pools!
    if (poolData.actualBalance0 !== undefined && poolData.actualBalance1 !== undefined) {
      token0Amount = Number(ethers.formatUnits(poolData.actualBalance0 || 0n, token0Info.decimals));
      token1Amount = Number(ethers.formatUnits(poolData.actualBalance1 || 0n, token1Info.decimals));
    }
    // Fallback to estimated values if actual balances not available
    else if (poolData.token0Amount && poolData.token1Amount) {
      token0Amount = parseFloat(poolData.token0Amount) || 0;
      token1Amount = parseFloat(poolData.token1Amount) || 0;
    }
    // Last resort: estimate from liquidity (inaccurate but better than 0)
    else {
      const liquidity = poolData.liquidity || 0n;
      if (liquidity > 0n && sqrtPriceX96 > 0n) {
        const liquidityNum = Number(liquidity);
        const sqrtPrice = Number(sqrtPriceX96) / (2 ** 96);

        token0Amount = liquidityNum / (sqrtPrice * 1e9);
        token1Amount = liquidityNum * sqrtPrice / 1e9;

        token0Amount = token0Amount / Math.pow(10, token0Info.decimals - 9);
        token1Amount = token1Amount / Math.pow(10, token1Info.decimals - 9);
      }
    }

    // DexScreener method: calculate both token values using known prices
    if (token0Price > 0 && token1Price > 0) {
      totalValueUSD = (token0Amount * token0Price) + (token1Amount * token1Price);
    } else if (token0Price > 0) {
      // Token0 has price - derive token1 price from sqrtPrice or reserve ratio
      const token0Value = token0Amount * token0Price;
      let derivedToken1Price = 0;
      if (sqrtPriceX96 > 0n) {
        const sqrtPrice = Number(sqrtPriceX96) / (2 ** 96);
        const priceRatio = sqrtPrice * sqrtPrice * Math.pow(10, token0Info.decimals - token1Info.decimals);
        derivedToken1Price = priceRatio > 0 ? token0Price / priceRatio : 0;
      } else if (token0Amount > 0 && token1Amount > 0) {
        derivedToken1Price = (token0Amount / token1Amount) * token0Price;
      }
      const token1Value = token1Amount * derivedToken1Price;
      totalValueUSD = token0Value + token1Value;
    } else if (token1Price > 0) {
      // Token1 has price - derive token0 price
      const token1Value = token1Amount * token1Price;
      let derivedToken0Price = 0;
      if (sqrtPriceX96 > 0n) {
        const sqrtPrice = Number(sqrtPriceX96) / (2 ** 96);
        const priceRatio = sqrtPrice * sqrtPrice * Math.pow(10, token0Info.decimals - token1Info.decimals);
        derivedToken0Price = priceRatio * token1Price;
      } else if (token1Amount > 0 && token0Amount > 0) {
        derivedToken0Price = (token1Amount / token0Amount) * token1Price;
      }
      const token0Value = token0Amount * derivedToken0Price;
      totalValueUSD = token0Value + token1Value;
    }

    totalValueBNB = bnbPrice > 0 ? totalValueUSD / bnbPrice : 0;

    return { token0Amount, token1Amount, totalValueUSD, totalValueBNB };
  }

  /**
   * Fallback to sequential fetching if Multicall fails
   */
  async fallbackSequentialFetch(pools) {
    const BATCH_SIZE = 8;
    const poolDataResults = [];

    for (let i = 0; i < pools.length; i += BATCH_SIZE) {
      const batch = pools.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(poolInfo =>
        this.fetchPoolData(poolInfo).catch(error => {
          this.logger.debug(`Failed to get pool data for ${poolInfo.address}: ${error.message}`);
          return null;
        })
      );

      const batchResults = await Promise.all(batchPromises);
      poolDataResults.push(...batchResults);
    }

    return poolDataResults;
  }

  // Helper method to fetch pool data based on protocol and type
  async fetchPoolData(poolInfo) {
    // Route to appropriate service based on pool type (BSC: PancakeSwap V2/V3)
    if (poolInfo.type === 'V2') {
      return await this.v2PoolService.getPoolData(poolInfo.address);
    } else if (poolInfo.type === 'V3') {
      return await this.v3PoolService.getPoolData(poolInfo.address);
    }
    return null;
  }

  getProtocolBreakdown(pools) {
    const breakdown = {
      pancakeswap: {
        v2: pools.filter(p => p.type === 'V2').length,
        v3: pools.filter(p => p.type === 'V3').length,
        total: 0
      }
    };

    breakdown.pancakeswap.total = breakdown.pancakeswap.v2 + breakdown.pancakeswap.v3;

    return breakdown;
  }

  formatPoolsWithPricing(pools, tokenAddress) {
    return pools.map(pool => {
      const isToken0 = pool.token0?.address?.toLowerCase() === tokenAddress.toLowerCase();
      const pairToken = isToken0 ? pool.token1 : pool.token0;

      // Calculate base price
      let priceRatio = 0;
      let token0Price = 0;
      let token1Price = 0;
      let priceSource = 'none';

      // Handle V3 pricing (concentrated liquidity)
      if (pool.type === 'V3' && pool.sqrtPriceX96) {
        const decimals0 = pool.token0?.decimals || 18;
        const decimals1 = pool.token1?.decimals || 18;
        
        try {
          let sqrtPriceX96Num;
          if (typeof pool.sqrtPriceX96 === 'bigint') {
            sqrtPriceX96Num = Number(pool.sqrtPriceX96);
          } else if (typeof pool.sqrtPriceX96 === 'string') {
            sqrtPriceX96Num = parseFloat(pool.sqrtPriceX96);
          } else {
            sqrtPriceX96Num = Number(pool.sqrtPriceX96);
          }
          
          if (sqrtPriceX96Num > 0 && isFinite(sqrtPriceX96Num)) {
            const Q96 = 2 ** 96;
            const sqrtPrice = sqrtPriceX96Num / Q96;
            let rawPrice = sqrtPrice * sqrtPrice;
            
            if (decimals0 !== decimals1) {
              const decimalAdjustment = Math.pow(10, decimals0 - decimals1);
              rawPrice = rawPrice * decimalAdjustment;
            }
            
            token1Price = rawPrice;
            token0Price = rawPrice > 0 ? (1 / rawPrice) : 0;
            
            if (isToken0) {
              priceRatio = token1Price;
            } else {
              priceRatio = token0Price;
            }
            
            priceSource = `${pool.type}-sqrtPriceX96`;
          }
        } catch (error) {
          this.logger.error(`Failed to calculate ${pool.type} price: ${error.message}`);
        }
      }
      // Handle V2 pricing (reserves)
      else if (pool.type === 'V2' && pool.reserves) {
        const reserve0 = BigInt(pool.reserves.reserve0 || 0);
        const reserve1 = BigInt(pool.reserves.reserve1 || 0);
        
        if (reserve0 > 0n && reserve1 > 0n) {
          const decimals0 = pool.token0?.decimals || 18;
          const decimals1 = pool.token1?.decimals || 18;
          
          try {
            const amount0 = Number(ethers.formatUnits(reserve0, decimals0));
            const amount1 = Number(ethers.formatUnits(reserve1, decimals1));
            
            if (amount0 > 0 && amount1 > 0) {
              token1Price = amount1 / amount0;
              token0Price = amount0 / amount1;
              
              if (isToken0) {
                priceRatio = amount1 / amount0;
              } else {
                priceRatio = amount0 / amount1;
              }
              
              priceSource = `${pool.type}-reserves`;
            }
          } catch (error) {
            this.logger.error(`Failed to calculate ${pool.type} price: ${error.message}`);
          }
        }
      }
      // Use existing price data if available
      else if (pool.price) {
        token0Price = pool.price.token0Price || 0;
        token1Price = pool.price.token1Price || 0;
        priceRatio = pool.price.priceRatio || pool.price.ratio || 0;
        priceSource = 'pool-data';
      }

      // Calculate comprehensive prices using PriceService
      const comprehensivePrices = this.priceService.calculatePoolPrices(
        {
          ...pool,
          price: { token0Price, token1Price, ratio: priceRatio }
        },
        tokenAddress
      );

      // Build formatted pool object
      const formattedPool = {
        address: pool.address,
        protocol: pool.protocol || 'PancakeSwap',
        type: pool.type,
        version: pool.version,
        pair: `${pool.token0?.symbol || 'UNKNOWN'}/${pool.token1?.symbol || 'UNKNOWN'}`,
        pairToken: pairToken,
        fee: pool.fee || (pool.feePercent ? pool.feePercent * 10000 : 3000),
        feePercent: pool.feePercent || (pool.fee ? pool.fee / 10000 : 0.3),
        liquidity: {
          status: pool.liquidity?.status || 'UNKNOWN',
          usd: pool.liquidity?.totalValueUSD || 0,
          bnb: pool.liquidity?.totalValueBNB || 0,
          token0: pool.token0Amount || pool.liquidity?.token0Amount || '0',
          token1: pool.token1Amount || pool.liquidity?.token1Amount || '0',
          raw: pool.liquidity?.raw || '0'
        },
        price: {
          token0: token0Price,
          token1: token1Price,
          ratio: priceRatio,
          raw: token1Price,
          source: priceSource,
          // Enhanced pricing
          inPairToken: comprehensivePrices.priceInPairToken,
          inBNB: comprehensivePrices.priceInBNB,
          inUSD: comprehensivePrices.priceInUSD,
          display: comprehensivePrices.displayPrice
        },
        token0: pool.token0,
        token1: pool.token1,
        isToken0: isToken0
      };

      // Add V3-specific fields
      if (pool.type === 'V3') {
        formattedPool.tick = pool.tick;
        formattedPool.sqrtPriceX96 = pool.sqrtPriceX96;
      }

      return formattedPool;
    });
  }

  analyzePoolData(pools, tokenInfo, aggregatePrices) {
    // Include both ACTIVE and WARNING_LIQUIDITY pools for analysis
    const activePools = pools.filter(p =>
      p.liquidity?.status === 'ACTIVE' || p.liquidity?.status === 'WARNING_LIQUIDITY'
    );
    
    const totalLiquidity = {
      usd: activePools.reduce((sum, p) => sum + (p.liquidity?.usd || 0), 0),
      bnb: activePools.reduce((sum, p) => sum + (p.liquidity?.eth || 0), 0)
    };

    // Group liquidity by protocol
    const liquidityByProtocol = {
      pancakeswap: activePools
        .filter(p => p.protocol === 'PancakeSwap' || !p.protocol)
        .reduce((sum, p) => sum + (p.liquidity?.usd || 0), 0)
    };

    const priceAnalysis = {
      averagePrice: {
        ratio: aggregatePrices.avgPriceUSD > 0 ? 
          pools.reduce((sum, p) => sum + (p.price?.ratio || 0), 0) / pools.length : 0,
        usd: aggregatePrices.avgPriceUSD,
        bnb: aggregatePrices.avgPriceBNB
      },
      priceRange: {
        usd: {
          min: aggregatePrices.minPriceUSD,
          max: aggregatePrices.maxPriceUSD,
          spread: aggregatePrices.maxPriceUSD - aggregatePrices.minPriceUSD
        },
        bnb: {
          min: aggregatePrices.minPriceBNB,
          max: aggregatePrices.maxPriceBNB,
          spread: aggregatePrices.maxPriceBNB - aggregatePrices.minPriceBNB
        }
      },
      bestPricePool: {
        byUSD: activePools.reduce((best, pool) => 
          (!best || pool.price.inUSD > best.price.inUSD) ? pool : best, null)?.address,
        byETH: activePools.reduce((best, pool) => 
          (!best || pool.price.inBNB > best.price.inBNB) ? pool : best, null)?.address
      }
    };

    return {
      totalLiquidity,
      liquidityByProtocol,
      priceAnalysis,
      liquidityDistribution: this.calculateLiquidityDistribution(activePools)
    };
  }

  calculateLiquidityDistribution(pools) {
    return {
      high: pools.filter(p => p.liquidity?.usd >= LIQUIDITY_THRESHOLDS.HIGH_LIQUIDITY_USD).length,
      medium: pools.filter(p => 
        p.liquidity?.usd >= LIQUIDITY_THRESHOLDS.WARNING_LIQUIDITY_USD && 
        p.liquidity?.usd < LIQUIDITY_THRESHOLDS.HIGH_LIQUIDITY_USD
      ).length,
      low: pools.filter(p => 
        p.liquidity?.usd >= LIQUIDITY_THRESHOLDS.MIN_LIQUIDITY_USD && 
        p.liquidity?.usd < LIQUIDITY_THRESHOLDS.WARNING_LIQUIDITY_USD
      ).length,
      veryLow: pools.filter(p => p.liquidity?.usd < LIQUIDITY_THRESHOLDS.MIN_LIQUIDITY_USD).length
    };
  }

  selectBestPools(pools) {
    // Include both ACTIVE ($1000+) and WARNING_LIQUIDITY ($100-$1000) pools
    // Exclude LOW_LIQUIDITY (<$100) pools entirely
    const activePools = pools.filter(p =>
      p.liquidity.status === 'ACTIVE' || p.liquidity.status === 'WARNING_LIQUIDITY'
    );
    
    if (activePools.length === 0) {
      return {
        byLiquidity: null,
        byPriceUSD: null,
        byPriceBNB: null,
        byFee: null,
        byProtocol: {
          pancakeswap: null
        },
        recommended: null
      };
    }

    const byLiquidity = [...activePools].sort((a, b) => {
      if (a.liquidity.usd > 0 || b.liquidity.usd > 0) {
        return b.liquidity.usd - a.liquidity.usd;
      }
      const aAmount = parseFloat(a.liquidity.token0) + parseFloat(a.liquidity.token1);
      const bAmount = parseFloat(b.liquidity.token0) + parseFloat(b.liquidity.token1);
      return bAmount - aAmount;
    })[0];

    const poolsWithUSDPrice = activePools.filter(p => p.price && p.price.inUSD > 0);
    const byPriceUSD = poolsWithUSDPrice.length > 0 
      ? [...poolsWithUSDPrice].sort((a, b) => b.price.inUSD - a.price.inUSD)[0]
      : null;

    const poolsWithETHPrice = activePools.filter(p => p.price && p.price.inBNB > 0);
    const byPriceBNB = poolsWithETHPrice.length > 0 
      ? [...poolsWithETHPrice].sort((a, b) => b.price.inBNB - a.price.inBNB)[0]
      : null;
      
    const byFee = [...activePools].sort((a, b) => a.fee - b.fee)[0];

    // Best by protocol
    const pancakeswapPools = activePools.filter(p => p.protocol === 'PancakeSwap' || !p.protocol);

    const byProtocol = {
      pancakeswap: pancakeswapPools.length > 0
        ? [...pancakeswapPools].sort((a, b) => b.liquidity.usd - a.liquidity.usd)[0]
        : null
    };
    
    const recommended = this.calculateRecommendedPool(activePools);

    return { byLiquidity, byPriceUSD, byPriceBNB, byFee, byProtocol, recommended };
  }

  /**
   * SMART POOL RECOMMENDATION - Default (no trade size known)
   * Uses balanced scoring when trade size is unknown
   */
  calculateRecommendedPool(pools) {
    // Default to medium trade assumption ($1000 USD)
    return this.calculateSmartRecommendation(pools, null);
  }

  /**
   * INTELLIGENT POOL SCORING WITH TRADE-SIZE AWARENESS
   *
   * Calculates the TOTAL COST of a swap including:
   * - Fee cost (what % the pool takes)
   * - Slippage cost (price impact from trade size vs liquidity)
   *
   * Formula: Total Cost = Fee% + Estimated Slippage%
   * Best pool = lowest total cost with acceptable risk
   */
  calculateSmartRecommendation(pools, tradeAmountUSD = null) {
    const bnbPrice = this.priceService.getBNBPrice() || 3600;

    // Classify trade size
    const tradeSize = tradeAmountUSD || 1000; // Default $1000
    const tradeSizeCategory = this.classifyTradeSize(tradeSize);

    const scoredPools = pools.map(pool => {
      const analysis = this.analyzePoolForTrade(pool, tradeSize, bnbPrice);
      return {
        ...pool,
        ...analysis
      };
    });

    // Sort by total cost (lowest = best), then by liquidity (highest = safest)
    const sorted = scoredPools
      .filter(p => p.tradeable) // Only tradeable pools
      .sort((a, b) => {
        // Primary: lower total cost wins
        if (Math.abs(a.totalCostPercent - b.totalCostPercent) > 0.01) {
          return a.totalCostPercent - b.totalCostPercent;
        }
        // Secondary: higher liquidity wins (safer)
        return (b.liquidity.usd || 0) - (a.liquidity.usd || 0);
      });

    if (sorted.length === 0) {
      return pools[0] ? { ...pools[0], score: 0, reason: 'No optimal pool found' } : null;
    }

    const best = sorted[0];

    // Enhanced UX: Create explicit score breakdown for transparency
    const scoreBreakdown = {
      totalScore: best.score,
      components: {
        feeCost: {
          value: best.costs?.feePercent || 0,
          weight: 30,
          description: `${(best.costs?.feePercent || 0).toFixed(2)}% pool fee`
        },
        slippage: {
          value: best.costs?.slippagePercent || 0,
          weight: 30,
          description: `${(best.costs?.slippagePercent || 0).toFixed(4)}% estimated slippage`
        },
        liquidity: {
          value: best.liquidityRatio || 0,
          weight: 25,
          description: `${(best.liquidityRatio || 0).toFixed(1)}x trade size coverage`
        },
        safety: {
          value: best.safety?.score || 100,
          weight: 15,
          description: best.safety?.warnings?.length > 0
            ? `${best.safety.warnings.length} warning(s): ${best.safety.warnings.join(', ')}`
            : 'No safety warnings'
        }
      },
      totalCostPercent: best.costs?.totalCostPercent || 0,
      whySelected: [
        `Lowest total cost: ${(best.costs?.totalCostPercent || 0).toFixed(4)}%`,
        `Risk level: ${best.riskLevel}`,
        best.liquidityRatio > 50 ? 'Deep liquidity' : best.liquidityRatio > 10 ? 'Good liquidity' : 'Moderate liquidity',
        'PancakeSwap protocol'
      ].filter(Boolean)
    };

    return {
      ...best,
      tradeSizeCategory,
      tradeAmountUSD: tradeSize,
      scoreBreakdown,
      // Summary fields for quick access
      priceUSD: best.price?.inUSD,
      priceBNB: best.price?.inBNB,
      liquidityUSD: best.liquidity?.usd
    };
  }

  /**
   * Analyze a single pool for a specific trade size
   * ENHANCED WITH SAFETY CHECKS
   */
  analyzePoolForTrade(pool, tradeAmountUSD, bnbPrice) {
    const liquidityUSD = pool.liquidity.usd || 0;
    const feePercent = (pool.fee || 3000) / 1000000; // Convert basis points to decimal (3000 = 0.3%)

    // ============ SAFETY CHECKS ============
    const safetyChecks = this.performSafetyChecks(pool, tradeAmountUSD, liquidityUSD, bnbPrice);

    // Calculate estimated slippage based on trade size vs liquidity
    let slippagePercent = this.estimateSlippage(pool, tradeAmountUSD, liquidityUSD, safetyChecks);

    // Add safety penalty to slippage if risks detected
    if (safetyChecks.priceDeviation > 5) {
      slippagePercent += safetyChecks.priceDeviation; // Add price deviation as extra slippage risk
    }

    // Total cost = fee + slippage
    const totalCostPercent = feePercent * 100 + slippagePercent;

    // Calculate actual costs in USD
    const feeCostUSD = tradeAmountUSD * feePercent;
    const slippageCostUSD = tradeAmountUSD * (slippagePercent / 100);
    const totalCostUSD = feeCostUSD + slippageCostUSD;

    // Determine if pool is tradeable (enhanced with safety checks)
    // CRITICAL: Pools with isUntradeable (rug pulls) are NEVER tradeable regardless of other factors
    const tradeable = !safetyChecks.isUntradeable &&
                      liquidityUSD > 0 &&
                      liquidityUSD >= tradeAmountUSD * 0.1 &&
                      safetyChecks.safetyScore >= 30; // Minimum safety threshold

    // Risk assessment (enhanced)
    const liquidityRatio = liquidityUSD / tradeAmountUSD;
    let riskLevel = this.calculateRiskLevel(liquidityRatio, safetyChecks, tradeAmountUSD);

    // Build reason string
    const reasons = [];
    if (feePercent <= 0.0001) reasons.push('Ultra-low fee (0.01%)');
    else if (feePercent <= 0.0005) reasons.push('Low fee (0.05%)');
    else if (feePercent <= 0.003) reasons.push('Standard fee (0.3%)');
    else reasons.push('High fee (1%)');

    if (slippagePercent < 0.1) reasons.push('Minimal slippage');
    else if (slippagePercent < 0.5) reasons.push('Low slippage');
    else if (slippagePercent < 1) reasons.push('Moderate slippage');
    else if (slippagePercent < 5) reasons.push('High slippage warning');
    else reasons.push('DANGEROUS slippage');

    if (liquidityRatio > 100) reasons.push('Deep liquidity');
    else if (liquidityRatio > 20) reasons.push('Good liquidity');
    else if (liquidityRatio < 5) reasons.push('LOW LIQUIDITY');

    if (pool.type === 'V3') reasons.push('Concentrated');

    // Add safety warnings to reasons
    if (safetyChecks.warnings.length > 0) {
      reasons.push(...safetyChecks.warnings);
    }

    // Calculate composite score (higher = better)
    // Penalize heavily for safety issues
    let score = Math.max(0, 100 - (totalCostPercent * 10) + (liquidityRatio > 50 ? 10 : 0));
    score = score * (safetyChecks.safetyScore / 100); // Apply safety multiplier

    // Calculate recommended minimum output (for slippage protection)
    const expectedOutput = tradeAmountUSD / (pool.price?.inUSD || 1);
    const minOutputPercent = Math.max(95, 100 - slippagePercent - 1); // At least 95% or (100 - slippage - 1% buffer)
    const recommendedMinOutput = expectedOutput * (minOutputPercent / 100);

    return {
      score: Math.round(score),
      reason: reasons.join(', '),
      tradeable,
      riskLevel,
      costs: {
        feePercent: feePercent * 100,
        slippagePercent,
        totalCostPercent,
        feeCostUSD: Math.round(feeCostUSD * 10000) / 10000,
        slippageCostUSD: Math.round(slippageCostUSD * 10000) / 10000,
        totalCostUSD: Math.round(totalCostUSD * 10000) / 10000
      },
      liquidityRatio: Math.round(liquidityRatio * 10) / 10,
      safety: {
        score: safetyChecks.safetyScore,
        warnings: safetyChecks.warnings,
        priceDeviation: safetyChecks.priceDeviation,
        sandwichRisk: safetyChecks.sandwichRisk,
        v3InRange: safetyChecks.v3InRange
      },
      protection: {
        recommendedMinOutputPercent: minOutputPercent,
        recommendedMinOutput: Math.round(recommendedMinOutput * 1000000) / 1000000,
        maxSlippageTolerance: Math.min(slippagePercent + 1, 10) // Recommended max slippage setting
      }
    };
  }

  /**
   * CRITICAL SAFETY CHECKS
   * Detect potential issues that could cause fund loss
   */
  performSafetyChecks(pool, tradeAmountUSD, liquidityUSD, bnbPrice) {
    const warnings = [];
    let safetyScore = 100;
    let isUntradeable = false;
    let priceDeviation = 0;
    let sandwichRisk = 'LOW';
    let v3InRange = true;

    // 1. V3 TICK RANGE CHECK - Is liquidity actually available at current price?
    if (pool.type === 'V3') {
      if (pool.tick !== undefined && pool.sqrtPriceX96) {
        // Check if pool has meaningful liquidity at current tick
        const liquidityRaw = BigInt(pool.liquidity?.raw || '0');
        if (liquidityRaw === 0n) {
          warnings.push('V3_NO_LIQUIDITY_IN_RANGE');
          safetyScore -= 50;
          v3InRange = false;
          isUntradeable = true;
        }
      }
    }

    // 2. PRICE DEVIATION CHECK - Compare pool price to aggregate/oracle price
    if (pool.price?.inUSD > 0) {
      const aggregatePrice = this.priceService.getAggregatePrice?.() || pool.price.inUSD;
      if (aggregatePrice > 0) {
        priceDeviation = Math.abs((pool.price.inUSD - aggregatePrice) / aggregatePrice) * 100;

        if (priceDeviation > 10) {
          warnings.push('PRICE_MANIPULATION_RISK');
          safetyScore -= 40;
        } else if (priceDeviation > 5) {
          warnings.push('PRICE_DEVIATION_HIGH');
          safetyScore -= 20;
        } else if (priceDeviation > 2) {
          warnings.push('PRICE_DEVIATION_MODERATE');
          safetyScore -= 5;
        }
      }
    }

    // 3. SANDWICH ATTACK RISK - Based on trade size vs liquidity
    const tradeToLiquidityRatio = tradeAmountUSD / (liquidityUSD || 1);
    if (tradeToLiquidityRatio > 0.1) { // Trade > 10% of pool
      sandwichRisk = 'CRITICAL';
      warnings.push('SANDWICH_ATTACK_CRITICAL');
      safetyScore -= 30;
    } else if (tradeToLiquidityRatio > 0.05) { // Trade > 5% of pool
      sandwichRisk = 'HIGH';
      warnings.push('SANDWICH_ATTACK_HIGH');
      safetyScore -= 15;
    } else if (tradeToLiquidityRatio > 0.01) { // Trade > 1% of pool
      sandwichRisk = 'MEDIUM';
    }

    // 4. LIQUIDITY DEPTH CHECK
    if (liquidityUSD < 1000) {
      warnings.push('EXTREMELY_LOW_LIQUIDITY');
      safetyScore -= 30;
    } else if (liquidityUSD < 10000) {
      warnings.push('LOW_LIQUIDITY');
      safetyScore -= 15;
    }

    // 4.5 RUG PULL DETECTION - Check if pair token (WBNB/USDC/etc) has near-zero reserves
    // This is CRITICAL: a rugged pool has tokens but no base liquidity to swap against
    // Fields may be token0/token1 or token0Amount/token1Amount depending on source
    const pairTokenAmount = pool.isToken0
      ? parseFloat(pool.liquidity?.token1 || pool.liquidity?.token1Amount || '0')
      : parseFloat(pool.liquidity?.token0 || pool.liquidity?.token0Amount || '0');
    const pairSymbol = pool.pairToken?.symbol?.toUpperCase();

    // Minimum pair token reserves (WBNB, USDC, CAKE, etc)
    const MIN_WBNB_RESERVE = 0.001;  // $3 minimum
    const MIN_USDC_RESERVE = 10;     // $10 minimum
    const MIN_CAKE_RESERVE = 5;      // ~$10 minimum
    const MIN_OTHER_RESERVE = 10;    // Generic minimum

    let minPairReserve = MIN_OTHER_RESERVE;
    if (pairSymbol === 'WBNB') minPairReserve = MIN_WBNB_RESERVE;
    else if (pairSymbol === 'USDC' || pairSymbol === 'USDT' || pairSymbol === 'BUSD') minPairReserve = MIN_USDC_RESERVE;
    else if (pairSymbol === 'CAKE') minPairReserve = MIN_CAKE_RESERVE;

    if (pairTokenAmount < minPairReserve) {
      warnings.push('RUG_PULL_DETECTED');
      safetyScore = 0; // Completely unsafe
      isUntradeable = true;
      this.logger?.warn?.(`RUG PULL: Pool ${pool.address} has only ${pairTokenAmount} ${pairSymbol} (min: ${minPairReserve})`);
    }

    // 5. STALE DATA CHECK - Warn if pool data might be stale
    if (pool.liquidity?.status !== 'ACTIVE') {
      warnings.push('POOL_INACTIVE');
      safetyScore -= 20;
    }

    // 6. PAIR TOKEN SAFETY - Prefer stable pairs for large trades
    // (pairSymbol already declared in section 4.5)
    const stableSymbols = ['USDC', 'USDT', 'DAI', 'USDBC', 'USDC.E'];
    const isStablePair = stableSymbols.includes(pairSymbol);

    if (tradeAmountUSD > 10000 && !isStablePair && pairSymbol !== 'WBNB') {
      warnings.push('VOLATILE_PAIR_FOR_LARGE_TRADE');
      safetyScore -= 10;
    }

    // 7. FEE ANOMALY CHECK
    if (pool.fee > 10000) { // > 1% fee is suspicious
      warnings.push('UNUSUALLY_HIGH_FEE');
      safetyScore -= 15;
    }

    return {
      safetyScore: Math.max(0, safetyScore),
      warnings,
      isUntradeable,
      priceDeviation: Math.round(priceDeviation * 100) / 100,
      sandwichRisk,
      v3InRange
    };
  }

  /**
   * Generate comprehensive warnings for the analysis response
   * Provides human-readable warnings with severity levels and suggestions
   */
  generateWarnings({ bestPools, formattedPools, aggregatePrices, pricesStale, timing, protocolStatus, hasPartialResults }) {
    const warnings = {
      items: [],
      count: 0,
      hasCritical: false,
      hasHigh: false
    };

    const addWarning = (code, severity, message, suggestion) => {
      warnings.items.push({ code, severity, message, suggestion });
      warnings.count++;
      if (severity === 'CRITICAL') warnings.hasCritical = true;
      if (severity === 'HIGH') warnings.hasHigh = true;
    };

    // 0. PARTIAL RESULTS WARNING (Graceful Degradation)
    if (hasPartialResults && protocolStatus) {
      const failedProtocols = Object.entries(protocolStatus)
        .filter(([_, status]) => status.status === 'failed')
        .map(([name]) => name);

      if (failedProtocols.length > 0) {
        addWarning(
          'PARTIAL_RESULTS',
          'MEDIUM',
          `Some protocols unavailable: ${failedProtocols.join(', ')}`,
          'Results may not include all available pools. Try again later for complete data.'
        );
      }
    }

    // 1. STALE PRICES WARNING
    if (pricesStale) {
      addWarning(
        'STALE_PRICES',
        'MEDIUM',
        'Price data may be stale (>30 seconds old)',
        'Consider refreshing with ?refresh=true for accurate pricing'
      );
    }

    // 2. SLOW RESPONSE WARNING
    if (timing.total > 2000) {
      addWarning(
        'SLOW_RESPONSE',
        'LOW',
        `Analysis took ${timing.total}ms (slower than usual)`,
        'RPC nodes may be congested. Prices are still accurate.'
      );
    }

    // 3. NO ACTIVE POOLS WARNING
    const activePools = formattedPools.filter(p =>
      p.liquidity?.status === 'ACTIVE' || p.liquidity?.status === 'WARNING_LIQUIDITY'
    );
    if (activePools.length === 0) {
      addWarning(
        'NO_ACTIVE_POOLS',
        'CRITICAL',
        'No active liquidity pools found for this token (all pools have <$100 liquidity)',
        'This token may be untradeable or have no meaningful liquidity'
      );
    }

    // 4. RUG PULL CHECK - Critical safety warning for rugged pools
    const ruggedPools = formattedPools.filter(p => {
      const pairAmount = p.isToken0
        ? parseFloat(p.liquidity?.token1 || p.liquidity?.token1Amount || '0')
        : parseFloat(p.liquidity?.token0 || p.liquidity?.token0Amount || '0');
      const targetTokenAmount = p.isToken0
        ? parseFloat(p.liquidity?.token0 || p.liquidity?.token0Amount || '0')
        : parseFloat(p.liquidity?.token1 || p.liquidity?.token1Amount || '0');
      const pairSymbol = p.pairToken?.symbol?.toUpperCase();
      const minReserve = pairSymbol === 'WBNB' ? 0.001 : 10;
      // Rug pull = has target token but no pair token to swap against
      return pairAmount < minReserve && targetTokenAmount > 0;
    });

    if (ruggedPools.length > 0) {
      addWarning(
        'RUG_PULL_DETECTED',
        'CRITICAL',
        `${ruggedPools.length} pool(s) appear to be rugged (pair token removed)`,
        'DANGER: These pools will take your funds but cannot give you tokens back. Avoid trading on them!'
      );
    }

    // 4b. V3 RUGGED POOLS - Pools with extreme tick values or zero liquidity
    const v3RuggedPools = formattedPools.filter(p =>
      p.type === 'V3' && (p.isRugged === true || p.liquidity?.status === 'RUGGED')
    );

    if (v3RuggedPools.length > 0) {
      addWarning(
        'V3_RUGGED_POOLS',
        'CRITICAL',
        `${v3RuggedPools.length} V3 pool(s) have removed liquidity (tick at boundary)`,
        'These pools show extreme tick values indicating all liquidity was withdrawn. Excluded from recommendations.'
      );
    }

    // 5. LOW LIQUIDITY WARNING (best pool)
    const recommended = bestPools?.recommended;
    if (recommended) {
      const liquidityUSD = recommended.liquidityUSD || recommended.liquidity?.usd || 0;

      if (liquidityUSD < 1000) {
        addWarning(
          'EXTREMELY_LOW_LIQUIDITY',
          'CRITICAL',
          `Best pool has only $${liquidityUSD.toLocaleString()} liquidity`,
          'High slippage expected. Consider smaller trade sizes or avoid trading.'
        );
      } else if (liquidityUSD < 10000) {
        addWarning(
          'LOW_LIQUIDITY',
          'HIGH',
          `Best pool has only $${liquidityUSD.toLocaleString()} liquidity`,
          'Significant slippage possible for trades over $100'
        );
      } else if (liquidityUSD < 50000) {
        addWarning(
          'MODERATE_LIQUIDITY',
          'MEDIUM',
          `Best pool has $${liquidityUSD.toLocaleString()} liquidity`,
          'May experience slippage on trades over $1,000'
        );
      }

      // 5. HIGH SLIPPAGE WARNING
      const slippage = recommended.costs?.slippagePercent || 0;
      if (slippage > 5) {
        addWarning(
          'EXTREME_SLIPPAGE',
          'CRITICAL',
          `Estimated slippage is ${slippage.toFixed(2)}%`,
          'Consider reducing trade size or using a different pool'
        );
      } else if (slippage > 2) {
        addWarning(
          'HIGH_SLIPPAGE',
          'HIGH',
          `Estimated slippage is ${slippage.toFixed(2)}%`,
          'Consider using a pool with more liquidity'
        );
      } else if (slippage > 1) {
        addWarning(
          'MODERATE_SLIPPAGE',
          'MEDIUM',
          `Estimated slippage is ${slippage.toFixed(2)}%`,
          'Slippage is above average but acceptable'
        );
      }

      // 6. SAFETY WARNINGS from recommended pool
      const safetyWarnings = recommended.safety?.warnings || [];
      for (const safetyWarn of safetyWarnings) {
        const warningInfo = this.mapSafetyWarning(safetyWarn);
        if (warningInfo) {
          addWarning(safetyWarn, warningInfo.severity, warningInfo.message, warningInfo.suggestion);
        }
      }

      // 7. RISK LEVEL WARNING
      if (recommended.riskLevel === 'CRITICAL') {
        addWarning(
          'RISK_CRITICAL',
          'CRITICAL',
          'This trade has critical risk factors',
          'Review all warnings carefully before proceeding'
        );
      } else if (recommended.riskLevel === 'HIGH') {
        addWarning(
          'RISK_HIGH',
          'HIGH',
          'This trade has elevated risk factors',
          'Consider splitting into smaller trades'
        );
      }
    }

    // 8. PRICE SPREAD WARNING
    if (aggregatePrices) {
      const priceSpread = aggregatePrices.maxPriceUSD - aggregatePrices.minPriceUSD;
      const avgPrice = aggregatePrices.avgPriceUSD || 1;
      const spreadPercent = (priceSpread / avgPrice) * 100;

      if (spreadPercent > 10) {
        addWarning(
          'HIGH_PRICE_SPREAD',
          'HIGH',
          `Price varies ${spreadPercent.toFixed(1)}% across pools`,
          'Significant arbitrage opportunity or manipulation risk'
        );
      } else if (spreadPercent > 5) {
        addWarning(
          'MODERATE_PRICE_SPREAD',
          'MEDIUM',
          `Price varies ${spreadPercent.toFixed(1)}% across pools`,
          'Some price discrepancy between pools'
        );
      }
    }

    // 9. LIMITED POOL OPTIONS
    if (activePools.length === 1) {
      addWarning(
        'SINGLE_POOL',
        'MEDIUM',
        'Only one active pool available for this token',
        'No alternative routing options if this pool has issues'
      );
    }

    // Sort warnings by severity
    const severityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    warnings.items.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    return warnings;
  }

  /**
   * Map safety warning codes to human-readable messages
   */
  mapSafetyWarning(code) {
    const mappings = {
      'V3_NO_LIQUIDITY_IN_RANGE': {
        severity: 'CRITICAL',
        message: 'V3 pool has no liquidity at current price',
        suggestion: 'This pool cannot execute trades at current price'
      },
      'PRICE_MANIPULATION_RISK': {
        severity: 'CRITICAL',
        message: 'Pool price deviates significantly from market (>10%)',
        suggestion: 'Possible price manipulation. Avoid this pool.'
      },
      'PRICE_DEVIATION_HIGH': {
        severity: 'HIGH',
        message: 'Pool price deviates >5% from market average',
        suggestion: 'Consider using a pool closer to market price'
      },
      'PRICE_DEVIATION_MODERATE': {
        severity: 'LOW',
        message: 'Pool price deviates slightly from market average',
        suggestion: 'Price difference is within acceptable range'
      },
      'SANDWICH_ATTACK_CRITICAL': {
        severity: 'CRITICAL',
        message: 'Trade is >10% of pool liquidity - high sandwich risk',
        suggestion: 'Split into smaller trades or use private mempool'
      },
      'SANDWICH_ATTACK_HIGH': {
        severity: 'HIGH',
        message: 'Trade is >5% of pool liquidity - elevated sandwich risk',
        suggestion: 'Consider splitting trade or using MEV protection'
      },
      'EXTREMELY_LOW_LIQUIDITY': {
        severity: 'CRITICAL',
        message: 'Pool has less than $1,000 liquidity',
        suggestion: 'Extremely high slippage expected'
      },
      'LOW_LIQUIDITY': {
        severity: 'HIGH',
        message: 'Pool has less than $10,000 liquidity',
        suggestion: 'High slippage expected for larger trades'
      },
      'POOL_INACTIVE': {
        severity: 'HIGH',
        message: 'Pool appears to be inactive or empty',
        suggestion: 'Use a different pool for trading'
      },
      'VOLATILE_PAIR_FOR_LARGE_TRADE': {
        severity: 'MEDIUM',
        message: 'Large trade with volatile pair token',
        suggestion: 'Consider using WBNB or stablecoin pairs for large trades'
      },
      'UNUSUALLY_HIGH_FEE': {
        severity: 'HIGH',
        message: 'Pool has unusually high fees (>1%)',
        suggestion: 'Look for a lower-fee pool option'
      }
    };

    return mappings[code] || null;
  }

  /**
   * Calculate comprehensive risk level
   */
  calculateRiskLevel(liquidityRatio, safetyChecks, tradeAmountUSD) {
    // Start with liquidity-based risk
    let riskLevel = 'LOW';
    if (liquidityRatio < 5) riskLevel = 'HIGH';
    else if (liquidityRatio < 20) riskLevel = 'MEDIUM';

    // Upgrade risk based on safety checks
    if (safetyChecks.safetyScore < 50) riskLevel = 'CRITICAL';
    else if (safetyChecks.safetyScore < 70 && riskLevel !== 'CRITICAL') riskLevel = 'HIGH';
    else if (safetyChecks.safetyScore < 85 && riskLevel === 'LOW') riskLevel = 'MEDIUM';

    // Sandwich risk override
    if (safetyChecks.sandwichRisk === 'CRITICAL') riskLevel = 'CRITICAL';
    else if (safetyChecks.sandwichRisk === 'HIGH' && riskLevel !== 'CRITICAL') riskLevel = 'HIGH';

    // Large trade risk
    if (tradeAmountUSD > 50000 && riskLevel === 'LOW') riskLevel = 'MEDIUM';

    return riskLevel;
  }

  /**
   * Estimate slippage based on pool type and trade size
   * Uses different formulas for V2 (constant product) vs V3 (concentrated)
   */
  estimateSlippage(pool, tradeAmountUSD, liquidityUSD, safetyChecks = null) {
    if (liquidityUSD <= 0) return 100; // 100% slippage = untradeable

    // If V3 and out of range, massive slippage
    if (safetyChecks && !safetyChecks.v3InRange) {
      return 50; // 50% slippage penalty for out-of-range V3
    }

    const tradeRatio = tradeAmountUSD / liquidityUSD;

    if (pool.type === 'V2') {
      // V2 Constant Product: slippage ≈ tradeSize / (2 * liquidity) * 100
      // For x*y=k, price impact ≈ Δx / (x + Δx)
      // Simplified: slippage% ≈ (trade / liquidity) * 50
      return tradeRatio * 50;
    }
    else if (pool.type === 'V3') {
      // V3 Concentrated: much better slippage if in range
      // Typical V3 pool has 3-10x capital efficiency
      // slippage ≈ tradeSize / (liquidity * efficiency_factor) * 100
      const efficiencyFactor = 5; // Conservative estimate
      return (tradeRatio / efficiencyFactor) * 50;
    }

    // Fallback
    return tradeRatio * 50;
  }

  /**
   * Classify trade size for appropriate pool selection strategy
   */
  classifyTradeSize(amountUSD) {
    if (amountUSD < 100) return 'MICRO'; // < $100: fees matter most
    if (amountUSD < 1000) return 'SMALL'; // $100-1K: balanced
    if (amountUSD < 10000) return 'MEDIUM'; // $1K-10K: liquidity starts mattering
    if (amountUSD < 100000) return 'LARGE'; // $10K-100K: liquidity critical
    return 'WHALE'; // > $100K: need deep liquidity, may need split
  }

  /**
   * FAST TRADE-SIZE-AWARE RECOMMENDATION
   * Call this after pool analysis is cached for instant recommendations
   *
   * @param {string} tokenAddress - The token to get recommendations for
   * @param {number} tradeAmountUSD - The trade size in USD
   * @param {boolean} useCache - Whether to use cached analysis (default true)
   * @returns {Object} Best pool recommendation with cost breakdown
   */
  async getSmartRecommendation(tokenAddress, tradeAmountUSD, useCache = true) {
    const startTime = Date.now();

    // Get or fetch analysis
    let analysis;
    if (useCache) {
      analysis = this.cache.getAnalysis(tokenAddress);
    }

    if (!analysis) {
      analysis = await this.analyzeToken(tokenAddress, false);
    }

    if (!analysis || !analysis.pools || analysis.pools.length === 0) {
      return { error: 'No pools found for token', tokenAddress };
    }

    // Filter to tradeable pools only (ACTIVE or WARNING_LIQUIDITY, min $100 USD)
    const activePools = analysis.pools.filter(p =>
      p.liquidity && (p.liquidity.status === 'ACTIVE' || p.liquidity.status === 'WARNING_LIQUIDITY')
    );

    // Get smart recommendation for this trade size
    const recommendation = this.calculateSmartRecommendation(activePools, tradeAmountUSD);

    // Also get top 3 alternatives
    const allScored = activePools.map(pool => {
      const poolAnalysis = this.analyzePoolForTrade(pool, tradeAmountUSD, this.priceService.getBNBPrice() || 3600);
      return { ...pool, ...poolAnalysis };
    })
    .filter(p => p.tradeable)
    .sort((a, b) => a.totalCostPercent - b.totalCostPercent);

    const alternatives = allScored.slice(1, 4).map(p => ({
      address: p.address,
      protocol: p.protocol,
      type: p.type,
      pair: p.pair,
      fee: p.fee,
      feePercent: p.feePercent,
      liquidityUSD: Math.round(p.liquidity.usd || 0),
      costs: p.costs,
      riskLevel: p.riskLevel,
      reason: p.reason
    }));

    const processingTime = Date.now() - startTime;

    return {
      token: {
        address: tokenAddress,
        symbol: analysis.token?.symbol,
        name: analysis.token?.name
      },
      tradeInfo: {
        amountUSD: tradeAmountUSD,
        sizeCategory: recommendation.tradeSizeCategory
      },
      recommended: {
        address: recommendation.address,
        protocol: recommendation.protocol,
        type: recommendation.type,
        pair: recommendation.pair,
        fee: recommendation.fee,
        feePercent: recommendation.feePercent,
        liquidityUSD: Math.round(recommendation.liquidity?.usd || 0),
        costs: recommendation.costs,
        riskLevel: recommendation.riskLevel,
        score: recommendation.score,
        reason: recommendation.reason,
        price: recommendation.price
      },
      alternatives,
      summary: {
        totalPoolsAnalyzed: activePools.length,
        tradeablePoolCount: allScored.length,
        bestTotalCost: recommendation.costs?.totalCostPercent
          ? `${recommendation.costs.totalCostPercent.toFixed(4)}%`
          : 'N/A',
        estimatedCostUSD: recommendation.costs?.totalCostUSD
          ? `$${recommendation.costs.totalCostUSD.toFixed(4)}`
          : 'N/A'
      },
      processingTimeMs: processingTime,
      cached: useCache && !!this.cache.getAnalysis(tokenAddress)
    };
  }

  /**
   * ULTRA-FAST SWAP POOL RECOMMENDATION
   *
   * Designed for swap service - uses ONLY cached data for instant response.
   * Call this AFTER user has already viewed token analysis (which cached the pools).
   *
   * Flow:
   * 1. User searches token → analyzeToken() runs → pools cached (2-5 sec)
   * 2. User decides to swap → getSwapRecommendation() → INSTANT (<20ms)
   *
   * @param {string} tokenAddress - Token to swap
   * @param {number} tradeAmountBNB - Amount in BNB (not USD)
   * @returns {Object} Best pool for swap with all needed data
   */
  getSwapRecommendation(tokenAddress, tradeAmountBNB) {
    const startTime = Date.now();

    try {
      tokenAddress = require('ethers').getAddress(tokenAddress);
    } catch (e) {
      return { error: 'Invalid token address', fast: true, processingTimeMs: Date.now() - startTime };
    }

    // Get cached analysis - NO AWAIT, pure sync cache lookup
    const analysis = this.cache.getAnalysis(tokenAddress);

    if (!analysis) {
      return {
        error: 'TOKEN_NOT_CACHED',
        message: 'Token not in cache. Call /api/analyze/:token first.',
        suggestion: 'User must view token details before swapping',
        fast: true,
        processingTimeMs: Date.now() - startTime
      };
    }

    // Get BNB price - CRITICAL: Must have valid price
    const bnbPrice = this.priceService.getBNBPrice();
    if (!bnbPrice || bnbPrice <= 0) {
      return {
        error: 'ETH_PRICE_UNAVAILABLE',
        message: 'Cannot get current BNB price. Try again in a few seconds.',
        fast: true,
        processingTimeMs: Date.now() - startTime
      };
    }

    // Check if price is stale (> 60 seconds old)
    const priceStale = this.priceService.arePricesStale?.() ?? false;

    const tradeAmountUSD = tradeAmountBNB * bnbPrice;

    // MAX TRADE LIMIT - Protect against whale trades that will fail
    const MAX_SINGLE_TRADE_USD = 500000; // $500K max
    if (tradeAmountUSD > MAX_SINGLE_TRADE_USD) {
      return {
        error: 'TRADE_TOO_LARGE',
        message: `Trade of $${Math.round(tradeAmountUSD).toLocaleString()} exceeds maximum single trade of $${MAX_SINGLE_TRADE_USD.toLocaleString()}`,
        suggestion: 'Use /api/split-trade/:token for large trades',
        maxTradeUSD: MAX_SINGLE_TRADE_USD,
        requestedTradeUSD: tradeAmountUSD,
        fast: true,
        processingTimeMs: Date.now() - startTime
      };
    }

    // Filter tradeable pools (ACTIVE or WARNING_LIQUIDITY, min $100 USD)
    const activePools = (analysis.pools || []).filter(p =>
      p.liquidity && (p.liquidity.status === 'ACTIVE' || p.liquidity.status === 'WARNING_LIQUIDITY')
    );

    if (activePools.length === 0) {
      return {
        error: 'NO_ACTIVE_POOLS',
        message: 'No active pools found for this token (all pools have <$100 liquidity)',
        fast: true,
        processingTimeMs: Date.now() - startTime
      };
    }

    // Calculate best pool (pure math - no RPC calls)
    // NOTE: This already calls performSafetyChecks internally via analyzePoolForTrade
    const recommendation = this.calculateSmartRecommendation(activePools, tradeAmountUSD);

    // Use safety info from recommendation (already calculated, don't call twice!)
    // Note: recommendation.safety.score (not safetyScore) - from analyzePoolForTrade()
    const safetyChecks = {
      safetyScore: recommendation.safety?.score ?? 100,
      warnings: recommendation.safety?.warnings || [],
      sandwichRisk: recommendation.safety?.sandwichRisk || 'LOW',
      priceDeviation: recommendation.safety?.priceDeviation || 0,
      v3InRange: recommendation.safety?.v3InRange
    };

    // Calculate protection values
    const slippagePercent = recommendation.costs?.slippagePercent || 0.5;
    const feePercent = recommendation.costs?.feePercent || 0.3;
    const totalCostPercent = slippagePercent + feePercent;

    // Min output protection: account for slippage + buffer
    const minOutputPercent = Math.max(95, 100 - totalCostPercent - 1); // 1% buffer

    // CRITICAL RISK CHECK - Block unsafe swaps
    const riskLevel = recommendation.riskLevel || 'LOW';
    if (riskLevel === 'CRITICAL' || safetyChecks.safetyScore < 30) {
      return {
        success: false,
        blocked: true,
        fast: true,
        processingTimeMs: Date.now() - startTime,
        error: 'SWAP_BLOCKED_UNSAFE',
        message: 'This swap is blocked due to critical safety risks',
        reasons: safetyChecks.warnings || [],
        riskLevel: 'CRITICAL',
        safetyScore: safetyChecks.safetyScore,
        suggestion: 'Try a smaller trade amount or wait for better liquidity conditions'
      };
    }

    // Calculate estimated output tokens
    const tokenPriceUSD = recommendation.price?.usd || analysis.pricing?.currentPrice?.usd || 0;
    const estimatedOutputBeforeCosts = tokenPriceUSD > 0 ? tradeAmountUSD / tokenPriceUSD : 0;
    const estimatedOutputAfterCosts = estimatedOutputBeforeCosts * (1 - totalCostPercent / 100);
    const minOutputTokens = estimatedOutputAfterCosts * (minOutputPercent / 100);

    const processingTime = Date.now() - startTime;

    return {
      success: true,
      fast: true,
      processingTimeMs: processingTime,

      // Token info
      token: {
        address: tokenAddress,
        symbol: analysis.token?.symbol,
        name: analysis.token?.name,
        decimals: analysis.token?.decimals
      },

      // Trade info
      trade: {
        amountBNB: tradeAmountBNB,
        amountUSD: Math.round(tradeAmountUSD * 100) / 100,
        sizeCategory: recommendation.tradeSizeCategory,
        bnbPrice: bnbPrice
      },

      // BEST POOL - all data needed for swap
      pool: {
        address: recommendation.address,
        protocol: recommendation.protocol,
        type: recommendation.type,
        pair: recommendation.pair,
        pairToken: recommendation.pairToken || this.extractPairToken(recommendation),
        fee: recommendation.fee,
        feePercent: recommendation.feePercent,
        tickSpacing: recommendation.tickSpacing || null, // For V3 routing
        liquidityUSD: Math.round(recommendation.liquidity?.usd || 0)
      },

      // MULTI-HOP ROUTING - For stable pair pools that need BNB→STABLE→TOKEN
      routing: this.getRoutingInfo(recommendation, tokenAddress, analysis.token?.symbol),

      // Price info
      price: {
        tokenPriceUSD: tokenPriceUSD,
        tokenPriceBNB: recommendation.price?.eth || analysis.pricing?.currentPrice?.eth,
        source: recommendation.protocol,
        stale: priceStale // Warning if price data is old
      },

      // ESTIMATED OUTPUT - What user will receive
      output: {
        estimatedTokens: Math.round(estimatedOutputAfterCosts * 1000000) / 1000000,
        minTokens: Math.round(minOutputTokens * 1000000) / 1000000,
        tokenSymbol: analysis.token?.symbol
      },

      // Cost breakdown
      costs: {
        feePercent: Math.round(feePercent * 10000) / 10000,
        slippagePercent: Math.round(slippagePercent * 10000) / 10000,
        totalCostPercent: Math.round(totalCostPercent * 10000) / 10000,
        totalCostUSD: Math.round(tradeAmountUSD * totalCostPercent / 100 * 100) / 100
      },

      // Safety
      safety: {
        riskLevel: riskLevel,
        safetyScore: safetyChecks.safetyScore,
        warnings: safetyChecks.warnings || [],
        sandwichRisk: safetyChecks.sandwichRisk || 'LOW',
        priceDeviation: safetyChecks.priceDeviation || 0
      },

      // Protection settings for swap execution
      protection: {
        minOutputPercent: minOutputPercent,
        minOutputTokens: Math.round(minOutputTokens * 1000000) / 1000000,
        recommendedSlippageTolerance: Math.min(Math.ceil(totalCostPercent + 0.5), 5),
        maxSlippageTolerance: Math.min(Math.ceil(totalCostPercent * 2), 10)
      },

      // Cache info
      cache: {
        age: analysis.timestamp ? Date.now() - new Date(analysis.timestamp).getTime() : 0,
        fresh: analysis.timestamp ? (Date.now() - new Date(analysis.timestamp).getTime()) < 120000 : false
      }
    };
  }

  /**
   * Extract pair token address from pool data
   */
  extractPairToken(pool) {
    // Try to get from reserves
    if (pool.reserves) {
      const tokens = Object.keys(pool.reserves);
      // Return the non-WBNB token, or first token
      const wbnbAddresses = [
        '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // BSC WBNB
        '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'  // Mainnet WBNB (unused)
      ];
      return tokens.find(t => !wbnbAddresses.includes(t.toLowerCase())) || tokens[0];
    }
    return null;
  }

  /**
   * Get routing information for multi-hop swaps
   * Determines if BNB→TOKEN needs to go through a stablecoin intermediate
   */
  getRoutingInfo(pool, tokenAddress, tokenSymbol = null) {
    const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
    const stablecoins = {
      '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d': { symbol: 'USDC', decimals: 18 },
      '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56': { symbol: 'BUSD', decimals: 18 },
      '0x55d398326f99059fF775485246999027B3197955': { symbol: 'USDT', decimals: 18 },
      '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3': { symbol: 'DAI', decimals: 18 }
    };

    const pairTokenAddress = pool.pairToken?.address?.toLowerCase();

    // Get the target token symbol from pair string or passed parameter
    // Pair format can be "TOKEN/WBNB" or "WBNB/TOKEN" - get the non-WBNB symbol
    const pairParts = pool.pair?.split('/') || [];
    const targetSymbol = tokenSymbol ||
      (pairParts[0] !== 'WBNB' && pairParts[0] !== pool.pairToken?.symbol ? pairParts[0] : pairParts[1]) ||
      'TOKEN';

    // Check if pair is a stablecoin (not WBNB)
    if (pairTokenAddress && pairTokenAddress !== WBNB.toLowerCase() && stablecoins[pairTokenAddress]) {
      const stable = stablecoins[pairTokenAddress];

      // Need multi-hop: BNB → STABLE → TOKEN
      return {
        type: 'MULTI_HOP',
        hops: 2,
        path: [
          { token: WBNB, symbol: 'WBNB' },
          { token: pool.pairToken.address, symbol: stable.symbol },
          { token: tokenAddress, symbol: targetSymbol }
        ],
        // For V3/Slipstream routing
        firstLegTickSpacing: 1,  // BNB-USDC typical tick spacing
        secondLegTickSpacing: pool.tickSpacing || 200,
        intermediateToken: pool.pairToken.address,
        reason: `Best pool is ${pool.pair}, requires ${stable.symbol} intermediate`
      };
    }

    // Direct swap: BNB → TOKEN
    return {
      type: 'DIRECT',
      hops: 1,
      path: [
        { token: WBNB, symbol: 'WBNB' },
        { token: tokenAddress, symbol: targetSymbol }
      ],
      tickSpacing: pool.tickSpacing || null
    };
  }

  /**
   * Compare multiple trade sizes to show how pool selection changes
   */
  async compareTradeScenarios(tokenAddress, tradeSizes = [100, 1000, 10000, 50000]) {
    const analysis = await this.analyzeToken(tokenAddress, false);

    if (!analysis || !analysis.pools) {
      return { error: 'No pools found', tokenAddress };
    }

    const activePools = analysis.pools.filter(p =>
      p.liquidity && (p.liquidity.status === 'ACTIVE' || p.liquidity.status === 'WARNING_LIQUIDITY')
    );

    const scenarios = tradeSizes.map(size => {
      const rec = this.calculateSmartRecommendation(activePools, size);
      return {
        tradeAmountUSD: size,
        sizeCategory: rec.tradeSizeCategory,
        bestPool: {
          address: rec.address,
          protocol: rec.protocol,
          type: rec.type,
          pair: rec.pair,
          fee: rec.fee,
          liquidityUSD: Math.round(rec.liquidity?.usd || 0)
        },
        costs: rec.costs,
        riskLevel: rec.riskLevel
      };
    });

    return {
      token: {
        address: tokenAddress,
        symbol: analysis.token?.symbol
      },
      scenarios,
      insight: this.generateTradeInsight(scenarios)
    };
  }

  /**
   * Generate human-readable insight about trade scenarios
   */
  generateTradeInsight(scenarios) {
    const insights = [];

    // Check if pool changes with size
    const uniquePools = [...new Set(scenarios.map(s => s.bestPool.address))];
    if (uniquePools.length > 1) {
      insights.push('Pool recommendation changes with trade size - larger trades need more liquidity');
    } else {
      insights.push(`${scenarios[0].bestPool.pair} pool is optimal across all trade sizes`);
    }

    // Check cost progression
    const smallCost = scenarios[0]?.costs?.totalCostPercent || 0;
    const largeCost = scenarios[scenarios.length - 1]?.costs?.totalCostPercent || 0;
    if (largeCost > smallCost * 2) {
      insights.push('Large trades have significantly higher costs due to slippage');
    }

    // Risk check
    const highRiskScenarios = scenarios.filter(s => s.riskLevel === 'HIGH' || s.riskLevel === 'CRITICAL');
    if (highRiskScenarios.length > 0) {
      const threshold = highRiskScenarios[0].tradeAmountUSD;
      insights.push(`Trades above $${threshold.toLocaleString()} have elevated slippage risk`);
    }

    return insights;
  }

  /**
   * SPLIT TRADE RECOMMENDATION
   * For large trades, recommend splitting across multiple pools to minimize slippage
   *
   * @param {string} tokenAddress - Token to trade
   * @param {number} totalAmountUSD - Total trade size in USD
   * @returns {Object} Split trade recommendation
   */
  async calculateSplitTrade(tokenAddress, totalAmountUSD) {
    const analysis = await this.analyzeToken(tokenAddress, false);

    if (!analysis || !analysis.pools) {
      return { error: 'No pools found', tokenAddress };
    }

    // For split trades, require higher liquidity - only ACTIVE pools ($1000+ USD)
    const activePools = analysis.pools.filter(p =>
      p.liquidity && p.liquidity.status === 'ACTIVE'
    );

    const bnbPrice = this.priceService.getBNBPrice() || 3600;

    // Score all pools for this trade
    const scoredPools = activePools.map(pool => {
      const poolAnalysis = this.analyzePoolForTrade(pool, totalAmountUSD, bnbPrice);
      return { ...pool, ...poolAnalysis };
    })
    .filter(p => p.tradeable && (p.safety?.score || 0) >= 50)
    .sort((a, b) => a.costs.totalCostPercent - b.costs.totalCostPercent);

    if (scoredPools.length === 0) {
      return {
        error: 'No safe tradeable pools found',
        tokenAddress,
        totalAmountUSD
      };
    }

    // Calculate single trade cost
    const singleTradePool = scoredPools[0];
    const singleTradeCost = singleTradePool.costs.totalCostUSD;

    // Calculate optimal split
    const splitRecommendation = this.optimizeSplit(scoredPools, totalAmountUSD, bnbPrice);

    // Determine if split is worth it
    const splitSavings = singleTradeCost - splitRecommendation.totalCost;
    const splitRecommended = splitSavings > 1 && splitRecommendation.splits.length > 1;

    return {
      token: {
        address: tokenAddress,
        symbol: analysis.token?.symbol,
        name: analysis.token?.name
      },
      totalAmountUSD,
      singleTrade: {
        pool: {
          address: singleTradePool.address,
          protocol: singleTradePool.protocol,
          type: singleTradePool.type,
          pair: singleTradePool.pair,
          liquidityUSD: Math.round(singleTradePool.liquidity?.usd || 0)
        },
        costs: singleTradePool.costs,
        riskLevel: singleTradePool.riskLevel,
        safety: singleTradePool.safety,
        protection: singleTradePool.protection
      },
      splitTrade: splitRecommended ? {
        recommended: true,
        savings: Math.round(splitSavings * 100) / 100,
        savingsPercent: Math.round((splitSavings / singleTradeCost) * 10000) / 100,
        splits: splitRecommendation.splits,
        totalCost: Math.round(splitRecommendation.totalCost * 100) / 100,
        riskLevel: splitRecommendation.worstRisk
      } : {
        recommended: false,
        reason: 'Single trade is more efficient for this amount'
      },
      insight: this.generateSplitInsight(totalAmountUSD, singleTradePool, splitRecommendation, splitRecommended)
    };
  }

  /**
   * Optimize trade split across multiple pools
   */
  optimizeSplit(scoredPools, totalAmountUSD, bnbPrice) {
    const splits = [];
    let remainingAmount = totalAmountUSD;
    let totalCost = 0;
    let worstRisk = 'LOW';

    // Strategy: Allocate to pools based on their capacity
    // Don't put more than 5% of a pool's liquidity in one trade (to minimize sandwich risk)
    const maxPoolAllocation = 0.05;

    for (const pool of scoredPools) {
      if (remainingAmount <= 0) break;

      const poolLiquidity = pool.liquidity?.usd || 0;
      const maxAllocation = poolLiquidity * maxPoolAllocation;

      // Allocate either remaining amount or max safe allocation
      const allocation = Math.min(remainingAmount, maxAllocation, totalAmountUSD * 0.5); // Max 50% per pool

      if (allocation < 100) continue; // Skip if allocation is too small

      // Recalculate costs for this specific allocation
      const poolAnalysis = this.analyzePoolForTrade(pool, allocation, bnbPrice);

      splits.push({
        pool: {
          address: pool.address,
          protocol: pool.protocol,
          type: pool.type,
          pair: pool.pair,
          liquidityUSD: Math.round(poolLiquidity)
        },
        allocationUSD: Math.round(allocation),
        allocationPercent: Math.round((allocation / totalAmountUSD) * 100),
        costs: poolAnalysis.costs,
        riskLevel: poolAnalysis.riskLevel,
        safety: poolAnalysis.safety
      });

      remainingAmount -= allocation;
      totalCost += poolAnalysis.costs.totalCostUSD;

      // Track worst risk
      if (poolAnalysis.riskLevel === 'CRITICAL') worstRisk = 'CRITICAL';
      else if (poolAnalysis.riskLevel === 'HIGH' && worstRisk !== 'CRITICAL') worstRisk = 'HIGH';
      else if (poolAnalysis.riskLevel === 'MEDIUM' && worstRisk === 'LOW') worstRisk = 'MEDIUM';
    }

    // If we couldn't allocate everything safely
    if (remainingAmount > 100) {
      splits.push({
        warning: 'REMAINING_UNALLOCATED',
        remainingUSD: Math.round(remainingAmount),
        reason: 'Insufficient safe liquidity for full trade'
      });
      worstRisk = 'CRITICAL';
    }

    return {
      splits,
      totalCost,
      worstRisk,
      fullyAllocated: remainingAmount <= 100
    };
  }

  /**
   * Generate insight for split trade recommendation
   */
  generateSplitInsight(totalAmountUSD, singleTradePool, splitRecommendation, splitRecommended) {
    const insights = [];

    const liquidityRatio = (singleTradePool.liquidity?.usd || 0) / totalAmountUSD;

    if (liquidityRatio < 5) {
      insights.push(`Trade is ${Math.round((totalAmountUSD / (singleTradePool.liquidity?.usd || 1)) * 100)}% of best pool liquidity - HIGH IMPACT`);
    }

    if (splitRecommended && splitRecommendation.splits.length > 1) {
      insights.push(`Splitting across ${splitRecommendation.splits.length} pools saves ~$${Math.round((singleTradePool.costs.totalCostUSD - splitRecommendation.totalCost) * 100) / 100}`);
    }

    if (totalAmountUSD > 50000) {
      insights.push('Consider using private mempool (Flashbots) to prevent sandwich attacks');
    }

    if (singleTradePool.safety?.sandwichRisk === 'CRITICAL' || singleTradePool.safety?.sandwichRisk === 'HIGH') {
      insights.push('HIGH MEV/Sandwich attack risk - use low slippage tolerance and private RPC');
    }

    if (!splitRecommendation.fullyAllocated) {
      insights.push('CRITICAL: Insufficient liquidity for safe execution - consider smaller trade');
    }

    return insights;
  }

  async comparePoolsForSwap(tokenIn, tokenOut, amountIn) {
    const [tokenInInfo, tokenOutInfo] = await Promise.all([
      this.tokenService.getTokenInfo(tokenIn),
      this.tokenService.getTokenInfo(tokenOut)
    ]);

    const [analysisIn, analysisOut] = await Promise.all([
      this.analyzeToken(tokenIn),
      this.analyzeToken(tokenOut)
    ]);

    const commonPools = analysisIn.pools.filter(poolIn => {
      return analysisOut.pools.some(poolOut => 
        poolIn.address.toLowerCase() === poolOut.address.toLowerCase()
      );
    });

    if (commonPools.length === 0) {
      return {
        tokenIn: tokenInInfo,
        tokenOut: tokenOutInfo,
        bestPool: null,
        pools: [],
        message: 'No direct pools found for this pair'
      };
    }

    const poolsWithSimulation = await Promise.all(
      commonPools.map(async (pool) => {
        try {
          let simulation;

          // Route to appropriate service for simulation (BSC: PancakeSwap V2/V3)
          if (pool.type === 'V2') {
            simulation = await this.v2PoolService.simulateSwap(
              pool.address,
              tokenIn,
              amountIn
            );
          } else {
            simulation = await this.v3PoolService.simulateSwap(
              pool.address,
              tokenIn,
              amountIn
            );
          }

          return {
            ...pool,
            simulation
          };
        } catch (error) {
          this.logger.debug(`Simulation failed: ${error.message}`);
          return null;
        }
      })
    );

    const validPools = poolsWithSimulation.filter(p => p && p.simulation);
    
    const bestPool = validPools.sort((a, b) => 
      BigInt(b.simulation.amountOut) - BigInt(a.simulation.amountOut)
    )[0];

    return {
      tokenIn: tokenInInfo,
      tokenOut: tokenOutInfo,
      bestPool,
      pools: validPools
    };
  }
}

// Singleton instance  
let poolAnalyzerInstance = null;

module.exports = {
  getPoolAnalyzer: () => {
    if (!poolAnalyzerInstance) {
      poolAnalyzerInstance = new PoolAnalyzer();
    }
    return poolAnalyzerInstance;
  }
};
