// src/services/ProviderService.js

const { ethers } = require('ethers');
const { getLogger } = require('../utils/Logger');
const { NETWORK, API_CONFIG } = require('../config/constants');

class ProviderService {
  constructor() {
    this.logger = getLogger();
    this.providers = [];
    this.currentProviderIndex = 0;
    this.setupProviders();
  }

  setupProviders() {
    const rpcUrls = [
      NETWORK.RPC_URLS.CUSTOM,
      NETWORK.RPC_URLS.ALCHEMY,
      NETWORK.RPC_URLS.QUICKNODE,
      NETWORK.RPC_URLS.PUBLIC,
    ].filter(url => url && url.length > 0);

    if (rpcUrls.length === 0) {
      throw new Error('No RPC providers configured. Please set at least one RPC URL in .env');
    }

    rpcUrls.forEach(url => {
      try {
        const provider = new ethers.JsonRpcProvider(url, {
          chainId: NETWORK.CHAIN_ID,
          name: NETWORK.NAME,
        });
        
        // Set timeout
        provider._getConnection().timeout = API_CONFIG.REQUEST_TIMEOUT;
        
        this.providers.push({
          url: this.maskUrl(url),
          provider,
          failures: 0,
          lastFailure: null,
        });
        
        this.logger.info(`Added provider: ${this.maskUrl(url)}`);
      } catch (error) {
        this.logger.warn(`Failed to add provider ${this.maskUrl(url)}: ${error.message}`);
      }
    });

    if (this.providers.length === 0) {
      throw new Error('Failed to initialize any RPC providers');
    }

    this.logger.info(`Initialized ${this.providers.length} RPC providers`);
  }

  maskUrl(url) {
    // Mask API keys in URLs for logging
    if (!url) return 'undefined';
    if (url.includes('alchemy.com')) {
      return url.replace(/\/v2\/.*$/, '/v2/***');
    }
    if (url.includes('quicknode')) {
      return url.replace(/\/.*$/, '/***');
    }
    return url.replace(/^(https?:\/\/[^\/]+).*/, '$1/***');
  }

  getCurrentProvider() {
    return this.providers[this.currentProviderIndex].provider;
  }

  async executeWithRetry(operation, maxRetries = API_CONFIG.MAX_RETRIES) {
    let lastError = null;
    let attempts = 0;

    while (attempts < maxRetries) {
      for (let i = 0; i < this.providers.length; i++) {
        const providerIndex = (this.currentProviderIndex + i) % this.providers.length;
        const providerInfo = this.providers[providerIndex];
        
        // Skip providers that have failed recently (within 1 minute)
        if (providerInfo.lastFailure && 
            Date.now() - providerInfo.lastFailure < 60000 && 
            providerInfo.failures > 2) {
          continue;
        }

        try {
          const result = await operation(providerInfo.provider);
          
          // Reset failure count on success
          providerInfo.failures = 0;
          providerInfo.lastFailure = null;
          
          // Update current provider if different
          if (providerIndex !== this.currentProviderIndex) {
            this.currentProviderIndex = providerIndex;
            this.logger.info(`Switched to provider: ${providerInfo.url}`);
          }
          
          return result;
        } catch (error) {
          lastError = error;
          providerInfo.failures++;
          providerInfo.lastFailure = Date.now();
          
          this.logger.warn(
            `Provider ${providerInfo.url} failed (attempt ${attempts + 1}): ${error.message}`
          );
        }
      }
      
      attempts++;
      if (attempts < maxRetries) {
        await this.delay(API_CONFIG.RETRY_DELAY * attempts);
      }
    }

    throw new Error(
      `All providers failed after ${attempts} attempts. Last error: ${lastError?.message || 'Unknown'}`
    );
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async testProviderHealth(provider = null) {
    const p = provider || this.getCurrentProvider();
    
    try {
      const startTime = Date.now();
      const [blockNumber, chainId, gasPrice] = await Promise.all([
        p.getBlockNumber(),
        p.getNetwork().then(n => n.chainId),
        p.getFeeData(),
      ]);
      
      const latency = Date.now() - startTime;
      
      const isHealthy = 
        blockNumber > 0 && 
        Number(chainId) === NETWORK.CHAIN_ID &&
        latency < 5000;
      
      return {
        healthy: isHealthy,
        blockNumber,
        chainId: Number(chainId),
        latency,
        gasPrice: gasPrice.gasPrice ? ethers.formatUnits(gasPrice.gasPrice, 'gwei') : null,
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message,
      };
    }
  }

  async getHealthStatus() {
    const results = await Promise.all(
      this.providers.map(async (p, index) => ({
        index,
        url: p.url,
        current: index === this.currentProviderIndex,
        failures: p.failures,
        lastFailure: p.lastFailure,
        health: await this.testProviderHealth(p.provider),
      }))
    );
    
    return results;
  }
}

// Singleton instance
let providerInstance = null;

module.exports = {
  getProviderService: () => {
    if (!providerInstance) {
      providerInstance = new ProviderService();
    }
    return providerInstance;
  },
};