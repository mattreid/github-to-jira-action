# GitHub to Jira Action 🚀

Welcome to **GitHub to Jira Action**! This GitHub Action automates the synchronization of issues, sprints, story points, and statuses between GitHub Projects and Jira Projects. It helps to streamline your project management by mapping relevant fields from GitHub to Jira, so you can easily manage your tasks and track progress.

## Key Features 🌟
- **Two sync modes**: Basic mode (simple issue tracking) and Full mode (Projects v2 integration)
- Synchronize **GitHub issues** with **Jira tasks**
- Automatically map **issue types** (Epics, Features, Bugs, etc.) from GitHub labels to Jira issue types
- **Basic Mode**: Sync issue state, labels, milestones - no GitHub token required for public repos!
- **Full Mode**: Map **sprint**, **story points**, **status**, and **priority** from GitHub Projects v2 to Jira
- **Assignee filtering**: Only sync issues assigned to your team members (server-side filtering for efficiency)
- **Incremental sync**: Automatically tracks last sync time, only fetches updated issues
- **Dry-run mode**: Test configuration without creating Jira issues
- Supports **batch synchronization** with custom batch size configurations
  
## Sync Modes

This action supports two sync modes that can be used together in the same configuration:

| Feature | Basic Mode | Full Mode |
|---------|-----------|-----------|
| **API** | GitHub REST | GitHub GraphQL |
| **GitHub Token Required** | ❌ No (optional for rate limits) | ✅ Yes (read:project) |
| **Use Case** | External public repos, simple tracking | Your repos with Projects v2 |
| **Issue Metadata** | ✅ Title, body, state, labels, milestones | ✅ All basic fields |
| **Projects v2 Fields** | ❌ Not available | ✅ Story points, status, sprints, priority |
| **State Mapping** | ✅ open/closed → Jira status/resolution | ✅ Projects v2 status field |
| **Assignee Filtering** | ✅ Yes (server-side) | ✅ Yes (server-side) |
| **Best For** | Public repos, external orgs | Your repos with Projects v2 boards |

### Basic Mode

Perfect for syncing from public repositories or when you don't need Projects v2 metadata.

**What You Get:**
- Issue title, description, state (open/closed)
- Labels mapped to Jira issue types
- Milestones mapped to Jira fix versions
- Smart state mapping: `closed` with `state_reason: completed` → Jira Resolution: Done
- GitHub URL as remote link

**No GitHub token required** for public repos (60 requests/hour). Add a basic token for 5000 requests/hour.

### Full Mode

For repositories with GitHub Projects v2 boards where you need rich project metadata.

**What You Get:**
- Everything from Basic Mode, PLUS:
- Story Points from Projects v2 custom field
- Board Status from Projects v2 status field
- Sprints/Iterations from Projects v2
- Priority from Projects v2 custom field

**Requires:** GitHub token with `read:project` scope

See [SYNC-MODES.md](./SYNC-MODES.md) for detailed comparison and [example-config-blended.yaml](./example-config-blended.yaml) for configuration examples.
  
## How It Works ⚙️
This GitHub Action reads configuration from a YAML file to map your GitHub issues and project data to corresponding fields in Jira. The tool enables seamless integration, updating Jira based on changes made in GitHub issues.

### Incremental Sync (Automatic)

The action automatically implements incremental sync:
- **First run**: Syncs all issues since configured `afterDate`
- **Subsequent runs**: Only fetches issues updated since last sync
- **State persistence**: Saves last sync timestamp to `sync-state.yaml`
- **Efficiency**: Reduces API usage by 10-20× after initial sync

No configuration needed - incremental sync is always enabled!

### What is Mapped?

**Basic Mode:**
- **Issue State**: GitHub `state` (open/closed) → Jira Status
- **State Reason**: GitHub `state_reason` (completed, not_planned, duplicate) → Jira Resolution
- **Labels**: GitHub labels → Jira issue types (Epic, Bug, Task, Story)
- **Milestones**: GitHub milestones → Jira fix versions
- **Metadata**: Created/updated/closed timestamps, GitHub URL

**Full Mode (all of Basic Mode PLUS):**
- **Story Points**: Extracted from Projects v2 custom field and synced to Jira
- **Status**: Mapped from Projects v2 board status to Jira issue status
- **Sprints**: Synced from Projects v2 iterations to Jira sprint board
- **Priority**: Mapped from Projects v2 priority field to Jira priority

## Configuration 📋

To use **GitHub to Jira Action**, configure the tool using a YAML file that defines the mappings and project synchronization details.

Here’s a breakdown of how to configure the YAML file:

Store it under the name sync.yaml at the root folder of the repository.

### Example YAML Configuration

#### Basic Mode (Simple Issue Tracking)

```yaml
issuesTypeMappings:
  - name: Basic Issue Mapping
    default: Task
    mapping:
      - fromGithubLabel: bug
        toJira: Bug
      - fromGithubLabel: story
        toJira: Story
      - fromGithubLabel: epic
        toJira: Epic

syncProjects:
  - name: "External Project"
    github:
      owner: external-org
      repo: public-repo
      syncMode: basic               # Basic mode - no Projects v2
      afterDate: "2026-01-01T00:00:00Z"
      # Optional: filter to team members only
      assigneeWhitelist:
        - alice
        - bob
    useMapping:
      issueType: Basic Issue Mapping
    jira:
      projectKey: EXT
      component: External
      globalIdPrefix: EXT
    maxBatchSize: 50
```

#### Full Mode (Projects v2 Integration)

```yaml
# Define GitHub Project to Jira Project Mapping
githubProjects:
  - name: My Project Planning
    storyPoints:
      fieldName: Story Points
      type: number
    status:
      fieldName: Status
      type: singleSelect
    sprint:
      fieldName: Sprint
      type: iteration
    priority:                    # Optional - omit if not syncing priority
      fieldName: Priority
      type: singleSelect

statusTypeMappings:
  - name: My Status Mapping
    default: Backlog
    mapping:
      - fromGithub: 📋 Backlog
        toJira: Backlog
      - fromGithub: 📅 Planned
        toJira: Backlog
      - fromGithub: 🚧 In Progress
        toJira: In Progress
      - fromGithub: 🚥 In Review
        toJira: Review
      - fromGithub: ⏳ On Hold
        toJira: Backlog
      - fromGithub: ✔️ Done
        toJira: Closed

priorityTypeMappings:           # Optional - omit if not syncing priority
  - name: My Priority Mapping
    default: Normal              # Default Jira priority when no mapping matches
    mapping:
      - fromGithub: 🔴 High     # Exact GitHub priority value
        toJira: Critical         # Jira priority name (depends on your Jira instance)
      - fromGithub: 🟡 Medium
        toJira: Major
      - fromGithub: 🟢 Low
        toJira: Minor

issuesTypeMappings:
  - name: My Issue Mapping
    default: Task
    mapping:
      - fromGithubLabel: kind/epic ⚡
        toJira: Epic
      - fromGithubLabel: kind/bug 🐞
        toJira: Bug
      - fromGithubLabel: kind/task ☑️
        toJira: Task

syncProjects:
  - name: "Podman Desktop"
    github:
      owner: my-organization-on-github
      repo: my-repository-name
      syncMode: full                        # Full mode - with Projects v2
      # The name of the GitHub Project v2 board
      projectsV2Board: My Project Planning  # New field name (backward compatible with 'project')
      # start sync from every issue updated after this date
      # after the first run, it'll be changed in the state
      # to a more recent date
      afterDate: 2024-04-25
      # Optional: filter to specific assignees
      assigneeWhitelist:
        - alice
        - bob
    useMapping:
     issueType: My Issue Mapping
     statusType: My Status Mapping
     priorityType: My Priority Mapping  # Optional - omit if not syncing priority
    jira:
      projectKey: MY-JIRA-PROJECT-KEY
      component: My Component
      sprintBoard: Jira board name
    # maximum number of issues to synchronize at each batch for this project
    maxBatchSize: 50
```

See [example-config-blended.yaml](./example-config-blended.yaml) for more examples including mixed basic/full configurations.


## Fields to Configure 📋

### GitHub Configuration

- **syncMode** (optional): `basic` or `full` (default: `full`)
  - `basic`: Simple issue tracking using REST API, no Projects v2 required
  - `full`: Include Projects v2 metadata (story points, status, sprints, priority)

- **projectsV2Board** (full mode only): Name of the GitHub Projects v2 board
  - Note: The old `project` field name still works for backward compatibility

- **assigneeWhitelist** (optional): Array of GitHub usernames
  - Only sync issues assigned to these users
  - Uses server-side filtering (very efficient for large repos)
  - Works in both basic and full modes

- **afterDate**: ISO 8601 timestamp - only sync issues updated after this date
  - After first run, automatically updated to last sync time (incremental sync)

### Projects v2 Field Definitions (Full Mode Only)

- **githubProjects**: Lists the GitHub Projects v2 boards to sync with Jira
  - **name**: Must match your Projects v2 board name exactly
  - **storyPoints**: The custom number field used for story points
  - **status**: The status field that corresponds to Jira statuses
  - **sprint**: The iteration field for sprint tracking
  - **priority** (optional): Maps GitHub priority values to Jira priority names

### Mappings

- **statusTypeMappings**: Defines how GitHub issue statuses are mapped to Jira statuses
  - **default**: Default Jira status if no mapping is found
  - **mapping**: Individual mappings for GitHub to Jira status
  - In basic mode, GitHub `state` (open/closed) is mapped automatically

- **priorityTypeMappings** (optional, full mode only): Maps GitHub project priority values to Jira priorities
  - **default**: Default Jira priority when no mapping matches
  - **mapping**: Individual mappings for GitHub to Jira priority
  - **Note**: Available Jira priorities depend on your instance configuration. Common values include:
    - Default scheme: Highest, High, Medium, Low, Lowest
    - Custom scheme example: Undefined, Blocker, Critical, Major, Normal, Minor
  - Check your Jira project settings → Issue types → Priority to see available values

- **issuesTypeMappings**: Maps GitHub issue labels to Jira issue types
  - **default**: The default Jira issue type for unmapped issues
  - **mapping**: Mappings between GitHub labels and Jira issue types
  - Works in both basic and full modes

### Sync Projects

- **syncProjects**: Defines synchronization details for each GitHub and Jira project
  - **github**: The GitHub repository and project to sync
  - **jira**: The Jira project key and other Jira-specific details
  - **maxBatchSize**: Limits the number of issues synced per batch

---

## How to Use 🚀

### Step 1: Create a GitHub Workflow

```yaml
on:
  push:
    branches:
      - main
  # every hour    
  schedule:
    - cron: '0 * * * *'
  workflow_dispatch:

name: Sync GitHub to Jira

jobs:
  sync:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - name: Restore state from previous run using GitHub variables (no secret inside)
        run: |
          if [ -z "${{ vars.SYNC_STATE }}" ]; then
            echo "no previous persisted state"
          else
            echo "restoring previous sync state"
            echo "${{ vars.SYNC_STATE }}" > sync-state.yaml
            cat sync-state.yaml
          fi

        # use development branch of the action (next is the build from the main branch)
      - name: Run GitHub to Jira Action
        uses: benoitf/github-to-jira-action@next
        with:
          jira-host: ${{ secrets.JIRA_HOST }}
          jira-email: ${{ secrets.JIRA_EMAIL }}
          jira-write-token: ${{ secrets.JIRA_WRITE_TOKEN }}
          github-read-token: ${{ secrets.GITHUB_TOKEN }}  # Optional for basic mode public repos
          # dry-run: 'true'  # Optional: test without creating Jira issues

        # save the state using a custom token as default GITHUB_TOKEN does not have the required permissions
        # to save variables
      - name: persist state
        env:
          GH_TOKEN: ${{ secrets.SET_VARIABLE_GITHUB_TOKEN }}
        run: |
          # use gh cli to save the content of a file into a variable
          gh variable set SYNC_STATE < sync-state.yaml
```

It is using GitHub variables to store the state between each run. GitHub Actions don't have permissions for that,
so write access needs to be granted to the step `persist state`.
In the example above, `GH_TOKEN: ${{ secrets.SET_VARIABLE_GITHUB_TOKEN }}` is granting that permission.

From GitHub UI it is then possible to view the current state of each repo sync (and optionally delete it).

---

### Step 2: Add the YAML Configuration

Copy the above workflow YAML to a workflow file in your repository (e.g., `.github/workflows/execute-sync.yaml`).

Place your `github-to-jira-action` YAML configuration file in `sync.yaml`.

### Step 3: Configure Secrets 🔐

You need to provide Jira credentials and GitHub tokens as secrets in your repository:

1. Go to **Settings > Secrets > Actions** in your GitHub repository.
2. Add the following secrets:
   - **JIRA_HOST**: The base URL of your Jira instance (e.g., `https://your-domain.atlassian.net` for Jira Cloud).
   - **JIRA_EMAIL**: The email address associated with your Jira account (required for Jira Cloud authentication).
   - **JIRA_WRITE_TOKEN**: Your Jira API token with write access. For Jira Cloud, generate this from [Atlassian Account Settings](https://id.atlassian.com/manage-profile/security/api-tokens).
   - **GITHUB_TOKEN**: For public repos in basic mode, this is optional (for rate limits). For full mode, requires `read:project` scope.

#### GitHub Token Requirements

**Basic Mode:**
- ❌ No token required for public repos (60 requests/hour)
- ✅ Optional: Any GitHub token for 5000 requests/hour rate limit (no special scopes needed)

**Full Mode:**
- ✅ Required: GitHub token with `read:project` scope to access Projects v2 data

### Jira Cloud Authentication

This action uses **Basic Authentication** for Jira Cloud, which requires:
- Your Jira account email address
- An API token (not your password)

To create a Jira Cloud API token:
1. Log in to https://id.atlassian.com/manage-profile/security/api-tokens
2. Click **Create API token**
3. Give it a label (e.g., "GitHub to Jira Sync")
4. Copy the token and add it as the `JIRA_WRITE_TOKEN` secret

**Note**: For Jira Data Center/Server, you would use a Personal Access Token instead, but this action is now configured for Jira Cloud's authentication method.

---

### Step 4: Ensure JIRA scheme/components are valid in JIRA project

 - Ensure `Story Points` field is available on every issue type.
 - Ensure the issues types are available in the JIRA project (by default it may only be a subset like only `Bug` and `Task`).
 - Ensure the statuses/transitions (`CLOSED`/`IN PROGRESS`/etc.) are available in the JIRA project.
 - Ensure that the component(s) referenced in the configuration YAML file exist in the JIRA project.

---

### Step 5: Run the Action

Once the workflow and configuration file are committed to the repository, the
action will automatically run based on your schedule.  It will also be triggered
when you merge updates (such as configuration changes) to the repository `main`
branch.  And, you can manually trigger it from the **Actions** tab in your
repository GitHub page.

---

## Advanced Options 🛠️

### Dry-Run Mode

Test your configuration without creating or updating Jira issues:

```bash
# Set DRY_RUN environment variable
DRY_RUN=true npm start

# Or in GitHub Actions workflow
with:
  dry-run: 'true'
```

The action will:
- ✅ Connect to Jira and validate configuration
- ✅ Fetch issues from GitHub
- ✅ Show what would be synced
- ❌ NOT create or update any Jira issues

See [DRY-RUN-GUIDE.md](./DRY-RUN-GUIDE.md) for details.

### Assignee Filtering

Only sync issues assigned to specific team members:

```yaml
github:
  assigneeWhitelist:
    - alice
    - bob
    - charlie
```

**Benefits:**
- Server-side filtering (only fetches matching issues)
- Works in both basic and full modes
- Perfect for large public repos (reduces API calls by 50×+)

### Other Options

- **Max Batch Size**: Control how many issues are synced in one batch. Set `maxBatchSize` to `0` to turn it off.
- **Status Mappings**: Customize how GitHub statuses (e.g., "📋 Backlog", "🚧 In Progress") are mapped to Jira statuses.
- **Date Filtering**: Use the `afterDate` field to only sync issues created after a specific date (automatically managed after first run).

---

## Troubleshooting ❓

- **Authentication Issues**: Ensure your Jira API token and GitHub tokens are correctly configured in GitHub secrets.
- **Sync Errors**: Check the logs in the **Actions** tab for detailed information on any errors during synchronization.
- **Always syncing the same issues**: Check the save/restore part of the state. Without state, it is always starting from the same date.
- **"Board with name not found"**: This error appears in basic mode because sprints/boards are only used in full mode. It's expected and can be ignored if using basic mode.
- **Story points showing as "None"**: In basic mode, story points are not available (Projects v2 only). Switch to full mode or accept that this field won't be set.
- **Missing Projects v2 data**: Ensure `syncMode: full` is set and GitHub token has `read:project` scope.

## State Mapping Reference

### Basic Mode State Mapping

GitHub's `state_reason` field maps to Jira Resolution:

| GitHub State | GitHub State Reason | Jira Status | Jira Resolution |
|---|---|---|---|
| `open` | - | To Do | Unresolved |
| `closed` | `completed` | Closed | Done |
| `closed` | `not_planned` | Closed | Won't Do |
| `closed` | `duplicate` | Closed | Duplicate |

### Full Mode

Uses Projects v2 board status field directly (configured in statusTypeMappings).

---

## Additional Documentation

- **[SYNC-MODES.md](./SYNC-MODES.md)**: Detailed comparison of basic vs full sync modes, when to use each, and migration paths
- **[example-config-blended.yaml](./example-config-blended.yaml)**: Complete working examples showing mixed basic/full configurations
- **[DRY-RUN-GUIDE.md](./DRY-RUN-GUIDE.md)**: Testing configurations safely without modifying Jira
- **[QUICK-TEST.md](./QUICK-TEST.md)**: 1-minute local testing guide
- **[TESTING.md](./TESTING.md)**: Comprehensive testing documentation

---

## Conclusion 🎉

With **GitHub to Jira Action**, you can seamlessly synchronize your project tasks, statuses, and more between GitHub and Jira. Choose basic mode for simple issue tracking or full mode for rich Projects v2 integration. Get started today to keep your workflow smooth and efficient!
