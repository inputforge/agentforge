export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  url: string;
  labels: string[];
  assignees: string[];
  createdAt: string;
  updatedAt: string;
}

export class GitHubService {
  constructor(
    private readonly pat: string,
    private readonly owner: string,
    private readonly repo: string,
  ) {}

  private async apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.pat}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`GitHub API ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async listIssues(state: "open" | "closed" | "all" = "open"): Promise<GitHubIssue[]> {
    const data = await this.apiFetch<Record<string, unknown>[]>(
      `/repos/${this.owner}/${this.repo}/issues?state=${state}&per_page=100&sort=updated`,
    );
    return data
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({
        number: issue.number as number,
        title: issue.title as string,
        body: (issue.body as string | null) ?? "",
        state: issue.state as "open" | "closed",
        url: issue.html_url as string,
        labels: (issue.labels as { name: string }[]).map((l) => l.name),
        assignees: (issue.assignees as { login: string }[]).map((a) => a.login),
        createdAt: issue.created_at as string,
        updatedAt: issue.updated_at as string,
      }));
  }

  async getIssue(number: number): Promise<GitHubIssue | null> {
    try {
      const issue = await this.apiFetch<Record<string, unknown>>(
        `/repos/${this.owner}/${this.repo}/issues/${number}`,
      );
      return {
        number: issue.number as number,
        title: issue.title as string,
        body: (issue.body as string | null) ?? "",
        state: issue.state as "open" | "closed",
        url: issue.html_url as string,
        labels: (issue.labels as { name: string }[]).map((l) => l.name),
        assignees: (issue.assignees as { login: string }[]).map((a) => a.login),
        createdAt: issue.created_at as string,
        updatedAt: issue.updated_at as string,
      };
    } catch {
      return null;
    }
  }
}
