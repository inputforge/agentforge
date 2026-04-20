export interface LinearTeam {
  id: string;
  name: string;
  key: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  state: string;
  url: string;
  priority: number;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

export class LinearService {
  constructor(private readonly pat: string) {}

  private async graphql<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        Authorization: this.pat,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Linear API ${res.status}: ${text}`);
    }
    const json = (await res.json()) as GraphQLResponse<T>;
    if (json.errors?.length) {
      throw new Error(`Linear API: ${json.errors[0].message}`);
    }
    return json.data as T;
  }

  async listTeams(): Promise<LinearTeam[]> {
    const data = await this.graphql<{ teams: { nodes: LinearTeam[] } }>(`
      query { teams { nodes { id name key } } }
    `);
    return data.teams.nodes;
  }

  async listIssues(teamId?: string, limit = 100): Promise<LinearIssue[]> {
    const filterArg = teamId ? `, filter: { team: { id: { eq: "${teamId}" } } }` : "";
    const data = await this.graphql<{ issues: { nodes: Record<string, unknown>[] } }>(`
      query {
        issues(first: ${limit}${filterArg}, orderBy: updatedAt) {
          nodes {
            id
            identifier
            title
            description
            url
            priority
            createdAt
            updatedAt
            state { name }
            labels { nodes { name } }
          }
        }
      }
    `);
    return data.issues.nodes.map((issue) => ({
      id: issue.id as string,
      identifier: issue.identifier as string,
      title: issue.title as string,
      description: (issue.description as string | null) ?? "",
      state: (issue.state as { name: string }).name,
      url: issue.url as string,
      priority: issue.priority as number,
      labels: ((issue.labels as { nodes: { name: string }[] }).nodes).map((l) => l.name),
      createdAt: issue.createdAt as string,
      updatedAt: issue.updatedAt as string,
    }));
  }

  async getIssue(id: string): Promise<LinearIssue | null> {
    try {
      const data = await this.graphql<{ issue: Record<string, unknown> | null }>(`
        query {
          issue(id: "${id}") {
            id identifier title description url priority createdAt updatedAt
            state { name }
            labels { nodes { name } }
          }
        }
      `);
      const issue = data.issue;
      if (!issue) return null;
      return {
        id: issue.id as string,
        identifier: issue.identifier as string,
        title: issue.title as string,
        description: (issue.description as string | null) ?? "",
        state: (issue.state as { name: string }).name,
        url: issue.url as string,
        priority: issue.priority as number,
        labels: ((issue.labels as { nodes: { name: string }[] }).nodes).map((l) => l.name),
        createdAt: issue.createdAt as string,
        updatedAt: issue.updatedAt as string,
      };
    } catch {
      return null;
    }
  }
}
