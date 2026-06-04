import {
  streamText,
  UIMessage,
  convertToModelMessages,
  tool,
  InferUITools,
  UIDataTypes,
  stepCountIs,
} from "ai";
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { searchDocuments } from '@/lib/search';

const tools = {
  searchKnowledgeBase: tool({
    description: "Search the knowledge base for relevant information",
    inputSchema: z.object({
      query: z.string().describe("The search query to find relevant documents"),
    }),
    execute: async ({ query }) => {
      try {

        const results = await searchDocuments(query, 8, 0.5);

        if (results.length === 0) {
          return "No relevant information found in the knowledge base.";
        }


        const formattedResults = results
          .map((r, i) => `[${i + 1}] ${r.content}`)
          .join("\n\n");

        return formattedResults;
      } catch (error) {
        console.error("Search error:", error);
        return "Error searching the knowledge base.";
      }
    },
  }),
};

export type ChatTools = InferUITools<typeof tools>;
export type ChatMessage = UIMessage<never, UIDataTypes, ChatTools>;


// Allow streaming responses up to 30 seconds
export const maxDuration = 30;
const responseCount = 10;
export async function POST(req: Request) {
  try {
    const {
      messages,
      model,
      webSearch,
    }: {
      messages: UIMessage[];
      model: string;
      webSearch: boolean;
    } = await req.json();

  const cleanedMessages = webSearch
  ? messages.map(m => {
      const { toolInvocations, toolResults, ...rest } = m as any;
      return rest;
    })
  : messages;
  
    const result = streamText({
      model: webSearch ? 'perplexity/sonar' : model,
      messages: await convertToModelMessages(cleanedMessages),
      tools: webSearch ? undefined : tools,
      system: webSearch
        ? "You are a helpful assistant that can answer questions using web search. Summarize results clearly."
        : `You are a knowledge-base–grounded assistant.

RULES (must follow):
- Use ONLY the information provided by the knowledge base tool results.
- Do NOT use prior knowledge, general world knowledge, or assumptions.
- If the knowledge base does not contain enough information, say so explicitly.
- You may explain, summarize, and rephrase the retrieved information in detail,
  but you may not add new facts.

Answer style:
- Write a detailed, multi-paragraph answer.
- Expand only by explaining and connecting the retrieved content.
- If something is unclear or missing, state what is missing instead of guessing.
When a question refers to a category or section (for example, "benefits",
"retirement", or "financial benefits"), you MUST:
- Identify ALL sub-items listed under that category in the knowledge base
- Cover each sub-item explicitly
- Do NOT stop after describing only one sub-item`,
      stopWhen: stepCountIs(responseCount),
    });

    return result.toUIMessageStreamResponse({
      sendSources: true,
      sendReasoning: true,
    });
  } catch (error) {
    console.error("Error streaming chat completion:", error);
    return new Response("Failed to stream chat completion", { status: 500 });
  }
}