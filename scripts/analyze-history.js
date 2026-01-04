
import fs from 'fs';

const DB_PATHS = [
    '/Users/majsai/Downloads/trading-simulator-db-new.json',
    '/Users/majsai/Downloads/trading-simulator-db-old.json'
];

function analyze() {
    let allHistory = [];

    DB_PATHS.forEach(path => {
        if (!fs.existsSync(path)) {
            console.error(`File not found: ${path}`);
            return;
        }
        try {
            const data = JSON.parse(fs.readFileSync(path, 'utf8'));
            const history = data.history || [];
            console.log(`Loaded ${history.length} trades from ${path.split('/').pop()}`);
            if (history.length > 0) {
                console.log(`  First: ${history[0].symbol} (${history[0].address})`);
                console.log(`  Last:  ${history[history.length-1].symbol} (${history[history.length-1].address})`);
            }
            allHistory = allHistory.concat(history);
        } catch (e) {
            console.error(`Error reading ${path}:`, e.message);
        }
    });

    // Deduplicate based on address + entry price (to handle re-entries if any, though unlikely with same price)
    // Using a Map to keep the "latest" version if duplicates exist (though they should be identical)
    const uniqueTrades = new Map();
    
    allHistory.forEach(trade => {
        // Normalize fields
        const address = trade.address || trade.tokenAddress;
        const entry = trade.entry || trade.entryPrice;
        
        if (!address) return;
        
        const key = `${address}-${entry}`;
        uniqueTrades.set(key, trade);
    });
    
    const history = Array.from(uniqueTrades.values());
    
    console.log(`\nMerged Total: ${history.length} unique trades.`);

    // Check positions for missing history
    let recoveredCount = 0;
    DB_PATHS.forEach(path => {
        if (!fs.existsSync(path)) return;
        try {
            const data = JSON.parse(fs.readFileSync(path, 'utf8'));
            const positions = data.positions || {};
            Object.entries(positions).forEach(([key, pos]) => {
                if (pos.status === 'exited') {
                    // Check if in history
                    const address = pos.tokenAddress || key;
                    const exists = history.some(h => h.address === address && Math.abs(h.entry - pos.entryPrice) < 0.000000001);
                    if (!exists) {
                        // Reconstruct history item
                        const item = {
                            address: address,
                            symbol: pos.symbol,
                            chain: pos.chain,
                            entry: pos.entryPrice,
                            exit: pos.exitPrice,
                            pnl: pos.pnl,
                            reason: pos.exitReason,
                            duration: (pos.exitTime || 0) - (pos.entryTime || 0)
                        };
                        // Add to history if valid
                        if (item.entry && item.exit) {
                            history.push(item);
                            recoveredCount++;
                        }
                    }
                }
            });
        } catch (e) {}
    });
    
    if (recoveredCount > 0) {
        console.log(`♻️ Recovered ${recoveredCount} trades from 'positions' object!`);
        console.log(`Total Trades Now: ${history.length}`);
    }
    
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
