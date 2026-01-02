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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return res.status(500).json({ error: 'Missing TELEGRAM_BOT_TOKEN' });
  }
  
  const { tokenAddress, chain, symbol, entryPrice, score, signalMsgId } = req.body;
  
  if (!tokenAddress || !entryPrice) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  try {
    const db = new SimulatorDB(botToken);
    await db.load();
    
    // Check if position already exists
    const existing = db.getPosition(tokenAddress);
    if (existing && existing.status !== 'exited') {
      return res.status(200).json({ 
        status: 'exists', 
        message: 'Position already open',
        position: existing
      });
    }
    
    // Open new position
    db.addPosition(tokenAddress, {
      chain: chain || 'SOL',
      symbol: symbol || tokenAddress.slice(0, 8),
      entryPrice: parseFloat(entryPrice),
      score: parseFloat(score) || 0,
      size: db.db.config.positionSize,
      signalMsgId
    });
    
    await db.save();
    
    // Send notification
    const chainTag = { sol: '🟣', eth: '🔷', bsc: '🔶', base: '🔵' }[chain?.toLowerCase()] || '📊';
    const position = db.getPosition(tokenAddress);
    
    const msg = `${chainTag} <b>NEW POSITION</b>

<b>Token:</b> ${symbol || tokenAddress.slice(0, 8)}
<b>Entry:</b> $${entryPrice < 0.0001 ? parseFloat(entryPrice).toExponential(2) : parseFloat(entryPrice).toFixed(6)}
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
