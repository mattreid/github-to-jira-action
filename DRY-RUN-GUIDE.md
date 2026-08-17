# Dry Run Mode Guide

## What is Dry Run Mode?

Dry run mode lets you **test the sync configuration without making any changes to Jira**. It:

- ✅ **Validates** your Jira connection and configuration
- ✅ **Fetches** issues from GitHub (uses your rate limit)
- ✅ **Shows** exactly what would be created/updated in Jira
- ❌ **Does NOT** create or update any Jira issues
- ❌ **Does NOT** modify releases or sprints

Perfect for:
- Testing new configurations before going live
- Verifying filtering logic works correctly
- Previewing what will sync from a new repo
- Debugging sync issues without touching Jira

---

## How to Use Dry Run Mode

### Option 1: Environment Variable (Local Testing)

```bash
# Set dry run mode
export DRY_RUN=true

# Run the test script
node test-basic-sync.js
```

### Option 2: Inline (Quick Test)

```bash
DRY_RUN=true node test-basic-sync.js
```

### Option 3: GitHub Actions Workflow

```yaml
name: Test Sync (Dry Run)
on: workflow_dispatch

jobs:
  test-sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: your-username/github-to-jira-action@v1
        with:
          github-read-token: ${{ secrets.GITHUB_TOKEN }}
          jira-host: ${{ secrets.JIRA_HOST }}
          jira-email: ${{ secrets.JIRA_EMAIL }}
          jira-write-token: ${{ secrets.JIRA_API_TOKEN }}
          dry-run: 'true'  # ← Enable dry run
```

---

## Example Output

### Dry Run Output

```
🧪 Testing Basic Sync Mode [DRY RUN]

Configuration:
  DRY_RUN: ✅ ENABLED
  JIRA_HOST: yourcompany.atlassian.net
  JIRA_EMAIL: your.email@company.com
  JIRA_API_TOKEN: ✅ SET
  GITHUB_READ_TOKEN: ✅ SET (5000/hr)

🔍 DRY RUN MODE - Simulating sync without modifying Jira

This will:
  ✅ Connect to Jira and validate configuration
  ✅ Fetch issues from GitHub
  ✅ Show what would be synced to Jira
  ❌ NOT create/update any Jira issues
  ❌ NOT modify releases or sprints

🚥 Init and sync...
ℹ️  Check JIRA is available
🔍 [DRY RUN] Jira connection successful - will simulate issue creation
ℹ️  Grab recent issues being updated...
ℹ️  Fetched 7 issues via REST API
🔍 [DRY RUN] Skipping releases and sprints sync

🚀 Create or update issues in Jira...
🔥 Create or update issue https://github.com/mattreid/test-sync-repo/issues/1 in Jira...

🔍 [DRY RUN] Would create/update Jira issue:
   Title: First issue
   Type: Story
   Status: Closed
   Resolution: Done
   Priority: None
   Story Points: None
   Fix Version: None
   Sprint: None
   GitHub URL: https://github.com/mattreid/test-sync-repo/issues/1
   Global ID: TEST-SYNC-1

🔥 Create or update issue https://github.com/mattreid/test-sync-repo/issues/2 in Jira...

🔍 [DRY RUN] Would create/update Jira issue:
   Title: Second issue
   Type: Task
   Status: To Do
   Resolution: None
   Priority: None
   Story Points: None
   Fix Version: None
   Sprint: None
   GitHub URL: https://github.com/mattreid/test-sync-repo/issues/2
   Global ID: TEST-SYNC-2

... (5 more issues)

✅ Sync completed successfully!
```

### What to Check

**In the output above, verify**:

1. **Jira Connection** ✅
   - "Jira connection successful" message appears
   - No connection errors

2. **GitHub Fetching** ✅
   - "Fetched N issues via REST API" (basic mode)
   - Correct number of issues fetched
   - Issues match your filtering criteria

3. **Field Mapping** ✅
   - Issue types match labels (bug → Bug, story → Story)
   - Status correct (open → To Do, closed → Closed)
   - Resolution set for closed issues
   - Story Points, Priority, Sprint show when configured

4. **Filtering** ✅
   - Only expected issues are listed
   - Issues not matching filter are skipped

---

## Common Dry Run Scenarios

### 1. Test New Repo Configuration

**Use case**: Adding a new external repo to sync.yaml

```yaml
# Add to sync.yaml
syncProjects:
  - name: "Kubernetes - Test"
    github:
      owner: kubernetes
      repo: kubernetes
      afterDate: "2026-06-01T00:00:00Z"
      syncMode: basic
      assigneeAllowlist:
        - your-github-username
    jira:
      projectKey: K8S
      globalIdPrefix: K8S
      component: External
```

Run dry run:
```bash
DRY_RUN=true node test-basic-sync.js
```

**Expect to see**:
- Issues assigned to you from kubernetes/kubernetes
- Correct issue type mapping
- No errors about missing Jira fields

---

### 2. Test Assignee Filtering

**Use case**: Verify only team issues are synced

```yaml
assigneeAllowlist:
  - alice
  - bob
  - charlie
```

**In GitHub**:
1. Assign issue #1 to alice ✅ (should sync)
2. Leave issue #2 unassigned ❌ (should skip)
3. Assign issue #3 to external-user ❌ (should skip)

Run dry run and check output:
```
🔥 Create or update issue .../issues/1 in Jira...  ← alice's issue
⏭️  Skipping issue #2 - no team members assigned
⏭️  Skipping issue #3 - no team members assigned
```

---

### 3. Test State Mapping

**Use case**: Verify state_reason maps correctly to Jira resolution

**In GitHub**, create issues with different states:
- Issue #1: Closed as "completed" → Resolution: Done
- Issue #2: Closed as "not planned" → Resolution: Won't Do
- Issue #3: Open → No resolution

Run dry run and verify output:
```
[Issue #1]
   Status: Closed
   Resolution: Done  ← ✅ Correct

[Issue #2]
   Status: Closed
   Resolution: Won't Do  ← ✅ Correct

[Issue #3]
   Status: To Do
   Resolution: None  ← ✅ Correct
```

---

### 4. Test Label Mapping

**Use case**: Verify GitHub labels map to Jira issue types

```yaml
issuesTypeMappings:
  - name: Basic Issue Mapping
    default: Task
    mapping:
      - fromGithubLabel: bug
        toJira: Bug
      - fromGithubLabel: story
        toJira: Story
```

**In GitHub**:
- Issue #1: Label "bug" → Type: Bug
- Issue #2: Label "story" → Type: Story
- Issue #3: No labels → Type: Task (default)

Verify in dry run output:
```
[Issue #1] Type: Bug  ← ✅ Mapped from label
[Issue #2] Type: Story  ← ✅ Mapped from label
[Issue #3] Type: Task  ← ✅ Default
```

---

## Troubleshooting Dry Run

### "Jira connection error"

**Cause**: Invalid Jira credentials or host

**Fix**:
```bash
# Verify credentials
export JIRA_HOST="yourcompany.atlassian.net"  # NO https://
export JIRA_EMAIL="your.email@company.com"
export JIRA_API_TOKEN="your_valid_token"
```

Generate new token: https://id.atlassian.com/manage-profile/security/api-tokens

---

### "Fetched 0 issues via REST API"

**Possible causes**:

1. **Date filter too recent**
   ```yaml
   afterDate: "2026-06-22T00:00:00Z"  # ← Issues older than this are ignored
   ```
   **Fix**: Set to earlier date: `"2020-01-01T00:00:00Z"`

2. **Assignee filter excludes all issues**
   ```yaml
   assigneeAllowlist:
     - alice  # ← But no issues are assigned to alice
   ```
   **Fix**: Remove filter or assign yourself in GitHub

3. **No issues updated since last sync**
   - Check `sync-state.yaml` for `afterDate`
   - Delete `sync-state.yaml` to re-sync all issues

---

### "Story Points field cannot be found"

**Cause**: Jira project doesn't have "Story Points" field

**Fix**: 
- **Option 1**: Add Story Points custom field to Jira project
- **Option 2**: Basic mode doesn't use Story Points (syncMode: basic)

---

### Dry run shows issues but they don't match filter

**Example**: Assignee filter set but all issues shown

**Cause**: Filter not configured correctly

**Check**:
```yaml
syncProjects:
  - github:
      assigneeAllowlist:  # ← Must be indented under github
        - alice
```

**Not**:
```yaml
syncProjects:
  - assigneeAllowlist:  # ❌ Wrong level
      - alice
    github:
      owner: org
```

---

## When to Use Dry Run vs Real Sync

### Use Dry Run When:

- ✅ Adding a new repo to sync.yaml
- ✅ Testing new filters (assignee, labels)
- ✅ Changing field mappings
- ✅ Verifying Jira configuration
- ✅ Testing after code changes
- ✅ Demonstrating to stakeholders
- ✅ Training new team members

### Use Real Sync When:

- ✅ Configuration verified in dry run
- ✅ Ready to create Jira issues
- ✅ Running production sync
- ✅ Incremental sync (daily/hourly)

---

## Dry Run Checklist

Before running real sync, verify in dry run:

- [ ] Jira connection successful
- [ ] Issues fetched from GitHub (correct count)
- [ ] Correct sync mode (basic or full)
- [ ] Filtering works (assignees, labels)
- [ ] Issue types map correctly
- [ ] Status/Resolution correct
- [ ] No errors in output
- [ ] sync-state.yaml will be created/updated

**If all checkboxes pass** → Safe to run real sync!

---

## Advanced: Dry Run in CI/CD

Use dry run in CI to validate config changes:

```yaml
name: Validate Sync Config

on:
  pull_request:
    paths:
      - 'sync.yaml'
      - 'src/**'

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Dry Run Sync
        uses: your-username/github-to-jira-action@v1
        with:
          github-read-token: ${{ secrets.GITHUB_TOKEN }}
          jira-host: ${{ secrets.JIRA_HOST }}
          jira-email: ${{ secrets.JIRA_EMAIL }}
          jira-write-token: ${{ secrets.JIRA_API_TOKEN }}
          dry-run: 'true'
      
      - name: Check for Errors
        run: |
          if grep -q "ERROR" sync.log; then
            echo "Sync validation failed"
            exit 1
          fi
```

**Benefits**:
- Catch config errors before merge
- Validate Jira connectivity
- Preview changes for reviewers

---

## Summary

**Dry run mode is your safety net** - use it liberally!

```bash
# Quick dry run
DRY_RUN=true node test-basic-sync.js

# Looks good? Run for real
node test-basic-sync.js
```

**Remember**: Dry run still uses GitHub API rate limits (fetches real issues), but never touches Jira.
