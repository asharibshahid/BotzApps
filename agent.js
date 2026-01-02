require("dotenv").config();
const { Agent, run, tool } = require("@openai/agents");
const { retrieveKnowledge } = require("./rag");
const stateStore = require("./state-store");

const RAG_TOP_K = 3;
const RAG_MIN_SCORE = 0.22;
const RAG_MAX_CHUNKS = 2;
const HISTORY_WINDOW = 15;

function formatRetrievedContext(chunks) {
  return chunks
    .map((c) => `[${c.id}] ${c.title ? `${c.title}: ` : ""}${c.text}`)
    .join("\n");
}

function extractCitations(text) {
  const ids = [];
  const regex = /\[(chunk:[^\]]+)\]/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4);
}

function hasSupport(line, chunkText) {
  const lineTokens = tokenize(line);
  const chunkTokens = new Set(tokenize(chunkText));
  let hit = 0;
  for (const t of lineTokens) {
    if (chunkTokens.has(t)) hit += 1;
    if (hit >= 2) return true;
  }
  return false;
}

function enforceGrounding(text, allowedChunks) {
  const allowedIds = new Set(allowedChunks.map((c) => c.id));
  const lines = String(text || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const kept = [];
  const used = new Set();

  for (const line of lines) {
    const cites = extractCitations(line).filter((id) => allowedIds.has(id));
    if (cites.length === 0) continue;
    const supported = cites.some((id) => {
      const chunk = allowedChunks.find((c) => c.id === id);
      return chunk ? hasSupport(line, chunk.text) : false;
    });
    if (!supported) continue;
    cites.forEach((id) => used.add(id));
    kept.push(line);
  }

  return {
    text: kept.join("\n"),
    usedIds: Array.from(used)
  };
}

function buildNoRagReply() {
  return (
    "Is info ke liye thori clarity chahiye hogi. " +
    "Aap kis policy ya company detail ke bare mein pooch rahe hain?"
  );
}

function stripCitations(text) {
  return String(text || "").replace(/\[chunk:[^\]]+\]/g, "").replace(/\s{2,}/g, " ").trim();
}

function isShortReply(message) {
  const text = String(message || "").trim().toLowerCase();
  return [
    "yes",
    "no",
    "han",
    "haan",
    "ok",
    "theek",
    "abhi bataya",
    "sub",
    "sub chahiye",
    "website",
    "restaurant",
    "ecommerce",
    "e-commerce"
  ].includes(text);
}

function isKnowledgeQuery(message) {
  const text = String(message || "").toLowerCase();
  const faqSignals = [
    "refund",
    "policy",
    "policies",
    "terms",
    "hours",
    "timing",
    "timings",
    "company info",
    "about company",
    "about you",
    "pricing policy"
  ];
  return faqSignals.some((k) => text.includes(k));
}

function updateSlotsFromMessage(state, message) {
  const text = String(message || "").toLowerCase();
  if (!state.slots.businessType) {
    if (text.includes("restaurant")) state.slots.businessType = "restaurant";
    if (text.includes("ecommerce") || text.includes("e-commerce")) state.slots.businessType = "ecommerce";
  }
  if (text.includes("website") || text.includes("web")) {
    state.slots.wantsWebsite = true;
    if (!state.slots.primaryNeed) state.slots.primaryNeed = "website";
  }
  if (text.includes("whatsapp") || text.includes("wa bot") || text.includes("whatsapp bot")) {
    state.slots.wantsWhatsappBot = true;
    if (!state.slots.primaryNeed) state.slots.primaryNeed = "whatsapp bot";
  }
  if (text.includes("ordering system") || text.includes("online order") || text.includes("orders")) {
    state.slots.orderingSystem = true;
    if (!state.slots.primaryNeed) state.slots.primaryNeed = "ordering system";
  }
  if (text.includes("booking")) {
    state.slots.bookingSystem = true;
    if (!state.slots.primaryNeed) state.slots.primaryNeed = "booking system";
  }
  if (text.includes("budget")) state.slots.budget = "discussed";
  if (text.includes("timeline")) state.slots.timeline = "discussed";
}

function detectLastQuestion(reply) {
  const text = String(reply || "").trim();
  const match = text.split("\n").find((line) => line.trim().endsWith("?"));
  return match ? match.trim() : "";
}

function inferQuestionType(question) {
  const text = String(question || "").toLowerCase();
  if (text.includes("business") || text.includes("kis type")) return "businessType";
  if (text.includes("main goal") || text.includes("goal") || text.includes("kis type ka solution")) return "goal";
  if (text.includes("whatsapp par orders") || text.includes("orders aate")) return "channel";
  if (text.includes("features") || text.includes("requirements")) return "features";
  if (text.includes("budget")) return "budget";
  if (text.includes("timeline") || text.includes("timeframe")) return "timeline";
  if (text.includes("website kis type") || text.includes("website type")) return "websiteType";
  return null;
}

function fillSlotFromAnswer(state, questionType, answer, lastQuestion) {
  const text = String(answer || "").trim();
  const lower = text.toLowerCase();
  const lastQ = String(lastQuestion || "").toLowerCase();
  if (!questionType) return;
  if (questionType === "businessType" && !state.slots.businessType) {
    state.slots.businessType = text;
    return;
  }
  if (questionType === "goal" && !state.slots.primaryNeed) {
    if (["yes", "haan", "han", "ok", "theek"].includes(lower)) {
      if (lastQ.includes("whatsapp")) {
        state.slots.primaryNeed = "whatsapp bot";
        state.slots.wantsWhatsappBot = true;
      } else if (lastQ.includes("website")) {
        state.slots.primaryNeed = "website";
        state.slots.wantsWebsite = true;
      }
      return;
    }
    state.slots.primaryNeed = text;
    if (lower.includes("website") || lower.includes("web")) state.slots.wantsWebsite = true;
    if (lower.includes("whatsapp")) state.slots.wantsWhatsappBot = true;
    if (lower.includes("ordering")) state.slots.orderingSystem = true;
    if (lower.includes("booking")) state.slots.bookingSystem = true;
    return;
  }
  if (questionType === "channel") {
    if (["yes", "haan", "han"].includes(lower) || lower.includes("whatsapp")) {
      state.slots.orderingSystem = true;
    }
    return;
  }
  if (questionType === "features" && !state.slots.features) {
    state.slots.features = text;
    return;
  }
  if (questionType === "budget" && !state.slots.budget) {
    state.slots.budget = text;
    return;
  }
  if (questionType === "timeline" && !state.slots.timeline) {
    state.slots.timeline = text;
    return;
  }
  if (questionType === "websiteType" && !state.slots.primaryNeed) {
    state.slots.primaryNeed = text;
    state.slots.wantsWebsite = true;
  }
}

function nextQuestionType(state) {
  if (!state.slots.businessType) return "businessType";
  if (!state.slots.primaryNeed) return "goal";
  if (state.slots.wantsWhatsappBot && !state.slots.orderingSystem) return "channel";
  if (!state.slots.features && state.stage === "requirements") return "features";
  if (!state.slots.budget && state.stage === "proposal") return "budget";
  if (!state.slots.timeline && state.stage === "proposal") return "timeline";
  return null;
}

function getNextQuestion(state) {
  const next = nextQuestionType(state);
  if (next === "businessType") {
    return { type: "businessType", text: "Aapka business kis type ka hai?" };
  }
  if (next === "goal") {
    return { type: "goal", text: "Main goal kya hai? Website, WhatsApp orders, ya automation?" };
  }
  if (next === "channel") {
    return { type: "channel", text: "Orders zyada WhatsApp par aate hain?" };
  }
  if (next === "features") {
    return { type: "features", text: "Kaun se features chahiye? Orders, menu, booking, ya support?" };
  }
  if (next === "budget") {
    return { type: "budget", text: "Budget range kya socha hai?" };
  }
  if (next === "timeline") {
    return { type: "timeline", text: "Timeline kya chahiye?" };
  }
  return { type: null, text: "" };
}

function isSlotFilledForQuestionType(state, questionType) {
  if (!questionType) return false;
  if (questionType === "businessType") return Boolean(state.slots.businessType);
  if (questionType === "goal" || questionType === "websiteType") return Boolean(state.slots.primaryNeed);
  if (questionType === "channel") return Boolean(state.slots.orderingSystem);
  if (questionType === "features") return Boolean(state.slots.features);
  if (questionType === "budget") return Boolean(state.slots.budget);
  if (questionType === "timeline") return Boolean(state.slots.timeline);
  return false;
}

function formatHistory(history) {
  return (history || [])
    .slice(-HISTORY_WINDOW)
    .map((h) => `${h.role === "user" ? "User" : "Bot"}: ${h.text}`)
    .join("\n");
}

function formatStateSummary(state) {
  return [
    `intent=${state.intent}`,
    `mode=${state.mode}`,
    `topic=${state.topic || "none"}`,
    `stage=${state.stage}`,
    `lastQuestionType=${state.lastQuestionType || "none"}`,
    `slots=${JSON.stringify(state.slots)}`
  ].join(" | ");
}

function buildSystemPrompt(state, historyText) {
  const basePrompt =
    "You are a human customer service rep for an IT consulting company. " +
    "You provide software, websites, WhatsApp bots, and automation solutions. " +
    "Be calm, helpful, and direct; never pushy. " +
    "Language must be Roman Urdu with light English only. " +
    "Default reply is 1-2 short lines. Longer only if truly needed. " +
    "Ask only one focused question at a time. " +
    "Never repeat a question if its answer is already in slots. " +
    "Use lastQuestionType to interpret short replies. " +
    "Acknowledge topic shifts in one line, then continue. " +
    "Use RAG only for explicit policies/company-info questions, never inside sales flow. " +
    "Never mention chunks, sources, tools, or internal state. " +
    "Always respond with plain text."
    "Before proceeding with the booking, ensure the user has shared their name, phone number, timeline, and budget."
"If any of these details are missing, do not confirm the booking and ask them to contact the admin directly at +92 315 0262140.";

  return (
    `${basePrompt}\n\n` +
    `STATE: ${formatStateSummary(state)}\n` +
    `HISTORY (last ${HISTORY_WINDOW}):\n${historyText}`
  );
}

function detectTopicShift(state, message) {
  const text = String(message || "").toLowerCase();
  let topic = state.topic;
  if (text.includes("website") || text.includes("web") || text.includes("ecommerce") || text.includes("e-commerce")) {
    topic = "website";
  } else if (text.includes("whatsapp") && (text.includes("order") || text.includes("orders"))) {
    topic = "restaurant_whatsapp_orders";
  } else if (text.includes("automation")) {
    topic = "automation";
  }
  if (topic && topic !== state.topic) return { shifted: true, topic };
  return { shifted: false, topic: state.topic };
}

function applyTopicShift(state, topic) {
  state.topic = topic;
  state.stage = "requirements";
  if (topic === "website") {
    state.slots.wantsWebsite = true;
    state.slots.primaryNeed = "website";
  }
  if (topic === "restaurant_whatsapp_orders") {
    state.slots.wantsWhatsappBot = true;
    state.slots.primaryNeed = "whatsapp orders";
  }
}

function getTopicShiftNote(topic) {
  if (topic === "website") return "Theek hai, ab website wali requirement par chalte hain.";
  if (topic === "restaurant_whatsapp_orders") return "Samajh gaya, WhatsApp orders wali requirement par aate hain.";
  if (topic === "automation") return "Theek hai, automation wali baat dekhte hain.";
  return "";
}

function isUnclearMessage(message) {
  const text = String(message || "").trim().toLowerCase();
  return ["sono", "suno", "sunno"].includes(text);
}

function updateStage(state) {
  if (state.slots.businessType && state.stage === "discovery") state.stage = "requirements";
  if (state.slots.primaryNeed && state.stage === "requirements") state.stage = "proposal";
  if (state.slots.budget && state.slots.timeline) state.stage = "handoff";
}

function summarizeFilledSlots(state) {
  return Object.entries(state.slots)
    .filter(([, v]) => Boolean(v))
    .map(([k]) => k);
}

function adjustReplyWithGuard(state, reply) {
  let output = String(reply || "").trim();
  if (!output) return output;

  const questionLine = detectLastQuestion(output);
  const questionType = inferQuestionType(questionLine);
  if (questionType && isSlotFilledForQuestionType(state, questionType)) {
    const next = getNextQuestion(state);
    if (next.text) {
      if (questionLine) {
        output = output.replace(questionLine, next.text).trim();
      } else {
        output = next.text;
      }
    } else if (questionLine) {
      output = output.replace(questionLine, "").trim();
    }
  }
  if (!detectLastQuestion(output)) {
    const next = getNextQuestion(state);
    if (next.text) {
      output = `${output} ${next.text}`.trim();
    }
  }
  return output;
}


function createAgent({ notifyAdmin }) {
  const tools = [
    tool({
      name: "retrieveKnowledge",
      description: "Search internal knowledge and return relevant facts.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" }
        },
        required: ["query"],
        additionalProperties: false
      },
      execute: async ({ query }) => {
        const result = await retrieveKnowledge(query, {
          topK: RAG_TOP_K,
          minScore: RAG_MIN_SCORE
        });
        if (!result.chunks.length) return "No relevant knowledge found.";
        return result.chunks
          .map((c) => `[${c.id}] ${c.text}`)
          .join("\n");
      }
    }),
    tool({
      name: "createBooking",
      description:
        "Create a booking request after collecting name, phone, time, and purpose.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          phone: { type: "string" },
          date: { type: "string" },
          time: { type: "string" },
          notes: { type: "string" }
        },
        required: ["name", "phone", "date", "time", "notes"],
        additionalProperties: false
      },
      execute: async ({ name, phone, date, time, notes }) => {
        const normalizedNotes = notes?.trim() || "N/A";
        const summary =
          `New booking request:\n` +
          `Name: ${name}\nPhone: ${phone}\nDate: ${date}\nTime: ${time}\nNotes: ${normalizedNotes}`;
        if (notifyAdmin) {
          await notifyAdmin(summary);
        }
        return "Your booking request is noted. Our team will confirm shortly.";
      }
    }),
    tool({
      name: "notifyAdmin",
      description: "Send a message to the admin for human follow-up.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string" }
        },
        required: ["message"],
        additionalProperties: false
      },
      execute: async ({ message }) => {
        if (!notifyAdmin) return "Admin notification is not configured.";
        await notifyAdmin(message);
        return "Admin has been notified.";
      }
    })
  ];

  return {
    async run(messageText, { userId } = {}) {
      const message = String(messageText || "");
      const state = stateStore.getState(userId);
      stateStore.recordUserMessage(userId, message);

      const hadLastQuestionType = Boolean(state.lastQuestionType);
      const shortReply = isShortReply(message);
      const unclearMessage = isUnclearMessage(message);

      const topicShift = detectTopicShift(state, message);
      if (topicShift.shifted) applyTopicShift(state, topicShift.topic);

      let forcedReply = "";
      if (unclearMessage && !state.pendingClarification) {
        forcedReply = "Maaf kijiye, yeh clear nahi hua. Aap kis cheez ke bare mein baat kar rahe hain?";
        state.pendingClarification = true;
      } else if (state.pendingClarification && unclearMessage) {
        state.pendingClarification = false;
      } else if (state.pendingClarification) {
        state.pendingClarification = false;
      }

      if (!unclearMessage && state.lastQuestionType) {
        fillSlotFromAnswer(state, state.lastQuestionType, message, state.lastQuestion);
        stateStore.clearLastQuestionType(userId);
      }
      updateSlotsFromMessage(state, message);
      updateStage(state);

      const shouldRag =
        !forcedReply && isKnowledgeQuery(message) && !shortReply && !hadLastQuestionType;
      const routerDecision = shouldRag
        ? { decision: "RAG_QUERY", reason: "explicit_knowledge" }
        : { decision: "SALES_CONTINUE", reason: "sales_flow" };

      console.log("[ROUTER]", {
        userId,
        topic: state.topic || "none",
        stage: state.stage,
        lastQuestionType: state.lastQuestionType || "none",
        slotsFilled: summarizeFilledSlots(state),
        routerDecision: routerDecision.decision
      });

      if (forcedReply) {
        const note = topicShift.shifted ? getTopicShiftNote(topicShift.topic) : "";
        const reply = `${note ? `${note} ` : ""}${forcedReply}`.trim();
        stateStore.recordBotReply(userId, reply);
        const lastQ = detectLastQuestion(reply);
        stateStore.setLastQuestion(userId, lastQ);
        const qType = inferQuestionType(lastQ);
        stateStore.setLastQuestionType(userId, qType);
        return reply;
      }

      const historyText = formatHistory(state.history);
      const agent = new Agent({
        name: "WhatsAppSupportAgent",
        model: "gpt-4.1-mini",
        instructions: buildSystemPrompt(state, historyText),
        tools
      });

      if (routerDecision.decision === "RAG_QUERY") {
        const ragResult = await retrieveKnowledge(message, {
          topK: RAG_TOP_K,
          minScore: RAG_MIN_SCORE
        });

        const scored = ragResult.scored || [];
        const bestScore = scored[0]?.score ?? 0;
        const chosen = scored.slice(0, RAG_MAX_CHUNKS);

        console.log("[RAG] query:", ragResult.query);
        console.log(
          "[RAG] topK:",
          scored.map((c) => ({ id: c.id, score: Number(c.score.toFixed(4)) }))
        );
        console.log("[RAG] chosen:", chosen.map((c) => c.id));
        console.log("[RAG] threshold:", {
          minScore: RAG_MIN_SCORE,
          bestScore: Number(bestScore.toFixed(4)),
          decision: bestScore >= RAG_MIN_SCORE ? "PASS" : "FAIL"
        });

        if (!chosen.length || bestScore < RAG_MIN_SCORE) {
          const fallback = buildNoRagReply();
          stateStore.recordBotReply(userId, fallback);
          return fallback;
        }

        const retrievedContext = formatRetrievedContext(chosen);
        const result = await run(agent, message, {
          context: {
            userId,
            memory: historyText,
            retrievedContext,
            ragChunkIds: ragResult.chunks.map((c) => c.id),
            mode: state.mode,
            stage: state.stage,
            lastQuestion: state.lastQuestion,
            slots: state.slots,
            nextQuestionType: nextQuestionType(state)
          }
        });

        const reply = stripCitations((result.finalOutput || "").trim());
        const adjusted = adjustReplyWithGuard(state, reply);
        const fallbackQuestion = getNextQuestion(state);
        const safeReply = adjusted || fallbackQuestion.text || buildNoRagReply();
        const withNote = topicShift.shifted
          ? `${getTopicShiftNote(topicShift.topic)} ${safeReply}`.trim()
          : safeReply;
        stateStore.recordBotReply(userId, withNote);
        const lastQ = detectLastQuestion(withNote);
        stateStore.setLastQuestion(userId, lastQ);
        const qType = inferQuestionType(lastQ);
        stateStore.setLastQuestionType(userId, qType);
        return withNote;
      }

      const result = await run(agent, message, {
        context: {
          userId,
          memory: historyText,
          retrievedContext: "",
          ragChunkIds: [],
          mode: state.mode,
          stage: state.stage,
          lastQuestion: state.lastQuestion,
          slots: state.slots,
          nextQuestionType: nextQuestionType(state)
        }
      });

      const reply = stripCitations((result.finalOutput || "").trim());
      const adjusted = adjustReplyWithGuard(state, reply);
      const fallbackQuestion = getNextQuestion(state);
      const safeReply = adjusted || fallbackQuestion.text || "Samajh gaya. Aapka next step kya hona chahiye?";
      const withNote = topicShift.shifted
        ? `${getTopicShiftNote(topicShift.topic)} ${safeReply}`.trim()
        : safeReply;
      stateStore.recordBotReply(userId, withNote);
      const lastQ = detectLastQuestion(withNote);
      stateStore.setLastQuestion(userId, lastQ);
      const qType = inferQuestionType(lastQ);
      stateStore.setLastQuestionType(userId, qType);
      return withNote;
    }
  };
}

module.exports = {
  createAgent,
  __test: {
    enforceGrounding,
    buildNoRagReply,
    formatRetrievedContext
  }
};
