import type { ToolDef } from './registry.js';
import { readTools } from './read.js';
import { catalogTools } from './catalog.js';
import { designTools } from './design.js';
import { productTools } from './product.js';
import { systemsTools } from './systems.js';
import { safetyTools } from './safety.js';
import { orderTools } from './orders.js';
import { analyticsTools } from './analytics.js';
import { collectionTools } from './collections.js';
import { transferTools } from './transfer.js';
import { managementTools } from './management.js';
import { apiTools } from './apirequest.js';

// The complete tool surface, assembled from each group.
export function allTools(): ToolDef[] {
  return [
    ...readTools,
    ...catalogTools,
    ...designTools,
    ...productTools,
    ...systemsTools,
    ...safetyTools,
    // Capability-gap tools (epic #47): order management, analytics, collections,
    // cross-workspace transfer, tier-2 management, and the api_request escape hatch.
    ...orderTools,
    ...analyticsTools,
    ...collectionTools,
    ...transferTools,
    ...managementTools,
    ...apiTools,
  ];
}
