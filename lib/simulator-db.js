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
    const openPositions = this.getOpenPositions();
    const activeCapital = openPositions.reduce((sum, p) => sum + (p.size || 0), 0);
    
    // Calculate Win Rate
    const totalClosed = stats.winCount + stats.lossCount;
    const winRate = totalClosed > 0 ? ((stats.winCount / totalClosed) * 100).toFixed(1) : '0.0';

    return `📊 <b>Live Portfolio Status</b>

💰 <b>Active Capital:</b> $${activeCapital.toFixed(2)}
📈 <b>Open Positions:</b> ${openPositions.length}
📉 <b>Realized PnL:</b> ${stats.totalPnL >= 0 ? '+' : ''}$${stats.totalPnL.toFixed(2)}

🏆 <b>Wins:</b> ${stats.winCount}
💀 <b>Losses:</b> ${stats.lossCount}
🎯 <b>Win Rate:</b> ${winRate}%

<i>Last Updated: ${new Date().toISOString().replace('T', ' ').substring(0, 19)} UTC</i>`;
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
      
      if (pinned && pinned.document) {
        console.log(`   📥 Found pinned DB file: ${pinned.document.file_name}`);
        this.db = await this.downloadFile(pinned.document.file_id);
        this.messageId = pinned.message_id;
        this.fileId = pinned.document.file_id;
        console.log(`   ✅ Loaded DB: ${Object.keys(this.db.positions || {}).length} positions`);
        return;
      }
    } catch (e) {
      console.log(`   ⚠️ Failed to load pinned DB: ${e.message}`);
    }
    
    // Initialize fresh DB
    this.db = {
      version: 1,
      created: Date.now(),
      updated: Date.now(),
      config: {
        positionSize: 250,
        scoreFilter: 0.3,
        trailActivation: 1.5,
        trailDistance: 0.10
      },
      stats: {
        totalTrades: 0,
        openPositions: 0,
        closedPositions: 0,
        totalPnL: 0,
        winCount: 0,
        lossCount: 0
      },
      positions: {},
      history: []
    };
    
    await this.save();
    console.log(`   📦 Initialized fresh DB`);
  }
  
  async save() {
    const filename = 'simulator-db.json';
    
    if (this.messageId) {
      try {
        const res = await this.updateFile(this.messageId, this.db, filename);
        this.fileId = res.fileId;
      } catch (e) {
        console.log(`   ⚠️ Update failed, creating new file: ${e.message}`);
        // If update fails (e.g. message deleted), create new
        const res = await this.uploadFile(this.db, filename);
        this.messageId = res.messageId;
        this.fileId = res.fileId;
        await this.api('pinChatMessage', {
          chat_id: this.channelId,
          message_id: this.messageId,
          disable_notification: true
        });
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
  }
  
  updatePosition(tokenAddress, currentPrice) {
    const pos = this.db.positions[tokenAddress];
    if (!pos || pos.status === 'exited') return null;
    
    const config = this.db.config;
    const entryPrice = pos.entryPrice;
    const currentMult = currentPrice / entryPrice;
    
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
    pos.pnl = (currentMult - 1) * pos.size;
    
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
