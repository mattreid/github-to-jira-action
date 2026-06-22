import { info } from '@actions/core';
import { getOctokit } from '@actions/github';
import type { GitHub as OctokitGitHub } from '@actions/github/lib/utils.js';
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
  #githubReadAccess: InstanceType<typeof OctokitGitHub> | undefined;

  constructor(projectConfiguration: ProjectConfiguration) {
    this.#projectConfiguration = projectConfiguration;
    // Only initialize Octokit if we have a token (needed for GraphQL full mode)
    if (this.#projectConfiguration.github.readToken) {
      this.#githubReadAccess = getOctokit(this.#projectConfiguration.github.readToken);
    }
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
    const assigneeWhitelist = this.#projectConfiguration.github.assigneeWhitelist;
    const maxBatchNumberIssues = this.#projectConfiguration.maxBatchNumberIssues;

    let allIssues: BasicIssue[] = [];

    // If we have assignee whitelist, fetch per assignee for efficiency
    if (assigneeWhitelist && assigneeWhitelist.length > 0) {
      for (const assignee of assigneeWhitelist) {
        info(`Fetching issues assigned to ${assignee}...`);
        const issues = await this.fetchIssuesForAssignee(owner, repo, assignee, startDate);
        allIssues.push(...issues);
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
    uniqueIssues.sort((a, b) =>
      new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()
    );

    // Respect maxBatchNumberIssues limit
    const limitedIssues = uniqueIssues.slice(0, maxBatchNumberIssues);

    info(`Fetched ${limitedIssues.length} issues via REST API`);
    return limitedIssues;
  }

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
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
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
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
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

  foo() {
    if (!this.#githubReadAccess) {
      throw new Error('GitHub Octokit client not initialized - token required for this operation');
    }
    this.#githubReadAccess.rest.issues.listForRepo({
      owner: this.#projectConfiguration.github.owner,
      repo: this.#projectConfiguration.github.repo,
    });
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

    // how many entries do we have ?
    if (allGraphQlResponse.length >= this.#projectConfiguration.maxBatchNumberIssues) {
      // we have enough entries, need to return only the first _maxBatchNumberIssues
      return allGraphQlResponse.slice(0, this.#projectConfiguration.maxBatchNumberIssues);
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
