/**
 * API: Get Stats
 * 
 * Returns current portfolio statistics
 * 
 * GET /api/stats
 */

import { SimulatorDB, sendTelegramMessage, SIMULATOR_CHANNEL } from '../lib/simulator-db.js';

export default async function handler(req, res) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return res.status(500).json({ error: 'Missing TELEGRAM_BOT_TOKEN' });
  }
  
  try {
    const db = new SimulatorDB(botToken);
    await db.load();
    
    const stats = db.getStats();
    const openPositions = db.getOpenPositions();
    const closedPositions = db.getClosedPositions();
    
    // Calculate additional metrics
    let totalUnrealizedPnL = 0;
    const positionDetails = openPositions.map(p => {
      const unrealized = p.pnl || 0;
      totalUnrealizedPnL += unrealized;
      return {
        symbol: p.symbol,
        chain: p.chain,
        status: p.status,
        entryPrice: p.entryPrice,
        currentPrice: p.currentPrice || p.entryPrice,
        multiplier: ((p.currentPrice || p.entryPrice) / p.entryPrice).toFixed(2),
        pnl: p.pnl?.toFixed(2) || '0.00',
        openedAt: p.openedAt
      };
    });
    
    // Recent closed trades
    const recentClosed = closedPositions
      .sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt))
      .slice(0, 10)
      .map(p => ({
        symbol: p.symbol,
        chain: p.chain,
        entryPrice: p.entryPrice,
        exitPrice: p.exitPrice,
        multiplier: (p.exitPrice / p.entryPrice).toFixed(2),
        pnl: p.pnl?.toFixed(2) || '0.00',
        closedAt: p.closedAt
      }));
    
    // Check if user wants to post stats to channel
    const postToChannel = req.query.post === 'true';
    
    if (postToChannel) {
      let statsMsg = `📊 <b>PORTFOLIO STATS</b>

💰 Realized PnL: $${stats.totalPnL.toFixed(2)}
📈 Unrealized PnL: $${totalUnrealizedPnL.toFixed(2)}

📊 <b>Performance</b>
• Total Trades: ${stats.closedPositions}
• Win Rate: ${stats.winRate}%
• Wins: ${stats.wins} | Losses: ${stats.losses}

📂 <b>Open Positions: ${stats.openPositions}</b>`;

      if (openPositions.length > 0) {
        statsMsg += '\n';
        for (const p of positionDetails) {
          const emoji = p.status === 'trailing' ? '🚀' : '⏳';
          statsMsg += `\n${emoji} ${p.symbol}: ${p.multiplier}x ($${p.pnl})`;
        }
      }

      await sendTelegramMessage(botToken, SIMULATOR_CHANNEL, statsMsg);
    }
    
    return res.status(200).json({
      status: 'ok',
      summary: {
        ...stats,
        unrealizedPnL: totalUnrealizedPnL.toFixed(2)
      },
      openPositions: positionDetails,
      recentClosed
    });
    
  } catch (error) {
    console.error('Error getting stats:', error);
    return res.status(500).json({ error: error.message });
  }
}
