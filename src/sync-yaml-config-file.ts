export type SyncYamlGitHubProjectFieldType = 'number' | 'singleSelect' | 'iteration';

export interface TeamDefinition {
  name: string;
  members: string[];
}

export interface SyncYamlGitHubProject {
  name: string;

  storyPoints: {
    fieldName: string;
    type: SyncYamlGitHubProjectFieldType;
  };

  status: {
    fieldName: string;
    type: SyncYamlGitHubProjectFieldType;
  };

  sprint: {
    fieldName: string;
    type: SyncYamlGitHubProjectFieldType;
  };

  priority?: {
    fieldName: string;
    type: SyncYamlGitHubProjectFieldType;
  };
}

export interface SyncYamStatusTypeMappingDefinition {
  fromGithub: string;
  toJira: string;
}

export interface SyncYamStatusTypeMapping {
  name: string;
  default: string;
  mapping: SyncYamStatusTypeMappingDefinition[];
}

export interface SyncYamPriorityTypeMappingDefinition {
  fromGithub: string;
  toJira: string;
}

export interface SyncYamPriorityTypeMapping {
  name: string;
  default: string;
  mapping: SyncYamPriorityTypeMappingDefinition[];
}

export interface SyncYamlIssuesTypeMappingDefinition {
  fromGithubLabel: string;
  toJira: string;
}

export interface SyncYamlIssuesTypeMapping {
  name: string;
  default: string;
  mapping: SyncYamlIssuesTypeMappingDefinition[];
}

export interface SyncYamlSyncProject {
  name: string;
  titlePrefix?: string; // Optional: prefix for Jira issue titles (defaults to name before ' - ', empty string disables)
  github: {
    owner: string;
    repo: string;
    project?: string; // DEPRECATED: Use projectsV2Board instead
    projectsV2Board?: string; // Optional: GitHub Projects v2 board name (only needed for full mode)
    afterDate: string;
    syncMode?: 'basic' | 'full'; // Optional: basic (REST API) or full (GraphQL), defaults to 'full'
    assigneeAllowlist?: string[]; // Optional: filter by assignees
    milestonePrefixWithProject?: boolean; // Optional: prefix milestone names with project name (default: true)
  };
  useMapping: {
    issueType: string;
    statusType?: string; // Optional: only needed for full mode (basic mode derives status from issue state)
    priorityType?: string; // Optional: only needed for full mode
  };
  jira: {
    projectKey: string;
    component: string | string[]; // Single component or array of components
    globalIdPrefix: string;
    sprintBoard?: string; // Optional: only used in full mode for sprint sync
  };
  maxBatchSize: number;
  skipDuplicateDetection?: boolean;
}

export interface SyncYaml {
  teams?: TeamDefinition[]; // Optional: Define teams for assignee filtering

  githubProjects: SyncYamlGitHubProject[];

  statusTypeMappings: SyncYamStatusTypeMapping[];

  priorityTypeMappings: SyncYamPriorityTypeMapping[];

  issuesTypeMappings: SyncYamlIssuesTypeMapping[];

  syncProjects: SyncYamlSyncProject[];

  jiraProjectsWithGitHubIssueField?: string[]; // Optional: Jira project keys that have GitHub Issue field enabled
}

export interface SyncStateYaml {
  syncProjects: {
    syncProjectName: string;
    afterDate: string;
  }[];
}
