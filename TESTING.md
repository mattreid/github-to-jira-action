# Local Testing Guide for Basic Sync Mode

## Prerequisites

Before testing locally, you need:

1. **Jira Credentials**:
   - `JIRA_HOST` - Your Jira Cloud instance (e.g., `yourcompany.atlassian.net`)
   - `JIRA_EMAIL` - Your Jira account email
   - `JIRA_API_TOKEN` - Your Jira API token (generate at https://id.atlassian.com/manage-profile/security/api-tokens)
   - `PROJECT_KEY` - The Jira project key to test with (e.g., `TEST`)

2. **GitHub Token** (optional for basic mode):
   - No token needed for public repos (60 req/hr)
   - Classic PAT with `public_repo` scope for 5000 req/hr (no `read:project` needed!)

## Setup Environment Variables

Create a `.env` file in the project root:

```bash
# Required for all modes
JIRA_HOST=yourcompany.atlassian.net
JIRA_EMAIL=your.email@company.com
JIRA_API_TOKEN=your_jira_api_token_here
PROJECT_KEY=TEST

# Optional for basic mode (increases rate limit from 60/hr to 5000/hr)
GITHUB_READ_TOKEN=ghp_yourGitHubTokenHere
```

**DO NOT COMMIT THIS FILE!** It's already in `.gitignore`.

## Test Configuration

The `sync.yaml` file at the project root is configured for testing:

```yaml
# Test configuration for basic sync mode
# Testing with mattreid/test-sync-repo

githubProjects:
  - name: Test Project
    storyPoints:
      fieldName: Story Points
      type: number
    status:
      fieldName: Status
      type: singleSelect

statusTypeMappings:
  - name: Basic Status Mapping
    default: To Do
    mapping:
      - fromGithub: Open
        toJira: To Do
      - fromGithub: Closed
        toJira: Closed

issuesTypeMappings:
  - name: Basic Issue Mapping
    default: Task
    mapping:
      - fromGithubLabel: bug
        toJira: Bug
      - fromGithubLabel: story
        toJira: Story
      - fromGithubLabel: task
        toJira: Task
      - fromGithubLabel: epic
        toJira: Epic

syncProjects:
  - name: "Test Sync Repo - Basic Mode"
    github:
      owner: mattreid
      repo: test-sync-repo
      afterDate: "2026-06-16T00:00:00Z"
      syncMode: basic  # ← NEW: Use REST API, no Projects v2
      assigneeAllowlist:  # ← NEW: Only sync issues assigned to you
        - mattreid
    useMapping:
      issueType: Basic Issue Mapping
      statusType: Basic Status Mapping
    jira:
      projectKey: TEST  # ← UPDATE: Your Jira project key
      component: GitHub Sync
      globalIdPrefix: TEST-SYNC
      sprintBoard: ""
    maxBatchSize: 10
```

**Before running**: Update the `jira.projectKey` to match your test Jira project.

## Test Data

The test repo `mattreid/test-sync-repo` has these issues:

| # | Title | State | State Reason | Labels | Expected Jira Status | Expected Resolution |
|---|---|---|---|---|---|---|
| 1 | First issue | closed | completed | story | Closed | Done |
| 2 | Second issue | open | null | task | To Do | - |
| 3 | Third Issue | open | null | bug | To Do | - |
| 4 | Larger effort | open | reopened | epic | To Do | - |
| 5 | Phase 0: 🦔 | open | null | task | To Do | - |
| 6 | Phase 1: 🐇 | open | null | story | To Do | - |
| 7 | Phase 3: 🚀 | open | null | task | To Do | - |

## Running Tests

### 1. Test Jira Connectivity

First, verify your Jira credentials work:

```bash
node test-jira-api.js
```

Expected output:
```
0️⃣  Testing basic Jira connectivity...
   ✅ Connected as: Your Name (your.email@company.com)
```

### 2. Build the Project

```bash
npm run build
```

### 3. Run the Sync

**Option A**: Use GitHub Actions locally with `act`

```bash
# Install act if you don't have it
brew install act  # macOS
# or: curl https://raw.githubusercontent.com/nektos/act/master/install.sh | sudo bash

# Run the action
act -j sync \
  -s JIRA_HOST="${JIRA_HOST}" \
  -s JIRA_EMAIL="${JIRA_EMAIL}" \
  -s JIRA_API_TOKEN="${JIRA_API_TOKEN}" \
  -s GITHUB_READ_TOKEN="${GITHUB_READ_TOKEN}"
```

**Option B**: Create a simple test script

Create `test-sync.js`:

```javascript
#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import * as jsYaml from 'js-yaml';
import { Configuration } from './lib/index.mjs';
import { Sync } from './lib/index.mjs';

// Load env from .env file or process.env
const JIRA_HOST = process.env.JIRA_HOST || 'yourcompany.atlassian.net';
const JIRA_EMAIL = process.env.JIRA_EMAIL || 'your.email@company.com';
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || 'your_token';
const GITHUB_READ_TOKEN = process.env.GITHUB_READ_TOKEN || '';  // Optional for basic mode

async function main() {
  console.log('🧪 Testing Basic Sync Mode\n');
  
  // Read sync.yaml
  const content = await readFile('sync.yaml', 'utf8');
  const syncYaml = jsYaml.load(content);
  
  // Create configuration
  const config = new Configuration({
    githubReadToken: GITHUB_READ_TOKEN,
    jiraHost: JIRA_HOST,
    jiraEmail: JIRA_EMAIL,
    jiraWriteToken: JIRA_API_TOKEN,
    syncYaml,
  });
  config.init();
  
  // Run sync
  const sync = new Sync(config);
  const result = await sync.start();
  
  console.log('\n✅ Sync completed!');
  console.log('Result:', JSON.stringify(result, null, 2));
}

main().catch(console.error);
```

Then run:

```bash
node test-sync.js
```

## What to Verify

### Phase 1: REST API Fetching

Watch for these log messages:

```
Fetching issues assigned to mattreid...
Fetched 7 issues via REST API
```

**Verify**:
- [ ] REST API is being called (not GraphQL)
- [ ] Only issues matching assignee filter are fetched
- [ ] Pull requests are excluded
- [ ] Issues are sorted by `updated_at` ascending

### Phase 2: Field Extraction

For each issue, verify:

```
🔥 Create or update issue https://github.com/mattreid/test-sync-repo/issues/1 in Jira...
```

**Check**:
- [ ] Issue #1 (closed, completed) → Status: Closed, Resolution: Done
- [ ] Issue #2-7 (open) → Status: To Do, Resolution: undefined
- [ ] Labels map to issue types (bug → Bug, story → Story, etc.)

### Phase 3: Jira Creation

Check your Jira project for:

- [ ] Issues created with globalId format: `TEST-SYNC-1`, `TEST-SYNC-2`, etc.
- [ ] Summary matches GitHub title
- [ ] Description contains GitHub issue body
- [ ] Remote link points to GitHub issue URL
- [ ] Issue type matches label mapping
- [ ] Status is correct (To Do for open, Closed for closed)
- [ ] Resolution is set only for closed issues

### Phase 4: Incremental Sync

After first run, check `sync-state.yaml`:

```yaml
syncProjects:
  - name: "Test Sync Repo - Basic Mode"
    afterDate: "2026-06-16T18:30:47Z"  # Latest issue's updated_at
```

**Run sync again** (should fetch 0 new issues):

```bash
node test-sync.js
```

Expected output:
```
Fetched 0 issues via REST API
```

**Verify**:
- [ ] Second run fetches no issues (nothing updated)
- [ ] `sync-state.yaml` is updated
- [ ] No duplicate Jira issues created

### Phase 5: Update Detection

**Manually edit an issue** in GitHub (add a comment or edit title), then:

```bash
node test-sync.js
```

**Verify**:
- [ ] Only the updated issue is fetched
- [ ] Jira issue is updated (not duplicated)
- [ ] `sync-state.yaml` reflects new timestamp

## Troubleshooting

### Error: "GitHub API error: 401"

**Cause**: Invalid or expired GitHub token

**Fix**: 
- For basic mode, token is optional - remove `GITHUB_READ_TOKEN` from `.env`
- For rate limit boost, generate new classic PAT at https://github.com/settings/tokens

### Error: "Jira unauthorized/throttling rate limit"

**Cause**: Jira API token expired or invalid

**Fix**: Generate new token at https://id.atlassian.com/manage-profile/security/api-tokens

### Error: "Cannot find module './lib/index.mjs'"

**Cause**: Project not built

**Fix**: Run `npm run build`

### No issues fetched

**Possible causes**:
1. **Assignee filter** - Issues are not assigned to `mattreid`
   - **Fix**: Remove `assigneeAllowlist` or assign yourself in GitHub
2. **Date filter** - `afterDate` is too recent
   - **Fix**: Set `afterDate: "2020-01-01T00:00:00Z"` to catch all issues
3. **Pull requests** - All items are PRs, not issues
   - **Fix**: Check GitHub repo has actual issues (not just PRs)

### Jira issues created but missing fields

**Cause**: Field mapping or Jira project configuration

**Fix**:
1. Check Jira project has required issue types (Bug, Story, Task, Epic)
2. Check Jira project allows setting Status and Resolution
3. Add debug logging to see what fields are being set

## Next Steps After Successful Test

Once basic sync works:

1. **Test assignee filtering**:
   - Assign some issues to yourself
   - Assign others to a different user
   - Verify only your assigned issues sync

2. **Test state_reason mapping**:
   - Close an issue as "completed" → Verify Resolution: Done
   - Close an issue as "not planned" → Verify Resolution: Won't Do

3. **Test multi-repo**:
   - Add a second repo to `sync.yaml`
   - Verify both repos sync correctly

4. **Test with external org**:
   - Try syncing a public repo from `kubernetes`, `prometheus`, etc.
   - Verify no authentication errors

5. **Performance test**:
   - Monitor API usage with rate limit headers
   - Verify incremental sync reduces API calls

## Success Criteria

✅ **MVP is working if**:

- [ ] Issues fetched via REST API (not GraphQL)
- [ ] Only filtered issues are synced
- [ ] State_reason maps to Jira resolution correctly
- [ ] Incremental sync works (second run fetches 0 issues)
- [ ] No authentication required (or optional token works)
- [ ] Pull requests are excluded
- [ ] Jira issues created with correct fields

**Ready for PR if all above pass!**
