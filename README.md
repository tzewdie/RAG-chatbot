# RAG Chatbot

An AI-powered, **agentic assistant** that answers questions grounded in your own sources — uploaded PDFs, Jira issues, and Confluence wiki pages. Instead of a one-shot retrieve-then-read pipeline, the assistant picks the right toolset for the question, iterates over multiple reasoning steps, and refuses to answer from anything it can't cite.

## Modes

The chat UI switches between four toolsets (one active per conversation):

| Mode | What it does |
|------|--------------|
| 📄 **Knowledge Base** | Agentic RAG over uploaded PDFs — the model calls `searchKnowledgeBase` when it needs context (top-15 chunks, 0.3 similarity threshold), with automatic query-variant expansion to maximize recall across chunked documents |
| 🎫 **Jira** | Five tools: search bugs, search incidents (with status filter), search all issue types, fetch an issue by key, and summarize a sprint (breakdown by type and status, highlights blocked/high-priority items). Accepts keywords or raw JQL. Works with Jira Cloud and Jira Server |
| 📚 **Wiki** | Search Confluence pages by keyword or title, fetch a full page by ID or tinylink URL. HTML is converted to Markdown (tables preserved) and reproduced exactly on request |
| 🌐 **Web** | Optional toggle routing queries to web search for fresh knowledge |

Every mode runs a multi-step tool-calling loop (up to 10 steps) with a mode-specific system prompt: the PDF mode enforces strict grounding ("no retrieved evidence, no answer"), the Jira mode applies tool-selection rules (sprint → bugs → incidents → stories/tasks), and the wiki mode handles URL parsing (pageId, `/pages/`, and `/x/` tinylinks).

## How it works

```
┌─────────────┐      ┌──────────────┐      ┌──────────────────┐
│  PDF upload │ ───▶ │ Chunk +      │ ───▶ │ Neon Postgres    │
│             │      │ embed        │      │ (pgvector)       │
└─────────────┘      └──────────────┘      └──────────────────┘
                                                   │ cosine similarity
┌─────────────┐      ┌──────────────┐      ┌───────▼──────────┐
│  Streaming  │ ◀─── │ Grounded     │ ◀─── │ Top-K retrieval  │
│  chat UI    │      │ generation   │      │ (K=15, τ=0.3)    │
└─────────────┘      └──────────────┘      └──────────────────┘

┌─────────────┐      ┌──────────────────────────────────────┐
│  Jira mode  │ ───▶ │ JQL search / issue fetch / sprint    │
│             │      │ summary via Jira REST API v2         │
└─────────────┘      └──────────────────────────────────────┘

┌─────────────┐      ┌──────────────────────────────────────┐
│  Wiki mode  │ ───▶ │ Confluence CQL search / page fetch,  │
│             │      │ HTML → Markdown, tables preserved    │
└─────────────┘      └──────────────────────────────────────┘
```

1. **Ingest** — `app/api/upload` parses PDFs (`pdf-parse`), splits them with LangChain text splitters, generates embeddings, and writes chunks + vectors to Postgres via Drizzle ORM.
2. **Retrieve** — `lib/search.ts` embeds the query and runs a pgvector cosine-distance search, filtering below the similarity threshold and returning the top-K chunks. Query variants are fanned out and deduplicated for recall.
3. **Jira** — `lib/jira.ts` talks to the Jira REST API with Basic (email:token) or Bearer (PAT) auth, handling both Cloud (ADF descriptions) and Server (plain-text) formats.
4. **Wiki** — `lib/confluence.ts` searches via CQL and fetches full pages, converting Confluence HTML to clean Markdown.
5. **Generate** — `app/api/chat` streams with `streamText`, exposing the active mode's tools. The model may call them multiple times, then answers using *only* tool results.

## Tech stack

| Layer      | Tech |
|------------|------|
| Frontend   | Next.js 16, React 19, TypeScript, Tailwind CSS |
| LLM        | Vercel AI SDK v6, OpenAI models, Perplexity Sonar (web search) |
| Retrieval  | Neon Postgres + pgvector, Drizzle ORM |
| Ingestion  | `pdf-parse`, `pdf-lib`, LangChain text splitters |
| Integrations | Jira REST API v2 (JQL), Confluence REST API (CQL) |

## Getting started

**Prerequisites:** Node.js 20+, a [Neon](https://neon.tech) Postgres database with the `pgvector` extension enabled, and an OpenAI API key. Jira/Confluence modes need API credentials (see below).

```bash
git clone https://github.com/tzewdie/RAG-chatbot.git
cd RAG-chatbot
npm install
```

Create `.env.local`:

```bash
# Required
NEON_DATABASE_URL=postgresql://...
OPENAI_API_KEY=sk-...

# Jira mode (optional)
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_API_TOKEN=...
JIRA_USER_EMAIL=you@example.com        # omit for PAT/Bearer auth

# Confluence/wiki mode (optional; falls back to Jira credentials)
CONFLUENCE_BASE_URL=https://your-domain.atlassian.net/wiki
CONFLUENCE_API_TOKEN=...               # or reuse JIRA_API_TOKEN
CONFLUENCE_USER_EMAIL=you@example.com  # or reuse JIRA_USER_EMAIL
```

Set up the `documents` table (see `lib/db-schema.ts`) with the `pgvector` extension enabled, then:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), upload a PDF, and start asking questions. Toggle Jira / Wiki / Web modes in the chat UI.

## Project structure

```
app/api/chat/route.ts    # Streaming chat + mode-switched toolsets
app/api/upload/route.ts  # PDF ingestion endpoint
lib/search.ts            # pgvector cosine-similarity retrieval
lib/embeddings.ts        # Embedding generation
lib/jira.ts              # Jira REST client (JQL search, issue fetch, sprint summary)
lib/confluence.ts        # Confluence REST client (CQL search, page fetch, HTML→MD)
lib/db-schema.ts         # Drizzle schema (documents + vectors)
lib/db-config.ts         # Neon serverless connection
```

## Configuration

Tune retrieval in `app/api/chat/route.ts` (`searchDocuments(query, 15, 0.3)`) and the reasoning budget via `stepCountIs(10)`. Grounding rules live in the per-mode system prompts — adjust strictness there.