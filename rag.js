const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const KNOWLEDGE_DIR = path.join(process.cwd(), "knowledge");

function safeRead(file) {
  const p = path.join(KNOWLEDGE_DIR, file);
  if (!fs.existsSync(p)) return "";
  return fs.readFileSync(p, "utf8").trim();
}

function loadDocuments() {
  const docs = [
    { id: "about", title: "About Company", text: safeRead("about.txt") },
    { id: "services", title: "Services", text: safeRead("services.txt") },
    { id: "pricing", title: "Pricing", text: safeRead("pricing.txt") },
    { id: "policies", title: "Policies", text: safeRead("policies.txt") },
    { id: "faqs", title: "FAQs", text: safeRead("faqs.txt") }
  ].filter((d) => d.text && d.text.length > 0);

  return docs;
}

let index = null;
let indexPromise = null;

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function embed(text) {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text
  });
  return response.data[0].embedding;
}

async function buildIndex() {
  const docs = loadDocuments();
  const vectors = [];
  for (const doc of docs) {
    const vector = await embed(doc.text);
    vectors.push({ ...doc, vector });
  }
  return vectors;
}

async function getIndex() {
  if (index) return index;
  if (!indexPromise) {
    indexPromise = buildIndex().then((built) => {
      index = built;
      return index;
    });
  }
  return indexPromise;
}

async function retrieveKnowledge(query, options = {}) {
  if (!query) return { query: "", topK: 0, minScore: 0, chunks: [] };
  const topK = Number.isFinite(options.topK) ? options.topK : 3;
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 0.2;
  const [queryVec, docs] = await Promise.all([embed(query), getIndex()]);

  const scored = docs
    .map((d) => ({
      id: `chunk:${d.id}`,
      title: d.title,
      text: d.text,
      score: cosineSimilarity(queryVec, d.vector)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const chunks = scored.filter((s) => s.score >= minScore);
  return { query, topK, minScore, scored, chunks };
}

module.exports = { retrieveKnowledge, loadDocuments };
