/**
 * API: Reset
 * 
 * Resets all positions and stats (for testing)
 * POST /api/reset
 */

import { SimulatorDB, sendTelegramMessage, SIMULATOR_CHANNEL } from '../lib/simulator-db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return res.status(500).json({ error: 'Missing TELEGRAM_BOT_TOKEN' });
  }
  
  // Optional confirmation
  const { confirm } = req.body || {};
  if (confirm !== 'RESET') {
    return res.status(400).json({ 
      error: 'Missing confirmation',
      message: 'Send { "confirm": "RESET" } to reset all data'
    });
  }
  
  try {
    const db = new SimulatorDB(botToken);
    
    // Reset to empty state
    db.data = {
      positions: {},
      stats: {
        totalPnL: 0,
        winCount: 0,
        lossCount: 0
      },
      config: {
        positionSize: 250,
        trailActivation: 1.5,
        trailPercent: 0.1,
        minScore: 0.3
      },
      lastUpdated: new Date().toISOString()
    };
    
    await db.save();
    
    const msg = `🔄 <b>SIMULATOR RESET</b>

All positions cleared.
Stats reset to zero.
Ready for new trades.`;
    
    await sendTelegramMessage(botToken, SIMULATOR_CHANNEL, msg);
    
    return res.status(200).json({
      status: 'ok',
      message: 'Simulator reset complete',
      data: db.data
    });
    
  } catch (error) {
    console.error('Error resetting simulator:', error);
    return res.status(500).json({ error: error.message });
  }
}
