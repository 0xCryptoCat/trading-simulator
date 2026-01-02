/**
 * API: Check Positions
 * 
 * Cron job that runs every 5 minutes to:
 * 1. Fetch current prices for all open positions
 * 2. Check if trail activated or trail stop hit
 * 3. Update positions and post notifications
 * 
 * GET /api/check-positions
 */

import { SimulatorDB, sendTelegramMessage, SIMULATOR_CHANNEL } from '../lib/simulator-db.js';

// DexScreener price API
async function fetchPrice(chain, tokenAddress) {
  const chainMap = {
    'SOL': 'solana',
    'ETH': 'ethereum', 
    'BSC': 'bsc',
    'BASE': 'base'
  };
  
  const dexChain = chainMap[chain?.toUpperCase()] || 'solana';
  const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
  
  try {
    const res = await fetch(url);
    const data = await res.json();
    
    if (data.pairs && data.pairs.length > 0) {
      // Find pair on correct chain
      const pair = data.pairs.find(p => p.chainId === dexChain) || data.pairs[0];
      return parseFloat(pair.priceUsd) || 0;
    }
  } catch (e) {
    console.error(`Price fetch error for ${tokenAddress}:`, e.message);
  }
  
  return 0;
}

export default async function handler(req, res) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return res.status(500).json({ error: 'Missing TELEGRAM_BOT_TOKEN' });
  }
  
  try {
    const db = new SimulatorDB(botToken);
    await db.load();
    
    const openPositions = db.getOpenPositions();
    
    if (openPositions.length === 0) {
      return res.status(200).json({ 
        status: 'ok', 
        message: 'No open positions',
        stats: db.getStats()
      });
    }
    
    console.log(`Checking ${openPositions.length} open positions...`);
    
    const updates = [];
    const closed = [];
    const trailActivated = [];
    
    for (const pos of openPositions) {
      const currentPrice = await fetchPrice(pos.chain, pos.address);
      
      if (currentPrice === 0) {
        console.log(`   ⚠️ No price for ${pos.symbol}`);
        continue;
      }
      
      const previousStatus = pos.status;
      const result = db.updatePosition(pos.address, currentPrice);
      
      if (!result) continue;
      
      if (result.action === 'closed') {
        closed.push({
          symbol: pos.symbol,
          chain: pos.chain,
          address: pos.address,
          entryPrice: pos.entryPrice,
          exitPrice: result.position.exitPrice,
          pnl: result.position.pnl,
          reason: result.reason
        });
      } else if (result.position.status === 'trailing' && previousStatus === 'active') {
        trailActivated.push({
          symbol: pos.symbol,
          chain: pos.chain,
          address: pos.address,
          entryPrice: pos.entryPrice,
          currentPrice,
          peakPrice: result.position.peakPrice,
          trailPrice: result.position.trailPrice
        });
      } else {
        updates.push({
          symbol: pos.symbol,
          status: result.position.status,
          currentMult: (currentPrice / pos.entryPrice).toFixed(2),
          pnl: result.position.pnl.toFixed(2)
        });
      }
    }
    
    // Save after all updates
    await db.save();
    
    // Send notifications for trail activations
    for (const t of trailActivated) {
      const mult = (t.currentPrice / t.entryPrice).toFixed(2);
      const pnlPct = ((mult - 1) * 100).toFixed(0);
      const pnlUsd = ((mult - 1) * 250).toFixed(0);
      
      const msg = `🚀 <b>TRAIL ACTIVATED</b>

<b>${t.symbol}</b>
📥 Entry: $${t.entryPrice}
📊 Current: $${t.currentPrice}
📈 Gain: <b>${mult}x (+${pnlPct}% / +$${pnlUsd})</b>

🛑 Trail stop: $${t.trailPrice} (-5%)
🔒 Locked: +$${((t.trailPrice / t.entryPrice - 1) * 250).toFixed(0)} min

<code>${t.address}</code>`;
      
      await sendTelegramMessage(botToken, SIMULATOR_CHANNEL, msg);
    }
    
    // Send notifications for closed positions
    for (const c of closed) {
      const mult = (c.exitPrice / c.entryPrice).toFixed(2);
      const pnlEmoji = c.pnl >= 0 ? '💰' : '�';
      const pnlStr = c.pnl >= 0 ? `+$${c.pnl.toFixed(2)}` : `-$${Math.abs(c.pnl).toFixed(2)}`;
      
      // Different header for stop loss vs trail
      const header = c.reason === 'stop_loss' 
        ? '🛑 <b>STOP LOSS HIT</b>' 
        : (c.pnl >= 0 ? '💰 <b>POSITION CLOSED</b>' : '📉 <b>POSITION CLOSED</b>');
      
      const msg = `${header}

<b>Token:</b> ${c.symbol}
<b>Entry:</b> $${c.entryPrice}
<b>Exit:</b> $${c.exitPrice}
<b>Result:</b> ${mult}x (${pnlStr})
<b>Reason:</b> ${c.reason === 'stop_loss' ? 'Hard Stop (-15%)' : c.reason}

<code>${c.address}</code>`;
      
      await sendTelegramMessage(botToken, SIMULATOR_CHANNEL, msg);
    }
    
    return res.status(200).json({
      status: 'ok',
      checked: openPositions.length,
      trailActivated: trailActivated.length,
      closed: closed.length,
      stats: db.getStats()
    });
    
  } catch (error) {
    console.error('Error checking positions:', error);
    return res.status(500).json({ error: error.message });
  }
}
