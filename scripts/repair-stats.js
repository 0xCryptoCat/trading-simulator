
import { SimulatorDB } from '../lib/simulator-db.js';

async function repair() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('Missing TELEGRAM_BOT_TOKEN');
    process.exit(1);
  }

  console.log('🔌 Connecting to DB...');
  const db = new SimulatorDB(token);
  await db.load();

  const stats = db.getStats();
  const openPositions = db.getOpenPositions();
  
  // Calculate correct totals
  // Total trades = wins + losses + open positions
  const totalTrades = stats.winCount + stats.lossCount + openPositions.length;
  const correctDeployed = totalTrades * 250; // Assuming $250 per trade

  console.log(`\n📊 Current Stats:`);
  console.log(`- Trades: ${totalTrades}`);
  console.log(`- Deployed (Bugged): $${stats.totalCapitalDeployed}`);
  console.log(`- Deployed (Fixed):  $${correctDeployed}`);

  // Apply Fix
  db.db.stats.totalCapitalDeployed = correctDeployed;
  db.db.stats.totalTrades = totalTrades; // Ensure this is synced too
  
  await db.save();
  console.log('\n✅ Database repaired and saved!');
}

repair();
