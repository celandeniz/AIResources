export * from './enums';
export * from './tool-intents';
export * from './agent';
export * from './dates';
export * from './resources';
export * from './consulting-resources';
export * from './business-resources';

import { RESOURCE_DEFS } from './resources';
import { CONSULTING_DEFS } from './consulting-resources';
import { BUSINESS_DEFS } from './business-resources';

export const ALL_RESOURCE_DEFS = [...RESOURCE_DEFS, ...CONSULTING_DEFS, ...BUSINESS_DEFS];
