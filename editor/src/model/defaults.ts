import { defaultAttrsForTable } from './tableRegistry.ts';

export function defaultAttrs(tableName: string, levelId: string): Record<string, string> {
  return defaultAttrsForTable(tableName, levelId);
}
