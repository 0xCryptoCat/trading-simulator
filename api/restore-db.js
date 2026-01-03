/**
 * API: Restore Database
 * 
 * Merges an old database backup (provided in body) into the current live database.
 * Used to recover from accidental DB resets.
 * 
 * POST /api/restore-db
 * Body: JSON content of the old trading-simulator-db.json
 */

import { SimulatorDB } from '../lib/simulator-db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const oldDB = req.body;

  if (!oldDB || !oldDB.stats || !oldDB.positions) {
    return res.status(400).json({ error: 'Invalid DB backup provided. Body must be the JSON content of the old DB.' });
  }

  try {
    const db = new SimulatorDB(botToken);
    await db.load(); // Loads the CURRENT (new) DB from Telegram

    console.log('🔄 Starting DB Restoration...');
    console.log(`   Current Stats:`, JSON.stringify(db.db.stats));
    console.log(`   Old Stats:`, JSON.stringify(oldDB.stats));

    // 1. Merge Stats
    // Add old cumulative stats to new stats
    db.db.stats.totalTrades += oldDB.stats.totalTrades || 0;
    db.db.stats.winCount += oldDB.stats.winCount || 0;
    db.db.stats.lossCount += oldDB.stats.lossCount || 0;
    db.db.stats.closedPositions += oldDB.stats.closedPositions || 0;
    db.db.stats.totalPnL += oldDB.stats.totalPnL || 0;
    db.db.stats.totalCapitalDeployed += oldDB.stats.totalCapitalDeployed || 0;
    db.db.stats.capitalFromProfits += oldDB.stats.capitalFromProfits || 0;
    
    // Preserve starting capital from old DB (it's the true start)
    if (oldDB.stats.startingCapital) {
      db.db.stats.startingCapital = oldDB.stats.startingCapital;
    }
    
    // Peak capital: take the max
    db.db.stats.peakCapitalDeployed = Math.max(
      db.db.stats.peakCapitalDeployed || 0, 
      oldDB.stats.peakCapitalDeployed || 0
    );

    // 2. Merge Positions
    // Restore ACTIVE positions from old DB
    let restoredCount = 0;
    const currentPositions = db.db.positions || {};
    
    for (const [addr, pos] of Object.entries(oldDB.positions)) {
      // If position doesn't exist in current DB
      if (!currentPositions[addr]) {
        // Restore if it was ACTIVE or TRAILING
        if (pos.status === 'active' || pos.status === 'trailing') {
           db.db.positions[addr] = pos;
           restoredCount++;
           console.log(`   ➕ Restored active position: ${pos.symbol} (${addr})`);
        }
      }
    }

    // 3. Merge History
    // Prepend old history to new history
    if (oldDB.history && Array.isArray(oldDB.history)) {
       const currentHistory = db.db.history || [];
       // Avoid duplicates based on tx hash or address+time? 
       // Simple concat for now, assuming new DB started after old DB ended
       db.db.history = [...oldDB.history, ...currentHistory];
       console.log(`   📜 Merged ${oldDB.history.length} history items`);
    }

    // 4. Recalculate Open Positions Count
    const openPos = Object.values(db.db.positions).filter(p => p.status === 'active' || p.status === 'trailing');
    db.db.stats.openPositions = openPos.length;

    console.log(`   ✅ Restoration complete. Saving...`);
    
    // Save merged DB to Telegram
    await db.save();

    return res.status(200).json({ 
      message: 'DB Restored Successfully', 
      restoredPositions: restoredCount,
      newStats: db.db.stats 
    });

  } catch (error) {
    console.error('Restore failed:', error);
    return res.status(500).json({ error: error.message });
  }
}