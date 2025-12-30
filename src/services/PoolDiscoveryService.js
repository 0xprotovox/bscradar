// src/services/PoolDiscoveryService.js
// OPTIMIZED VERSION - Uses Multicall for batch RPC queries

const { ethers } = require('ethers');
const { getProviderService } = require('./ProviderService');
const { getMulticallService } = require('./MulticallService');
const { getLogger } = require('../utils/Logger');

class PoolDiscoveryService {
  constructor() {
    this.providerService = getProviderService();
    this.multicallService = getMulticallService();
    this.logger = getLogger();

    // PancakeSwap factories on BSC
    this.pancakeV2Factory = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73'; // PancakeSwap V2
    this.pancakeV3Factory = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865'; // PancakeSwap V3
  }

  /**
   * Find all pools for a token using Multicall (FAST!)
   * Single RPC call instead of 100+ sequential calls
   */
  async findAllPoolsForToken(tokenAddress) {
    this.logger.info(`Starting optimized pool discovery for ${tokenAddress}`);
    const startTime = Date.now();

    try {
      // Use Multicall for batch discovery - MUCH faster!
      const pools = await this.multicallService.batchDiscoverPools(tokenAddress, {
        uniswapV2Factory: this.pancakeV2Factory,
        uniswapV3Factory: this.pancakeV3Factory,
      });

      // Remove duplicates
      const uniquePools = this.removeDuplicates(pools);

      const duration = Date.now() - startTime;
      this.logger.info(`Pool discovery completed in ${duration}ms - Found ${uniquePools.length} pools`);

      return uniquePools;
    } catch (error) {
      this.logger.warn(`Multicall discovery failed, falling back to sequential: ${error.message}`);
      // Fallback to sequential method if multicall fails
      return this.findAllPoolsForTokenSequential(tokenAddress);
    }
  }

  /**
   * Fallback: Sequential pool discovery (slower but more reliable)
   */
  async findAllPoolsForTokenSequential(tokenAddress) {
    this.logger.info(`Using sequential pool discovery for ${tokenAddress}`);

    // Find PancakeSwap V2/V3 pools
    const pools = await this.findPancakeSwapPools(tokenAddress);

    // Remove duplicates
    const uniquePools = this.removeDuplicates(pools);

    this.logger.info(`Total pools found: ${uniquePools.length}`);

    return uniquePools;
  }

  async findPancakeSwapPools(tokenAddress) {
    const commonTokens = [
      '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
      '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', // USDC
      '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', // BUSD
      '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3', // DAI
      '0x55d398326f99059fF775485246999027B3197955', // USDT
    ];

    const feeTiers = [100, 500, 2500, 3000, 10000]; // PancakeSwap V3 fee tiers including 0.25%
    const allPromises = [];

    for (const pairToken of commonTokens) {
      if (pairToken.toLowerCase() === tokenAddress.toLowerCase()) continue;

      // Check PancakeSwap V2
      allPromises.push(
        this.checkPancakeV2Pool(tokenAddress, pairToken).catch(() => null)
      );

      // Check PancakeSwap V3 (all fee tiers in parallel)
      for (const fee of feeTiers) {
        allPromises.push(
          this.checkPancakeV3Pool(tokenAddress, pairToken, fee).catch(() => null)
        );
      }
    }

    const results = await Promise.all(allPromises);
    return results.filter((pool) => pool !== null);
  }


  async checkPancakeV2Pool(tokenA, tokenB) {
    try {
      const provider = this.providerService.getCurrentProvider();
      const factoryContract = new ethers.Contract(
        this.pancakeV2Factory,
        ['function getPair(address, address) view returns (address)'],
        provider
      );

      const pairAddress = await factoryContract.getPair(tokenA, tokenB);
      if (pairAddress && pairAddress !== ethers.ZeroAddress) {
        return {
          address: pairAddress,
          token0: tokenA,
          token1: tokenB,
          type: 'V2',
          protocol: 'PancakeSwap',
        };
      }
    } catch (error) {
      // Silent fail
    }
    return null;
  }

  async checkPancakeV3Pool(tokenA, tokenB, fee) {
    try {
      const provider = this.providerService.getCurrentProvider();
      const factoryContract = new ethers.Contract(
        this.pancakeV3Factory,
        ['function getPool(address, address, uint24) view returns (address)'],
        provider
      );

      const poolAddress = await factoryContract.getPool(tokenA, tokenB, fee);
      if (poolAddress && poolAddress !== ethers.ZeroAddress) {
        return {
          address: poolAddress,
          token0: tokenA,
          token1: tokenB,
          fee,
          type: 'V3',
          protocol: 'PancakeSwap',
        };
      }
    } catch (error) {
      // Silent fail
    }
    return null;
  }

  removeDuplicates(pools) {
    const seen = new Set();
    return pools.filter((pool) => {
      const key = `${pool.type}_${pool.address.toLowerCase()}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }
}

// Singleton
let poolDiscoveryInstance = null;

module.exports = {
  getPoolDiscoveryService: () => {
    if (!poolDiscoveryInstance) {
      poolDiscoveryInstance = new PoolDiscoveryService();
    }
    return poolDiscoveryInstance;
  },
};
