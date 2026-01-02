/**
 * API: New Signal Entry
 * 
 * Called by signal-pipeline when a new signal passes the score filter.
 * Opens a simulated position.
 * 
 * POST /api/new-signal
 * Body: { tokenAddress, chain, symbol, entryPrice, score, signalMsgId }
 */

import { SimulatorDB, sendTelegramMessage, SIMULATOR_CHANNEL } from '../lib/simulator-db.js';
import { sendUserbotMessage } from '../lib/userbot.js';

// Fetch LIVE price from DexScreener (more accurate than OKX signal price)
async function fetchLivePrice(chain, tokenAddress) {
  const chainMap = {
    'sol': 'solana',
    'eth': 'ethereum', 
    'bsc': 'bsc',
    'base': 'base'
  };
  
  const dexChain = chainMap[chain?.toLowerCase()] || 'solana';
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
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return res.status(500).json({ error: 'Missing TELEGRAM_BOT_TOKEN' });
  }
  
  const { tokenAddress, chain, symbol, entryPrice: signalPrice, score, signalMsgId } = req.body;
  
  if (!tokenAddress) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  try {
    const db = new SimulatorDB(botToken);
    await db.load();
    
    // Check if position already exists (active OR closed)
    const existing = db.getPosition(tokenAddress);
    if (existing) {
      // If active, definitely don't buy
      if (existing.status !== 'exited') {
        return res.status(200).json({ 
          status: 'exists', 
          message: 'Position already open',
          position: existing
        });
      }
      
      // If exited, check if we want to re-enter (currently: NO)
      // This prevents double-buying the same token if multiple signals come in
      return res.status(200).json({
        status: 'exists',
        message: 'Position previously closed (no re-entry)',
        position: existing
      });
    }
    
    // Also check history to be safe (in case position was removed from active map)
    const inHistory = db.db.history?.find(h => h.address === tokenAddress);
    if (inHistory) {
      return res.status(200).json({
        status: 'exists',
        message: 'Token in history (no re-entry)',
        history: inHistory
      });
    }
    
    // Fetch LIVE price from DexScreener (overrides OKX signal price)
    // This is the actual market price we'd pay if trading live
    const livePrice = await fetchLivePrice(chain, tokenAddress);
    const entryPrice = livePrice > 0 ? livePrice : parseFloat(signalPrice) || 0;
    
    if (entryPrice === 0) {
      return res.status(400).json({ error: 'Could not determine entry price' });
    }
    
    // Log if there's a significant difference between signal and live price
    const signalPriceNum = parseFloat(signalPrice) || 0;
    const priceDiff = signalPriceNum > 0 ? ((entryPrice / signalPriceNum - 1) * 100) : 0;
    if (Math.abs(priceDiff) > 10) {
      console.log(`   ⚠️ Price difference: Signal $${signalPriceNum} vs Live $${entryPrice} (${priceDiff.toFixed(1)}%)`);
    }
    
    // Open new position with LIVE price
    db.addPosition(tokenAddress, {
      chain: chain || 'SOL',
      symbol: symbol || tokenAddress.slice(0, 8),
      entryPrice: entryPrice,
      signalPrice: signalPriceNum, // Store original signal price for reference
      score: parseFloat(score) || 0,
      size: db.db.config.positionSize,
      signalMsgId
    });
    
    await db.save();
    
    // Send notification
    const chainTag = { sol: '🟣', eth: '🔷', bsc: '🔶', base: '🔵' }[chain?.toLowerCase()] || '📊';
    const position = db.getPosition(tokenAddress);
    
    // Show both prices if they differ significantly
    const entryPriceStr = entryPrice < 0.0001 ? entryPrice.toExponential(2) : entryPrice.toFixed(6);
    const signalInfo = Math.abs(priceDiff) > 5 
      ? `\n<i>Signal: $${signalPriceNum < 0.0001 ? signalPriceNum.toExponential(2) : signalPriceNum.toFixed(6)} (Live ${priceDiff > 0 ? '+' : ''}${priceDiff.toFixed(0)}%)</i>`
      : '';
    
    const msg = `${chainTag} <b>NEW POSITION</b>

<b>Token:</b> ${symbol || tokenAddress.slice(0, 8)}
<b>Entry:</b> $${entryPriceStr}${signalInfo}
<b>Size:</b> $${position.size}
<b>Score:</b> ${score?.toFixed(2) || 'N/A'}

📍 Trail activates at ${(db.db.config.trailActivation * 100 - 100).toFixed(0)}% gain
🛑 Trail stop: -${(db.db.config.trailDistance * 100).toFixed(0)}% from peak

<code>${tokenAddress}</code>`;
    
    await sendTelegramMessage(botToken, SIMULATOR_CHANNEL, msg);
    
    // Trigger Userbot to send token address
    // Must await this in Vercel/Serverless environment or process will be killed
    try {
      await sendUserbotMessage(tokenAddress);
    } catch (err) {
      console.error('Userbot trigger failed:', err);
    }

    return res.status(200).json({
      status: 'opened',
      position: position,
      stats: db.getStats()
    });
    
  } catch (error) {
    console.error('Error opening position:', error);
    return res.status(500).json({ error: error.message });
  }
}
