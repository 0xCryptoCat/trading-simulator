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
      const msg = `🚀 <b>TRAIL ACTIVATED</b>

<b>Token:</b> ${t.symbol}
<b>Entry:</b> $${t.entryPrice < 0.0001 ? t.entryPrice.toExponential(2) : t.entryPrice.toFixed(6)}
<b>Current:</b> $${t.currentPrice < 0.0001 ? t.currentPrice.toExponential(2) : t.currentPrice.toFixed(6)}
<b>Gain:</b> ${mult}x (+${((mult - 1) * 100).toFixed(0)}%)

🛑 Trail stop set at: $${t.trailPrice < 0.0001 ? t.trailPrice.toExponential(2) : t.trailPrice.toFixed(6)}

<code>${t.address}</code>`;
      
      await sendTelegramMessage(botToken, SIMULATOR_CHANNEL, msg);
    }
    
    // Send notifications for closed positions
    for (const c of closed) {
      const mult = (c.exitPrice / c.entryPrice).toFixed(2);
      const pnlEmoji = c.pnl >= 0 ? '💰' : '📉';
      const pnlStr = c.pnl >= 0 ? `+$${c.pnl.toFixed(2)}` : `-$${Math.abs(c.pnl).toFixed(2)}`;
      
      const msg = `${pnlEmoji} <b>POSITION CLOSED</b>

<b>Token:</b> ${c.symbol}
<b>Entry:</b> $${c.entryPrice < 0.0001 ? c.entryPrice.toExponential(2) : c.entryPrice.toFixed(6)}
<b>Exit:</b> $${c.exitPrice < 0.0001 ? c.exitPrice.toExponential(2) : c.exitPrice.toFixed(6)}
<b>Result:</b> ${mult}x (${pnlStr})
<b>Reason:</b> ${c.reason}

<code>${c.address}</code>`;
      
      await sendTelegramMessage(botToken, SIMULATOR_CHANNEL, msg);
    }
    
    // Post summary if there were changes
    if (closed.length > 0 || trailActivated.length > 0) {
      const stats = db.getStats();
      const openPos = db.getOpenPositions();
      const activeCapital = openPos.reduce((sum, p) => sum + (p.size || 0), 0);
      const unrealizedPnL = openPos.reduce((sum, p) => sum + (p.unrealizedPnL || 0), 0);

      const summaryMsg = `📊 <b>Portfolio Update</b>

💰 <b>Active Capital:</b> $${activeCapital.toFixed(2)}
📈 <b>Open Positions:</b> ${stats.openPositions}
📉 <b>Realized PnL:</b> ${stats.totalPnL >= 0 ? '+' : ''}$${stats.totalPnL.toFixed(2)}
💸 <b>Unrealized PnL:</b> ${unrealizedPnL >= 0 ? '+' : ''}$${unrealizedPnL.toFixed(2)}
🏆 <b>Wins:</b> ${stats.winCount} | 💀 <b>Losses:</b> ${stats.lossCount}
🎯 <b>Win Rate:</b> ${stats.winRate}%`;
      
      await sendTelegramMessage(botToken, SIMULATOR_CHANNEL, summaryMsg);
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
