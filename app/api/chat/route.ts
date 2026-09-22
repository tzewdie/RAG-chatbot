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
import { searchJiraIssues, getJiraIssue, formatIssues } from '@/lib/jira';
import { searchConfluencePages, getConfluencePage, formatPages } from '@/lib/confluence';

export const dynamic = 'force-dynamic';

const knowledgeBaseTools = {
  searchKnowledgeBase: tool({
    description: "Search the knowledge base for relevant information",
    inputSchema: z.object({
      query: z.string().describe("The search query to find relevant documents"),
    }),
    execute: async ({ query }) => {
      try {
        // Build query variants to maximise recall across chunked documents
        const lq = query.toLowerCase();
        const queries = [query];
        if (lq.includes('all') || lq.includes('list') || lq.includes('status') || lq.includes('complete')) {
          queries.push(`${query} continued`);
          queries.push(`${query} additional details`);
          // Target specific status names likely to live in separate chunks
          queries.push('GPMATS action status workflow stages');
          queries.push('GPMATS status Completed Rejected Returned Sent Supervisor Hold');
          queries.push('GPMATS status Additional GM Review Returned to Reviewer Sent to Supervisor');
        }

        // Run all variants and deduplicate by id
        const seen = new Set<number>();
        const allResults: Array<{ id: number; content: string; similarity: number }> = [];
        for (const q of queries) {
          const results = await searchDocuments(q, 15, 0.3);
          for (const r of results) {
            if (!seen.has(r.id)) {
              seen.add(r.id);
              allResults.push(r);
            }
          }
        }

        if (allResults.length === 0) return "No relevant information found in the knowledge base.";
        allResults.sort((a, b) => b.similarity - a.similarity);
        return allResults.map((r, i) => `[${i + 1}] ${r.content}`).join("\n\n");
      } catch (error) {
        console.error("Search error:", error);
        return "Error searching the knowledge base.";
      }
    },
  }),
};

const jiraTools = {
  searchJiraBugs: tool({
    description: "Search Jira for bug issues using a keyword or JQL query",
    inputSchema: z.object({
      query: z.string().describe("Keywords or a JQL query to search for bugs"),
      maxResults: z.number().optional().default(10).describe("Maximum number of results"),
    }),
    execute: async ({ query, maxResults }) => {
      try {
        const isJql = query.includes('=') || query.includes('ORDER BY');
        const jql = isJql
          ? query
          : `issuetype = Bug AND text ~ "${query}" ORDER BY updated DESC`;
        const issues = await searchJiraIssues(jql, maxResults);
        return formatIssues(issues);
      } catch (error) {
        console.error("Jira bug search error:", error);
        return `Error searching Jira bugs: ${error instanceof Error ? error.message : 'Unknown error'}`;
      }
    },
  }),

  searchJiraIncidents: tool({
    description: "Search Jira for incident issues",
    inputSchema: z.object({
      query: z.string().describe("Keywords or a JQL query to search for incidents"),
      status: z.enum(["open", "in-progress", "resolved", "all"]).optional().default("all"),
      maxResults: z.number().optional().default(10).describe("Maximum number of results"),
    }),
    execute: async ({ query, status, maxResults }) => {
      try {
        const statusClause =
          status === "open" ? 'AND status = "Open"' :
          status === "in-progress" ? 'AND status = "In Progress"' :
          status === "resolved" ? 'AND status in ("Resolved", "Done", "Closed")' : '';

        const isJql = query.includes('=') || query.includes('ORDER BY');
        const jql = isJql
          ? query
          : `issuetype = Incident AND text ~ "${query}" ${statusClause} ORDER BY updated DESC`;

        const issues = await searchJiraIssues(jql, maxResults);
        return formatIssues(issues);
      } catch (error) {
        console.error("Jira incident search error:", error);
        return `Error searching Jira incidents: ${error instanceof Error ? error.message : 'Unknown error'}`;
      }
    },
  }),

  getJiraIssueDetails: tool({
    description: "Get full details of a specific Jira issue by its key (e.g. PROJ-123)",
    inputSchema: z.object({
      issueKey: z.string().describe("The Jira issue key, e.g. PROJ-123"),
    }),
    execute: async ({ issueKey }) => {
      try {
        const issue = await getJiraIssue(issueKey);
        return formatIssues([issue]);
      } catch (error) {
        console.error("Jira issue fetch error:", error);
        return `Error fetching Jira issue ${issueKey}: ${error instanceof Error ? error.message : 'Unknown error'}`;
      }
    },
  }),

  searchJiraAll: tool({
    description: "Search Jira for any type of issue including stories, tasks, epics, bugs, sub-tasks. Use this when the user asks for stories, tasks, epics, or doesn't specify a type.",
    inputSchema: z.object({
      query: z.string().describe("Keywords or a JQL query to search across all issue types"),
      issueType: z.string().optional().describe("Optional issue type filter e.g. Story, Task, Epic, Sub-task"),
      maxResults: z.number().optional().default(10).describe("Maximum number of results"),
    }),
    execute: async ({ query, issueType, maxResults }) => {
      try {
        const isJql = query.includes('=') || query.includes('ORDER BY');
        const typeClause = issueType ? `AND issuetype = "${issueType}"` : '';
        const jql = isJql
          ? query
          : `text ~ "${query}" ${typeClause} ORDER BY updated DESC`;
        const issues = await searchJiraIssues(jql, maxResults);
        return formatIssues(issues);
      } catch (error) {
        console.error("Jira search error:", error);
        return `Error searching Jira: ${error instanceof Error ? error.message : 'Unknown error'}`;
      }
    },
  }),

  summarizeJiraSprint: tool({
    description: "Get all issues in a specific sprint by sprint name. Use this when the user asks to summarize, review, or list issues in a sprint. The sprint input must be the EXACT full sprint name as stated by the user, e.g. 'Grant Details Sprint 3', 'Sprint 22', 'Q2 Sprint 5'.",
    inputSchema: z.object({
      sprint: z.string().describe("The EXACT full sprint name as the user said it, e.g. 'Grant Details Sprint 3'"),
      project: z.string().optional().describe("Optional project key to narrow results e.g. 'PROJ'"),
      maxResults: z.number().optional().default(50).describe("Maximum number of issues to retrieve"),
    }),
    execute: async ({ sprint, project, maxResults }) => {
      try {
        const sprintValue = /^\d+$/.test(sprint) ? `"Sprint ${sprint}"` : `"${sprint}"`;
        const projectClause = project ? `project = "${project}" AND ` : '';
        const jql = `${projectClause}sprint = ${sprintValue} ORDER BY issuetype ASC, status ASC`;
        const issues = await searchJiraIssues(jql, maxResults);
        if (issues.length === 0) return `No issues found in sprint ${sprint}. Try specifying the project key.`;
        const byType = issues.reduce((acc, issue) => {
          acc[issue.issueType] = (acc[issue.issueType] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);
        const byStatus = issues.reduce((acc, issue) => {
          acc[issue.status] = (acc[issue.status] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);
        const summary = `Sprint: ${sprint} — ${issues.length} total issues\nBy type: ${Object.entries(byType).map(([k,v]) => `${k}(${v})`).join(', ')}\nBy status: ${Object.entries(byStatus).map(([k,v]) => `${k}(${v})`).join(', ')}\n\n${formatIssues(issues)}`;
        return summary;
      } catch (error) {
        console.error("Sprint summary error:", error);
        return `Error fetching sprint ${sprint}: ${error instanceof Error ? error.message : 'Unknown error'}`;
      }
    },
  }),
};

export type ChatTools = InferUITools<typeof knowledgeBaseTools & typeof jiraTools>;
export type ChatMessage = UIMessage<never, UIDataTypes, ChatTools>;

const wikiTools = {
  searchWikiPages: tool({
    description: "Search NIH Confluence wiki pages by keyword or exact page title. Always pass the exact title the user provides as the query for best results.",
    inputSchema: z.object({
      query: z.string().describe("Keywords to search for in wiki pages"),
      limit: z.number().optional().default(10).describe("Max number of pages to return"),
      sortOrder: z.enum(["asc", "desc"]).optional().default("desc").describe("Sort by last modified date. Use 'asc' when the user asks for the first, oldest, or earliest page. Use 'desc' (default) for latest or most recent."),
    }),
    execute: async ({ query, limit, sortOrder }) => {
      try {
        const pages = await searchConfluencePages(query, limit, sortOrder);
        return formatPages(pages);
      } catch (error) {
        console.error('Wiki search error:', error);
        return `Error searching wiki: ${error instanceof Error ? error.message : 'Unknown error'}`;
      }
    },
  }),

  getWikiPage: tool({
    description: "Get the full content of a specific Confluence wiki page by its page ID or tinylink ID (the part after /x/ in the URL, e.g. HIBtKQ from https://wiki.nci.nih.gov/x/HIBtKQ)",
    inputSchema: z.object({
      pageId: z.string().describe("Page ID number or tinylink ID from the URL (e.g. '12345' or 'HIBtKQ')"),
    }),
    execute: async ({ pageId }) => {
      try {
        const page = await getConfluencePage(pageId);
        return formatPages([page]);
      } catch (error) {
        console.error('Wiki page fetch error:', error);
        return `Error fetching wiki page: ${error instanceof Error ? error.message : 'Unknown error'}`;
      }
    },
  }),
};

export const maxDuration = 30;
const responseCount = 10;

export async function POST(req: Request) {
  try {
    const {
      messages,
      model,
      webSearch,
      jiraSearch,
      wikiSearch,
    }: {
      messages: UIMessage[];
      model: string;
      webSearch: boolean;
      jiraSearch: boolean;
      wikiSearch: boolean;
    } = await req.json();

    const activeTools = webSearch
      ? { webSearch: openai.tools.webSearchPreview({}) }
      : jiraSearch
      ? jiraTools
      : wikiSearch
      ? wikiTools
      : knowledgeBaseTools;

    const cleanedMessages = webSearch
      ? messages.map(m => {
          const { toolInvocations, toolResults, ...rest } = m as any;
          return rest;
        })
      : messages;

    const systemPrompt = webSearch
      ? "You are a helpful assistant that can answer questions using web search. Summarize results clearly."
      : jiraSearch
      ? `You are a Jira assistant. Use the Jira tools to search for any type of issue.

Tool selection rules:
- User mentions "sprint", "summarize sprint", or a sprint name like "Grant Details Sprint 3" → ALWAYS call summarizeJiraSprint with the FULL sprint name exactly as stated
- Bugs → use searchJiraBugs
- Incidents → use searchJiraIncidents
- Stories, tasks, epics, sub-tasks, or unspecified types → use searchJiraAll
- Specific issue key like PROJ-123 → use getJiraIssueDetails

After retrieving sprint data, provide a structured summary: total count, breakdown by type and status, highlight blocked/high-priority items.`
      : wikiSearch
      ? `You are a Confluence wiki assistant for NIH wiki pages.
Tool selection rules:
- User asks about a topic or wants to find pages → use searchWikiPages. Use sortOrder='asc' when the user says 'first', 'oldest', 'earliest', or 'initial'; use sortOrder='desc' (default) for 'latest', 'recent', or 'last'.
- If searchWikiPages returns no results, retry with a shorter or broader query (e.g. if 'EM Meeting Minutes' fails, retry with just 'Meeting Minutes'; if 'Grant Detail Page Meeting Minutes' fails, try 'Meeting Minutes' or 'Grant Detail').
- User pastes a URL containing viewpage.action?pageId=NNNN → extract the numeric pageId and call getWikiPage with that number (e.g. pageId=1117716503 → call getWikiPage with '1117716503')
- User pastes a URL with format /spaces/{space}/pages/{pageId}/{title} → extract the numeric segment after /pages/ and call getWikiPage with it (e.g. https://wiki.nci.nih.gov/spaces/CBIITscimanag/pages/1053786114/04-13-2026+Grant+Detail+Page+Meeting+Minutes → call getWikiPage with '1053786114')
- User pastes a wiki URL like https://wiki.nci.nih.gov/x/HIBtKQ → extract the ID after /x/ and call getWikiPage with that ID
- User provides a page ID number → call getWikiPage
When fetching a page, present its full title, space, URL, and ALL content.
- If the page content contains a markdown table, ALWAYS reproduce the relevant rows as a markdown table in your response.
- If the user asks about a specific row (e.g. 'Grant Summary Banner'), find that row and return it as a table with all its columns: #, Title, User Story, Business Rules/Acceptance Criteria, Dependencies, JIRA ticket(s).
- Do NOT summarize or paraphrase table content — reproduce it exactly.
- ALWAYS include the wiki page URL as a clickable markdown link at the top of every response, e.g. **Source:** [Page Title](URL).`
      : `You are a knowledge-base–grounded assistant.

RULES (must follow):
- Use ONLY the information provided by the knowledge base tool results.
- Do NOT use prior knowledge, general world knowledge, or assumptions.
- If the knowledge base does not contain enough information, say so explicitly.
- You may explain, summarize, and rephrase the retrieved information in detail,
  but you may not add new facts.
- If a question asks for a complete list (e.g. "all statuses", "all steps", "all fields"), ALWAYS call the tool at least TWICE using different query phrasings before answering, to ensure all document chunks are retrieved.
- If any retrieved chunk contains phrases like "not a complete list", "continued", "see also", or "additional", you MUST search again with a more specific query targeting the missing items before composing your answer.

Answer style:
- Write a detailed, structured answer covering EVERY item found across ALL tool calls.
- If the question asks for a list, enumerate every distinct item — do not stop early or combine unrelated items.
- Clearly state if information appears incomplete even after multiple searches.
When a question refers to a category or section, identify ALL sub-items and cover each explicitly.`;

    const result = streamText({
      model: webSearch ? openai.responses('gpt-4o') : openai(model),
      messages: await convertToModelMessages(cleanedMessages),
      tools: activeTools,
      system: systemPrompt,
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