import type { ToolDef } from './registry.js';
import { readTools } from './read.js';
import { catalogTools } from './catalog.js';
import { designTools } from './design.js';

// The complete tool surface, assembled from each group. Tickets add their group here:
//   #16 productTools, #17 systemsTools, #18 safetyTools.
export function allTools(): ToolDef[] {
  return [...readTools, ...catalogTools, ...designTools];
}
