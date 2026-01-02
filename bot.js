const path = require("path");
const fs = require("fs");
const EventEmitter = require("events");
const { Client, LocalAuth } = require("whatsapp-web.js");
const { MessageHandler } = require("./message-handler");

class WhatsAppBot extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.latestQr = null;
    this.messageHandler = null;
  }

  getLatestQr() {
    return this.latestQr;
  }

  async initialize() {
    const dataDir = process.env.DATA_DIR || path.join(process.cwd(), "persist");
    const authDir = path.join(dataDir, ".wwebjs_auth");

    fs.mkdirSync(authDir, { recursive: true });

    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: authDir }),
      puppeteer: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--disable-gpu"
        ]
      }
    });

    const notifyAdmin = async (text) => {
      const adminNumber = process.env.ADMIN_NUMBER;
      if (!adminNumber) return false;
      const chatId = `${adminNumber}@c.us`;
      await this.client.sendMessage(chatId, text);
      return true;
    };

    this.messageHandler = new MessageHandler({ notifyAdmin });

    this.client.on("qr", (qr) => {
      this.latestQr = qr;
      this.emit("qr", qr);
      console.log("QR received. Open /qr to scan.");
    });

    this.client.on("ready", () => {
      console.log("WhatsApp Bot is ready.");
    });

    this.client.on("auth_failure", (msg) => {
      console.error("Authentication failure:", msg);
    });

    this.client.on("message", async (message) => {
      try {
        if (message.isGroupMsg || String(message.from || "").endsWith("@g.us")) return;
        if (message.from === "status@broadcast" || message.fromMe) return;
        if (message.hasMedia) {
          await message.reply("I can only process text messages right now.");
          return;
        }

        const userId = message.from;
        const userText = message.body || "";
        if (!userText.trim()) return;
        const reply = await this.messageHandler.handleMessage(userId, userText);

        await message.reply(reply);
      } catch (err) {
        console.error("Message handling failed:", err);
        try {
          await message.reply("Sorry, something went wrong. Please try again.");
        } catch {}
      }
    });

    await this.client.initialize();
  }
}

module.exports = { WhatsAppBot };
