// src/services/MulticallService.js
// High-performance batch RPC queries using Multicall3

const { ethers } = require('ethers');
const { getProviderService } = require('./ProviderService');
const { getLogger } = require('../utils/Logger');
const { CONTRACTS } = require('../config/constants');

// Multicall3 is deployed at same address on all chains
const MULTICALL3_ADDRESS = CONTRACTS.MULTICALL3 || '0xcA11bde05977b3631167028862bE2a173976CA11';

const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) external payable returns (tuple(bool success, bytes returnData)[])',
  'function aggregate3Value(tuple(address target, bool allowFailure, uint256 value, bytes callData)[] calls) external payable returns (tuple(bool success, bytes returnData)[])',
];

// Common ABIs for encoding
const FACTORY_V2_ABI = ['function getPair(address, address) view returns (address)'];
const FACTORY_V3_ABI = ['function getPool(address, address, uint24) view returns (address)'];
const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
];
const V2_PAIR_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112, uint112, uint32)',
];
const V3_POOL_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)',
];

class MulticallService {
  constructor() {
    this.providerService = getProviderService();
    this.logger = getLogger();
    this.multicall = null;

    // In-memory token info cache (1 hour TTL)
    this.tokenInfoCache = new Map();
    this.tokenInfoCacheTTL = 3600 * 1000; // 1 hour in ms

    // Pre-populated common BSC tokens (never need to fetch these)
    this.knownTokens = {
      '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c': { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', name: 'Wrapped BNB', symbol: 'WBNB', decimals: 18 },
      '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d': { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', name: 'USD Coin', symbol: 'USDC', decimals: 18 },
      '0xe9e7cea3dedca5984780bafc599bd69add087d56': { address: '0xe9e7cea3dedca5984780bafc599bd69add087d56', name: 'Binance USD', symbol: 'BUSD', decimals: 18 },
      '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82': { address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', name: 'PancakeSwap Token', symbol: 'CAKE', decimals: 18 },
      '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3': { address: '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3', name: 'Dai Stablecoin', symbol: 'DAI', decimals: 18 },
      '0x55d398326f99059ff775485246999027b3197955': { address: '0x55d398326f99059ff775485246999027b3197955', name: 'Tether USD', symbol: 'USDT', decimals: 18 },
    };

    // Interfaces for encoding/decoding
    this.interfaces = {
      factoryV2: new ethers.Interface(FACTORY_V2_ABI),
      factoryV3: new ethers.Interface(FACTORY_V3_ABI),
      erc20: new ethers.Interface(ERC20_ABI),
      v2Pair: new ethers.Interface(V2_PAIR_ABI),
      v3Pool: new ethers.Interface(V3_POOL_ABI),
    };
  }

  /**
   * Get cached token info (instant for known tokens)
   */
  getCachedTokenInfo(address) {
    const normalizedAddr = address.toLowerCase();

    // Check known tokens first (instant)
    if (this.knownTokens[normalizedAddr]) {
      return this.knownTokens[normalizedAddr];
    }

    // Check cache
    const cached = this.tokenInfoCache.get(normalizedAddr);
    if (cached && Date.now() - cached.timestamp < this.tokenInfoCacheTTL) {
      return cached.data;
    }

    return null;
  }

  /**
   * Set token info in cache
   */
  setCachedTokenInfo(address, data) {
    const normalizedAddr = address.toLowerCase();
    this.tokenInfoCache.set(normalizedAddr, {
      data: { ...data, address },
      timestamp: Date.now()
    });
  }

  async getMulticall() {
    if (!this.multicall) {
      const provider = this.providerService.getCurrentProvider();
      this.multicall = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);
    }
    return this.multicall;
  }

  /**
   * Execute batch calls using Multicall3
   * @param {Array} calls - Array of { target, callData, allowFailure }
   * @returns {Array} Results with { success, returnData }
   */
  async execute(calls) {
    if (!calls || calls.length === 0) return [];

    const startTime = Date.now();

    try {
      return await this.providerService.executeWithRetry(async (provider) => {
        const multicall = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);

        const formattedCalls = calls.map(call => ({
          target: call.target,
          allowFailure: call.allowFailure !== false, // Default to true
          callData: call.callData,
        }));

        const results = await multicall.aggregate3.staticCall(formattedCalls);

        this.logger.debug(`Multicall executed ${calls.length} calls in ${Date.now() - startTime}ms`);

        return results.map((result, i) => ({
          success: result.success,
          returnData: result.returnData,
          target: calls[i].target,
        }));
      });
    } catch (error) {
      this.logger.error(`Multicall failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Batch discover all pools for a token using Multicall
   * Much faster than sequential calls!
   */
  async batchDiscoverPools(tokenAddress, options = {}) {
    const {
      uniswapV2Factory = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73', // PancakeSwap V2
      uniswapV3Factory = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', // PancakeSwap V3
      fullMode = false,  // Set to true to check ALL tokens/fees (slower but comprehensive)
    } = options;

    // SPEED OPTIMIZED BY DEFAULT: Only check most liquid pairs (WBNB, USDC, USDT)
    // This covers 99%+ of real trading scenarios while being ~2x faster
    // Set fullMode=true to check all tokens including minor stablecoins
    const commonTokens = fullMode ? [
      '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
      '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', // USDC
      '0x55d398326f99059fF775485246999027B3197955', // USDT
      '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', // BUSD
      '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3', // DAI
    ] : [
      '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB - primary liquidity
      '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', // USDC - primary stablecoin
      '0x55d398326f99059fF775485246999027B3197955', // USDT - BSC ecosystem
    ];

    // PancakeSwap V3 fee tiers including 0.25% (2500) - common on BSC
    const feeTiers = [100, 500, 2500, 3000, 10000];

    const calls = [];
    const callMeta = []; // Track what each call represents

    // Build all calls for PancakeSwap V2 and V3
    for (const pairToken of commonTokens) {
      if (pairToken.toLowerCase() === tokenAddress.toLowerCase()) continue;

      // PancakeSwap V2
      calls.push({
        target: uniswapV2Factory,
        callData: this.interfaces.factoryV2.encodeFunctionData('getPair', [tokenAddress, pairToken]),
        allowFailure: true,
      });
      callMeta.push({ type: 'V2', protocol: 'PancakeSwap', pairToken });

      // PancakeSwap V3 (all fee tiers)
      for (const fee of feeTiers) {
        calls.push({
          target: uniswapV3Factory,
          callData: this.interfaces.factoryV3.encodeFunctionData('getPool', [tokenAddress, pairToken, fee]),
          allowFailure: true,
        });
        callMeta.push({ type: 'V3', protocol: 'PancakeSwap', pairToken, fee });
      }
    }

    this.logger.info(`Batch discovering pools: ${calls.length} checks in single multicall`);
    const startTime = Date.now();

    // Execute all in one call!
    const results = await this.execute(calls);

    const pools = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i].success && results[i].returnData !== '0x') {
        try {
          const poolAddress = ethers.AbiCoder.defaultAbiCoder().decode(['address'], results[i].returnData)[0];

          if (poolAddress && poolAddress !== ethers.ZeroAddress) {
            pools.push({
              address: poolAddress,
              token0: tokenAddress,
              token1: callMeta[i].pairToken,
              ...callMeta[i],
            });
          }
        } catch (e) {
          // Decode failed, skip
        }
      }
    }

    this.logger.info(`Found ${pools.length} pools in ${Date.now() - startTime}ms (vs ~${calls.length * 100}ms sequential)`);

    return pools;
  }

  /**
   * Batch get token info for multiple addresses
   * OPTIMIZED: Uses cache for known tokens, only fetches unknown ones
   */
  async batchGetTokenInfo(tokenAddresses) {
    const uniqueAddresses = [...new Set(tokenAddresses.map(a => a.toLowerCase()))];
    const tokenInfo = {};

    // Step 1: Check cache for all addresses (instant)
    const uncachedAddresses = [];
    for (const address of uniqueAddresses) {
      const cached = this.getCachedTokenInfo(address);
      if (cached) {
        tokenInfo[address] = cached;
      } else {
        uncachedAddresses.push(address);
      }
    }

    // If all tokens are cached, return immediately
    if (uncachedAddresses.length === 0) {
      this.logger.debug(`All ${uniqueAddresses.length} tokens found in cache`);
      return tokenInfo;
    }

    this.logger.debug(`Token info cache: ${uniqueAddresses.length - uncachedAddresses.length} cached, ${uncachedAddresses.length} to fetch`);

    // Step 2: Fetch uncached tokens in single multicall batch
    const calls = [];
    for (const address of uncachedAddresses) {
      calls.push({
        target: address,
        callData: this.interfaces.erc20.encodeFunctionData('name'),
        allowFailure: true,
      });
      calls.push({
        target: address,
        callData: this.interfaces.erc20.encodeFunctionData('symbol'),
        allowFailure: true,
      });
      calls.push({
        target: address,
        callData: this.interfaces.erc20.encodeFunctionData('decimals'),
        allowFailure: true,
      });
    }

    try {
      const results = await this.execute(calls);

      for (let i = 0; i < uncachedAddresses.length; i++) {
        const address = uncachedAddresses[i];
        const baseIdx = i * 3;

        try {
          const name = results[baseIdx].success
            ? this.interfaces.erc20.decodeFunctionResult('name', results[baseIdx].returnData)[0]
            : 'Unknown';
          const symbol = results[baseIdx + 1].success
            ? this.interfaces.erc20.decodeFunctionResult('symbol', results[baseIdx + 1].returnData)[0]
            : 'UNKNOWN';
          const decimals = results[baseIdx + 2].success
            ? Number(this.interfaces.erc20.decodeFunctionResult('decimals', results[baseIdx + 2].returnData)[0])
            : 18;

          const info = { address, name, symbol, decimals };
          tokenInfo[address] = info;

          // Cache for next time
          this.setCachedTokenInfo(address, info);
        } catch (e) {
          tokenInfo[address] = { address, name: 'Unknown', symbol: 'UNKNOWN', decimals: 18 };
        }
      }
    } catch (error) {
      // If batch fails, add fallback entries
      this.logger.warn(`Token info batch failed: ${error.message}`);
      for (const address of uncachedAddresses) {
        tokenInfo[address] = { address, name: 'Unknown', symbol: 'UNKNOWN', decimals: 18 };
      }
    }

    return tokenInfo;
  }

  /**
   * Batch get V2 pool data for multiple pools
   */
  async batchGetV2PoolData(poolAddresses) {
    const calls = [];

    for (const address of poolAddresses) {
      calls.push({
        target: address,
        callData: this.interfaces.v2Pair.encodeFunctionData('token0'),
        allowFailure: true,
      });
      calls.push({
        target: address,
        callData: this.interfaces.v2Pair.encodeFunctionData('token1'),
        allowFailure: true,
      });
      calls.push({
        target: address,
        callData: this.interfaces.v2Pair.encodeFunctionData('getReserves'),
        allowFailure: true,
      });
    }

    const results = await this.execute(calls);
    const poolData = [];

    for (let i = 0; i < poolAddresses.length; i++) {
      const baseIdx = i * 3;

      try {
        if (!results[baseIdx].success || !results[baseIdx + 1].success || !results[baseIdx + 2].success) {
          continue;
        }

        const token0 = this.interfaces.v2Pair.decodeFunctionResult('token0', results[baseIdx].returnData)[0];
        const token1 = this.interfaces.v2Pair.decodeFunctionResult('token1', results[baseIdx + 1].returnData)[0];
        const reserves = this.interfaces.v2Pair.decodeFunctionResult('getReserves', results[baseIdx + 2].returnData);

        poolData.push({
          address: poolAddresses[i],
          token0,
          token1,
          reserve0: reserves[0],
          reserve1: reserves[1],
          blockTimestamp: reserves[2],
        });
      } catch (e) {
        this.logger.debug(`Failed to decode V2 pool data for ${poolAddresses[i]}`);
      }
    }

    return poolData;
  }

  /**
   * Batch get V3 pool data for multiple pools
   */
  async batchGetV3PoolData(poolAddresses) {
    const calls = [];

    for (const address of poolAddresses) {
      calls.push({
        target: address,
        callData: this.interfaces.v3Pool.encodeFunctionData('token0'),
        allowFailure: true,
      });
      calls.push({
        target: address,
        callData: this.interfaces.v3Pool.encodeFunctionData('token1'),
        allowFailure: true,
      });
      calls.push({
        target: address,
        callData: this.interfaces.v3Pool.encodeFunctionData('fee'),
        allowFailure: true,
      });
      calls.push({
        target: address,
        callData: this.interfaces.v3Pool.encodeFunctionData('liquidity'),
        allowFailure: true,
      });
      calls.push({
        target: address,
        callData: this.interfaces.v3Pool.encodeFunctionData('slot0'),
        allowFailure: true,
      });
    }

    const results = await this.execute(calls);
    const poolData = [];

    for (let i = 0; i < poolAddresses.length; i++) {
      const baseIdx = i * 5;

      try {
        if (!results[baseIdx].success) continue;

        const token0 = this.interfaces.v3Pool.decodeFunctionResult('token0', results[baseIdx].returnData)[0];
        const token1 = this.interfaces.v3Pool.decodeFunctionResult('token1', results[baseIdx + 1].returnData)[0];
        const fee = results[baseIdx + 2].success
          ? Number(this.interfaces.v3Pool.decodeFunctionResult('fee', results[baseIdx + 2].returnData)[0])
          : 0;
        const liquidity = results[baseIdx + 3].success
          ? this.interfaces.v3Pool.decodeFunctionResult('liquidity', results[baseIdx + 3].returnData)[0]
          : 0n;

        let slot0 = null;
        if (results[baseIdx + 4].success) {
          const decoded = this.interfaces.v3Pool.decodeFunctionResult('slot0', results[baseIdx + 4].returnData);
          slot0 = {
            sqrtPriceX96: decoded[0],
            tick: Number(decoded[1]),
          };
        }

        poolData.push({
          address: poolAddresses[i],
          token0,
          token1,
          fee,
          liquidity,
          slot0,
        });
      } catch (e) {
        this.logger.debug(`Failed to decode V3 pool data for ${poolAddresses[i]}`);
      }
    }

    return poolData;
  }

  /**
   * Batch get token balances for pools (for accurate TVL)
   */
  async batchGetPoolBalances(pools) {
    const calls = [];

    for (const pool of pools) {
      calls.push({
        target: pool.token0,
        callData: this.interfaces.erc20.encodeFunctionData('balanceOf', [pool.address]),
        allowFailure: true,
      });
      calls.push({
        target: pool.token1,
        callData: this.interfaces.erc20.encodeFunctionData('balanceOf', [pool.address]),
        allowFailure: true,
      });
    }

    const results = await this.execute(calls);
    const balances = [];

    for (let i = 0; i < pools.length; i++) {
      const baseIdx = i * 2;

      try {
        const balance0 = results[baseIdx].success
          ? this.interfaces.erc20.decodeFunctionResult('balanceOf', results[baseIdx].returnData)[0]
          : 0n;
        const balance1 = results[baseIdx + 1].success
          ? this.interfaces.erc20.decodeFunctionResult('balanceOf', results[baseIdx + 1].returnData)[0]
          : 0n;

        balances.push({
          address: pools[i].address,
          balance0,
          balance1,
        });
      } catch (e) {
        balances.push({
          address: pools[i].address,
          balance0: 0n,
          balance1: 0n,
        });
      }
    }

    return balances;
  }
}

// Singleton
let multicallInstance = null;

module.exports = {
  getMulticallService: () => {
    if (!multicallInstance) {
      multicallInstance = new MulticallService();
    }
    return multicallInstance;
  },
};
