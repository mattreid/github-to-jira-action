import { info } from '@actions/core';
import type { Moment } from 'moment';
import moment from 'moment';
import type {
  SyncStateYaml,
  SyncYamStatusTypeMappingDefinition,
  SyncYamPriorityTypeMappingDefinition,
  SyncYaml,
  SyncYamlGitHubProject,
  SyncYamlIssuesTypeMappingDefinition,
} from './sync-yaml-config-file.js';

export enum ProjectConfigurationFieldType {
  Number = 'number',
  SingleSelect = 'singleSelect',
  Iteration = 'iteration',
}

export interface ProjectConfigurationGitHubField {
  alias: string;
  fieldName: string;
  type: ProjectConfigurationFieldType;
}

export interface ProjectConfigurationGitHub {
  readToken: string;
  owner: string;
  repo: string;
  projectsV2Board?: string; // Optional: GitHub Projects v2 board name (only needed for full mode)
  startDate: Moment;
  syncMode?: 'basic' | 'full'; // Optional: defaults to 'full' for backward compatibility
  assigneeAllowlist?: string[]; // Optional: filter by assignees
  milestonePrefixWithProject?: boolean; // Optional: prefix milestone names with project name (default: true)

  projectFields: ProjectConfigurationGitHubField[];
}

export interface ProjectConfiguration {
  name: string;
  titlePrefix?: string; // Optional: prefix for Jira issue titles (empty string disables)
  github: ProjectConfigurationGitHub;

  jira: {
    host: string;
    email: string;
    projectKey: string;
    writeToken: string;
    component: string[]; // Always normalized to array internally
    globalIdPrefix: string;
    sprintBoard?: string; // Optional: only used in full mode for sprint sync
    useGitHubIssueField: boolean; // Whether to use GitHub Issue custom field for this project
  };
  issueTypeDefault: string;
  issueTypeMapping: SyncYamlIssuesTypeMappingDefinition[];
  statusTypeMapping?: SyncYamStatusTypeMappingDefinition[]; // Optional: only used in full mode
  statusTypeDefault?: string; // Optional: only used in full mode
  priorityTypeMapping?: SyncYamPriorityTypeMappingDefinition[]; // Optional: only used in full mode
  priorityTypeDefault?: string; // Optional: only used in full mode

  maxBatchNumberIssues: number;
  dryRun?: boolean; // NEW: Dry-run mode flag
  skipDuplicateDetection?: boolean;
}

export class Configuration {
  #githubReakToken: string;
  #jiraHost: string;
  #jiraEmail: string;
  #jiraWriteToken: string;
  #syncYaml: SyncYaml;
  #syncStateYaml: SyncStateYaml | undefined;
  #dryRun: boolean;

  #statusTypeMappings: Map<string, SyncYamStatusTypeMappingDefinition[]>;
  #priorityTypeMappings: Map<string, SyncYamPriorityTypeMappingDefinition[]>;
  #issueTypeMappings: Map<string, SyncYamlIssuesTypeMappingDefinition[]>;
  #githubProjects: Map<string, SyncYamlGitHubProject>;

  constructor(params: {
    githubReadToken: string;
    jiraHost: string;
    jiraEmail: string;
    jiraWriteToken: string;
    syncYaml: SyncYaml;
    syncStateYaml?: SyncStateYaml;
    dryRun?: boolean;
  }) {
    this.#githubReakToken = params.githubReadToken;
    this.#jiraHost = params.jiraHost;
    this.#jiraEmail = params.jiraEmail;
    this.#jiraWriteToken = params.jiraWriteToken;
    this.#syncYaml = params.syncYaml;
    this.#syncStateYaml = params.syncStateYaml;
    this.#dryRun = params.dryRun || false;
    this.#statusTypeMappings = new Map();
    this.#priorityTypeMappings = new Map();
    this.#issueTypeMappings = new Map();
    this.#githubProjects = new Map();
  }

  get githubReadToken(): string {
    return this.#githubReakToken;
  }

  /**
   * Expand team references in assigneeAllowlist to individual member lists
   */
  private expandAssigneeAllowlist(
    allowlist: string[] | undefined,
    projectName: string,
  ): string[] | undefined {
    if (!allowlist?.length) return allowlist;

    const teams = this.#syncYaml.teams || [];
    const expanded = new Set<string>();

    for (const item of allowlist) {
      if (item.startsWith('team:')) {
        const teamName = item.substring(5);
        const team = teams.find(t => t.name === teamName);

        if (!team) {
          const availableTeams = teams.map(t => t.name).join(', ');
          throw new Error(
            `Project "${projectName}": Team '${teamName}' not found. ` +
            (availableTeams ? `Available teams: ${availableTeams}` : 'No teams defined in configuration.')
          );
        }

        if (!team.members?.length) {
          throw new Error(`Team '${teamName}' has no members defined`);
        }

        // Add all team members
        team.members.forEach(member => expanded.add(member));
      } else {
        // Individual username
        expanded.add(item);
      }
    }

    return Array.from(expanded);
  }

  init(): void {
    // Validate team definitions
    const teams = this.#syncYaml.teams || [];
    for (const team of teams) {
      if (!team.name) {
        throw new Error('Team definition missing required field: name');
      }
      if (!team.members?.length) {
        throw new Error(`Team '${team.name}' has no members defined`);
      }
    }

    // build a a map from statusTypeMappings
    for (const mappingObj of this.#syncYaml.statusTypeMappings) {
      this.#statusTypeMappings.set(mappingObj.name, mappingObj.mapping);
    }

    // build a map from priorityTypeMappings
    for (const mappingObj of this.#syncYaml.priorityTypeMappings) {
      this.#priorityTypeMappings.set(mappingObj.name, mappingObj.mapping);
    }

    // build a map from issuesTypeMappings
    for (const mappingObj of this.#syncYaml.issuesTypeMappings) {
      this.#issueTypeMappings.set(mappingObj.name, mappingObj.mapping);
    }

    // build a map from githubProjects
    for (const project of this.#syncYaml.githubProjects) {
      this.#githubProjects.set(project.name, project);
    }

    // override afterDate from syncStateYaml
    if (this.#syncStateYaml) {
      for (const syncProject of this.#syncStateYaml.syncProjects) {
        const project = this.#syncYaml.syncProjects.find((project) => project.name === syncProject.syncProjectName);
        if (project) {
          info(
            `Overriding afterDate for project ${project.name} from ${project.github.afterDate} to ${syncProject.afterDate}`,
          );
          project.github.afterDate = syncProject.afterDate;
        }
      }
    }
  }

  protected getFieldTypeFromYaml(type: string): ProjectConfigurationFieldType {
    switch (type) {
      case 'number':
        return ProjectConfigurationFieldType.Number;
      case 'singleSelect':
        return ProjectConfigurationFieldType.SingleSelect;
      case 'iteration':
        return ProjectConfigurationFieldType.Iteration;
      default:
        throw new Error('Unknown field type');
    }
  }

  getProjectConfigurations(): ProjectConfiguration[] {
    // need one project configuration for each project in githubProjects field of the syncYaml
    const projectConfigurations = this.#syncYaml.syncProjects.map((project) => {
      // Support both old 'project' and new 'projectsV2Board' field names (backwards compatibility)
      const projectsV2BoardName = project.github.projectsV2Board || project.github.project;

      // grab agile project definition (only needed for full mode)
      const agileProject = projectsV2BoardName ? this.#githubProjects.get(projectsV2BoardName) : undefined;
      const projectFields: ProjectConfigurationGitHubField[] = [];

      if (agileProject) {
        if (agileProject.storyPoints) {
          projectFields.push({
            alias: 'storyPoints',
            fieldName: agileProject.storyPoints.fieldName,
            type: this.getFieldTypeFromYaml(agileProject.storyPoints.type),
          });
        }
        if (agileProject.status) {
          projectFields.push({
            alias: 'status',
            fieldName: agileProject.status.fieldName,
            type: this.getFieldTypeFromYaml(agileProject.status.type),
          });
        }
        if (agileProject.sprint) {
          projectFields.push({
            alias: 'sprint',
            fieldName: agileProject.sprint.fieldName,
            type: this.getFieldTypeFromYaml(agileProject.sprint.type),
          });
        }
        if (agileProject.priority) {
          projectFields.push({
            alias: 'priority',
            fieldName: agileProject.priority.fieldName,
            type: this.getFieldTypeFromYaml(agileProject.priority.type),
          });
        }
      }

      const github: ProjectConfigurationGitHub = {
        owner: project.github.owner,
        repo: project.github.repo,
        projectsV2Board: projectsV2BoardName,
        readToken: this.#githubReakToken,
        startDate: moment(project.github.afterDate),
        syncMode: project.github.syncMode || 'full', // Default to 'full' for backward compatibility
        assigneeAllowlist: this.expandAssigneeAllowlist(project.github.assigneeAllowlist, project.name),
        milestonePrefixWithProject: project.github.milestonePrefixWithProject ?? false, // Default to false (no prefix)
        projectFields,
      };

      // Normalize component to array (support both string and string[] in config)
      const componentList = Array.isArray(project.jira.component)
        ? project.jira.component
        : [project.jira.component];

      // Check if this Jira project has GitHub Issue field enabled
      const useGitHubIssueField = this.#syncYaml.jiraProjectsWithGitHubIssueField?.includes(project.jira.projectKey) || false;

      const jira = {
        host: this.#jiraHost,
        email: this.#jiraEmail,
        projectKey: project.jira.projectKey,
        writeToken: this.#jiraWriteToken,
        globalIdPrefix: project.jira.globalIdPrefix,
        sprintBoard: project.jira.sprintBoard,
        component: componentList,
        useGitHubIssueField,
      };

      const maxBatchNumberIssues = project.maxBatchSize;

      const issueTypeMapping = this.#issueTypeMappings.get(project.useMapping.issueType);
      const issueTypeDefault = this.#syncYaml.issuesTypeMappings.find(
        (mapping) => mapping.name === project.useMapping.issueType,
      )?.default;

      // Status mapping is optional for basic mode (status derived from issue state)
      // Required for full mode (maps Projects v2 board status)
      let statusTypeMapping: SyncYamStatusTypeMappingDefinition[] | undefined;
      let statusTypeDefault: string | undefined;
      if (project.useMapping.statusType) {
        statusTypeMapping = this.#statusTypeMappings.get(project.useMapping.statusType);
        statusTypeDefault = this.#syncYaml.statusTypeMappings.find(
          (mapping) => mapping.name === project.useMapping.statusType,
        )?.default;
      }

      // Priority mapping is optional (only used in full mode with Projects v2)
      let priorityTypeMapping: SyncYamPriorityTypeMappingDefinition[] | undefined;
      let priorityTypeDefault: string | undefined;
      if (project.useMapping.priorityType) {
        priorityTypeMapping = this.#priorityTypeMappings.get(project.useMapping.priorityType);
        priorityTypeDefault = this.#syncYaml.priorityTypeMappings.find(
          (mapping) => mapping.name === project.useMapping.priorityType,
        )?.default;
      }

      // Validate required mappings
      if (!issueTypeMapping) {
        throw new Error(`Issue type mapping not found for ${project.name}`);
      }

      if (!issueTypeDefault) {
        throw new Error(`Default issue type not found for ${project.name}`);
      }

      // For full mode, status mapping is required
      const syncMode = project.github.syncMode || 'full';
      if (syncMode === 'full') {
        if (!statusTypeMapping) {
          throw new Error(`Status type mapping not found for ${project.name} (required for full mode)`);
        }
        if (!statusTypeDefault) {
          throw new Error(`Default status type not found for ${project.name} (required for full mode)`);
        }
      }

      // Determine title prefix: explicit override, or extract from name before ' - '
      let titlePrefix: string | undefined;
      if (project.titlePrefix !== undefined) {
        // Explicit override (including empty string to disable)
        titlePrefix = project.titlePrefix;
      } else {
        // Auto-extract from name: "Team - repo" → "Team", "repo" → "repo"
        const parts = project.name.split(' - ');
        titlePrefix = parts[0];
      }

      const projectConfiguration: ProjectConfiguration = {
        name: project.name,
        titlePrefix,
        jira,
        github,
        maxBatchNumberIssues,
        issueTypeDefault,
        issueTypeMapping,
        statusTypeMapping,
        statusTypeDefault,
        priorityTypeMapping,
        priorityTypeDefault,
        dryRun: this.#dryRun,
        skipDuplicateDetection: project.skipDuplicateDetection || false,
      };

      return projectConfiguration;
    });

    return projectConfigurations;
  }
}
