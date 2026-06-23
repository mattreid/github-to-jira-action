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
  github: {
    owner: string;
    repo: string;
    project?: string; // DEPRECATED: Use projectsV2Board instead
    projectsV2Board?: string; // Optional: GitHub Projects v2 board name (only needed for full mode)
    afterDate: string;
    syncMode?: 'basic' | 'full'; // Optional: basic (REST API) or full (GraphQL), defaults to 'full'
    assigneeAllowlist?: string[]; // Optional: filter by assignees
  };
  useMapping: {
    issueType: string;
    statusType: string;
    priorityType?: string;
  };
  jira: {
    projectKey: string;
    component: string;
    globalIdPrefix: string;
    sprintBoard: string;
  };
  maxBatchSize: number;
}

export interface SyncYaml {
  teams?: TeamDefinition[]; // Optional: Define teams for assignee filtering

  githubProjects: SyncYamlGitHubProject[];

  statusTypeMappings: SyncYamStatusTypeMapping[];

  priorityTypeMappings: SyncYamPriorityTypeMapping[];

  issuesTypeMappings: SyncYamlIssuesTypeMapping[];

  syncProjects: SyncYamlSyncProject[];
}

export interface SyncStateYaml {
  syncProjects: {
    syncProjectName: string;
    afterDate: string;
  }[];
}
