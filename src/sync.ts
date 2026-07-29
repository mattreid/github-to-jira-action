import { endGroup, startGroup, error as coreError, notice as coreNotice, warning as coreWarning } from '@actions/core';
import { writeFile } from 'node:fs/promises';
import * as jsYaml from 'js-yaml';
import type { Configuration } from './config.js';
import type { ProjectConfiguration } from './config.js';
import { Jira } from './jira.js';
import { SyncRepository } from './sync-repo.js';
import type { SyncStateYaml } from './sync-yaml-config-file.js';

export interface SyncProjectResult {
  // name of the project in sync.yaml
  syncProjectName: string;

  // date to use for the next sync
  afterDate: string;

  // metrics for this sync
  issuesCreated?: number;
  issuesUpdated?: number;
  issuesSkipped?: number;  // deduplication prevented
}
export class Sync {
  #configuration: Configuration;

  constructor(configuration: Configuration) {
    this.#configuration = configuration;
  }

  async start(): Promise<SyncProjectResult[]> {
    // grab project configurations
    const projectConfigurations = this.#configuration.getProjectConfigurations();

    const results: SyncProjectResult[] = [];
    const errors: Array<{ projectName: string; error: Error }> = [];
    let skippedRepos = 0;

    // Cache Jira clients per project to avoid redundant initialization
    // Multiple repos can share the same Jira project (e.g., 67 repos in DPROD)
    const jiraCache = new Map<string, Jira>();

    // Loop sequentially through each project configuration
    // Continue on errors to maximize partial progress
    for (const projectConfiguration of projectConfigurations) {
      startGroup(
        `Sync project ${projectConfiguration.name} from ${projectConfiguration.github.owner}/${projectConfiguration.github.repo}`,
      );

      try {
        // Check if repo has activity since last sync (optimization for nightly runs)
        const hasActivity = await this.checkRepoActivity(projectConfiguration);
        if (!hasActivity) {
          console.log(`⏭️  Skipping ${projectConfiguration.name} - no activity since ${projectConfiguration.github.startDate.toISOString()}`);
          skippedRepos++;

          // Save state even for skipped repos to preserve their afterDate
          results.push({
            syncProjectName: projectConfiguration.name,
            afterDate: projectConfiguration.github.startDate.toISOString(),
            issuesCreated: 0,
            issuesUpdated: 0,
            issuesSkipped: 0,
          });
          await this.saveIncrementalState(results);

          endGroup();
          continue;
        }

        // Get or create cached Jira client for this project
        const projectKey = projectConfiguration.jira.projectKey;
        let jira = jiraCache.get(projectKey);

        if (!jira) {
          // First repo for this Jira project - initialize once
          jira = new Jira(projectConfiguration);
          await jira.initAndCheck();
          jiraCache.set(projectKey, jira);
        } else {
          await jira.prepareForProject(projectConfiguration);
        }

        const syncRepository = new SyncRepository(projectConfiguration, jira);
        const projectResult = await syncRepository.start();
        results.push({
          syncProjectName: projectConfiguration.name,
          afterDate: projectResult.afterDate,
          issuesCreated: projectResult.issuesCreated,
          issuesUpdated: projectResult.issuesUpdated,
          issuesSkipped: projectResult.issuesSkipped,
        });

        // Save state immediately after successful sync
        // This ensures partial progress is preserved even if later repos fail
        await this.saveIncrementalState(results);
      } catch (error) {
        // Log error but continue to next repo
        const errorMsg = this.formatError(error, projectConfiguration);
        console.error(`❌ Failed to sync ${projectConfiguration.name}: ${errorMsg}`);
        errors.push({ projectName: projectConfiguration.name, error: error as Error });
      }

      endGroup();
    }

    // Report summary
    if (errors.length > 0) {
      console.error(`\n⚠️  ${errors.length} repo(s) failed to sync:`);
      errors.forEach(e => console.error(`   - ${e.projectName}: ${e.error.message}`));

      // Create GitHub annotations for each failure (visible in UI)
      errors.forEach(e => {
        coreError(`${e.projectName}: ${e.error.message}`);
      });

      // Show warning instead of failing to ensure state gets saved
      coreWarning(`Sync completed with ${errors.length} failure(s). ${results.length} repos succeeded. See error annotations above for details.`);
    }

    console.log(`\n✅ Successfully synced ${results.length}/${projectConfigurations.length} repos`);

    // Calculate totals and create summary annotation
    const totalCreated = results.reduce((sum, r) => sum + (r.issuesCreated || 0), 0);
    const totalUpdated = results.reduce((sum, r) => sum + (r.issuesUpdated || 0), 0);
    const totalSkipped = results.reduce((sum, r) => sum + (r.issuesSkipped || 0), 0);

    const summary = [
      `📊 Sync Summary:`,
      `  • Repos synced: ${results.length}`,
      `  • Repos skipped (no activity): ${skippedRepos}`,
      `  • Issues created: ${totalCreated}`,
      `  • Issues updated: ${totalUpdated}`,
      `  • Issues skipped (already synced): ${totalSkipped}`,
    ].join('\n');

    console.log(`\n${summary}`);

    // Create annotation for GitHub Actions UI
    if (results.length > 0 || skippedRepos > 0) {
      coreNotice(summary);
    }

    return results;
  }

  async stop() {}

  /**
   * Check if repo has any issue activity since the last sync date
   * Queries the issues API for the most recently updated issue
   *
   * @returns true if repo should be synced, false to skip
   */
  private async checkRepoActivity(projectConfiguration: ProjectConfiguration): Promise<boolean> {
    const { owner, repo, startDate, readToken } = projectConfiguration.github;

    try {
      const headers: HeadersInit = {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      };

      if (readToken) {
        headers['Authorization'] = `token ${readToken}`;
      }

      // Check for most recently updated issue (1 API call)
      const params = new URLSearchParams({
        state: 'all',
        per_page: '1',
        sort: 'updated',
        direction: 'desc',
      });

      const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues?${params}`, { headers });

      if (!response.ok) {
        // If we can't check activity, assume repo should be synced (fail open)
        console.warn(`⚠️  Could not check activity for ${owner}/${repo}: ${response.status}. Proceeding with sync.`);
        return true;
      }

      const issues = await response.json() as Array<{ updated_at: string }>;

      // No issues at all = skip
      if (issues.length === 0) {
        return false;
      }

      const lastIssueUpdate = new Date(issues[0].updated_at);
      const syncDate = startDate.toDate();

      // If most recent issue was updated after our sync date, sync the repo
      return lastIssueUpdate >= syncDate;
    } catch (error) {
      // On error, fail open (sync the repo anyway)
      console.warn(`⚠️  Error checking activity for ${owner}/${repo}: ${error}. Proceeding with sync.`);
      return true;
    }
  }

  /**
   * Save incremental state after each successful repo sync
   * This ensures partial progress is preserved even if later repos fail
   */
  private async saveIncrementalState(results: SyncProjectResult[]): Promise<void> {
    const syncStateYamlToWrite: SyncStateYaml = {
      syncProjects: results,
    };
    const fileContent = jsYaml.dump(syncStateYamlToWrite, { noArrayIndent: true, quotingType: '"', lineWidth: -1 });
    await writeFile('sync-state.yaml', fileContent, 'utf8');
  }

  /**
   * Format error messages with helpful context for debugging
   */
  private formatError(error: unknown, projectConfiguration: ProjectConfiguration): string {
    if (error instanceof Error) {
      // Check for specific GitHub API errors
      if (error.message.includes('401')) {
        const token = projectConfiguration.github.readToken ? 'provided' : 'none';
        return `401 Unauthorized (token: ${token}) - check token permissions for ${projectConfiguration.github.owner}/${projectConfiguration.github.repo}`;
      }
      if (error.message.includes('403')) {
        return `403 Forbidden - likely rate limited or insufficient permissions`;
      }
      if (error.message.includes('404')) {
        return `404 Not Found - repo may be private or deleted: ${projectConfiguration.github.owner}/${projectConfiguration.github.repo}`;
      }
      return error.message;
    }
    return String(error);
  }
}
