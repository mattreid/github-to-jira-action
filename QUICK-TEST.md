# Quick Test Instructions

## DRY RUN (Recommended First Step!)

Test without making any changes to Jira:

```bash
# 1. Set your credentials (use your actual values!)
export JIRA_HOST="yourcompany.atlassian.net"
export JIRA_EMAIL="your.email@company.com"
export JIRA_API_TOKEN="your_jira_api_token"

# 2. Update sync.yaml - replace PROJECT_KEY with your test Jira project
# Line 64: projectKey: YOUR_PROJECT_KEY_HERE

# 3. Run DRY RUN (simulates sync without modifying Jira)
DRY_RUN=true node test-basic-sync.js
```

**What Dry Run Does:**
- ✅ Connects to Jira to validate config
- ✅ Fetches issues from GitHub
- ✅ Shows exactly what would be synced
- ❌ Does NOT create/update any Jira issues

## Full Sync (After Dry Run Looks Good)

```bash
# Same setup as dry run, but without DRY_RUN flag
node test-basic-sync.js
```

## What to Expect

### First Run (Initial Sync)
```
🧪 Testing Basic Sync Mode

Configuration:
  JIRA_HOST: yourcompany.atlassian.net ✅
  JIRA_EMAIL: your.email@company.com ✅
  JIRA_API_TOKEN: ✅ SET
  GITHUB_READ_TOKEN: ⚠️  NOT SET (60/hr)

🚥 Init and sync...
ℹ️  Check JIRA is available
ℹ️  Grab recent issues being updated...
ℹ️  Fetched 7 issues via REST API  ← ✅ Using REST API (basic mode)
ℹ️  Sync releases...
ℹ️  Sync sprint...

🚀 Create or update issues in Jira...
🔥 Create or update issue https://github.com/mattreid/test-sync-repo/issues/1 in Jira...
🔥 Create or update issue https://github.com/mattreid/test-sync-repo/issues/2 in Jira...
... (7 total issues)

✅ Sync completed successfully!
```

**Check in Jira**:
- Go to your test project
- Look for issues with keys like `TEST-SYNC-1`, `TEST-SYNC-2`, etc.
- Verify titles match GitHub issues
- Verify closed issues have Resolution: Done

### Second Run (Incremental Sync)
```
🧪 Testing Basic Sync Mode

ℹ️  Fetched 0 issues via REST API  ← ✅ Incremental sync working!

✅ Sync completed successfully!
```

**Success!** Incremental sync is working - it only fetched issues updated since last run.

## Key Features to Verify

| Feature | How to Check | Expected Result |
|---|---|---|
| **Basic Mode** | Log message | "Fetched N issues via REST API" (not GraphQL) |
| **No Auth Required** | Omit GITHUB_READ_TOKEN | Sync works (60/hr limit) |
| **State Mapping** | Check Jira issue | Closed issues have Resolution: Done |
| **Issue Types** | Check Jira issue | Labels map: bug→Bug, story→Story, task→Task |
| **Incremental Sync** | Run twice | Second run fetches 0 issues |
| **State Saving** | Check file | `sync-state.yaml` created with afterDate |

## Troubleshooting

**"Missing required environment variables"**
→ Set JIRA_HOST, JIRA_EMAIL, JIRA_API_TOKEN

**"Fetched 0 issues"**
→ Check `afterDate` in sync.yaml is not too recent (set to "2020-01-01T00:00:00Z")

**"JIRA unauthorized"**
→ Generate new Jira API token at https://id.atlassian.com/manage-profile/security/api-tokens

**"Cannot find module './lib/index.mjs'"**
→ Run `npm run build` first

## Next: Test Filtering

After basic test works, try assignee filtering:

```yaml
# In sync.yaml, add:
syncProjects:
  - github:
      assigneeAllowlist:
        - your-github-username  # Only sync your assigned issues
```

Then in GitHub:
1. Assign issue #2 to yourself
2. Leave issue #3 unassigned
3. Run sync again

**Expected**: Only issue #2 syncs to Jira (issue #3 skipped)

## Test Complete! 🎉

If you see:
- ✅ "Fetched N issues via REST API"
- ✅ Issues created in Jira
- ✅ Second run fetches 0 issues
- ✅ State saved to sync-state.yaml

**Your MVP is working!** Ready to create a PR.
