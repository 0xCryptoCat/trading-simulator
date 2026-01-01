/**
 * Trading Simulator - Telegram DB for Position Storage
 * 
 * Uses a Telegram channel as a simple key-value store:
 * - Positions stored as JSON in pinned message
 * - Updates via edit message
 */

// Simulator Channel ID
const SIMULATOR_CHANNEL = '-1003691871409';

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
 * Edit existing message
 */
export async function editTelegramMessage(botToken, chatId, messageId, text) {
  const url = `https://api.telegram.org/bot${botToken}/editMessageText`;
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  
  return res.json();
}

/**
 * Pin a message
 */
export async function pinMessage(botToken, chatId, messageId) {
  const url = `https://api.telegram.org/bot${botToken}/pinChatMessage`;
  const body = {
    chat_id: chatId,
    message_id: messageId,
    disable_notification: true
  };
  
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  
  return res.json();
}

/**
 * Get pinned message (contains our DB)
 */
export async function getPinnedMessage(botToken, chatId) {
  const url = `https://api.telegram.org/bot${botToken}/getChat`;
  const body = { chat_id: chatId };
  
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  
  const data = await res.json();
  return data.result?.pinned_message || null;
}

/**
 * Simulator Database Class
 * Stores positions and stats in a pinned Telegram message
 */
export class SimulatorDB {
  constructor(botToken, channelId = SIMULATOR_CHANNEL) {
    this.botToken = botToken;
    this.channelId = channelId;
    this.db = null;
    this.messageId = null;
  }
  
  async load() {
    const pinned = await getPinnedMessage(this.botToken, this.channelId);
    
    if (pinned && pinned.text) {
      try {
        // Extract JSON from message (format: ```json ... ```)
        const jsonMatch = pinned.text.match(/```json\n([\s\S]*?)\n```/);
        if (jsonMatch) {
          this.db = JSON.parse(jsonMatch[1]);
          this.messageId = pinned.message_id;
          console.log(`   ✅ Loaded DB: ${Object.keys(this.db.positions || {}).length} positions`);
          return;
        }
      } catch (e) {
        console.log(`   ⚠️ Failed to parse pinned message: ${e.message}`);
      }
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
    const text = `📊 <b>Trading Simulator Database</b>

<code>Last Updated: ${new Date().toISOString()}</code>

\`\`\`json
${JSON.stringify(this.db, null, 2)}
\`\`\``;
    
    if (this.messageId) {
      await editTelegramMessage(this.botToken, this.channelId, this.messageId, text);
    } else {
      const result = await sendTelegramMessage(this.botToken, this.channelId, text);
      if (result.ok) {
        this.messageId = result.result.message_id;
        await pinMessage(this.botToken, this.channelId, this.messageId);
      }
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
    
    // Keep history manageable
    if (this.db.history.length > 100) {
      this.db.history = this.db.history.slice(-100);
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

export { SIMULATOR_CHANNEL };
