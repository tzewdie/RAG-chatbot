export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  priority: string;
  issueType: string;
  description: string;
  assignee: string | null;
  reporter: string | null;
  created: string;
  updated: string;
  labels: string[];
  url: string;
}

function getJiraCredentials() {
  const baseUrl = process.env.JIRA_BASE_URL;
  const apiToken = process.env.JIRA_API_TOKEN;

  if (!baseUrl || !apiToken) {
    throw new Error(
      'Jira credentials not configured. Set JIRA_BASE_URL and JIRA_API_TOKEN.'
    );
  }

  const email = process.env.JIRA_USER_EMAIL;
  // If email/username is provided → Basic Auth (username:password or email:token)
  // If only token is provided → Bearer token (Personal Access Token for Jira Server 8.14+)
  const authHeader = email
    ? `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`
    : `Bearer ${apiToken}`;

  return { baseUrl, authHeader };
}

function extractText(adfNode: unknown): string {
  if (!adfNode || typeof adfNode !== 'object') return '';
  const node = adfNode as Record<string, unknown>;
  if (node.type === 'text' && typeof node.text === 'string') return node.text;
  if (Array.isArray(node.content)) {
    return (node.content as unknown[]).map(extractText).join('');
  }
  return '';
}

function mapIssue(issue: Record<string, unknown>, baseUrl: string): JiraIssue {
  const fields = issue.fields as Record<string, unknown>;
  // Jira Server returns description as a plain string; Cloud returns ADF object
  const rawDescription = fields.description;
  const description =
    typeof rawDescription === 'string'
      ? rawDescription
      : rawDescription
      ? extractText(rawDescription)
      : 'No description';
  return {
    key: issue.key as string,
    summary: fields.summary as string,
    status: (fields.status as Record<string, string>)?.name ?? 'Unknown',
    priority: (fields.priority as Record<string, string>)?.name ?? 'Unknown',
    issueType: (fields.issuetype as Record<string, string>)?.name ?? 'Unknown',
    description,
    assignee: (fields.assignee as Record<string, string>)?.displayName ?? null,
    reporter: (fields.reporter as Record<string, string>)?.displayName ?? null,
    created: fields.created as string,
    updated: fields.updated as string,
    labels: (fields.labels as string[]) ?? [],
    url: `${baseUrl}/browse/${issue.key}`,
  };
}

export async function searchJiraIssues(
  jql: string,
  maxResults = 10
): Promise<JiraIssue[]> {
  const { baseUrl, authHeader } = getJiraCredentials();

  const url = new URL(`${baseUrl}/rest/api/2/search`);
  url.searchParams.set('jql', jql);
  url.searchParams.set('maxResults', String(maxResults));
  url.searchParams.set(
    'fields',
    'summary,status,priority,issuetype,description,assignee,reporter,created,updated,labels'
  );

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: authHeader,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[Jira] searchIssues failed — status: ${response.status}, url: ${url.toString()}, body: ${text}`);
    throw new Error(`Jira API error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as { issues: Record<string, unknown>[] };
  return data.issues.map((issue) => mapIssue(issue, baseUrl));
}

export async function getJiraIssue(issueKey: string): Promise<JiraIssue> {
  const { baseUrl, authHeader } = getJiraCredentials();

  const response = await fetch(
    `${baseUrl}/rest/api/2/issue/${issueKey}?fields=summary,status,priority,issuetype,description,assignee,reporter,created,updated,labels`,
    {
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
      },
    }
  );

  if (!response.ok) {
    const text = await response.text();
    console.error(`[Jira] getIssue failed — status: ${response.status}, key: ${issueKey}, body: ${text}`);
    throw new Error(`Jira API error ${response.status}: ${text}`);
  }

  const issue = (await response.json()) as Record<string, unknown>;
  return mapIssue(issue, baseUrl);
}

export function formatIssues(issues: JiraIssue[]): string {
  if (issues.length === 0) return 'No issues found matching the criteria.';
  return issues
    .map(
      (issue, i) =>
        `[${i + 1}] ${issue.key}: ${issue.summary}
  Type: ${issue.issueType} | Status: ${issue.status} | Priority: ${issue.priority}
  Assignee: ${issue.assignee ?? 'Unassigned'} | Reporter: ${issue.reporter ?? 'Unknown'}
  Labels: ${issue.labels.length > 0 ? issue.labels.join(', ') : 'None'}
  Created: ${new Date(issue.created).toLocaleDateString()} | Updated: ${new Date(issue.updated).toLocaleDateString()}
  URL: ${issue.url}
  Description: ${issue.description.slice(0, 300)}${issue.description.length > 300 ? '...' : ''}`
    )
    .join('\n\n');
}
