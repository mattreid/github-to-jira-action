import { info } from '@actions/core';
import { graphql } from '@octokit/graphql';
import type { ProjectConfiguration, ProjectConfigurationFieldType } from './config.js';

export interface GraphQLSearchIssuesNodeMilestone {
  id: string;
  dueOn?: string;
  closed?: boolean;
  title: string;
}

export interface GraphQLSearchIssuesNodeSprint {
  title: string;
  duration: number;
  startDate: string;
}

export interface GraphQLSearchIssuesNode {
  url: string;
  number: number;
  state: string;
  stateReason?: string;
  updatedAt: string;
  body: string;
  title: string;
  labels: {
    nodes: { name: string }[];
  };
  issueType?: {
    id: string;
    name: string;
  };
  milestone?: GraphQLSearchIssuesNodeMilestone;
  projectItems: {
    projects: {
      project: {
        title?: {
          name: string;
        };
        status?: {
          name: string;
        };
        sprint?: GraphQLSearchIssuesNodeSprint;
        storyPoints: {
          value: number;
        };
        priority?: {
          name: string;
        };
      };
    }[];
  };
}

export interface GraphQLSearchIssuesResponse {
  rateLimit: {
    cost: number;
    remaining: number;
    resetAt: string;
  };

  search: {
    pageInfo: {
      startCursor: string;
      endCursor: string;
      hasNextPage: boolean;
    };
    edges: {
      node: GraphQLSearchIssuesNode[];
    }[];
  };
}

// Basic issue type from REST API
export interface BasicIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  state_reason: 'completed' | 'not_planned' | 'reopened' | 'duplicate' | null;
  html_url: string;
  updated_at: string;
  created_at: string;
  closed_at: string | null;
  labels: Array<{ name: string }>;
  type?: {
    id: number;
    node_id: string;
    name: string;
    description: string;
    color: string;
    created_at: string;
    updated_at: string;
    is_enabled: boolean;
  };
  milestone: {
    title: string;
    number: number;
  } | null;
  assignees: Array<{ login: string }>;
  pull_request?: unknown; // Present if this is a PR
  user: { login: string };
}

export class GitHub {
  #projectConfiguration: ProjectConfiguration;

  constructor(projectConfiguration: ProjectConfiguration) {
    this.#projectConfiguration = projectConfiguration;
  }

  async getIssuesUpdatedAfter(): Promise<{
    owner: string;
    repo: string;
    afterDate: string;
    issues: GraphQLSearchIssuesNode[] | BasicIssue[];
  }> {
    const syncMode = this.#projectConfiguration.github.syncMode || 'full';

    let issues: GraphQLSearchIssuesNode[] | BasicIssue[];
    if (syncMode === 'basic') {
      issues = await this.getIssuesViaREST();
    } else {
      issues = await this.doGetIssuesUpdatedAfterBatch();
    }

    // startDate will be the last updated date of the last issue
    let nextStartDate: string = this.#projectConfiguration.github.startDate.toISOString();
    const lastItem = issues[issues.length - 1];
    if (lastItem) {
      const lastUpdateTime = 'updated_at' in lastItem ? lastItem.updated_at : lastItem.updatedAt;

      // Add 1 second to avoid re-fetching the same issue
      // (GitHub's 'since' parameter is inclusive: updated_at >= since)
      const lastUpdateDate = new Date(lastUpdateTime);
      lastUpdateDate.setSeconds(lastUpdateDate.getSeconds() + 1);
      nextStartDate = lastUpdateDate.toISOString();
    }

    return {
      owner: this.#projectConfiguration.github.owner,
      repo: this.#projectConfiguration.github.repo,
      afterDate: nextStartDate,
      issues,
    };
  }

  async getIssuesViaREST(): Promise<BasicIssue[]> {
    const startDate = this.#projectConfiguration.github.startDate.toISOString();
    const owner = this.#projectConfiguration.github.owner;
    const repo = this.#projectConfiguration.github.repo;
    const assigneeAllowlist = this.#projectConfiguration.github.assigneeAllowlist;
    const maxBatchNumberIssues = this.#projectConfiguration.maxBatchNumberIssues;

    let allIssues: BasicIssue[] = [];

    // If we have assignee allowlist, try optimized search API first, fall back to per-assignee
    if (assigneeAllowlist && assigneeAllowlist.length > 0) {
      info(`Fetching issues for ${assigneeAllowlist.length} assignees using optimized query...`);
      try {
        allIssues = await this.fetchIssuesForAssignees(owner, repo, assigneeAllowlist, startDate);
      } catch (error) {
        // If search API fails (422 or other), fall back to per-assignee queries
        console.warn(`⚠️  Search API failed, falling back to per-assignee queries: ${error}`);
        for (const assignee of assigneeAllowlist) {
          info(`  Fetching issues assigned to ${assignee}...`);
          const issues = await this.fetchIssuesForAssignee(owner, repo, assignee, startDate);
          allIssues.push(...issues);
        }
      }
    } else {
      // Fetch all issues (no filter)
      info(`Fetching all issues...`);
      allIssues = await this.fetchAllIssues(owner, repo, startDate);
    }

    // Deduplicate (issue might match multiple criteria)
    const uniqueIssues = Array.from(
      new Map(allIssues.map(i => [i.number, i])).values()
    );

    // Sort by updated_at ascending (match GraphQL behavior)
    // This ensures afterDate progresses chronologically through the backlog
    uniqueIssues.sort((a, b) =>
      new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()
    );

    // Process in batches to avoid memory issues and allow incremental progress
    // The last issue's timestamp becomes the next run's afterDate
    const limitedIssues = uniqueIssues.slice(0, maxBatchNumberIssues);

    if (uniqueIssues.length > maxBatchNumberIssues) {
      info(`Fetched ${uniqueIssues.length} issues, processing first ${maxBatchNumberIssues} (batch limit)`);
    } else {
      info(`Fetched ${limitedIssues.length} issues via REST API`);
    }

    return limitedIssues;
  }

  /**
   * Fetch issues for multiple assignees using search API (optimized)
   * Reduces N API calls (one per assignee) to 1-2 calls (batched OR query)
   *
   * GitHub search query max length is ~256 chars, so we batch if needed
   */
  private async fetchIssuesForAssignees(
    owner: string,
    repo: string,
    assignees: string[],
    since: string
  ): Promise<BasicIssue[]> {
    // Build search query: repo:owner/repo is:issue updated:>=date (assignee:user1 OR assignee:user2 OR ...)
    // Example: repo:eclipse-che/che is:issue updated:>=2026-06-01 (assignee:user1 OR assignee:user2)

    const baseQuery = `repo:${owner}/${repo} is:issue updated:>=${since}`;

    // GitHub search query has a practical limit (~256 chars for the URL)
    // If assignee list is huge, we may need to batch into multiple queries
    // Each "assignee:username OR " is ~20-30 chars, so we can fit ~50 assignees per query

    const BATCH_SIZE = 50;
    let allIssues: BasicIssue[] = [];

    for (let i = 0; i < assignees.length; i += BATCH_SIZE) {
      const batch = assignees.slice(i, i + BATCH_SIZE);
      const assigneeQuery = batch.map(a => `assignee:${a}`).join(' ');
      const fullQuery = `${baseQuery} ${assigneeQuery}`;

      info(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: Searching for ${batch.length} assignees...`);

      let page = 1;
      while (true) {
        const params = new URLSearchParams({
          q: fullQuery,
          per_page: '100',
          page: page.toString(),
          sort: 'updated',
          order: 'asc',
        });

        const url = `https://api.github.com/search/issues?${params}`;
        const response = await fetch(url, {
          headers: this.getAuthHeaders(),
        });

        if (!response.ok) {
          const authMode = this.#projectConfiguration.github.readToken ? 'authenticated' : 'unauthenticated';
          const errorBody = await response.json().catch(() => ({}));
          console.error(`Search query that failed: ${fullQuery}`);
          console.error(`Error response:`, errorBody);
          throw new Error(`GitHub Search API error: ${response.status} ${response.statusText} (${authMode} mode, repo: ${owner}/${repo})`);
        }

        const data = await response.json() as { items: BasicIssue[] };
        const items = data.items;

        // Filter out pull requests
        const issues = items.filter(item => !item.pull_request);
        allIssues.push(...issues);

        // Stop if no more results
        if (items.length < 100) {
          break;
        }

        page++;
      }
    }

    return allIssues;
  }

  /**
   * @deprecated Use fetchIssuesForAssignees for better performance (1 call vs N calls)
   */
  private async fetchIssuesForAssignee(
    owner: string,
    repo: string,
    assignee: string,
    since: string
  ): Promise<BasicIssue[]> {
    let page = 1;
    let allIssues: BasicIssue[] = [];

    while (true) {
      const params = new URLSearchParams({
        state: 'all',
        assignee: assignee,
        per_page: '100',
        page: page.toString(),
        sort: 'updated',
        direction: 'asc',
        since: since,
      });

      const url = `https://api.github.com/repos/${owner}/${repo}/issues?${params}`;
      const response = await fetch(url, {
        headers: this.getAuthHeaders(),
      });

      if (!response.ok) {
        const authMode = this.#projectConfiguration.github.readToken ? 'authenticated' : 'unauthenticated';
        const repoSlug = `${owner}/${repo}`;
        throw new Error(`GitHub API error: ${response.status} ${response.statusText} (${authMode} mode, repo: ${repoSlug})`);
      }

      const items: BasicIssue[] = await response.json();

      // Filter out pull requests (they have a pull_request field)
      const issues = items.filter(item => !item.pull_request);
      allIssues.push(...issues);

      // Stop if no more results or less than per_page (last page)
      if (items.length < 100) {
        break;
      }

      page++;
    }

    return allIssues;
  }

  private async fetchAllIssues(
    owner: string,
    repo: string,
    since: string
  ): Promise<BasicIssue[]> {
    let page = 1;
    let allIssues: BasicIssue[] = [];

    while (true) {
      const params = new URLSearchParams({
        state: 'all',
        per_page: '100',
        page: page.toString(),
        sort: 'updated',
        direction: 'asc',
        since: since,
      });

      const url = `https://api.github.com/repos/${owner}/${repo}/issues?${params}`;
      const response = await fetch(url, {
        headers: this.getAuthHeaders(),
      });

      if (!response.ok) {
        const authMode = this.#projectConfiguration.github.readToken ? 'authenticated' : 'unauthenticated';
        const repoSlug = `${owner}/${repo}`;
        throw new Error(`GitHub API error: ${response.status} ${response.statusText} (${authMode} mode, repo: ${repoSlug})`);
      }

      const items: BasicIssue[] = await response.json();

      // Filter out pull requests
      const issues = items.filter(item => !item.pull_request);
      allIssues.push(...issues);

      // Stop if no more results
      if (items.length < 100) {
        break;
      }

      page++;
    }

    return allIssues;
  }

  private getAuthHeaders(): HeadersInit {
    const token = this.#projectConfiguration.github.readToken;
    if (token) {
      return {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      };
    }
    return {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  protected async doGetIssuesUpdatedAfterBatch(
    cursor?: string,
    previousIssues?: GraphQLSearchIssuesNode[],
  ): Promise<GraphQLSearchIssuesNode[]> {
    const projectItemsFieldsGrapQLQuery = this.#projectConfiguration.github.projectFields
      .map((field) => this.getProjectGraphQLFieldQuery(field.alias, field.fieldName, field.type))
      .join('\n');

    const query = `

query getRecentIssues($cursorAfter: String) {
    rateLimit {
      cost
      remaining
      resetAt
    }
   search(query:"repo:${this.#projectConfiguration.github.owner}/${this.#projectConfiguration.github.repo} is:issue sort:updated-asc updated:>${this.#projectConfiguration.github.startDate.toISOString()}", type: ISSUE, first: 50, after: $cursorAfter) {
     pageInfo {
            startCursor
            endCursor
            hasNextPage
          }
       edges {
      node {
        ... on Issue {
          url
          number
          updatedAt
          body
          state
          stateReason
          title
          milestone {
            id
            dueOn
            closed
            title
          }
          labels(first: 20) {
            nodes {
              name
            }
          }
          issueType {
            id
            name
          }
          projectItems(first: 20, includeArchived: true) {
            projects: edges {
              project: node {
                title: project {
                  name: title
                }
                ${projectItemsFieldsGrapQLQuery}
              }
            }
          }          
        }
      }
    }
  }
}
`;

    const graphQlResponse = await graphql<GraphQLSearchIssuesResponse>(query, {
      cursorAfter: cursor,
      headers: {
        authorization: `token ${this.#projectConfiguration.github.readToken}`,
      },
    });

    const currentEntries = graphQlResponse.search.edges.flatMap((edge) => edge.node);

    let allGraphQlResponse: GraphQLSearchIssuesNode[];
    if (previousIssues) {
      allGraphQlResponse = previousIssues.concat(currentEntries);
    } else {
      allGraphQlResponse = currentEntries;
    }

    // Process in batches to avoid memory issues and allow incremental progress
    if (allGraphQlResponse.length >= this.#projectConfiguration.maxBatchNumberIssues) {
      // Reached batch limit, stop fetching and process what we have
      const limited = allGraphQlResponse.slice(0, this.#projectConfiguration.maxBatchNumberIssues);
      info(`Fetched ${allGraphQlResponse.length} issues, processing first ${this.#projectConfiguration.maxBatchNumberIssues} (batch limit)`);
      return limited;
    }

    info(`Fetched additional ${currentEntries.length}, current total ${allGraphQlResponse.length} items`);

    // if there are more issues to fetch, fetch them
    if (graphQlResponse.search.pageInfo.hasNextPage) {
      // needs to redo the search starting from the last search
      info('Fetching additional issues...');
      return await this.doGetIssuesUpdatedAfterBatch(graphQlResponse.search.pageInfo.endCursor, allGraphQlResponse);
    }

    return allGraphQlResponse;
  }

  getQueryForFieldType(fieldType: ProjectConfigurationFieldType): string {
    if (fieldType === 'number') {
      return `... on ProjectV2ItemFieldNumberValue {
    value: number
  }`;
    }
    if (fieldType === 'singleSelect') {
      return `... on ProjectV2ItemFieldSingleSelectValue {
       name
       }`;
    }

    if (fieldType === 'iteration') {
      return `... on ProjectV2ItemFieldIterationValue {
       duration
       startDate
       title
       }`;
    }
    return '';
  }

  // get graphql query for a field
  getProjectGraphQLFieldQuery(aliasName: string, fieldName: string, fieldType: ProjectConfigurationFieldType): string {
    return `
${aliasName}: fieldValueByName(name: "${fieldName}") {
  ${this.getQueryForFieldType(fieldType)}
}  
`;
  }
}
