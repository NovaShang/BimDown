import type { CanonicalElement } from '../../model/elements.ts';
import type { Level, SystemDef } from '../../types.ts';
import type { GeometryContext } from '../../elements/archetypes.ts';

interface BuildGeometryContextOpts {
  level: Level;
  allLevels: Level[];
  allElements: Map<string, CanonicalElement>;
  /** Project-level MEP system definitions; default [] when project has none. */
  mepSystems?: SystemDef[];
}

/**
 * Build a fresh GeometryContext for one render pass. Memo cache lives only
 * for the duration of this context — adapters create a new one whenever the
 * element map or level changes.
 */
export function buildGeometryContext(opts: BuildGeometryContextOpts): GeometryContext {
  const { level, allLevels, allElements, mepSystems = [] } = opts;

  const levelElevations = new Map<string, number>();
  for (const l of allLevels) levelElevations.set(l.id, l.elevation);

  const memoStore = new Map<string, unknown>();

  const byTableCache = new Map<string, CanonicalElement[]>();
  function elementsByTable(tableName: string, selfId?: string): CanonicalElement[] {
    let arr = byTableCache.get(tableName);
    if (!arr) {
      arr = [];
      for (const el of allElements.values()) {
        if (el.tableName === tableName) arr.push(el);
      }
      byTableCache.set(tableName, arr);
    }
    return selfId ? arr.filter(e => e.id !== selfId) : arr;
  }

  const hostedCache = new Map<string, CanonicalElement[]>();
  function hostedOf(hostId: string): CanonicalElement[] {
    let arr = hostedCache.get(hostId);
    if (arr) return arr;
    arr = [];
    const colonIdx = hostId.indexOf(':');
    const unprefixed = colonIdx >= 0 ? hostId.substring(colonIdx + 1) : hostId;
    for (const el of allElements.values()) {
      const explicit = el.attrs.host_id || el.hostId;
      if (explicit === hostId || explicit === unprefixed) arr.push(el);
    }
    hostedCache.set(hostId, arr);
    return arr;
  }

  return {
    level,
    levelElevation: level.elevation,
    levelElevations,
    allElements,
    elementById: id => allElements.get(id),
    elementsByTable,
    hostedOf,
    memo<T>(key: string, factory: () => T): T {
      if (memoStore.has(key)) return memoStore.get(key) as T;
      const v = factory();
      memoStore.set(key, v);
      return v;
    },
    projectSystems: () => mepSystems,
  };
}
