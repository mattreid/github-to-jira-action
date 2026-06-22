#!/usr/bin/env node

/**
 * Local test script for basic sync mode
 *
 * Usage:
 *   1. Set environment variables in .env or shell:
 *      - JIRA_HOST=yourcompany.atlassian.net
 *      - JIRA_EMAIL=your.email@company.com
 *      - JIRA_API_TOKEN=your_jira_token
 *      - GITHUB_READ_TOKEN=ghp_token (optional, for rate limit boost)
 *      - DRY_RUN=true (optional, for dry-run mode)
 *
 *   2. Update sync.yaml with your Jira project key
 *
 *   3. Run: node test-basic-sync.js
 */

async function main() {
  const isDryRun = process.env.DRY_RUN === 'true';

  console.log(`🧪 Testing Basic Sync Mode${isDryRun ? ' [DRY RUN]' : ''}\n`);
  console.log('Configuration:');
  console.log(`  DRY_RUN: ${isDryRun ? '✅ ENABLED' : '❌ DISABLED'}`);
  console.log(`  JIRA_HOST: ${process.env.JIRA_HOST || '❌ NOT SET'}`);
  console.log(`  JIRA_EMAIL: ${process.env.JIRA_EMAIL || '❌ NOT SET'}`);
  console.log(`  JIRA_API_TOKEN: ${process.env.JIRA_API_TOKEN ? '✅ SET' : '❌ NOT SET'}`);
  console.log(`  GITHUB_READ_TOKEN: ${process.env.GITHUB_READ_TOKEN ? '✅ SET (5000/hr)' : '⚠️  NOT SET (60/hr)'}\n`);

  // Validate required env vars
  const required = ['JIRA_HOST', 'JIRA_EMAIL', 'JIRA_API_TOKEN'];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    console.error(`\n❌ Missing required environment variables: ${missing.join(', ')}`);
    console.error('\nSet them in your shell or create a .env file:');
    console.error('  export JIRA_HOST=yourcompany.atlassian.net');
    console.error('  export JIRA_EMAIL=your.email@company.com');
    console.error('  export JIRA_API_TOKEN=your_jira_token\n');
    process.exit(1);
  }

  if (isDryRun) {
    console.log('🔍 DRY RUN MODE - Simulating sync without modifying Jira\n');
    console.log('This will:');
    console.log('  ✅ Connect to Jira and validate configuration');
    console.log('  ✅ Fetch issues from GitHub');
    console.log('  ✅ Show what would be synced to Jira');
    console.log('  ❌ NOT create/update any Jira issues');
    console.log('  ❌ NOT modify releases or sprints\n');
  }

  // Set INPUT_* environment variables that @actions/core reads
  process.env.INPUT_JIRA_HOST = process.env.INPUT_JIRA_HOST || process.env.JIRA_HOST;
  process.env['INPUT_JIRA-HOST'] = process.env.JIRA_HOST;
  process.env['INPUT_JIRA-EMAIL'] = process.env.JIRA_EMAIL;
  process.env['INPUT_JIRA-WRITE-TOKEN'] = process.env.JIRA_API_TOKEN;
  process.env['INPUT_GITHUB-READ-TOKEN'] = process.env.GITHUB_READ_TOKEN || '';
  process.env['INPUT_DRY-RUN'] = isDryRun ? 'true' : 'false';

  // Import Main after setting environment variables
  const { Main } = await import('./lib/index.mjs');

  try {
    const main = new Main();
    await main.start();

    console.log('\n✅ Sync completed successfully!');
    console.log('\nNext steps:');
    if (isDryRun) {
      console.log('  1. Review the output above to verify what would be synced');
      console.log('  2. If everything looks good, run without DRY_RUN to sync for real');
      console.log('  3. Run: node test-basic-sync.js');
    } else {
      console.log('  1. Check your Jira project for synced issues');
      console.log('  2. Check sync-state.yaml for saved state');
      console.log('  3. Run again to test incremental sync (should fetch 0 issues)');
    }

  } catch (error) {
    console.error('\n❌ Sync failed:', error.message);
    if (process.env.DEBUG === 'true') {
      console.error('\nFull error:', error);
    } else {
      console.error('\nRun with DEBUG=true for full error details');
    }
    process.exit(1);
  }
}

main();
