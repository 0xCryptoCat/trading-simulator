
import fs from 'fs';

const DB_PATH = '/Users/majsai/Downloads/trading-simulator-db-latest.json';

function analyze() {
    if (!fs.existsSync(DB_PATH)) {
        console.error(`File not found: ${DB_PATH}`);
        return;
    }

    const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    const history = data.history || [];
    
    console.log(`Loaded ${history.length} trades from history.`);
    if (history.length > 0) {
        console.log('Sample trade:', JSON.stringify(history[0], null, 2));
    }
    
    let totalRoi = 0;
    let winRoi = 0;
    let lossRoi = 0;
    let wins = 0;
    let losses = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    
    const rois = [];
    
    history.forEach(trade => {
        // Check for different PnL field names just in case
        const pnl = trade.realizedPnL !== undefined ? trade.realizedPnL : (trade.pnl || 0);
        const size = trade.size || 250; // Default size if missing
        const roi = (pnl / size) * 100;
        
        rois.push(roi);
        totalRoi += roi;
        
        if (pnl > 0) {
            wins++;
            winRoi += roi;
            grossProfit += pnl;
        } else if (pnl < 0) { // Only count as loss if pnl < 0
            losses++;
            lossRoi += roi;
            grossLoss += Math.abs(pnl);
        }
        // pnl === 0 is break-even/neutral
    });
    
    const avgRoi = history.length > 0 ? totalRoi / history.length : 0;
    const avgWinRoi = wins > 0 ? winRoi / wins : 0;
    const avgLossRoi = losses > 0 ? lossRoi / losses : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit;
    
    console.log('\n--- 📊 Trade Analysis ---');
    console.log(`Total Trades: ${history.length}`);
    console.log(`Win Rate: ${((wins / history.length) * 100).toFixed(2)}% (${wins}W / ${losses}L)`);
    console.log(`\n--- 💰 ROI Stats ---`);
    console.log(`Avg ROI per trade: ${avgRoi.toFixed(2)}%`);
    console.log(`Avg Win ROI: ${avgWinRoi.toFixed(2)}%`);
    console.log(`Avg Loss ROI: ${avgLossRoi.toFixed(2)}%`);
    console.log(`\n--- 💵 PnL Stats ---`);
    console.log(`Profit Factor: ${profitFactor.toFixed(2)}`);
    console.log(`Gross Profit: $${grossProfit.toFixed(2)}`);
    console.log(`Gross Loss: $${grossLoss.toFixed(2)}`);
    console.log(`Net PnL: $${(grossProfit - grossLoss).toFixed(2)}`);
}

analyze();
