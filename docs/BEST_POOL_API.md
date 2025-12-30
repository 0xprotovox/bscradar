# Best Pool Endpoint Documentation

## GET /api/best-pool/:token

The best-pool endpoint provides intelligent pool selection based on various criteria. This is essential for finding optimal liquidity sources for swaps, liquidity provision, or price discovery.

## Endpoint

```
GET /api/best-pool/:token?criteria={criteria}&basePair={address}&priceDirection={direction}
```

## Parameters

### Path Parameters
- `token` (required) - The token contract address to analyze

### Query Parameters

#### `criteria` (string, default: 'recommended')
Determines how the best pool is selected:

| Criteria | Description | Use Case |
|----------|-------------|----------|
| `liquidity` | Highest USD liquidity | Best for large swaps to minimize slippage |
| `price` | Best execution price | Optimal for getting best rates |
| `fee` | Lowest fee percentage | Best for frequent small trades |
| `v2` | Best PancakeSwap V2 pool | When V2 routing is required |
| `v3` | Best PancakeSwap V3 pool | For concentrated liquidity benefits |
| `balanced` | Weighted scoring system | Good general-purpose selection |
| `recommended` | Smart AI selection | Default, adapts to conditions |

#### `basePair` (address, optional)
- Filter pools to only those paired with a specific token
- Example: Only USDC/WBNB pools

#### `priceDirection` (string, default: 'sell')
- Only applies when `criteria=price`
- Options:
  - `sell` - Highest price (best for selling the token)
  - `buy` - Lowest price (best for buying the token)

## Response Format

### Success Response (200)
```json
{
  "success": true,
  "pool": {
    "address": "0x1E213600FA9317FEAC4Ef4087acDF5D0e25D7187",
    "type": "V3",
    "version": 3,
    "pair": "CAKE/WBNB",
    "pairToken": {
      "address": "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
      "symbol": "WBNB",
      "name": "Wrapped BNB",
      "decimals": 18
    },
    "fee": 2500,
    "feePercent": 0.25,
    "liquidity": {
      "status": "ACTIVE",
      "usd": 30000000,
      "bnb": 42857.14,
      "token0": "4000000",
      "token1": "42857.14"
    },
    "price": {
      "token0": 0.00216,
      "token1": 463,
      "ratio": 463
    },
    "priceInfo": {  // Only when criteria=price
      "direction": "sell",
      "currentPrice": 7.77,
      "priceRange": {
        "min": 7.75,
        "max": 7.80,
        "average": 7.77
      }
    },
    "balanceScore": 85  // Only when criteria=balanced
  },
  "criteria": "price",
  "basePair": "any",
  "priceDirection": "sell"  // Only when criteria=price
}
```

### Error Response (404)
```json
{
  "success": false,
  "error": "No suitable pool found",
  "criteria": "liquidity",
  "basePair": "0x...",
  "totalPools": 10,
  "activePools": 5
}
```

## Criteria Detailed Explanations

### 1. Liquidity Criteria
```javascript
// GET /api/best-pool/0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82?criteria=liquidity
```
- Selects pool with highest total value locked (TVL) in USD
- Best for large trades to minimize price impact
- Ensures deep liquidity for stable execution

### 2. Price Criteria
```javascript
// Best price for selling (highest price)
// GET /api/best-pool/0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82?criteria=price&priceDirection=sell

// Best price for buying (lowest price)
// GET /api/best-pool/0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82?criteria=price&priceDirection=buy
```
- Finds optimal price across all pools
- `sell` direction: Highest price (maximize output when selling)
- `buy` direction: Lowest price (minimize input when buying)
- Only considers pools with ACTIVE status

### 3. Fee Criteria
```javascript
// GET /api/best-pool/0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82?criteria=fee
```
- Selects pool with lowest fee tier
- V2 pools: 0.25% fixed
- V3 pools: 0.01%, 0.05%, 0.25%, 0.30%, or 1%
- Best for high-frequency trading or small amounts

### 4. Version-Specific Criteria

#### V2 Pools
```javascript
// GET /api/best-pool/0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82?criteria=v2
```
- Best V2 pool by liquidity
- Simple constant product formula
- Gas efficient for smaller trades

#### V3 Pools
```javascript
// GET /api/best-pool/0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82?criteria=v3
```
- Best V3 pool by liquidity
- Concentrated liquidity benefits
- Better capital efficiency

### 5. Balanced Criteria
```javascript
// GET /api/best-pool/0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82?criteria=balanced
```

Scoring system (100 points total):
- **Liquidity (0-40 points)**
  - ≥$100k: 40 points
  - ≥$50k: 30 points
  - ≥$10k: 20 points
  - ≥$1k: 10 points

- **Fee (0-30 points)**
  - ≤0.01%: 30 points
  - ≤0.05%: 25 points
  - ≤0.25%: 20 points
  - ≤0.3%: 15 points
  - ≤1%: 5 points

- **Version (0-10 points)**
  - V3: 10 points
  - V2: 5 points

- **Price Stability (0-20 points)**
  - Within 1% of average: 20 points
  - Within 5% of average: 15 points
  - Within 10% of average: 10 points
  - Within 20% of average: 5 points

### 6. Recommended Criteria (Default)
```javascript
// GET /api/best-pool/0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82
```
- Intelligent selection based on multiple factors
- Considers liquidity, fees, and efficiency
- Adapts to market conditions

## Examples

### Example 1: Find best pool for large CAKE sale
```bash
GET /api/best-pool/0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82?criteria=liquidity
```

### Example 2: Find cheapest WBNB to buy
```bash
GET /api/best-pool/0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c?criteria=price&priceDirection=buy
```

### Example 3: Find best CAKE/WBNB pool specifically
```bash
GET /api/best-pool/0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82?basePair=0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c
```

### Example 4: Find most balanced pool
```bash
GET /api/best-pool/0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82?criteria=balanced
```

## Integration Examples

### JavaScript
```javascript
const axios = require('axios');

async function findBestPool(token, criteria, options = {}) {
  const params = new URLSearchParams({ criteria, ...options });
  const response = await axios.get(
    `http://localhost:3000/api/best-pool/${token}?${params}`
  );
  return response.data.pool;
}

// Examples
const bestForLiquidity = await findBestPool(CAKE_ADDRESS, 'liquidity');
const bestForSelling = await findBestPool(CAKE_ADDRESS, 'price', { priceDirection: 'sell' });
const bestForBuying = await findBestPool(CAKE_ADDRESS, 'price', { priceDirection: 'buy' });
const lowestFee = await findBestPool(CAKE_ADDRESS, 'fee');
const balanced = await findBestPool(CAKE_ADDRESS, 'balanced');
```

### Python
```python
import requests

def find_best_pool(token, criteria='recommended', **options):
    params = {'criteria': criteria, **options}
    response = requests.get(
        f'http://localhost:3000/api/best-pool/{token}',
        params=params
    )
    return response.json()['pool']

# Examples
best_liquidity = find_best_pool(CAKE_ADDRESS, 'liquidity')
best_sell_price = find_best_pool(CAKE_ADDRESS, 'price', priceDirection='sell')
best_buy_price = find_best_pool(CAKE_ADDRESS, 'price', priceDirection='buy')
lowest_fee = find_best_pool(CAKE_ADDRESS, 'fee')
```

## Use Case Recommendations

| Use Case | Recommended Criteria | Additional Parameters |
|----------|---------------------|----------------------|
| Large swap (>$100k) | `liquidity` | - |
| Arbitrage trading | `price` | `priceDirection` based on trade |
| High-frequency trading | `fee` | - |
| DEX aggregation | `balanced` | - |
| Specific pair trading | `recommended` | `basePair` address |
| V3-only routing | `v3` | - |
| Legacy V2 routing | `v2` | - |
| Price discovery | `price` | Compare buy/sell directions |

## Notes

1. All addresses should be checksummed BSC addresses
2. The API caches results for 60 seconds by default
3. Use `refresh=true` on `/api/analyze/:token` to force cache refresh
4. Price criteria only considers pools with ACTIVE liquidity status
5. Balanced scoring provides the best general-purpose selection
6. The recommended criteria uses smart heuristics and is the default

## Rate Limits

- Default: 100 requests per minute per IP
- Configure in `.env` file if needed
- Use caching to reduce API calls
