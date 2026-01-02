const express = require("express");
const dotenv = require("dotenv");
const { WhatsAppBot } = require("./bot");

dotenv.config();

const PORT = Number(process.env.PORT) || 3000;

const app = express();
const bot = new WhatsAppBot();

app.get("/qr", (req, res) => {
  const qr = bot.getLatestQr();
  if (!qr) {
    res.status(404).send("QR not ready. Please try again in a few seconds.");
    return;
  }

  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(qr)}`;
  res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>WhatsApp QR</title>
    <style>
      body { font-family: Arial, sans-serif; display: grid; place-items: center; height: 100vh; margin: 0; }
      .card { text-align: center; padding: 24px; border: 1px solid #ddd; border-radius: 12px; }
      img { width: 320px; height: 320px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Scan QR to Login</h1>
      <p>Open WhatsApp > Linked Devices > Link a Device</p>
      <img src="${qrUrl}" alt="WhatsApp QR" />
    </div>
  </body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});

bot.initialize().catch((err) => {
  console.error("Failed to initialize WhatsApp bot:", err);
  process.exit(1);
});
