/**
 * API: Check Positions
 * 
 * Cron job that runs every 1 minute to:
 * 1. Fetch current prices for all open positions (in a 3x loop)
 * 2. Check if trail activated or trail stop hit
 * 3. Update positions and post notifications
 * 
 * GET /api/check-positions
 */

import { SimulatorDB, sendTelegramMessage, SIMULATOR_CHANNEL } from '../lib/simulator-db.js';

// DexScreener bulk price API
async function fetchPrices(positions) {
  if (!positions || positions.length === 0) return {};
  
  const addresses = positions.map(p => p.address);
  
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
          // Normalize address to lowercase for matching
          const addr = pair.baseToken.address.toLowerCase();
          
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
  
  // Fallback to GeckoTerminal for missing tokens
  const missing = positions.filter(p => !results[p.address.toLowerCase()]);
  
  if (missing.length > 0) {
    console.log(`   ⚠️ DexScreener missing ${missing.length} tokens. Trying GeckoTerminal...`);
    
    const chainMap = {
      'sol': 'solana',
      'eth': 'eth',
      'bsc': 'bsc',
      'base': 'base'
    };
    
    for (const pos of missing) {
      const network = chainMap[pos.chain?.toLowerCase()];
      if (!network) continue;
      
      const url = `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${pos.address}`;
      try {
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          const attr = data.data?.attributes;
          if (attr) {
            results[pos.address.toLowerCase()] = {
              price: parseFloat(attr.price_usd),
              liquidity: parseFloat(attr.total_reserve_in_usd || 0) // GT uses total_reserve_in_usd
            };
            console.log(`   ✅ Found ${pos.symbol} on GeckoTerminal`);
          }
        }
        // Be nice to GT API
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        console.error(`   ❌ GeckoTerminal failed for ${pos.symbol}: ${e.message}`);
      }
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
    
    // Run loop 3 times (0s, 20s, 40s) to avoid rate limits
    // Total execution ~40-50s
    const iterations = 3;
    const delayMs = 20000;
    
    let totalChecked = 0;
    let totalClosed = 0;
    
    for (let i = 0; i < iterations; i++) {
      // Reload DB each iteration to avoid race conditions with new-signal.js
      // This ensures we don't overwrite new positions added while we were sleeping
      await db.load();

      const openPositions = db.getOpenPositions();
      
      if (openPositions.length === 0) {
        console.log(`Loop ${i+1}: No open positions`);
        if (i < iterations - 1) await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      
      console.log(`Loop ${i+1}: Checking ${openPositions.length} positions...`);
      
      // Bulk fetch prices
      const marketData = await fetchPrices(openPositions);
      
      // RELOAD DB AGAIN to minimize race condition window
      // We fetched prices (slow), now we get fresh DB state before applying updates
      await db.load();
      const freshPositions = db.getOpenPositions();

      const closed = [];
      const trailActivated = [];
      let dbChanged = false;
      
      for (const pos of freshPositions) {
        // Match using lowercase address
        const data = marketData[pos.address.toLowerCase()];
        
        if (!data || !data.price) {
          // If it's a new position that wasn't in the fetch list, we skip it this time
          // console.log(`   ⚠️ No price for ${pos.symbol} (${pos.address})`);
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
        try {
          await db.save();
        } catch (saveErr) {
          // Ignore "canceled by new editMessageMedia request" as it means we're updating too fast
          // The next loop will save the latest state anyway
          if (saveErr.message && saveErr.message.includes('canceled by new editMessageMedia')) {
            console.log('   ⚠️ Save skipped (concurrent update)');
          } else {
            console.error('   ⚠️ Save failed:', saveErr.message);
          }
        }
        
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
