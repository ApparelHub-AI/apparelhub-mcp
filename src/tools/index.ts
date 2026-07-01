import type { ToolDef } from './registry.js';
import { readTools } from './read.js';
import { catalogTools } from './catalog.js';

// The complete tool surface, assembled from each group. Tickets add their group here:
//   #15 designTools, #16 productTools, #17 systemsTools, #18 safetyTools.
export function allTools(): ToolDef[] {
  return [...readTools, ...catalogTools];
}
