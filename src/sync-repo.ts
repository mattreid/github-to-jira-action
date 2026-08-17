import { endGroup, error, info, isDebug, startGroup, warning } from '@actions/core';
import { HttpException } from 'jira.js';
import * as jira2md from 'jira2md';
import moment from 'moment';
import type { ProjectConfiguration } from './config.js';
import {
  GitHub,
  type GraphQLSearchIssuesNode,
  type GraphQLSearchIssuesNodeMilestone,
  type GraphQLSearchIssuesNodeSprint,
} from './github.js';
import { type CreateIssueParams, type CreateReleaseParams, type CreateSprintParams, Jira } from './jira.js';

/**
 * Handle the synchronization of a GitHub repository to a Jira project
 */
export class SyncRepository {
  #github: GitHub;

  #jira: Jira;

  #projectConfiguration: ProjectConfiguration;

  // map between the name of the fixVersion in Jira and the id
  #fixVersions: Map<string, string | undefined> = new Map();

  // map between the name of the sprint in Jira and the id
  #sprints: Map<string, number> = new Map();

  #jiraWasProvided: boolean;

  constructor(projectConfiguration: ProjectConfiguration, jira?: Jira) {
    this.#projectConfiguration = projectConfiguration;
    this.#github = new GitHub(this.#projectConfiguration);

    // Use provided Jira instance (cached) or create new one
    this.#jiraWasProvided = !!jira;
    this.#jira = jira || new Jira(this.#projectConfiguration);
  }

  protected fromGithubMilestoneToJiraRelease(githubMilestone: GraphQLSearchIssuesNodeMilestone): CreateReleaseParams {
    // keep only the left part of the date (YYYY-MM-DD)
    const releaseDate = githubMilestone.dueOn ? new Date(githubMilestone.dueOn).toISOString().split('T')[0] : undefined;

    const jiraRelease: CreateReleaseParams = {
      name: githubMilestone.title,
      released: githubMilestone.closed ?? false,
      releaseDate,
    };
    return jiraRelease;
  }

  async syncReleases(issues: GraphQLSearchIssuesNode[]): Promise<void> {
    // get all existing releases in Jira
    const jiraReleases = await this.#jira.getReleases();

    // get all milestones from all issues that we need to handle
    const githubReleases = issues
      .flatMap((issue) => issue.milestone)
      .filter((m) => m !== undefined)
      .filter((m) => m?.id);

    // remove any duplicates
    const githubReleasesWithoutDuplicates = githubReleases.filter((m, index) => {
      return githubReleases.findIndex((m2) => m2?.title === m?.title) === index;
    });

    // Optionally add the name of the project to the milestone as prefix
    // Default: false (no prefix, allows milestone sharing across repos)
    // Set to true if you want repo-specific milestone names
    const prefixWithProject = this.#projectConfiguration.github.milestonePrefixWithProject ?? false;
    const githubReleasesWithProjectPrefix = githubReleasesWithoutDuplicates.map((release) => {
      return {
        ...release,
        title: prefixWithProject ? `${this.#projectConfiguration.name} ${release.title}` : release.title,
      };
    });

    // get all the releases that are not in Jira
    const releasesToCreate = githubReleasesWithProjectPrefix.filter((release) => {
      return !jiraReleases.find((r) => r.name === release.title);
    });
    // create the releases in Jira
    for (const release of releasesToCreate) {
      const jiraRelease = this.fromGithubMilestoneToJiraRelease(release);
      this.#jira.createRelease(jiraRelease);
    }

    // now, update all the fields if it differs
    for (const release of githubReleasesWithoutDuplicates) {
      const jiraRelease = jiraReleases.find((r) => r.name === release.title);
      if (!jiraRelease) {
        continue;
      }

      // now compare the fields
      const fromGithub = this.fromGithubMilestoneToJiraRelease(release);
      if (
        jiraRelease.name !== fromGithub.name ||
        jiraRelease.released !== fromGithub.released ||
        jiraRelease.releaseDate !== fromGithub.releaseDate
      ) {
        const updatedRelease = {
          ...jiraRelease,
          id: jiraRelease.id ?? '',
          projectId: Number(jiraRelease.projectId),
          name: fromGithub.name,
          released: fromGithub.released,
          releaseDate: fromGithub.releaseDate,
        };
        await this.#jira.updateRelease(updatedRelease);
      }
    }

    // ok, refresh the list of releases
    const jiraReleasesAfterUpdate = await this.#jira.getReleases();
    for (const release of jiraReleasesAfterUpdate) {
      this.#fixVersions.set(release.name ?? release.id ?? 'unknown', release.id);
    }
  }

  /**
   * Convert a GitHub sprint to a Jira sprint
   * @param githubSprint the GitHub sprint
   * @returns the Jira sprint parameters
   */
  protected fromGithubSprintToJiraSprint(githubSprint: GraphQLSearchIssuesNodeSprint): CreateSprintParams {
    // keep only the left part of the date (YYYY-MM-DD)
    const startDate: string = new Date(githubSprint.startDate).toISOString();
    const endDate: string = moment(startDate).add(githubSprint.duration, 'day').toISOString();

    const jiraRelease: CreateSprintParams = {
      name: githubSprint.title,
      startDate,
      endDate,
    };
    return jiraRelease;
  }

  /**
   * Sync the sprints from GitHub to Jira
   * @param issues the issues containing the sprints to create or update
   */
  async syncSprints(issues: GraphQLSearchIssuesNode[]): Promise<void> {
    // get all existing sprints in Jira
    const jiraSprints = await this.#jira.getSprints();

    // get all sprints from all issues that we need to handle
    const filteredGithubSprints = issues
      .flatMap((issue) => issue.projectItems.projects)
      // keep only the projects not null
      .filter((p) => p !== null)
      .filter((p) => p.project.sprint !== undefined)
      .filter((p) => p.project.title?.name === this.#projectConfiguration.github.projectsV2Board);

    // keep only .project.sprint fields that are defined
    const githubSprints = filteredGithubSprints
      .filter((s) => s.project.sprint !== undefined)
      .map((s) => s.project.sprint)
      .filter((s) => s !== undefined)
      .filter((s) => s?.title);

    // remove any duplicates from githubSprints
    const githubSprintsWithoutDuplicates = githubSprints.filter((s, index) => {
      return githubSprints.findIndex((s2) => s2?.title === s?.title) === index;
    });

    // get all the sprints that are not in Jira
    const sprintsToCreateInJira = githubSprintsWithoutDuplicates
      .filter((sprint) => {
        return !jiraSprints.find((j) => j.name === sprint.title);
      })
      .filter((s) => s.startDate && s.duration);
    // create the sprint in Jira
    for (const sprintToCreate of sprintsToCreateInJira) {
      const jiraSprint = this.fromGithubSprintToJiraSprint(sprintToCreate);
      await this.#jira.createSprint(jiraSprint);
    }

    // now, update all the fields if it differs
    for (const githubSprint of githubSprintsWithoutDuplicates) {
      // matching sprint in Jira
      const jiraSprint = jiraSprints.find((r) => r.name === githubSprint.title);
      if (!jiraSprint) {
        continue;
      }

      // now compare the fields
      const fromGithub = this.fromGithubSprintToJiraSprint(githubSprint);

      // do not compare timezone (GitHub does not provide it and Jira has it so ignore it for comparison)
      const shortGithubStartDate = fromGithub.startDate.split('T')[0];
      const shortJiraStartDate = jiraSprint.startDate?.split('T')[0];

      const shortGithubEndDate = fromGithub.endDate.split('T')[0];
      const shortJiraEndDate = jiraSprint.endDate?.split('T')[0];

      if (
        jiraSprint.name !== fromGithub.name ||
        shortJiraStartDate !== shortGithubStartDate ||
        shortGithubEndDate !== shortJiraEndDate
      ) {
        const updatedSprint = {
          ...jiraSprint,
          sprintId: jiraSprint.id ?? 0,
          name: fromGithub.name,
          startDate: fromGithub.startDate,
          endDate: fromGithub.endDate,
        };
        await this.#jira.updateSprint(updatedSprint);
      }
    }

    // ok, refresh the list of sprints
    const jiraSprintsAfterUpdate = await this.#jira.getSprints();
    for (const sprint of jiraSprintsAfterUpdate) {
      this.#sprints.set(sprint.name ?? sprint.id ?? 'unknown', sprint.id);
    }
  }

  async start(): Promise<{ afterDate: string; issuesCreated: number; issuesUpdated: number; issuesSkipped: number }> {
    startGroup('🚥 Init and sync...');

    // Track metrics
    let issuesCreated = 0;
    let issuesUpdated = 0;
    let issuesSkipped = 0;

    // check JIRA is connected and do checks (skip if Jira was provided pre-initialized)
    if (!this.#jiraWasProvided) {
      info('Check JIRA is available');
      await this.#jira.initAndCheck();
    }

    // get all the issues from GitHub that have been updated since a given date
    info('Grab recent issues being updated...');
    const recentIssuesSearch = await this.#github.getIssuesUpdatedAfter();

    const syncMode = this.#projectConfiguration.github.syncMode || 'full';

    // Sync releases (milestones → fix versions) for both modes
    // Milestones are available in both REST API (basic) and GraphQL (full)
    if (this.#projectConfiguration.dryRun) {
      info('🔍 [DRY RUN] Skipping releases sync');
    } else {
      info('Sync releases (milestones → fix versions)...');
      await this.syncReleases(recentIssuesSearch.issues as GraphQLSearchIssuesNode[]);
    }

    // Sprints only available in full mode (Projects v2 iterations)
    if (syncMode === 'full') {
      if (this.#projectConfiguration.dryRun) {
        info('🔍 [DRY RUN] Skipping sprints sync');
      } else {
        info('Sync sprint...');
        await this.syncSprints(recentIssuesSearch.issues as GraphQLSearchIssuesNode[]);
      }
    } else {
      info('ℹ️  Basic mode: Skipping sprints sync (Projects v2 iterations not available)');
    }

    endGroup();

    startGroup('🚀 Create or update issues in Jira...');

    const assigneeAllowlist = this.#projectConfiguration.github.assigneeAllowlist;

    // for each issue
    for (const issue of recentIssuesSearch.issues) {
      // Assignee filtering (works for both basic and full mode)
      if (assigneeAllowlist && assigneeAllowlist.length > 0) {
        const assignees = 'assignees' in issue
          ? issue.assignees.map(a => a.login)
          : []; // GraphQL doesn't have assignees field in our current query

        const hasTeamAssignee = assignees.some(a => assigneeAllowlist.includes(a));

        if (!hasTeamAssignee) {
          info(`⏭️  Skipping issue #${issue.number} - no team members assigned`);
          continue;
        }
      }

      // check if the issue exists in Jira

      // build the globalId from this issue
      // the globalId is the github issue number prefixed by the repository name all in upper-case
      const globalId = `${this.#projectConfiguration.jira.globalIdPrefix}-${issue.number}`;

      // Get the issue URL (different field names for REST vs GraphQL)
      const issueUrl = 'html_url' in issue ? issue.html_url : issue.url;

      // create the issue in Jira
      info(`🔥 Create or update issue ${issueUrl} in Jira...`);

      // get the labels of the issue (handle both REST and GraphQL formats)
      const labels = 'labels' in issue && Array.isArray(issue.labels)
        ? issue.labels.map((l) => (typeof l === 'string' ? l : l.name))
        : 'labels' in issue && 'nodes' in issue.labels
        ? issue.labels.nodes.map((n) => n.name)
        : [];

      // the remote link title is based from the name of the repository, taking first letters separated by a dash
      // then making it upper case and adding the issue number
      // for example: `PD #123` if the repository is `podman-desktop`
      const remoteLinkTitle = `${this.#projectConfiguration.github.repo
        .split('-')
        .map((w) => w.charAt(0).toUpperCase())
        .join('')} #${issue.number}`;

      // fixVersionId from the milestone
      let fixVersionId: string | undefined;
      if (issue.milestone) {
        const prefixWithProject = this.#projectConfiguration.github.milestonePrefixWithProject ?? false;
        const milestoneName = prefixWithProject
          ? `${this.#projectConfiguration.name} ${issue.milestone.title}`
          : issue.milestone.title;
        fixVersionId = this.#fixVersions.get(milestoneName);
      }

      let status: string | undefined;
      let resolution: string | undefined;
      let storyPoints: number | undefined;
      let priority: string | undefined;
      let sprintBoardId: number | undefined;

      // Get issue state and state_reason (available in both REST and GraphQL)
      const issueState = 'state' in issue ? issue.state : 'open';
      const stateReason = 'stateReason' in issue ? issue.stateReason :
                          'state_reason' in issue ? issue.state_reason : null;

      if (syncMode === 'full') {
        // Full mode: Extract Projects v2 fields (GraphQL)
        // ignore null projects that can be returned by the GrapQH query
        const projectData = 'projectItems' in issue
          ? issue.projectItems.projects
              .filter((p) => p !== null)
              .find((p) => p.project.title?.name === this.#projectConfiguration.github.projectsV2Board)
          : undefined;

        // Debug: log what we found
        if (isDebug()) {
          info(`  🔍 Looking for GitHub Projects v2 board: "${this.#projectConfiguration.github.projectsV2Board}"`);
          if ('projectItems' in issue) {
            info(`  🔍 Found projects: ${JSON.stringify(issue.projectItems.projects.map(p => p?.project?.title?.name))}`);
            info(`  🔍 ProjectData match: ${projectData ? 'YES' : 'NO'}`);
            if (projectData) {
              info(`  🔍 Full projectData: ${JSON.stringify(projectData.project, null, 2)}`);
            }
          }
        }

        const projectStatus = projectData?.project.status?.name;
        status = this.getJiraStatusFromGithubProject(projectStatus);
        storyPoints = projectData?.project.storyPoints?.value;
        const githubPriority = projectData?.project.priority?.name;
        priority = this.getJiraPriorityFromGithubProject(githubPriority);

        const sprintName = projectData?.project.sprint?.title;
        if (sprintName) {
          sprintBoardId = this.#sprints.get(sprintName);
        }

        // Map state_reason to resolution (works for both modes!)
        if (issueState === 'closed') {
          switch (stateReason) {
            case 'completed':
              resolution = 'Done';
              break;
            case 'not_planned':
              resolution = "Won't Do";
              break;
            case 'duplicate':
              resolution = 'Duplicate';
              break;
            default:
              // Fallback for null or unknown reasons
              resolution = 'Done';
          }
        } else {
          resolution = undefined; // Open issues are unresolved
        }
      } else {
        // Basic mode: Derive from issue state and state_reason (REST API)
        if (issueState === 'open') {
          status = undefined; // Leave in workflow's default status
          resolution = undefined; // Open issues are unresolved
        } else if (issueState === 'closed') {
          // Map state_reason to resolution
          switch (stateReason) {
            case 'completed':
              status = 'Closed';
              resolution = 'Done';
              break;
            case 'not_planned':
              status = 'Closed';
              resolution = "Won't Do";
              break;
            case 'duplicate':
              status = 'Closed';
              resolution = 'Duplicate';
              break;
            default:
              // Fallback for null or unknown reasons
              status = 'Closed';
              resolution = 'Done';
          }
        } else {
          status = undefined; // Fallback: leave in workflow's default status
        }

        // storyPoints, priority, sprintBoardId remain undefined in basic mode
      }

      const jiraProjectKey = this.#projectConfiguration.jira.projectKey;

      // Debug: log story points, status, and priority (only in full mode)
      if (isDebug() && syncMode === 'full') {
        info(`  📊 Story Points: ${storyPoints ?? 'undefined'}`);
        info(`  🎯 Priority: ${priority || 'undefined'}`);
      }

      // convert the body from Markdown to Jira (handle null body)
      const issueBody = issue.body || '';
      const body = jira2md.default.to_jira(issueBody);

      // data to create the issue in Jira
      const issueToCreate: CreateIssueParams = {
        title: issue.title,
        body,
        state: issueState,
        issuetype: this.getJiraIssueType(issue, labels),
        status,
        resolution, // NEW: Add resolution field
        fixVersionId,
        sprintBoardId,
        globalId,
        remoteLinkUrl: issueUrl,
        remoteLinkTitle,
        jiraProjectKey,
        priority,
        // Project-specific fields (not from cached Jira instance)
        titlePrefix: this.#projectConfiguration.titlePrefix,
        components: this.#projectConfiguration.jira.component,
      };

      if (storyPoints) {
        issueToCreate.storyPoints = storyPoints;
      }

      // create the issue in Jira
      try {
        const result = await this.#jira.createOrUpdateIssue(issueToCreate);
        if (result.created) {
          issuesCreated++;
        } else if (result.skipped) {
          issuesSkipped++;
        } else {
          issuesUpdated++;
        }
      } catch (err: unknown) {
        if (isDebug()) {
          console.error(err);
        }
        let isThrottled = false;
        // check if the error is a HttpException error
        if (err instanceof HttpException) {
          const httpException = err as HttpException;
          // check if the error is related to throttling
          if (
            httpException.status === 401 &&
            httpException.statusText === 'Unauthorized' &&
            httpException.code === 'ERR_BAD_REQUEST'
          ) {
            // pause for 30s and retry after
            warning('Jira unauthorized/throttling rate limit reached, pausing for 30s before retrying');
            isThrottled = true;
            await new Promise((resolve) => setTimeout(resolve, 30000));
            const retryResult = await this.#jira.createOrUpdateIssue(issueToCreate);
            if (retryResult.created) {
              issuesCreated++;
            } else if (retryResult.skipped) {
              issuesSkipped++;
            } else {
              issuesUpdated++;
            }
          }
        }
        if (!isThrottled) {
          error(`❌ Error creating issue in Jira ${String(err)}`);
        }
      }
    }
    endGroup();
    return {
      afterDate: recentIssuesSearch.afterDate,
      issuesCreated,
      issuesUpdated,
      issuesSkipped,
    };
  }

  async stop() {}

  /**
   * Gets the Jira issue type from the GitHub labels
   * @param labels the GitHub labels
   * @returns matching Jira issue type or the default one
   */
  /**
   * Get Jira issue type from GitHub issue
   * Priority: structured type field → label matching → default
   *
   * @param issue - GitHub issue (REST or GraphQL format)
   * @param labels - Array of label names (already extracted)
   * @returns Jira issue type name
   */
  getJiraIssueType(issue: any, labels: string[]): string {
    const issueTypeMapping = this.#projectConfiguration.issueTypeMapping;

    // Priority 1: Check structured type field (REST: type.name, GraphQL: issueType.name)
    const typeName = ('type' in issue && issue.type?.name) ||
                     ('issueType' in issue && issue.issueType?.name);

    if (typeName && issueTypeMapping) {
      // Try to match type.name through the same mapping config
      // e.g., type.name="Bug" matches fromGithubLabel="Bug" → toJira="Bug"
      const typeMatch = issueTypeMapping.find(
        mapping => mapping.fromGithubLabel.toLowerCase() === typeName.toLowerCase()
      );
      if (typeMatch) {
        return typeMatch.toJira;
      }
    }

    // Priority 2: Fall back to label matching (existing logic)
    if (issueTypeMapping) {
      for (const mapping of issueTypeMapping) {
        if (labels.includes(mapping.fromGithubLabel)) {
          return mapping.toJira;
        }
      }
    }

    // Priority 3: Default
    return this.#projectConfiguration.issueTypeDefault;
  }

  /**
   * @deprecated Use getJiraIssueType instead - kept for backward compatibility
   */
  getJiraIssueTypeFromGitHubLabels(labels: string[]): string {
    const issueTypeMapping = this.#projectConfiguration.issueTypeMapping;
    if (issueTypeMapping) {
      for (const mapping of issueTypeMapping) {
        if (labels.includes(mapping.fromGithubLabel)) {
          return mapping.toJira;
        }
      }
    }
    return this.#projectConfiguration.issueTypeDefault;
  }

  /**
   * Gets the Jira status from the GitHub project status
   * @param githubStatus the GitHub project status
   * @returns matching Jira status or the default one
   */
  getJiraStatusFromGithubProject(githubStatus?: string): string {
    // do we have a status mapping ?
    const statusTypeMapping = this.#projectConfiguration.statusTypeMapping;
    if (statusTypeMapping) {
      for (const mapping of statusTypeMapping) {
        if (githubStatus === mapping.fromGithub) {
          return mapping.toJira;
        }
      }
    }

    // not found, default
    return this.#projectConfiguration.statusTypeDefault ?? 'Backlog';
  }

  /**
   * Gets the Jira priority from the GitHub project priority
   * @param githubPriority the GitHub project priority value
   * @returns matching Jira priority or the default one
   */
  getJiraPriorityFromGithubProject(githubPriority?: string): string | undefined {
    // If no priority mapping configured, return undefined (don't set priority)
    if (!this.#projectConfiguration.priorityTypeMapping) {
      return undefined;
    }

    // Search for matching priority mapping
    for (const mapping of this.#projectConfiguration.priorityTypeMapping) {
      if (githubPriority === mapping.fromGithub) {
        return mapping.toJira;
      }
    }

    // Fall back to default if no mapping found
    return this.#projectConfiguration.priorityTypeDefault;
  }
}
