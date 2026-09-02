import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Both the extension and the plugin consume @c2d/shared straight from source. */
export const sharedAlias = {
  '@c2d/shared': path.resolve(here, '../shared/src/index.ts'),
};
