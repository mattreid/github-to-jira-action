import { endGroup, startGroup, error as coreError } from '@actions/core';
import { writeFile } from 'node:fs/promises';
import * as jsYaml from 'js-yaml';
import type { Configuration } from './config.js';
import type { ProjectConfiguration } from './config.js';
import { SyncRepository } from './sync-repo.js';
import type { SyncStateYaml } from './sync-yaml-config-file.js';

export interface SyncProjectResult {
  // name of the project in sync.yaml
  syncProjectName: string;

  // date to use for the next sync
  afterDate: string;
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

    // Loop sequentially through each project configuration
    // Continue on errors to maximize partial progress
    for (const projectConfiguration of projectConfigurations) {
      startGroup(
        `Sync project ${projectConfiguration.name} from ${projectConfiguration.github.owner}/${projectConfiguration.github.repo}`,
      );

      try {
        const syncRepository = new SyncRepository(projectConfiguration);
        const projectResult = await syncRepository.start();
        results.push({ syncProjectName: projectConfiguration.name, afterDate: projectResult.afterDate });

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

      // Fail the action to make failures obvious (user preference)
      throw new Error(`Sync completed with ${errors.length} failure(s). See annotations above for details.`);
    }

    console.log(`\n✅ Successfully synced ${results.length}/${projectConfigurations.length} repos`);
    return results;
  }

  async stop() {}

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
