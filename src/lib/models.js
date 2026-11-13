// Single source of truth lives in the studio workspace package.
// See packages/studio/src/models.js. This file exists only so the
// Preserve the existing Vite build's imports of "../lib/models".
// keep resolving without touching every consumer.
export * from "studio/src/models.js";
