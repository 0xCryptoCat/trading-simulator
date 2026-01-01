# Trading Simulator

Paper trading simulator for Alphalert signals. Simulates positions based on the optimized strategy discovered through backtesting.

## Optimal Strategy (from backtest)

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Score Filter | ≥ 0.3 | Best risk-adjusted returns |
| Position Size | $250 | Balances exposure and diversification |
| Trail Activation | 1.5x | Let winners run |
| Trail Distance | -10% | Lock in gains at pullback |
| Stop Loss | NONE | Backtesting showed 0% win rate with any SL |

### Backtest Results (Score ≥ 0.3)
- **Starting Capital**: $400 minimum
- **Total PnL**: $6,568
- **ROI on Capital**: 1,642%
- **Win Rate**: 71%

## Architecture

```
trading-simulator/
├── api/
│   ├── new-signal.js      # POST: Open new position from signal-pipeline
│   ├── check-positions.js # GET: Cron job to update prices & check trail exits
│   ├── stats.js           # GET: View portfolio stats
│   └── reset.js           # POST: Reset all positions (requires confirmation)
├── lib/
│   └── simulator-db.js    # SimulatorDB class (Telegram pinned message storage)
├── package.json
├── vercel.json            # Deployment config with cron
└── README.md
```

## Endpoints

### POST /api/new-signal
Opens a new simulated position.

```json
{
  "tokenAddress": "0x...",
  "chain": "SOL",
  "symbol": "TOKEN",
  "entryPrice": 0.0001234,
  "score": 0.75
}
```

### GET /api/check-positions
Cron job (every 5 minutes) that:
1. Fetches current prices from DexScreener
2. Updates peak prices
3. Checks trail activation (1.5x)
4. Closes positions when trail is hit (-10% from peak)
5. Posts notifications to simulator channel

### GET /api/stats
Returns current portfolio statistics.

Query params:
- `?post=true` - Also post stats to Telegram channel

### POST /api/reset
Clears all positions and resets stats.

```json
{
  "confirm": "RESET"
}
```

## Environment Variables

```env
# Required
TELEGRAM_BOT_TOKEN=8369100757:AAG...

# Optional (defaults shown)
POSITION_SIZE=250
TRAIL_ACTIVATION=1.5
TRAIL_DISTANCE=0.10
MIN_SCORE=0.3
```

## Telegram Channel

- **Simulator Channel**: `-1003691871409`
- Bot must be added as admin with permission to:
  - Send messages
  - Pin messages
  - Edit messages

## Data Storage

Positions are stored as JSON in a pinned message in the simulator channel:

```json
{
  "version": 1,
  "config": {
    "positionSize": 250,
    "scoreFilter": 0.3,
    "trailActivation": 1.5,
    "trailDistance": 0.10
  },
  "stats": {
    "totalTrades": 0,
    "openPositions": 0,
    "closedPositions": 0,
    "totalPnL": 0,
    "winCount": 0,
    "lossCount": 0
  },
  "positions": {
    "0x...": {
      "status": "trailing",
      "entryPrice": 0.0001,
      "peakPrice": 0.00018,
      "trailPrice": 0.000162,
      "pnl": 45.00
    }
  }
}
```

## Integration with Signal Pipeline

Add to signal-pipeline `.env`:
```env
SIMULATOR_URL=https://trading-simulator.vercel.app
SIMULATOR_MIN_SCORE=0.3
```

The signal pipeline will automatically POST qualifying signals to the simulator.

## Deployment

```bash
cd trading-simulator
vercel --prod
```

Then set up cron-job.org to ping `/api/check-positions` every 5 minutes.

## Notifications

The bot posts to the simulator channel:
- 📦 **New Position**: When a signal is received
- 🚀 **Trail Activated**: When position reaches 1.5x
- 💰 **Position Closed**: When trail is hit (profit)
- 📉 **Position Closed**: When trail is hit (loss - shouldn't happen often)
- 📊 **Portfolio Update**: Summary after any position changes
