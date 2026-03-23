import { createContext, useContext, type ReactNode } from 'react';
import type { DataSource } from './dataSource.ts';

const DataSourceContext = createContext<DataSource | null>(null);

export function DataSourceProvider({ ds, children }: { ds: DataSource; children: ReactNode }) {
  return <DataSourceContext.Provider value={ds}>{children}</DataSourceContext.Provider>;
}

export function useDataSource(): DataSource {
  const ds = useContext(DataSourceContext);
  if (!ds) throw new Error('useDataSource must be used within DataSourceProvider');
  return ds;
}
