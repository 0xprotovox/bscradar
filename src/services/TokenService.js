// src/services/TokenService.js

const { ethers } = require('ethers');
const { getProviderService } = require('./ProviderService');
const { getCacheService } = require('../utils/Cache');
const { getLogger } = require('../utils/Logger');
const { ERC20_ABI } = require('../config/abis');
const { CONTRACTS } = require('../config/constants');

class TokenService {
  constructor() {
    this.providerService = getProviderService();
    this.cache = getCacheService();
    this.logger = getLogger();
  }

  async getTokenInfo(tokenAddress) {
    try {
      // Check cache first
      const cached = this.cache.getTokenData(tokenAddress);
      if (cached) {
        this.logger.debug(`Token info cache hit: ${tokenAddress}`);
        return cached;
      }

      // Fetch from blockchain
      const tokenInfo = await this.providerService.executeWithRetry(async (provider) => {
        const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        
        const [name, symbol, decimals, totalSupply] = await Promise.all([
          contract.name().catch(() => 'Unknown'),
          contract.symbol().catch(() => 'UNKNOWN'),
          contract.decimals().catch(() => 18),
          contract.totalSupply().catch(() => 0n),
        ]);

        return {
          address: tokenAddress.toLowerCase(),
          name,
          symbol,
          decimals: Number(decimals),
          totalSupply: totalSupply.toString(),
        };
      });

      // Cache the result
      this.cache.setTokenData(tokenAddress, tokenInfo);
      this.logger.info(`Fetched token info: ${tokenInfo.symbol} (${tokenAddress})`);
      
      return tokenInfo;
    } catch (error) {
      this.logger.error(`Failed to get token info for ${tokenAddress}`, error);
      
      // Return default values for known tokens
      const knownTokens = {
        [CONTRACTS.WBNB.toLowerCase()]: { symbol: 'WBNB', name: 'Wrapped BNB', decimals: 18 },
        [CONTRACTS.USDC.toLowerCase()]: { symbol: 'USDC', name: 'USD Coin', decimals: 6 },
        [CONTRACTS.USDT.toLowerCase()]: { symbol: 'USDT', name: 'Tether USD', decimals: 6 },
        [CONTRACTS.DAI.toLowerCase()]: { symbol: 'DAI', name: 'Dai Stablecoin', decimals: 18 },
      };

      const known = knownTokens[tokenAddress.toLowerCase()];
      if (known) {
        return {
          address: tokenAddress.toLowerCase(),
          ...known,
          totalSupply: '0',
        };
      }

      throw error;
    }
  }

  async getMultipleTokenInfo(tokenAddresses) {
    const results = await Promise.allSettled(
      tokenAddresses.map(address => this.getTokenInfo(address))
    );

    const tokens = {};
    results.forEach((result, index) => {
      const address = tokenAddresses[index].toLowerCase();
      if (result.status === 'fulfilled') {
        tokens[address] = result.value;
      } else {
        this.logger.warn(`Failed to get info for token ${address}`);
        tokens[address] = {
          address,
          symbol: 'UNKNOWN',
          name: 'Unknown Token',
          decimals: 18,
          totalSupply: '0',
        };
      }
    });

    return tokens;
  }

  isStablecoin(tokenAddress) {
    const stablecoins = [
      CONTRACTS.USDC.toLowerCase(),
      CONTRACTS.USDT.toLowerCase(),
      CONTRACTS.DAI.toLowerCase(),
    ];
    return stablecoins.includes(tokenAddress.toLowerCase());
  }

  isWrappedNative(tokenAddress) {
    return tokenAddress.toLowerCase() === CONTRACTS.WBNB.toLowerCase();
  }

  formatTokenAmount(amount, decimals) {
    try {
      return ethers.formatUnits(amount, decimals);
    } catch {
      return '0';
    }
  }

  parseTokenAmount(amount, decimals) {
    try {
      return ethers.parseUnits(amount.toString(), decimals);
    } catch {
      return 0n;
    }
  }
}

// Singleton instance
let tokenServiceInstance = null;

module.exports = {
  getTokenService: () => {
    if (!tokenServiceInstance) {
      tokenServiceInstance = new TokenService();
    }
    return tokenServiceInstance;
  },
};