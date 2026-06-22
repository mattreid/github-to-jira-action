# Sync Modes Guide

This action supports two sync modes that can be mixed in the same configuration:

## Quick Comparison

| Feature | Basic Mode | Full Mode |
|---------|-----------|-----------|
| **API** | GitHub REST | GitHub GraphQL |
| **Token Required** | ❌ No (or basic for 5000/hr) | ✅ Yes (read:project) |
| **Use Case** | External public repos | Your repos with Projects v2 |
| **Issue Metadata** | ✅ Title, body, state, labels | ✅ All basic fields |
| **Projects v2 Fields** | ❌ Not available | ✅ Story points, status, sprints, priority |
| **Assignee Filtering** | ✅ Yes | ✅ Yes |
| **Rate Limit** | 60/hr (no token)<br>5000/hr (with token) | 5000/hr (token required) |
| **Best For** | Public repos you don't own | Your repos with Projects v2 boards |

---

## Basic Mode

### When to Use

- ✅ Syncing from **external public repositories** (kubernetes, prometheus, etc.)
- ✅ You **don't have admin access** to the source org
- ✅ You want **simple issue tracking** without Projects v2 complexity
- ✅ You want to **avoid token management** for Projects v2

### What You Get

**Issue Fields:**
- Title, description, state (open/closed)
- Labels (mapped to Jira issue types)
- Milestones (mapped to Jira fix versions)
- Assignees (for filtering)
- Created/updated/closed timestamps
- GitHub URL (as remote link)

**Jira Fields Set:**
- Status: Derived from issue state
  - `open` → To Do
  - `closed` with `state_reason: completed` → Closed (Resolution: Done)
  - `closed` with `state_reason: not_planned` → Closed (Resolution: Won't Do)
  - `closed` with `state_reason: duplicate` → Closed (Resolution: Duplicate)
- Issue Type: Mapped from labels
- Fix Version: From milestone
- Component: From your config

**Not Available:**
- ❌ Story Points (Projects v2 only)
- ❌ Board Status (Projects v2 only)
- ❌ Sprints/Iterations (Projects v2 only)
- ❌ Priority custom field (Projects v2 only)

### Example Configuration

```yaml
syncProjects:
  - name: "Kubernetes Issues"
    github:
      owner: kubernetes
      repo: kubernetes
      afterDate: "2026-06-01T00:00:00Z"
      syncMode: basic  # ← Basic mode

      # Only sync issues assigned to your team
      assigneeWhitelist:
        - alice
        - bob

    jira:
      projectKey: K8S
      component: External
      globalIdPrefix: K8S
      sprintBoard: ""  # Not used in basic mode
```

---

## Full Mode

### When to Use

- ✅ Syncing from **your own repositories**
- ✅ You use **GitHub Projects v2 boards** for planning
- ✅ You need **story points, sprint tracking, and custom fields**
- ✅ You have a GitHub token with `read:project` scope

### What You Get

**Everything from Basic Mode, PLUS:**
- Story Points (from Projects v2 custom field)
- Board Status (from Projects v2 status field)
- Sprints/Iterations (from Projects v2)
- Priority (from Projects v2 custom field)
- Milestone and Sprint sync to Jira

### Example Configuration

```yaml
# First, define your Projects v2 board fields
githubProjects:
  - name: Sprint Board  # Must match your board name exactly
    storyPoints:
      fieldName: Story Points
      type: number
    status:
      fieldName: Status
      type: singleSelect
    sprint:
      fieldName: Iteration
      type: iteration
    priority:
      fieldName: Priority
      type: singleSelect

syncProjects:
  - name: "Internal Product"
    github:
      owner: yourcompany
      repo: product
      afterDate: "2026-06-01T00:00:00Z"
      syncMode: full  # ← Full mode
      projectsV2Board: Sprint Board  # Must match definition above

    jira:
      projectKey: PROD
      component: Backend
      globalIdPrefix: PROD
      sprintBoard: Product Board  # Jira board for sprint sync
```

---

## Mixed Configuration

**You can use both modes in the same sync.yaml!**

This is perfect for teams that:
- Track work in **multiple external repos** (basic mode)
- AND have **internal repos** with Projects v2 boards (full mode)

### Example: One Config, Multiple Modes

```yaml
syncProjects:
  # External repos - basic mode
  - name: "Kubernetes"
    github:
      syncMode: basic
      owner: kubernetes
      repo: kubernetes
      assigneeWhitelist: [alice]

  - name: "Prometheus"
    github:
      syncMode: basic
      owner: prometheus
      repo: prometheus
      assigneeWhitelist: [bob]

  # Your repos - full mode
  - name: "Internal Backend"
    github:
      syncMode: full
      owner: yourcompany
      repo: backend-api
      projectsV2Board: Sprint Board

  - name: "Internal Frontend"
    github:
      syncMode: full
      owner: yourcompany
      repo: frontend-app
      projectsV2Board: Sprint Board
```

**Result:**
- 2 external repos synced with **basic tracking** (no permissions needed)
- 2 internal repos synced with **full Projects v2 metadata**
- All in **one workflow run**!

---

## Filtering (Both Modes)

### Assignee Whitelist

Filter issues to only sync those assigned to your team members:

```yaml
github:
  assigneeWhitelist:
    - alice
    - bob
    - charlie
```

**Benefits:**
- ✅ **Server-side filtering** - Only fetches matching issues (50x more efficient)
- ✅ **Works in both modes**
- ✅ Perfect for public repos with community contributions

**Example:**
- `kubernetes/kubernetes` has 5000 open issues
- Only 10 are assigned to your team
- Without filter: Fetches 5000, processes 10
- With filter: Fetches 10, processes 10 (500x faster!)

---

## Incremental Sync (Automatic)

Both modes automatically use incremental sync:

**How it works:**
1. First run: Syncs all issues since `afterDate`
2. Saves last sync timestamp to `sync-state.yaml`
3. Next run: Only fetches issues updated since last sync

**Efficiency:**
- Initial sync: 100 issues
- Daily syncs: 2-5 issues (only what changed)
- **10-20x reduction** in API usage over time

---

## Dry-Run Mode (Both Modes)

Test your configuration safely:

```bash
DRY_RUN=true node test-basic-sync.js
```

**What it does:**
- ✅ Connects to Jira (validates config)
- ✅ Fetches issues from GitHub
- ✅ Shows what would be synced
- ❌ Does NOT create/update Jira issues

Perfect for:
- Testing new repo configurations
- Verifying filtering works
- Previewing what will sync

---

## Migration Path

### Start Basic, Upgrade to Full Later

You can start with basic mode and upgrade to full mode when ready:

**Week 1: Basic mode**
```yaml
github:
  syncMode: basic  # Get data flowing immediately
```

**Week 4: Upgrade to full mode**
```yaml
github:
  syncMode: full  # Add Projects v2 metadata
  projectsV2Board: Sprint Board
```

Existing Jira issues will be **enriched** with Projects v2 data on next sync!

---

## Rate Limits

### Basic Mode
- **No token**: 60 requests/hour (1-2 small repos)
- **With token** (public_repo scope): 5000 requests/hour (50+ repos)

### Full Mode
- **Token required** (read:project scope): 5000 requests/hour

### Incremental Sync Impact
- Without incremental: 20 requests/hour (fetch all repos every hour)
- With incremental: 1-2 requests/hour (only when issues update)
- **10-20x reduction!**

---

## Choosing a Mode

### Choose Basic Mode If:
- ✅ Syncing external public repos
- ✅ Don't have org admin access
- ✅ Basic issue tracking is sufficient
- ✅ Want to avoid token management

### Choose Full Mode If:
- ✅ Your own repos
- ✅ You use Projects v2 boards
- ✅ Need story points and sprint tracking
- ✅ Have read:project token

### Use Both If:
- ✅ Track work across multiple orgs
- ✅ Some repos need full metadata, others just basic tracking
- ✅ Want breadth (many repos) + depth (rich data where needed)

---

## See Also

- [example-config-blended.yaml](./example-config-blended.yaml) - Complete working example
- [QUICK-TEST.md](./QUICK-TEST.md) - 1-minute test guide
- [DRY-RUN-GUIDE.md](./DRY-RUN-GUIDE.md) - Dry-run testing guide
- [TESTING.md](./TESTING.md) - Comprehensive testing documentation
