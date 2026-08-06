export interface LinearIssueSnapshot {
  id: string;
  identifier: string;
  title: string;
  description: string;
  priority: number | null;
  url: string | null;
  updatedAt: string;
  state: {
    id: string;
    name: string;
    type: string;
  };
  team: {
    id: string;
  };
  labels: string[];
}

interface GraphqlEnvelope<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

export interface LinearProjectionClient {
  listProjectIssues(projectId: string): Promise<LinearIssueSnapshot[]>;
  findCommentByMarker(issueId: string, marker: string): Promise<string | null>;
  createComment(issueId: string, body: string): Promise<string>;
  resolveCompletedState(teamId: string): Promise<string>;
  setIssueState(issueId: string, stateId: string): Promise<string>;
}

export class LinearGraphqlClient implements LinearProjectionClient {
  constructor(
    private readonly apiKey: string,
    private readonly endpoint = 'https://api.linear.app/graphql',
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly requestTimeoutMs = 15000
  ) {}

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: this.apiKey,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(this.requestTimeoutMs)
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new Error(`linear_request_timeout_${this.requestTimeoutMs}ms`);
      }
      throw error;
    }

    if (!response.ok) {
      throw new Error(`linear_http_${response.status}`);
    }

    const envelope = (await response.json()) as GraphqlEnvelope<T>;
    if (envelope.errors?.length) {
      const message = envelope.errors.map((error) => error.message ?? 'unknown').join('; ');
      throw new Error(`linear_graphql_error:${message.slice(0, 500)}`);
    }
    if (!envelope.data) throw new Error('linear_graphql_missing_data');
    return envelope.data;
  }

  async listProjectIssues(projectId: string): Promise<LinearIssueSnapshot[]> {
    const data = await this.request<{
      project: {
        issues: {
          nodes: Array<{
            id: string;
            identifier: string;
            title: string;
            description: string | null;
            priority: number | null;
            url: string | null;
            updatedAt: string;
            state: { id: string; name: string; type: string };
            team: { id: string };
            labels: { nodes: Array<{ name: string }> };
          }>;
        };
      } | null;
    }>(
      `query BradProjectIssues($projectId: String!) {
        project(id: $projectId) {
          issues(first: 250) {
            nodes {
              id identifier title description priority url updatedAt
              state { id name type }
              team { id }
              labels { nodes { name } }
            }
          }
        }
      }`,
      { projectId }
    );

    if (!data.project) throw new Error('linear_project_not_found');
    return data.project.issues.nodes.map((issue) => ({
      ...issue,
      description: issue.description ?? '',
      labels: issue.labels.nodes.map((label) => label.name)
    }));
  }

  async findCommentByMarker(issueId: string, marker: string): Promise<string | null> {
    const data = await this.request<{
      issue: { comments: { nodes: Array<{ id: string; body: string }> } } | null;
    }>(
      `query BradIssueComments($issueId: String!) {
        issue(id: $issueId) {
          comments(first: 100) { nodes { id body } }
        }
      }`,
      { issueId }
    );

    return data.issue?.comments.nodes.find((comment) => comment.body.includes(marker))?.id ?? null;
  }

  async createComment(issueId: string, body: string): Promise<string> {
    const data = await this.request<{
      commentCreate: { success: boolean; comment: { id: string } | null };
    }>(
      `mutation BradCreateComment($input: CommentCreateInput!) {
        commentCreate(input: $input) { success comment { id } }
      }`,
      { input: { issueId, body } }
    );

    if (!data.commentCreate.success || !data.commentCreate.comment) {
      throw new Error('linear_comment_create_failed');
    }
    return data.commentCreate.comment.id;
  }

  async resolveCompletedState(teamId: string): Promise<string> {
    const data = await this.request<{
      team: { states: { nodes: Array<{ id: string; name: string; type: string }> } } | null;
    }>(
      `query BradTeamStates($teamId: String!) {
        team(id: $teamId) { states { nodes { id name type } } }
      }`,
      { teamId }
    );
    const states = data.team?.states.nodes ?? [];
    const completed = states.find((state) => state.type === 'completed' && state.name.toLowerCase() === 'done')
      ?? states.find((state) => state.type === 'completed');
    if (!completed) throw new Error('linear_completed_state_not_found');
    return completed.id;
  }

  async setIssueState(issueId: string, stateId: string): Promise<string> {
    const data = await this.request<{
      issueUpdate: { success: boolean; issue: { id: string; state: { id: string } } | null };
    }>(
      `mutation BradSetIssueState($issueId: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $issueId, input: $input) { success issue { id state { id } } }
      }`,
      { issueId, input: { stateId } }
    );
    if (!data.issueUpdate.success || !data.issueUpdate.issue) {
      throw new Error('linear_issue_update_failed');
    }
    return data.issueUpdate.issue.state.id;
  }
}
