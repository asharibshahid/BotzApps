const store = new Map();
const HISTORY_LIMIT = 15;

function getState(userId) {
  if (!store.has(userId)) {
    store.set(userId, {
      intent: "sales",
      mode: "consulting",
      topic: "",
      stage: "discovery",
      lastQuestion: "",
      lastQuestionType: null,
      pendingClarification: false,
      history: [],
      slots: {
        businessType: "",
        primaryNeed: "",
        wantsWhatsappBot: false,
        wantsWebsite: false,
        orderingSystem: false,
        bookingSystem: false,
        budget: "",
        timeline: "",
        features: ""
      },
      updatedAt: Date.now()
    });
  }
  return store.get(userId);
}

function appendHistory(state, role, text) {
  state.history.push({
    role,
    text: String(text || ""),
    ts: Date.now()
  });
  if (state.history.length > HISTORY_LIMIT) {
    state.history = state.history.slice(-HISTORY_LIMIT);
  }
}

function recordUserMessage(userId, text) {
  const state = getState(userId);
  appendHistory(state, "user", text);
  state.updatedAt = Date.now();
  return state;
}

function recordBotReply(userId, text) {
  const state = getState(userId);
  appendHistory(state, "bot", text);
  state.updatedAt = Date.now();
  return state;
}

function setLastQuestion(userId, question) {
  const state = getState(userId);
  state.lastQuestion = question || "";
  state.updatedAt = Date.now();
  return state;
}

function setLastQuestionType(userId, questionType) {
  const state = getState(userId);
  state.lastQuestionType = questionType || null;
  state.updatedAt = Date.now();
  return state;
}

function clearLastQuestionType(userId) {
  const state = getState(userId);
  state.lastQuestionType = null;
  state.updatedAt = Date.now();
  return state;
}

module.exports = {
  getState,
  recordUserMessage,
  recordBotReply,
  setLastQuestion,
  setLastQuestionType,
  clearLastQuestionType
};
