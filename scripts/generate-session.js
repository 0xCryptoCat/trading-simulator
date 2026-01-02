
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";

const apiId = 34484129;
const apiHash = "c0ae7a14eb9a035d21967eb605c6884a";

(async () => {
  console.log("Loading interactive example...");
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.start({
    phoneNumber: async () => await input.text("Please enter your number: "),
    password: async () => await input.text("Please enter your password: "),
    phoneCode: async () => await input.text("Please enter the code you received: "),
    onError: (err) => console.log(err),
  });
  console.log("You should now be connected.");
  console.log("Save this session string in your Vercel Environment Variables as TELEGRAM_SESSION:");
  console.log(client.session.save()); // This prints the string session
  await client.disconnect();
  process.exit(0);
})();
