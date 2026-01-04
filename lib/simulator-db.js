/**
 * Trading Simulator - Telegram DB for Position Storage (File-Based)
 * 
 * Uses Telegram file upload/download for unlimited storage.
 * Stores JSON files (up to 50MB) instead of message text.
 */

// Simulator Channel ID
export const SIMULATOR_CHANNEL = '-1003691871409';

/**
 * Send message to Telegram
 */
export async function sendTelegramMessage(botToken, chatId, text, options = {}) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...options
  };
  
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  
  return res.json();
}

/**
 * Simulator Database Class
 * Stores positions and stats in a pinned Telegram document (JSON file)
 */
export class SimulatorDB {
  constructor(botToken, channelId = SIMULATOR_CHANNEL) {
    this.botToken = botToken;
    this.channelId = channelId;
    this.apiBase = `https://api.telegram.org/bot${botToken}`;
    
    this.db = null;
    this.fileId = null;
    this.messageId = null;
  }

  // ============================================================
  // TELEGRAM API HELPERS
  // ============================================================

  async api(method, params = {}) {
    const res = await fetch(`${this.apiBase}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`TG API ${method}: ${json.description}`);
    return json.result;
  }

  async apiForm(method, formData) {
    const res = await fetch(`${this.apiBase}/${method}`, {
      method: 'POST',
      body: formData,
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`TG API ${method}: ${json.description}`);
    return json.result;
  }

  // ============================================================
  // FILE OPERATIONS
  // ============================================================

  generateSummary() {
    const stats = this.db.stats;
    const config = this.db.config;
    const openPositions = this.getOpenPositions();
    const activeCapital = openPositions.reduce((sum, p) => sum + (p.size || 0), 0);
    const unrealizedPnL = openPositions.reduce((sum, p) => sum + (p.unrealizedPnL || 0), 0);
    const netPnL = stats.totalPnL + unrealizedPnL;
    
    // Capital tracking
    const startingCapital = stats.startingCapital || 5000; // Default to $5k if not set
    const currentBalance = startingCapital + netPnL;
    const totalGrowth = ((currentBalance / startingCapital - 1) * 100).toFixed(2);
    
    const totalDeployed = stats.totalCapitalDeployed || (stats.totalTrades * config.positionSize);
    const ongoingCapital = activeCapital + unrealizedPnL;

    const peakUsed = stats.peakCapitalDeployed || 0;
    const peakUsedPct = startingCapital > 0 ? ((peakUsed / startingCapital) * 100).toFixed(0) : '0';

    // ROI Calculations
    const roiCum = totalDeployed > 0 ? ((netPnL / totalDeployed) * 100).toFixed(2) : '0.00';
    const roiInit = ((netPnL / startingCapital) * 100).toFixed(2);
    
    // Strategy config display
    const slPct = config.stopLoss ? (config.stopLoss * 100).toFixed(0) : '15';
    const trailPct = config.trailActivation ? ((config.trailActivation - 1) * 100).toFixed(0) : '50';
    const tdPct = config.trailDistance ? (config.trailDistance * 100).toFixed(0) : '5';
    
    // Win rate from closed positions only
    const closedCount = stats.closedPositions || (stats.winCount + stats.lossCount);
    const winRate = closedCount > 0 ? ((stats.winCount / closedCount) * 100).toFixed(1) : '0.0';

    let msg = `📊 <b>Live Portfolio Status</b>

🏦 Init Capital: <b>$${startingCapital.toLocaleString()}</b>
✅ Peak Used: $${peakUsed.toLocaleString()} (${peakUsedPct}%)
🔄 Cum Used: $${totalDeployed.toLocaleString()} (${stats.totalTrades} trades)

💵 Active: $${activeCapital.toFixed(0)} (${openPositions.length} positions)
🔥 Ongoing: $${ongoingCapital.toFixed(2)}

💸 Unrealized: ${unrealizedPnL >= 0 ? '+' : ''}$${unrealizedPnL.toFixed(2)}
💰 Realized: ${stats.totalPnL >= 0 ? '+' : ''}$${stats.totalPnL.toFixed(2)}
📈 Net PnL: ${netPnL >= 0 ? '+' : ''}$${netPnL.toFixed(2)}

⭐️ Total: <b>$${currentBalance.toLocaleString()}</b> (${totalGrowth >= 0 ? '+' : ''}${totalGrowth}%)

🏆 Win Rate: ${winRate}% (${stats.winCount}W / ${stats.lossCount}L)
ROI Cum: ${roiCum}% | ROI Init: ${roiInit}%
⚙️ Strat: SL -${slPct}% | Trail +${trailPct}% | TD ${tdPct}%`;

    // Add positions list if any
    if (openPositions.length > 0) {
      msg += `\n\n<b>Positions (${openPositions.length}):</b>\n━━━━━━━━━━━━━\n`;
      
      // Chain emoji mapping
      const chainEmoji = { sol: '🟣', eth: '🔷', bsc: '🔶', base: '🔵' };
      
      // Sort by unrealized PnL (best first)
      const sorted = openPositions.sort((a, b) => (b.unrealizedPnL || 0) - (a.unrealizedPnL || 0));
      
      for (const pos of sorted) {
        const emoji = chainEmoji[pos.chain?.toLowerCase()] || '📊';
        const pnl = pos.unrealizedPnL || 0;
        // Use current PnL for percentage, not peak price
        const pnlPct = pos.size > 0 ? ((pnl / pos.size) * 100) : 0;
        const pctStr = pnlPct >= 0 ? `+${pnlPct.toFixed(1)}%` : `${pnlPct.toFixed(1)}%`;
        const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(0)}` : `-$${Math.abs(pnl).toFixed(0)}`;
        const statusIcon = pos.status === 'trailing' ? '🔒' : '';
        
        msg += `${emoji}<code>${pctStr}│${pnlStr}${statusIcon}│</code><b>${pos.symbol}</b>\n`;
      }
      
      msg += `━━━━━━━━━━━━━`;
    }

    msg += `\n<i>${new Date().toISOString().replace('T', ' ').substring(0, 16)} UTC</i>`;
    
    return msg;
  }

  async uploadFile(data, filename) {
    const jsonStr = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    
    const formData = new FormData();
    formData.append('chat_id', this.channelId);
    formData.append('document', blob, filename);
    formData.append('caption', this.generateSummary());
    formData.append('parse_mode', 'HTML');
    
    const result = await this.apiForm('sendDocument', formData);
    return {
      messageId: result.message_id,
      fileId: result.document.file_id,
    };
  }

  async updateFile(messageId, data, filename) {
    const jsonStr = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    
    const formData = new FormData();
    formData.append('chat_id', this.channelId);
    formData.append('message_id', messageId);
    formData.append('media', JSON.stringify({
      type: 'document',
      media: 'attach://document',
      caption: this.generateSummary(),
      parse_mode: 'HTML'
    }));
    formData.append('document', blob, filename);
    
    const result = await this.apiForm('editMessageMedia', formData);
    return {
      messageId: result.message_id,
      fileId: result.document.file_id,
    };
  }

  async downloadFile(fileId) {
    const file = await this.api('getFile', { file_id: fileId });
    const path = file.file_path;
    
    const res = await fetch(`https://api.telegram.org/file/bot${this.botToken}/${path}`);
    return await res.json();
  }

  // ============================================================
  // DB OPERATIONS
  // ============================================================
  
  async load() {
    try {
      const chat = await this.api('getChat', { chat_id: this.channelId });
      const pinned = chat.pinned_message;
      
      if (pinned) {
        // Case 1: It's a document (potential DB)
        if (pinned.document) {
          // Check filename to ensure it's our DB
          if (pinned.document.file_name === 'trading-simulator-db.json') {
            console.log(`   📥 Found pinned DB file: ${pinned.document.file_name}`);
            try {
              this.db = await this.downloadFile(pinned.document.file_id);
              this.messageId = pinned.message_id;
              this.fileId = pinned.document.file_id;
              const total = Object.keys(this.db.positions || {}).length;
              const active = Object.values(this.db.positions || {}).filter(p => p.status === 'active' || p.status === 'trailing').length;
              console.log(`   ✅ Loaded DB: ${total} total (${active} active)`);
              return;
            } catch (parseErr) {
              console.error(`   ⚠️ Failed to parse pinned DB: ${parseErr.message}`);
              // If parsing fails, we might want to backup or fail, but for now let's fall through
            }
          } else {
            // Document exists but wrong name - User pinned something else?
            console.error(`   ⚠️ Pinned document '${pinned.document.file_name}' is not the DB!`);
            throw new Error('Pinned message is not the simulator DB. Please unpin it or re-pin the DB file.');
          }
        } else {
          // Case 2: Pinned message is NOT a document (e.g. text/photo)
          // This means the DB is hidden behind this pin. DO NOT WIPE.
          console.error('   ⚠️ Pinned message is not a document! DB might be hidden.');
          throw new Error('Pinned message is not the simulator DB. Please unpin it to restore DB access.');
        }
      } else {
        // No pinned message at all - Assume fresh start
        console.log('   ℹ️ No pinned message found. Starting fresh.');
      }
    } catch (e) {
      console.log(`   🛑 Load aborted: ${e.message}`);
      // Re-throw to stop execution and prevent overwriting
      throw e;
    }
    
    // Initialize fresh DB (Only if no pinned message found)
    this.db = {
      version: 1,
      created: Date.now(),
      updated: Date.now(),
      config: {
        positionSize: 250,
        scoreFilter: 0.3,
        trailActivation: 1.5,
        trailDistance: 0.05,  // Tight 5% trail distance (optimal from backtest)
        stopLoss: 0.15  // Hard stop loss at -15% (optimal from backtest)
      },
      stats: {
        totalTrades: 0,
        openPositions: 0,
        closedPositions: 0,
        totalPnL: 0,
        winCount: 0,
        lossCount: 0,
        startingCapital: 0,
        peakCapitalDeployed: 0,
        totalCapitalDeployed: 0,
        capitalFromProfits: 0
      },
      positions: {},
      history: []
    };
    
    await this.save();
    console.log(`   📦 Initialized fresh DB`);
  }
  
  async save() {
    const filename = 'trading-simulator-db.json';
    
    if (this.messageId) {
      try {
        const res = await this.updateFile(this.messageId, this.db, filename);
        this.fileId = res.fileId;
      } catch (e) {
        // Ignore "not modified" error - it means data hasn't changed
        if (e.message.includes('message is not modified')) {
          return;
        }
        
        console.log(`   ⚠️ Update failed: ${e.message}`);
        
        // Only create new file if the message is truly gone or inaccessible
        if (e.message.includes('message to edit not found') || e.message.includes('chat not found')) {
          console.log('   🔄 Message lost, creating new DB file...');
          const res = await this.uploadFile(this.db, filename);
          this.messageId = res.messageId;
          this.fileId = res.fileId;
          await this.api('pinChatMessage', {
            chat_id: this.channelId,
            message_id: this.messageId,
            disable_notification: true
          });
        } else {
          // For other errors (network, timeout), throw to prevent data loss/forking
          throw e;
        }
      }
    } else {
      const res = await this.uploadFile(this.db, filename);
      this.messageId = res.messageId;
      this.fileId = res.fileId;
      await this.api('pinChatMessage', {
        chat_id: this.channelId,
        message_id: this.messageId,
        disable_notification: true
      });
    }
    
    this.db.updated = Date.now();
  }
  
  getPosition(tokenAddress) {
    return this.db.positions[tokenAddress] || null;
  }
  
  getAllPositions() {
    return this.db.positions;
  }
  
  getOpenPositions() {
    return Object.entries(this.db.positions)
      .filter(([_, p]) => p.status === 'active' || p.status === 'trailing')
      .map(([addr, p]) => ({ address: addr, ...p }));
  }
  
  getClosedPositions() {
    return Object.entries(this.db.positions)
      .filter(([_, p]) => p.status === 'exited')
      .map(([addr, p]) => ({ address: addr, ...p }));
  }
  
  addPosition(tokenAddress, data) {
    this.db.positions[tokenAddress] = {
      status: 'active',
      entryTime: Date.now(),
      entryPrice: data.entryPrice,
      signalPrice: data.signalPrice || data.entryPrice, // Original OKX signal price for reference
      size: data.size || this.db.config.positionSize,
      chain: data.chain,
      symbol: data.symbol,
      score: data.score,
      peakPrice: data.entryPrice,
      peakTime: Date.now(),
      trailPrice: null,
      exitPrice: null,
      exitTime: null,
      pnl: 0,
      signalMsgId: data.signalMsgId
    };
    
    this.db.stats.totalTrades++;
    this.db.stats.openPositions++;
    
    // Track capital deployed
    const posSize = data.size || this.db.config.positionSize;
    this.db.stats.totalCapitalDeployed = (this.db.stats.totalCapitalDeployed || 0) + posSize;
    
    // Calculate current capital deployed
    const currentDeployed = this.getOpenPositions().reduce((sum, p) => sum + (p.size || 0), 0);
    
    // Track peak capital deployed
    if (currentDeployed > (this.db.stats.peakCapitalDeployed || 0)) {
      this.db.stats.peakCapitalDeployed = currentDeployed;
    }
    
    // Track if this came from profits or fresh capital
    const availableProfits = this.db.stats.totalPnL || 0;
    if (availableProfits >= posSize) {
      this.db.stats.capitalFromProfits = (this.db.stats.capitalFromProfits || 0) + posSize;
    } else {
      // Some from profits, rest from fresh
      const fromProfits = Math.max(0, availableProfits);
      this.db.stats.capitalFromProfits = (this.db.stats.capitalFromProfits || 0) + fromProfits;
      this.db.stats.startingCapital = (this.db.stats.startingCapital || 0) + (posSize - fromProfits);
    }
  }
  
  updatePosition(tokenAddress, currentPrice) {
    const pos = this.db.positions[tokenAddress];
    if (!pos || pos.status === 'exited') return null;
    
    const config = this.db.config;
    const entryPrice = pos.entryPrice;
    const currentMult = currentPrice / entryPrice;
    
    // Check stop loss FIRST (before trail logic)
    const stopLoss = config.stopLoss || 0.25; // Default -25%
    if (currentMult <= (1 - stopLoss)) {
      const stopPrice = entryPrice * (1 - stopLoss);
      return this.closePosition(tokenAddress, stopPrice, 'stop_loss');
    }
    
    // Update peak
    if (currentPrice > pos.peakPrice) {
      pos.peakPrice = currentPrice;
      pos.peakTime = Date.now();
    }
    
    // Check trail activation
    if (pos.status === 'active' && currentMult >= config.trailActivation) {
      pos.status = 'trailing';
      pos.trailPrice = pos.peakPrice * (1 - config.trailDistance);
    }
    
    // Update trail stop if trailing
    if (pos.status === 'trailing') {
      pos.trailPrice = pos.peakPrice * (1 - config.trailDistance);
      
      // Check if trail hit
      if (currentPrice <= pos.trailPrice) {
        return this.closePosition(tokenAddress, pos.trailPrice, 'trail');
      }
    }
    
    // Update unrealized PnL
    pos.unrealizedPnL = (currentMult - 1) * pos.size;
    
    return { action: 'update', position: pos };
  }
  
  closePosition(tokenAddress, exitPrice, reason) {
    const pos = this.db.positions[tokenAddress];
    if (!pos) return null;
    
    pos.status = 'exited';
    pos.exitPrice = exitPrice;
    pos.exitTime = Date.now();
    pos.exitReason = reason;
    pos.pnl = (exitPrice / pos.entryPrice - 1) * pos.size;
    
    // Update stats
    this.db.stats.openPositions--;
    this.db.stats.closedPositions++;
    this.db.stats.totalPnL += pos.pnl;
    
    if (pos.pnl > 0) {
      this.db.stats.winCount++;
    } else {
      this.db.stats.lossCount++;
    }
    
    // Add to history
    this.db.history.push({
      address: tokenAddress,
      symbol: pos.symbol,
      chain: pos.chain,
      entry: pos.entryPrice,
      exit: exitPrice,
      pnl: pos.pnl,
      reason,
      duration: pos.exitTime - pos.entryTime
    });
    
    // Keep history manageable (but larger now that we have files)
    if (this.db.history.length > 1000) {
      this.db.history = this.db.history.slice(-1000);
    }
    
    return { action: 'closed', position: pos, reason };
  }
  
  getStats() {
    const open = this.getOpenPositions();
    const unrealizedPnL = open.reduce((sum, p) => sum + (p.pnl || 0), 0);
    
    return {
      ...this.db.stats,
      unrealizedPnL,
      totalPnL: this.db.stats.totalPnL + unrealizedPnL,
      winRate: this.db.stats.closedPositions > 0 
        ? (this.db.stats.winCount / this.db.stats.closedPositions * 100).toFixed(1) 
        : 0
    };
  }
}
