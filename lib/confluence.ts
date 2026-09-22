export interface ConfluencePage {
  id: string;
  title: string;
  space: string;
  url: string;
  lastModified: string;
  excerpt: string;
  body: string;
}

function getConfluenceCredentials() {
  const baseUrl = process.env.CONFLUENCE_BASE_URL;
  const apiToken = process.env.CONFLUENCE_API_TOKEN ?? process.env.JIRA_API_TOKEN;

  if (!baseUrl || !apiToken) {
    throw new Error(
      'Confluence credentials not configured. Set CONFLUENCE_BASE_URL and CONFLUENCE_API_TOKEN.'
    );
  }

  const email = process.env.CONFLUENCE_USER_EMAIL ?? process.env.JIRA_USER_EMAIL;
  const authHeader = email
    ? `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`
    : `Bearer ${apiToken}`;

  return { baseUrl, authHeader };
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function htmlToMarkdown(html: string): string {
  let md = html;

  // Convert tables → markdown tables
  md = md.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, tableContent: string) => {
    const rows: string[][] = [];
    const rowMatches = tableContent.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) ?? [];
    for (const row of rowMatches) {
      const cellMatches = row.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) ?? [];
      const cells = cellMatches.map(cell =>
        cell.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
      );
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length === 0) return '';
    const maxCols = Math.max(...rows.map(r => r.length));
    const lines: string[] = [];
    rows.forEach((row, i) => {
      while (row.length < maxCols) row.push('');
      lines.push('| ' + row.join(' | ') + ' |');
      if (i === 0) lines.push('| ' + Array(maxCols).fill('---').join(' | ') + ' |');
    });
    return '\n\n' + lines.join('\n') + '\n\n';
  });

  // Convert headings
  md = md.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_, level: string, text: string) =>
    '\n\n' + '#'.repeat(Number(level)) + ' ' + text.replace(/<[^>]*>/g, '').trim() + '\n'
  );

  // Convert list items
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, text: string) =>
    '\n- ' + text.replace(/<[^>]*>/g, '').trim()
  );

  // Breaks and paragraphs
  md = md.replace(/<br\s*\/?>/gi, '\n');
  md = md.replace(/<\/p>/gi, '\n');
  md = md.replace(/<p[^>]*>/gi, '');

  // Strip remaining tags
  md = md.replace(/<[^>]*>/g, ' ');

  // Decode HTML entities
  md = md
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Clean up whitespace while preserving structure
  md = md.replace(/[ \t]{2,}/g, ' ');
  md = md.replace(/\n{3,}/g, '\n\n');

  return md.trim();
}

function mapPage(result: Record<string, unknown>, baseUrl: string): ConfluencePage {
  const content = result.content as Record<string, unknown> | undefined;
  const item = content ?? result;
  const fields = item.fields as Record<string, unknown> | undefined;
  const space = (item.space as Record<string, string>)?.name
    ?? (fields?.space as Record<string, string>)?.name
    ?? 'Unknown';

  const rawBody =
    (item.body as Record<string, Record<string, string>>)?.storage?.value
    ?? (item.body as Record<string, Record<string, string>>)?.view?.value
    ?? '';

  const excerpt =
    (result.excerpt as string)
    ?? stripHtml(rawBody).slice(0, 300);

  const lastModified =
    (item.history as Record<string, string>)?.lastUpdated
    ?? (item.version as Record<string, string>)?.when
    ?? '';

  const id = item.id as string;

  return {
    id,
    title: item.title as string,
    space,
    url: `${baseUrl}/pages/viewpage.action?pageId=${id}`,
    lastModified,
    excerpt,
    body: htmlToMarkdown(rawBody).slice(0, 20000),
  };
}

export async function searchConfluencePages(
  query: string,
  limit = 10,
  sortOrder: 'asc' | 'desc' = 'desc'
): Promise<ConfluencePage[]> {
  const { baseUrl, authHeader } = getConfluenceCredentials();

  const order = sortOrder === 'asc' ? 'ASC' : 'DESC';

  // Confluence CQL: text~ (full-text) does not reliably support ORDER BY.
  // Use title-based CQL with ORDER BY as primary query.
  // Fall back to individual keyword title search if no results.
  const cqlTitle = `(title = "${query}" OR title ~ "${query}") AND type = "page" ORDER BY lastModified ${order}`;

  // Keyword fallback: split into words and search each word in title
  const keywords = query.split(/\s+/).filter(w => w.length > 2);
  const keywordCql = keywords.length > 0
    ? `(${keywords.map(w => `title ~ "${w}"`).join(' AND ')}) AND type = "page" ORDER BY lastModified ${order}`
    : null;

  async function runCql(cql: string) {
    const url = new URL(`${baseUrl}/rest/api/content/search`);
    url.searchParams.set('cql', cql);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('expand', 'body.storage,space,version,history');
    const response = await fetch(url.toString(), {
      headers: { Authorization: authHeader, Accept: 'application/json' },
    });
    if (!response.ok) {
      const text = await response.text();
      console.error(`[Confluence] search failed — status: ${response.status}, body: ${text.slice(0, 300)}`);
      return null;
    }
    const data = (await response.json()) as { results: Record<string, unknown>[] };
    return data.results;
  }

  // Try exact/phrase title search first
  let results = await runCql(cqlTitle);
  if (!results || results.length === 0) {
    // Fall back to individual keyword title search
    if (keywordCql) results = await runCql(keywordCql);
  }
  if (!results || results.length === 0) {
    // Last resort: full-text search without ORDER BY (relevance order)
    const textCql = `(title ~ "${query}" OR text ~ "${query}") AND type = "page"`;
    results = await runCql(textCql);
  }

  return (results ?? []).map((r) => mapPage(r, baseUrl));
}

export async function getConfluencePage(pageId: string): Promise<ConfluencePage> {
  const { baseUrl, authHeader } = getConfluenceCredentials();

  // Resolve tinylinks (x/XXXXX format) — follow redirect to get real page ID
  // Only attempt tinylink resolution for non-numeric IDs (numeric IDs are direct page IDs)
  let resolvedId = pageId;
  if (/^[A-Za-z0-9+/=]+$/.test(pageId) && !pageId.includes('-') && !/^\d+$/.test(pageId)) {
    try {
      const tinyUrl = `${baseUrl}/x/${pageId}`;
      const res = await fetch(tinyUrl, {
        headers: { Authorization: authHeader },
        redirect: 'manual',
      });
      const location = res.headers.get('location') ?? '';
      const match = location.match(/pageId=(\d+)/);
      if (match) resolvedId = match[1];
    } catch {
      // Fall through with original ID
    }
  }

  const url = `${baseUrl}/rest/api/content/${resolvedId}?expand=body.storage,space,version,history`;
  const response = await fetch(url, {
    headers: { Authorization: authHeader, Accept: 'application/json' },
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[Confluence] getPage failed — status: ${response.status}, id: ${resolvedId}`);
    throw new Error(`Confluence API error ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  return mapPage(data, baseUrl);
}

export function formatPages(pages: ConfluencePage[]): string {
  if (pages.length === 0) return 'No wiki pages found matching the query.';
  return pages
    .map(
      (page, i) =>
        `[${i + 1}] ${page.title}
  Space: ${page.space}
  Last Modified: ${page.lastModified ? new Date(page.lastModified).toLocaleDateString() : 'Unknown'}
  URL: ${page.url}
  Excerpt: ${page.excerpt}
  Content: ${page.body}`
    )
    .join('\n\n---\n\n');
}
