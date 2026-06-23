import { debug, info } from '@actions/core';
import { AgileClient, type Paginated, Version2Client, Version3Client } from 'jira.js';
import type { Sprint } from 'jira.js/out/agile/models/sprint.js';
import type { CreateSprint } from 'jira.js/out/agile/parameters/createSprint.js';
import type { Project } from 'jira.js/out/version2/models/project.js';
import type { ProjectComponent } from 'jira.js/out/version2/models/projectComponent.js';
import type { Version } from 'jira.js/out/version2/models/version.js';
import type { CreateVersion } from 'jira.js/out/version2/parameters/createVersion.js';
import type { ProjectConfiguration } from './config.js';
import { ThrottledClient } from './throttle-client.js';
import { ThrottleQueue } from './throttle-queue.js';

export interface CreateIssueParamsMilestone {
  name: string;
  startDate: string;
  releaseDate: string;
  closed: true;
}
export interface CreateIssueParams {
  title: string;
  body: string;
  state: string;
  issuetype: string;
  status: string;
  resolution?: string; // Optional: Jira resolution field (e.g., "Done", "Won't Do")
  storyPoints?: number;
  fixVersionId?: string;
  sprintBoardId?: number;
  priority?: string;
  jiraProjectKey: string;

  globalId: string;
  remoteLinkUrl: string;
  remoteLinkTitle: string;
}

export interface CreateReleaseParams {
  name: string;
  released: boolean;
  releaseDate?: string;
}

export interface CreateSprintParams {
  name: string;
  startDate: string;
  endDate: string;
}

export interface UpdateReleaseParams {
  id: string;
  projectId: number;
  name: string;
  released: boolean;
  releaseDate?: string;
}

export interface UpdateSprintParams {
  sprintId: number;
  name: string;
  startDate: string;
  endDate: string;
}

export class Jira {
  #client: Version2Client;
  #agileClient: AgileClient;
  #clientV3: Version3Client;

  #projectConfiguration: ProjectConfiguration;

  #storyPointsFieldId: string | undefined;
  #epicNameFieldId: string | undefined;
  #githubIssueFieldId: string | undefined;

  #project: Project | undefined;

  #components: ProjectComponent[] = [];

  #boardId: number | undefined;

  constructor(projectConfiguration: ProjectConfiguration) {
    this.#projectConfiguration = projectConfiguration;

    const jiraConfig = {
      host: this.#projectConfiguration.jira.host,
      authentication: {
        basic: {
          email: this.#projectConfiguration.jira.email,
          apiToken: this.#projectConfiguration.jira.writeToken,
        },
      },
    };

    // create client
    const throttle = new ThrottleQueue(2000); // one call every 2s
    const throttleClient = new ThrottledClient(throttle);

    this.#client = throttleClient.createProxy(new Version2Client(jiraConfig));
    this.#agileClient = throttleClient.createProxy(new AgileClient(jiraConfig));
    this.#clientV3 = throttleClient.createProxy(new Version3Client(jiraConfig));
  }

  async checkJiraConnection(): Promise<boolean> {
    try {
      await this.#client.myself.getCurrentUser();
      return true;
    } catch (e) {
      console.error('Jira connection error', e);
      return false;
    }
  }

  async initAndCheck(): Promise<void> {
    // check the connection to Jira
    const jiraConnected = await this.checkJiraConnection();
    if (!jiraConnected) {
      throw new Error('Jira connection error');
    }

    if (this.#projectConfiguration.dryRun) {
      console.log('🔍 [DRY RUN] Jira connection successful - will simulate issue creation');
    }

    // get JIRA project
    this.#project = await this.#client.projects.getProject({
      projectIdOrKey: this.#projectConfiguration.jira.projectKey,
    });

    // ok now get all issue types
    const existingIssueTypes = (this.#project?.issueTypes?.map((issueType) => issueType.name) ?? []).filter(
      (item) => item !== undefined,
    );

    //get the statuses required from the configuration
    const wantedIssueTypes = this.#projectConfiguration.issueTypeMapping?.map((status) => status.toJira) ?? [];

    // check that all wanted statuses are in Jira
    for (const wantedIssueType of wantedIssueTypes) {
      if (!existingIssueTypes.includes(wantedIssueType)) {
        throw new Error(
          `Issue type "${wantedIssueType}" not found in Jira to sync the project ${this.#projectConfiguration.name}`,
        );
      }
    }

    // check if the wanted component exists, create if missing
    this.#components = await this.#client.projectComponents.getProjectComponents({
      projectIdOrKey: this.#projectConfiguration.jira.projectKey,
    });
    const wantedComponent = this.#projectConfiguration.jira.component;
    let componentExists = this.#components.find((component) => component.name === wantedComponent);

    if (!componentExists) {
      info(`Component "${wantedComponent}" not found in Jira project ${this.#projectConfiguration.jira.projectKey}, creating it...`);

      try {
        const newComponent = await this.#client.projectComponents.createComponent({
          name: wantedComponent,
          project: this.#projectConfiguration.jira.projectKey,
        });

        info(`✅ Created component "${wantedComponent}" (id: ${newComponent.id})`);

        // Refresh components list to include the newly created one
        this.#components = await this.#client.projectComponents.getProjectComponents({
          projectIdOrKey: this.#projectConfiguration.jira.projectKey,
        });

        componentExists = this.#components.find((component) => component.name === wantedComponent);
      } catch (error) {
        throw new Error(
          `Failed to create component "${wantedComponent}" in Jira project ${this.#projectConfiguration.jira.projectKey}: ${error}`
        );
      }
    }

    const fields = await this.#client.issueFields.getFields();

    // search for the field named 'Story Points'
    const storyPointsField = fields.find((field) => field.name === 'Story Points');
    if (!storyPointsField || !storyPointsField.id) {
      throw new Error('Story Points field cannot be found');
    }
    this.#storyPointsFieldId = storyPointsField.id;

    // search for the field named 'Epic Name'
    const epicNameField = fields.find((field) => field.name === 'Epic Name');
    if (!epicNameField || !epicNameField.id) {
      throw new Error('Epic Name field cannot be found');
    }
    this.#epicNameFieldId = epicNameField.id;

    // search for the field named 'GitHub Issue' (for deduplication)
    const githubIssueField = fields.find((field) => field.name === 'GitHub Issue');
    if (githubIssueField && githubIssueField.id) {
      this.#githubIssueFieldId = githubIssueField.id;
      info(`✅ Found GitHub Issue custom field (enables reliable deduplication): ${githubIssueField.id}`);
    } else {
      info('ℹ️  GitHub Issue custom field not found - using remote links API for deduplication');
    }
  }

  async getReleases(): Promise<Version[]> {
    // list all releases from JIRA
    return this.#client.projectVersions.getProjectVersions({
      projectIdOrKey: this.#projectConfiguration.jira.projectKey,
    });
  }

  protected async doGetAllSprintsByBoardId(boardId: number): Promise<Sprint[]> {
    let allSprints: Sprint[] = [];
    let startAt = 0;
    const maxResults = 50;

    let response: Paginated<Sprint>;
    do {
      response = await this.#agileClient.board.getAllSprints({
        boardId,
        startAt,
        maxResults,
      });

      // append
      allSprints = allSprints.concat(response.values);

      // update
      startAt += response.values.length;
    } while (!response.isLast); // Continue while there are more sprints to fetch

    return allSprints;
  }

  async getSprints(): Promise<Sprint[]> {
    // list all releases from JIRA
    const boards = await this.#agileClient.board.getAllBoards({
      projectKeyOrId: this.#projectConfiguration.jira.projectKey,
    });

    // filter the expected board
    const board = boards.values?.find((b) => b.name === this.#projectConfiguration.jira.sprintBoard);
    if (!board?.id) {
      throw new Error(
        `Board with name ${this.#projectConfiguration.jira.sprintBoard} not found for project ${this.#projectConfiguration.jira.projectKey}`,
      );
    }

    this.#boardId = board.id;

    // get sprints
    return this.doGetAllSprintsByBoardId(board.id);
  }

  async createSprint(sprint: CreateSprintParams): Promise<void> {
    if (!this.#boardId) {
      throw new Error('Board id not initialized, cannot create sprint');
    }

    const params: CreateSprint = {
      originBoardId: this.#boardId,
      name: sprint.name,
      startDate: sprint.startDate,
      endDate: sprint.endDate,
    };

    await this.#agileClient.sprint.createSprint(params);
  }

  async updateSprint(params: UpdateSprintParams): Promise<void> {
    await this.#agileClient.sprint.updateSprint(params);
  }

  async createRelease(release: CreateReleaseParams): Promise<void> {
    if (!this.#project) {
      throw new Error('Project not initialized, cannot create release');
    }
    const projectId = Number(this.#project.id);

    const params: CreateVersion = {
      projectId,
      name: release.name,
      released: release.released,
      releaseDate: release.releaseDate,
    };

    await this.#client.projectVersions.createVersion(params);
  }

  async updateRelease(params: UpdateReleaseParams): Promise<void> {
    await this.#client.projectVersions.updateVersion(params);
  }

  async findExistingGithubIssueInJira(remoteId: string, githubUrl?: string): Promise<string | undefined> {
    // If we have the GitHub Issue custom field, use it for reliable searching
    if (this.#githubIssueFieldId && githubUrl) {
      return await this.findExistingIssueByCustomField(githubUrl);
    }

    // Otherwise fall back to remote links API (may be unreliable)
    try {
      // Try the JQL function first (works in some Jira Cloud instances)
      const jql = `issue in issuesWithRemoteLinksByGlobalId("${remoteId}") and project = "${this.#projectConfiguration.jira.projectKey}"`;
      const query = { jql, maxResults: 1 };
      const issues = await this.#clientV3.issueSearch.searchForIssuesUsingJqlEnhancedSearch(query);
      return issues.issues?.[0]?.key;
    } catch (searchError: unknown) {
      const error = searchError as { response?: { status?: number } };
      if (error.response?.status === 410) {
        // JQL function is deprecated, fall back to fetching all project issues and checking remote links
        console.warn(
          `⚠️  JQL remote links function deprecated (410). Falling back to checking remote links via API...`,
        );
        return await this.findExistingIssueByRemoteLinkAPI(remoteId);
      }
      throw searchError;
    }
  }

  private async findExistingIssueByCustomField(githubUrl: string): Promise<string | undefined> {
    console.log(`🔍 Searching for existing issue with URL: ${githubUrl}`);

    // Try 1: Simple JQL search (fastest if it works)
    const jqlResult = await this.tryJqlDescriptionSearch(githubUrl);
    if (jqlResult) {
      console.log(`✅ Found existing issue ${jqlResult} via JQL search`);
      return jqlResult;
    }

    // Try 2: Fetch recent issues without JQL and filter client-side
    const clientSideResult = await this.findByClientSideFiltering(githubUrl);
    if (clientSideResult) {
      console.log(`✅ Found existing issue ${clientSideResult} via client-side filtering`);
      return clientSideResult;
    }

    console.log(`🆕 No existing issue found for ${githubUrl}`);
    return undefined;
  }

  /**
   * Extract plain text from Atlassian Document Format (ADF) or return string as-is
   */
  private extractTextFromDescription(description: unknown): string {
    if (typeof description === 'string') {
      return description;
    }

    // ADF format: {type: 'doc', content: [...], version: 1}
    if (description && typeof description === 'object' && 'content' in description) {
      const adf = description as { content?: Array<{ content?: Array<{ text?: string }> }> };
      const texts: string[] = [];

      // Recursively extract text nodes
      const extractText = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;

        if ('text' in node && typeof node.text === 'string') {
          texts.push(node.text);
        }

        if ('content' in node && Array.isArray(node.content)) {
          node.content.forEach(extractText);
        }
      };

      if (Array.isArray(adf.content)) {
        adf.content.forEach(extractText);
      }

      return texts.join(' ');
    }

    return '';
  }

  /**
   * Try JQL-based description search (fast but may fail with 410)
   */
  private async tryJqlDescriptionSearch(githubUrl: string): Promise<string | undefined> {
    try {
      // Use simple JQL to search description field with project scoping
      // Note: JQL text search (~) doesn't support OR conditions, so we search the full URL
      const jql = `project = "${this.#projectConfiguration.jira.projectKey}" AND description ~ "${githubUrl}" ORDER BY updated DESC`;
      const issues = await this.#clientV3.issueSearch.searchForIssuesUsingJqlEnhancedSearch({
        jql,
        maxResults: 20,  // Increased from 5 to catch more potential matches
        fields: ['description', 'key'],
      });

      // Check each result for exact URL match in description
      for (const issue of issues.issues || []) {
        const descText = this.extractTextFromDescription(issue.fields?.description);
        if (descText.includes(githubUrl)) {
          return issue.key;
        }
      }
    } catch (error: unknown) {
      const err = error as { response?: { status?: number } };
      if (err.response?.status === 410) {
        console.warn(`⚠️  JQL search returned 410 (deprecated). Falling back to client-side filtering...`);
        return undefined; // Fallback to next method
      }
      // Non-410 errors - log and fallback
      console.error(`❌ JQL search error (status ${err.response?.status}):`, err);
      return undefined; // Fallback on any error
    }

    return undefined;
  }

  /**
   * Fetch recent issues via REST API without JQL and filter client-side
   * This works even when JQL is completely broken in Jira Cloud
   *
   * IMPORTANT: Orders by UPDATED date, not CREATED date, so old issues that get
   * updated in GitHub will still be found in the recent issues list
   */
  private async findByClientSideFiltering(githubUrl: string): Promise<string | undefined> {
    try {
      console.log(`🔍 Fetching recent issues for client-side filtering (project: ${this.#projectConfiguration.jira.projectKey})...`);

      // CRITICAL: Order by UPDATED, not CREATED
      // This ensures old Jira issues that were recently updated in GitHub
      // will still appear in the search window
      const maxResults = 150; // Increased from 100 to reduce false negatives
      const response = await this.#clientV3.issueSearch.searchForIssuesUsingJqlEnhancedSearch({
        jql: `project = "${this.#projectConfiguration.jira.projectKey}" ORDER BY updated DESC`, // ← ORDER BY UPDATED
        maxResults,
        fields: ['description', 'key', 'created', 'updated'],
        validateQuery: 'none', // Skip JQL validation
      });

      if (!response.issues || response.issues.length === 0) {
        console.warn(`⚠️  No issues returned from project ${this.#projectConfiguration.jira.projectKey}`);
        return undefined;
      }

      console.log(`📊 Checking ${response.issues.length} recently updated issues for GitHub URL...`);

      // Log warning if approaching limit
      if (response.issues.length >= maxResults * 0.95) {
        console.warn(
          `⚠️  Approaching search limit (${response.issues.length}/${maxResults}). Consider enabling GitHub Issue custom field.`,
        );
      }

      // Filter client-side by checking description field
      const matches: string[] = [];
      for (const issue of response.issues) {
        const descText = this.extractTextFromDescription(issue.fields?.description);
        if (descText && descText.includes(githubUrl)) {
          matches.push(issue.key);
        }
      }

      // Handle duplicate matches (e.g., test data with multiple issues for same GitHub URL)
      if (matches.length === 0) {
        console.log(`🔍 No match found in ${response.issues.length} recently updated issues`);
        return undefined;
      } else if (matches.length === 1) {
        console.log(`✅ Match found in ${matches[0]} description`);
        return matches[0];
      } else {
        // Multiple duplicates found - use the most recently updated one
        console.warn(`⚠️  Found ${matches.length} duplicate Jira issues for ${githubUrl}: ${matches.join(', ')}`);
        console.warn(`   Using the first one (most recently updated): ${matches[0]}`);
        console.warn(`   This suggests manual cleanup is needed in Jira to remove duplicates.`);
        return matches[0]; // First match = most recently updated (ORDER BY updated DESC)
      }
    } catch (error: unknown) {
      const err = error as { response?: { status?: number; data?: unknown } };

      // Even simple project search failed - last resort
      if (err.response?.status === 410) {
        console.error(`❌ Even basic Jira API calls return 410. Deduplication impossible.`);
        console.error(`   This Jira instance may have API restrictions. Creating new issue.`);
        return undefined;
      }

      console.error(`❌ Client-side filtering failed (status ${err.response?.status}):`, err.response?.data);
      return undefined;
    }
  }

  private async findExistingIssueByRemoteLinkAPI(remoteId: string): Promise<string | undefined> {
    // Fallback: Search for issues in the project and check their remote links via v3 API
    // This is slower but works when the JQL function is deprecated
    try {
      const jql = `project = "${this.#projectConfiguration.jira.projectKey}" ORDER BY created DESC`;
      const query = { jql, maxResults: 100, fields: ['key'] }; // Only need key field
      const issues = await this.#clientV3.issueSearch.searchForIssuesUsingJqlEnhancedSearch(query);

      for (const issue of issues.issues || []) {
        try {
          const remoteLinks = await this.#clientV3.issueRemoteLinks.getRemoteIssueLinks({
            issueIdOrKey: issue.key,
          });

          const hasMatchingLink = remoteLinks.some((link) => link.globalId === remoteId);
          if (hasMatchingLink) {
            return issue.key;
          }
        } catch (linkError: unknown) {
          const error = linkError as { response?: { status?: number; data?: unknown } };
          if (error.response?.status === 410) {
            // Known Jira bug (JRACLOUD-28064): GET also returns 410
            // Since we can't reliably search for existing issues, fall back to URL-based search
            console.warn(
              `⚠️  Remote links GET API returns 410 (known Jira bug). Cannot search by remote links.`,
            );
            // Stop trying remote links API - will fall back to creating new issues
            return undefined;
          }
          // If we can't get remote links for this issue for other reasons, skip it
          continue;
        }
      }

      return undefined;
    } catch (searchError: unknown) {
      const error = searchError as { response?: { status?: number } };
      if (error.response?.status === 410) {
        // Remote links API is completely unavailable - return undefined to create new issues
        console.warn(`⚠️  Remote links API unavailable (410). Will create new issues without deduplication.`);
        return undefined;
      }
      throw searchError;
    }
  }

  async createOrUpdateIssue(createOrUpdateIssueParams: CreateIssueParams): Promise<{ key: string }> {
    // DRY RUN MODE: Just log what would happen
    if (this.#projectConfiguration.dryRun) {
      console.log('\n🔍 [DRY RUN] Would create/update Jira issue:');
      console.log(`   Title: ${createOrUpdateIssueParams.title}`);
      console.log(`   Type: ${createOrUpdateIssueParams.issuetype}`);
      console.log(`   Status: ${createOrUpdateIssueParams.status}`);
      console.log(`   Resolution: ${createOrUpdateIssueParams.resolution || 'None'}`);
      console.log(`   Priority: ${createOrUpdateIssueParams.priority || 'None'}`);
      console.log(`   Story Points: ${createOrUpdateIssueParams.storyPoints || 'None'}`);
      console.log(`   Fix Version: ${createOrUpdateIssueParams.fixVersionId || 'None'}`);
      console.log(`   Sprint: ${createOrUpdateIssueParams.sprintBoardId || 'None'}`);
      console.log(`   GitHub URL: ${createOrUpdateIssueParams.remoteLinkUrl}`);
      console.log(`   Global ID: ${createOrUpdateIssueParams.globalId}`);
      return { key: 'DRY-RUN-123' };
    }

    if (!this.#storyPointsFieldId) {
      throw new Error('Story Points field not initialized, cannot create or update issue');
    }

    if (!this.#epicNameFieldId && createOrUpdateIssueParams.issuetype === 'Epic') {
      throw new Error('Epic Name field not initialized, cannot create or update issue');
    }

    debug(
      `  🧪 Creating issue in Jira Type/${createOrUpdateIssueParams.issuetype} status/${createOrUpdateIssueParams.state} fixVersionID ${createOrUpdateIssueParams.fixVersionId} sprintBoardId/${createOrUpdateIssueParams.sprintBoardId}`,
    );

    // fields that may be mandatory for certain type of fields
    const createOptionalFields: Record<string, unknown> = {};

    // epic name
    if (this.#epicNameFieldId && createOrUpdateIssueParams.issuetype === 'Epic') {
      createOptionalFields[this.#epicNameFieldId] = createOrUpdateIssueParams.title;
    }

    // GitHub Issue URL will be set during editIssue instead of create
    // (field may not be on the Create screen)

    // create the REST API parameters
    const createParams = {
      fields: {
        ...createOptionalFields,
        summary: createOrUpdateIssueParams.title,
        project: {
          key: createOrUpdateIssueParams.jiraProjectKey,
        },
        issuetype: {
          name: createOrUpdateIssueParams.issuetype,
        },
        // Add priority if configured and provided
        ...(createOrUpdateIssueParams.priority && {
          priority: {
            name: createOrUpdateIssueParams.priority,
          },
        }),
      },
    };

    const existingKey = await this.findExistingGithubIssueInJira(
      createOrUpdateIssueParams.globalId,
      createOrUpdateIssueParams.remoteLinkUrl,
    );

    // create issue in Jira or update if already exists
    let issueKey: string;
    let isNewIssue = false;
    if (!existingKey) {
      try {
        const result = await this.#client.issues.createIssue(createParams);
        issueKey = result.key;
        isNewIssue = true;
        console.log(`✅ Created Jira issue ${issueKey}`);
      } catch (createError: unknown) {
        const error = createError as { response?: { status?: number; data?: unknown } };
        console.error(`❌ Failed to create issue. Status: ${error.response?.status}`);
        console.error(`   Data:`, JSON.stringify(error.response?.data, null, 2));
        throw createError;
      }
    } else {
      issueKey = existingKey;
      console.log(`Found existing Jira issue ${issueKey}`);
    }

    // Only create remote link for new issues (existing issues should already have it)
    if (isNewIssue) {
      try {
        await this.#clientV3.issueRemoteLinks.createOrUpdateRemoteIssueLink({
          issueIdOrKey: issueKey,
          globalId: createOrUpdateIssueParams.globalId,
          object: {
            url: createOrUpdateIssueParams.remoteLinkUrl,
            title: createOrUpdateIssueParams.remoteLinkTitle,
            icon: {
              url16x16: 'https://github.githubassets.com/favicons/favicon.svg',
              title: 'GitHub',
            },
          },
        });
        console.log(`✅ Remote link created for issue ${issueKey}`);
      } catch (remoteLinkError: unknown) {
        const error = remoteLinkError as { response?: { status?: number; data?: unknown } };
        if (error.response?.status === 410) {
          // Known Jira bug (JRACLOUD-28064): API returns 410 but link is actually created
          // Treat this as success and continue
          console.warn(
            `⚠️  Remote link API returned 410 (known Jira bug), but link was likely created successfully for ${issueKey}`,
          );
          // Don't throw - the link was probably created despite the 410 error
        } else {
          console.error(`❌ Remote link error (status ${error.response?.status}):`, error.response?.data);
          // Re-throw other errors
          throw remoteLinkError;
        }
      }
    }

    // optional fields that can be defined for updating an issue
    const updateOptionalFields: Record<string, unknown> = {};

    // story points - only set if explicitly provided (from Projects v2 in full mode)
    if (this.#storyPointsFieldId && createOrUpdateIssueParams.storyPoints !== undefined) {
      updateOptionalFields[this.#storyPointsFieldId] = createOrUpdateIssueParams.storyPoints;
    }

    let fixVersions: { id: string }[] | undefined = [];
    if (createOrUpdateIssueParams.fixVersionId) {
      fixVersions = [{ id: createOrUpdateIssueParams.fixVersionId }];
    }

    // grab component id from the components
    const findComponent = this.#components.find((c) => c.name === this.#projectConfiguration.jira.component);
    let component: { id: string } | undefined;
    if (findComponent?.id) {
      component = { id: findComponent.id };
    }

    const components = component ? [component] : undefined;

    // Append GitHub issue URL to description for easy reference and deduplication
    // Jira has a ~32KB limit on description field, so truncate if needed
    const gitHubUrlSuffix = `\n\n---\nGitHub: ${createOrUpdateIssueParams.remoteLinkUrl}`;
    const truncationMessage = '\n\n[...content truncated - see GitHub for full description]';
    const maxDescriptionLength = 32000 - gitHubUrlSuffix.length - truncationMessage.length;

    let body = createOrUpdateIssueParams.body || '';
    if (body.length > maxDescriptionLength) {
      body = body.substring(0, maxDescriptionLength) + truncationMessage;
    }

    const descriptionWithGitHubLink = `${body}${gitHubUrlSuffix}`;

    // update the issue with the story points, body, etc
    const updateFields = {
      ...createParams.fields,
      ...updateOptionalFields,
      components,
      description: descriptionWithGitHubLink,
      fixVersions,
      // Add resolution if provided
      ...(createOrUpdateIssueParams.resolution && {
        resolution: {
          name: createOrUpdateIssueParams.resolution,
        },
      }),
    };

    try {
      await this.#client.issues.editIssue({
        issueIdOrKey: issueKey,
        fields: updateFields,
      });
    } catch (editError: unknown) {
      const error = editError as { response?: { status?: number; data?: unknown } };
      if (error.response?.status === 410) {
        console.warn(`⚠️  Edit issue API returned 410 (Gone) for ${issueKey}. Skipping field updates.`);
        console.warn(`   Fields attempted:`, JSON.stringify(Object.keys(updateFields)));
        // Continue without the field updates
      } else if (error.response?.status === 400) {
        console.error(`❌ Failed to update issue ${issueKey}. Status: 400 Bad Request`);
        console.error(`   Fields attempted:`, JSON.stringify(Object.keys(updateFields)));
        console.error(`   Error details:`, JSON.stringify(error.response?.data, null, 2));
        throw editError;
      } else {
        throw editError;
      }
    }

    // do the transitions for the status
    const toStatus = createOrUpdateIssueParams.status;

    try {
      // get current status of the issue
      const issue = await this.#client.issues.getIssue({ issueIdOrKey: issueKey });
      const currentStatus = issue.fields?.status?.name;

      // if the status is the same, no need to update
      if (currentStatus?.toLowerCase() !== toStatus.toLowerCase()) {
        await this.updateIssueStatusTo(issueKey, toStatus);
      } else {
        debug(`  🧪 Issue ${issueKey} already in status ${toStatus}, skipping`);
      }
    } catch (statusError: unknown) {
      const error = statusError as { response?: { status?: number } };
      if (error.response?.status === 410) {
        console.warn(`⚠️  Status transition returned 410 for ${issueKey}. Issue created but status not updated.`);
        // Continue - issue was created successfully
      } else {
        throw statusError;
      }
    }

    // if sprint id, need to add the issue to the sprint
    if (createOrUpdateIssueParams.sprintBoardId) {
      try {
        await this.#agileClient.sprint.moveIssuesToSprintAndRank({
          sprintId: createOrUpdateIssueParams.sprintBoardId,
          issues: [issueKey],
        });
        console.log(`✅ Added ${issueKey} to sprint ${createOrUpdateIssueParams.sprintBoardId}`);
      } catch (sprintError: unknown) {
        const error = sprintError as { response?: { status?: number } };
        if (error.response?.status === 410) {
          console.warn(
            `⚠️  Sprint assignment returned 410 for ${issueKey}. Issue created but not added to sprint.`,
          );
          // Continue - issue was created/updated successfully
        } else {
          console.error(`❌ Sprint assignment failed:`, error);
          throw sprintError;
        }
      }
    }

    console.log(`✅ Successfully processed issue ${issueKey}`);
    return { key: issueKey };
  }

  async getTransitionId(issueKey: string, targetStatus: string): Promise<string | undefined> {
    try {
      const transitions = await this.#client.issues.getTransitions({ issueIdOrKey: issueKey });

      // Find the transition to the target status (e.g., "NEW")
      const transition = transitions.transitions?.find((t) => t.to?.name?.toLowerCase() === targetStatus.toLowerCase());

      return transition?.id;
    } catch (error: unknown) {
      const err = error as { response?: { status?: number } };
      if (err.response?.status === 410) {
        console.warn(`⚠️  getTransitions returned 410 for ${issueKey}`);
        return undefined;
      }
      throw error;
    }
  }

  async updateIssueStatusTo(issueKey: string, newStatus: string) {
    const transitionId = await this.getTransitionId(issueKey, newStatus);

    if (!transitionId) {
      console.warn(`⚠️  Transition to status "${newStatus}" not found for ${issueKey}`);
      return; // Don't throw - just skip the transition
    }

    // Perform the transition
    try {
      await this.#client.issues.doTransition({
        issueIdOrKey: issueKey,
        transition: { id: transitionId },
      });
      console.log(`✅ Transitioned ${issueKey} to ${newStatus}`);
    } catch (error: unknown) {
      const err = error as { response?: { status?: number } };
      if (err.response?.status === 410) {
        console.warn(`⚠️  doTransition returned 410 for ${issueKey}`);
        // Don't throw - transition failed but issue exists
      } else {
        throw error;
      }
    }
  }
}
