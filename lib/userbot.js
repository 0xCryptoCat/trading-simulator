
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const apiId = 34484129;
const apiHash = "c0ae7a14eb9a035d21967eb605c6884a";

// Target channel to send the token address to
// Using the Simulator Channel by default, but can be changed
const TARGET_CHANNEL = '-1003691871409'; 

export async function sendUserbotMessage(tokenAddress) {
  const sessionString = process.env.TELEGRAM_SESSION;
  
  if (!sessionString) {
    console.error('❌ No TELEGRAM_SESSION found in env vars');
    return;
  }

  try {
    console.log('🤖 Connecting Userbot...');
    const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
      connectionRetries: 5,
    });
    
    await client.connect();
    
    console.log(`📤 Sending token ${tokenAddress} to ${TARGET_CHANNEL}`);
    await client.sendMessage(TARGET_CHANNEL, { message: tokenAddress });
    
    // Disconnect to prevent hanging
    await client.disconnect();
    console.log('✅ Userbot message sent');
    
  } catch (e) {
    console.error('⚠️ Userbot failed:', e.message);
  }
}
