import { Main } from './main.js';

// Export for programmatic use (testing, etc.)
export { Main } from './main.js';
export { Configuration } from './config.js';
export { Sync } from './sync.js';

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  await new Main().start();
}
