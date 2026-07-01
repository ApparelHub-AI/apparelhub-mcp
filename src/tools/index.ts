import type { ToolDef } from './registry.js';
import { readTools } from './read.js';

// The complete tool surface, assembled from each group. Tickets add their group here:
//   #14 catalogTools, #15 designTools, #16 productTools, #17 systemsTools, #18 safetyTools.
export function allTools(): ToolDef[] {
  return [...readTools];
}
