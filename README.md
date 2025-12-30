<p align="center">
  <h1 align="center">BscRadar</h1>
  <p align="center">
    <strong>High-performance DEX pool analyzer for BSC network</strong>
  </p>
  <p align="center">
    Real-time pool discovery, liquidity analysis, and swap routing for PancakeSwap V2/V3
  </p>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#api-reference">API</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#contributing">Contributing</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18+-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Express-4.x-000000?style=flat-square&logo=express&logoColor=white" alt="Express" />
  <img src="https://img.shields.io/badge/ethers.js-6.x-3C3C3D?style=flat-square&logo=ethereum&logoColor=white" alt="ethers.js" />
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square" alt="License" />
  <img src="https://img.shields.io/badge/BSC-Mainnet-F0B90B?style=flat-square&logo=binance&logoColor=white" alt="BSC" />
</p>

---

## Features

- **Multi-Protocol Support** — PancakeSwap V2 (constant product AMM) and V3 (concentrated liquidity)
- **Real-Time Pool Discovery** — Automatic detection of all pools for any BEP-20 token
- **Multi-Tier Pricing** — Token → BNB → USD price calculation with liquidity-weighted averages
- **Intelligent Pool Scoring** — Best pool selection based on liquidity, fees, spread, and version
- **Swap Quotes** — Accurate quote generation with slippage calculation
- **Resilient RPC** — Multi-provider setup with automatic failover and health monitoring
- **In-Memory Caching** — Sub-100ms responses with configurable TTL
- **Rate Limiting** — Built-in protection against abuse
- **Stateless Design** — No database required, horizontally scalable

## Quick Start

### Prerequisites

- Node.js 18+
- npm or yarn
- BSC RPC URL (Alchemy, QuickNode, or public)

### Installation

```bash
# Clone the repository
git clone https://github.com/0xprotovox/bscradar.git
cd bscradar

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your RPC URLs

# Start the server
npm start
```

### Development

```bash
# Run with hot reload
npm run dev

# Run tests
npm test

# Lint code
npm run lint

# Format code
npm run format
```

## Configuration

Create a `.env` file based on `.env.example`:

```env
# RPC URLs (at least one required)
BSC_RPC=https://bnb-mainnet.g.alchemy.com/v2/YOUR_KEY
QUICKNODE_RPC=https://your-endpoint.quiknode.pro/YOUR_KEY
PUBLIC_RPC=https://bsc-dataseed.binance.org

# Server
PORT=3000
NODE_ENV=production

# Cache TTL (seconds)
CACHE_TTL=60
PRICE_CACHE_TTL=30

# Rate Limiting
RATE_LIMIT_WINDOW=60000
RATE_LIMIT_MAX_REQUESTS=100

# Logging
LOG_LEVEL=info
LOG_FILE=logs/app.log
```

## API Reference

### Token Analysis

#### `GET /api/analyze/:token`

Full token analysis including all pools, pricing, and recommendations.

```bash
curl http://localhost:3000/api/analyze/0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `token` | `address` | BEP-20 token address |
| `refresh` | `boolean` | Force cache bypass (optional) |

#### `GET /api/best-pool/:token`

Get the optimal pool for a token based on specified criteria.

```bash
curl "http://localhost:3000/api/best-pool/0x0E09...?criteria=liquidity"
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `criteria` | `string` | `liquidity`, `price`, `fee`, `v2`, `v3`, `balanced`, `recommended` |
| `basePair` | `address` | Filter by base pair (optional) |
| `priceDirection` | `string` | `buy` or `sell` for price criteria |

#### `GET /api/pools/:token`

List all discovered pools for a token.

```bash
curl "http://localhost:3000/api/pools/0x0E09...?type=V3&minLiquidity=10000"
```

### Trading

#### `POST /api/quote`

Get a swap quote between two tokens.

```bash
curl -X POST http://localhost:3000/api/quote \
  -H "Content-Type: application/json" \
  -d '{
    "tokenIn": "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    "tokenOut": "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82",
    "amountIn": "1.0",
    "slippage": 0.5
  }'
```

#### `GET /api/pair/:tokenA/:tokenB`

Find direct pools between two tokens.

### Utility

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Service health check with provider status |
| `GET /api/prices` | Current known token prices |
| `GET /api/cache/stats` | Cache statistics and hit rates |
| `POST /api/cache/clear` | Clear cache (admin) |
| `GET /api/docs` | Full API documentation |

### Response Example

```json
{
  "success": true,
  "token": {
    "address": "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82",
    "symbol": "CAKE",
    "name": "PancakeSwap Token",
    "decimals": 18
  },
  "summary": {
    "totalPools": 12,
    "v2Pools": 3,
    "v3Pools": 9,
    "totalLiquidityUSD": 119000000,
    "bestPool": "0x..."
  },
  "pricing": {
    "currentPrice": { "usd": 2.45, "bnb": 0.0041 },
    "priceRange": { "min": 2.44, "max": 2.46, "spread": 0.008 }
  },
  "pools": [...],
  "recommendations": {
    "bestForLiquidity": {...},
    "bestForPrice": {...},
    "bestOverall": {...}
  }
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Express App                            │
├─────────────────────────────────────────────────────────────┤
│                     API Routes                              │
├─────────────────────────────────────────────────────────────┤
│                PoolAnalyzer (Orchestrator)                  │
├──────────────┬──────────────┬───────────────────────────────┤
│  V2PoolService │  V3PoolService │      PriceService         │
├──────────────┴──────────────┴───────────────────────────────┤
│                  PoolDiscoveryService                       │
├─────────────────────────────────────────────────────────────┤
│               ProviderService (Multi-RPC)                   │
├─────────────────────────────────────────────────────────────┤
│          Cache (node-cache)  │  TokenService                │
└─────────────────────────────────────────────────────────────┘
```

### Project Structure

```
bscradar/
├── src/
│   ├── index.js              # Entry point
│   ├── app.js                # Express app setup
│   ├── config/
│   │   ├── constants.js      # Contract addresses, network config
│   │   └── abis.js           # Contract ABIs
│   ├── routes/
│   │   ├── apiRoutes.js      # Main API routes
│   │   └── poolRoutes.js     # Pool-specific routes
│   ├── services/
│   │   ├── PoolAnalyzer.js   # Main orchestrator
│   │   ├── PoolDiscoveryService.js
│   │   ├── PriceService.js
│   │   ├── ProviderService.js
│   │   ├── TokenService.js
│   │   ├── V2PoolService.js
│   │   └── V3PoolService.js
│   ├── middlewares/
│   │   └── ...
│   └── utils/
│       ├── Cache.js
│       └── Logger.js
├── docs/
│   └── BEST_POOL_API.md
├── .env.example
├── .gitignore
├── package.json
├── LICENSE
└── README.md
```

## Supported Protocols

| Protocol | Type | Factory Address |
|----------|------|-----------------|
| PancakeSwap V2 | Constant Product AMM | `0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73` |
| PancakeSwap V3 | Concentrated Liquidity | `0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865` |

### Fee Tiers (V3)

| Fee | Basis Points | Typical Use Case |
|-----|--------------|------------------|
| 0.01% | 100 | Stable pairs (USDC/USDT) |
| 0.05% | 500 | Stable/major pairs |
| 0.25% | 2500 | Standard pairs |
| 0.30% | 3000 | Standard pairs |
| 1.00% | 10000 | Exotic/volatile pairs |

## Performance

| Metric | Value |
|--------|-------|
| Response Time (cached) | < 100ms |
| Response Time (uncached) | < 3s |
| Cache Hit Rate | ~85% |
| Concurrent Requests | 100+ RPS |
| Memory Usage | ~50-100MB |

## Contributing

Contributions are welcome! Please read our contributing guidelines before submitting PRs.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built with [ethers.js](https://docs.ethers.org/v6/) v6
- Powered by [PancakeSwap](https://pancakeswap.finance/) on BSC

---

<p align="center">
  <sub>Built for the BSC DeFi ecosystem</sub>
</p>
