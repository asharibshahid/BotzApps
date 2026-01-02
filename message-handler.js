const { createAgent } = require("./agent");

class MessageHandler {
  constructor({ notifyAdmin }) {
    this.agent = createAgent({ notifyAdmin });
  }

  async handleMessage(userId, messageText) {
    const reply = await this.agent.run(String(messageText), { userId });
    return reply;
  }
}

module.exports = { MessageHandler };
