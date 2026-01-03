/**
 * API: Check Positions
 * 
 * Cron job that runs every 1 minute to:
 * 1. Fetch current prices for all open positions (in a 5x loop)
 * 2. Check if trail activated or trail stop hit
 * 3. Update positions and post notifications
 * 
 * GET /api/check-positions
 */

import { SimulatorDB, sendTelegramMessage, SIMULATOR_CHANNEL } from '../lib/simulator-db.js';

// DexScreener bulk price API
async function fetchPrices(addresses) {
  if (!addresses || addresses.length === 0) return {};
  
  // DexScreener supports up to 30 addresses per call
  // We'll chunk them just in case
  const chunks = [];
  for (let i = 0; i < addresses.length; i += 30) {
    chunks.push(addresses.slice(i, i + 30));
  }
  
  const results = {};
  
  for (const chunk of chunks) {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`;
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Alphalert/1.0; +https://alphalert.xyz)'
        }
      });
      
      if (!res.ok) {
        console.error(`Bulk price fetch failed: ${res.status} ${res.statusText}`);
        continue;
      }

      const data = await res.json();
      
      if (data.pairs) {
        for (const pair of data.pairs) {
          // Prefer SOL pairs for Solana tokens, etc.
          // But since we query by token address, we just need the most liquid pair
          const addr = pair.baseToken.address;
          
          // If we already have a price for this token, check if this pair is more liquid
          if (results[addr]) {
            if (pair.liquidity?.usd > results[addr].liquidity) {
              results[addr] = {
                price: parseFloat(pair.priceUsd),
                liquidity: pair.liquidity?.usd || 0
              };
            }
          } else {
            results[addr] = {
              price: parseFloat(pair.priceUsd),
              liquidity: pair.liquidity?.usd || 0
            };
          }
        }
      }
      
      // Respect rate limits - wait 1s between chunks
      if (chunks.length > 1) await new Promise(r => setTimeout(r, 1000));
      
    } catch (e) {
      console.error(`Bulk price fetch error:`, e.message);
    }
  }
  
  return results;
}

// Helper to calculate slippage
function getSlippage(tradeSize, liquidity) {
  if (!liquidity || liquidity === 0) return 0;
  // Simple linear slippage model: 1% slippage for every 1% of pool size traded
  // e.g. $250 trade in $25k pool = 1% slippage
  // Cap at 50% to avoid crazy numbers
  const impact = tradeSize / liquidity;
  return Math.min(impact, 0.5);
}

export default async function handler(req, res) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return res.status(500).json({ error: 'Missing TELEGRAM_BOT_TOKEN' });
  }
  
  try {
    const db = new SimulatorDB(botToken);
    await db.load();
    
    // Run loop 3 times (0s, 20s, 40s) to avoid rate limits
    // Total execution ~40-50s
    const iterations = 3;
    const delayMs = 20000;
    
    let totalChecked = 0;
    let totalClosed = 0;
    
    for (let i = 0; i < iterations; i++) {
      const openPositions = db.getOpenPositions();
      
      if (openPositions.length === 0) {
        console.log(`Loop ${i+1}: No open positions`);
        if (i < iterations - 1) await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      
      console.log(`Loop ${i+1}: Checking ${openPositions.length} positions...`);
      
      // Bulk fetch prices
      const addresses = openPositions.map(p => p.address);
      const marketData = await fetchPrices(addresses);
      
      const closed = [];
      const trailActivated = [];
      let dbChanged = false;
      
      for (const pos of openPositions) {
        const data = marketData[pos.address];
        
        if (!data || !data.price) {
          console.log(`   ⚠️ No price for ${pos.symbol}`);
          continue;
        }
        
        const slippage = getSlippage(pos.size, data.liquidity);
        
        const previousStatus = pos.status;
        const result = db.updatePosition(pos.address, data.price);
        
        if (!result) continue;
        dbChanged = true;
        
        if (result.action === 'closed') {
          // Apply slippage to the exit
          // updatePosition already closed it with data.price. We need to adjust it.
          const realExitPrice = data.price * (1 - slippage);
          
          // Update the DB entry directly
          const dbPos = db.getPosition(pos.address);
          dbPos.exitPrice = realExitPrice;
          dbPos.pnl = (realExitPrice / dbPos.entryPrice - 1) * dbPos.size;
          
          // Re-update stats (subtract old PnL, add new PnL)
          db.db.stats.totalPnL -= result.position.pnl; // Remove the non-slippage PnL
          db.db.stats.totalPnL += dbPos.pnl; // Add real PnL
          
          closed.push({
            symbol: pos.symbol,
            chain: pos.chain,
            address: pos.address,
            entryPrice: pos.entryPrice,
            exitPrice: realExitPrice,
            pnl: dbPos.pnl,
            reason: result.reason,
            slippage: (slippage * 100).toFixed(2)
          });
        } else if (result.position.status === 'trailing' && previousStatus === 'active') {
          trailActivated.push({
            symbol: pos.symbol,
            chain: pos.chain,
            address: pos.address,
            entryPrice: pos.entryPrice,
            currentPrice: data.price,
            peakPrice: result.position.peakPrice,
            trailPrice: result.position.trailPrice
          });
        }
      }
      
      if (dbChanged) {
        await db.save();
        
        // Send notifications
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
        
        for (const c of closed) {
          const mult = (c.exitPrice / c.entryPrice).toFixed(2);
          const pnlStr = c.pnl >= 0 ? `+$${c.pnl.toFixed(2)}` : `-$${Math.abs(c.pnl).toFixed(2)}`;
          
          const header = c.reason === 'stop_loss' 
            ? '🛑 <b>STOP LOSS HIT</b>' 
            : (c.pnl >= 0 ? '💰 <b>POSITION CLOSED</b>' : '📉 <b>POSITION CLOSED</b>');
          
          const msg = `${header}

<b>Token:</b> ${c.symbol}
<b>Entry:</b> $${c.entryPrice}
<b>Exit:</b> $${c.exitPrice.toFixed(6)} (Slip: ${c.slippage}%)
<b>Result:</b> ${mult}x (${pnlStr})
<b>Reason:</b> ${c.reason === 'stop_loss' ? 'Hard Stop (-15%)' : c.reason}

<code>${c.address}</code>`;
          
          await sendTelegramMessage(botToken, SIMULATOR_CHANNEL, msg);
          totalClosed++;
        }
      }
      
      totalChecked = openPositions.length;
      
      // Wait for next loop (unless it's the last one)
      if (i < iterations - 1) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    
    return res.status(200).json({
      status: 'ok',
      loops: iterations,
      checked: totalChecked,
      closed: totalClosed,
      stats: db.getStats()
    });
    
  } catch (error) {
    console.error('Error checking positions:', error);
    return res.status(500).json({ error: error.message });
  }
}
