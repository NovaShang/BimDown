// Public API for embedding editor components in other apps (e.g. web SaaS)
export { EditorProvider, useEditorState, useEditorDispatch } from './state/EditorContext.tsx';
export { DataSourceProvider, useDataSource } from './utils/DataSourceContext.tsx';
export { createApiDataSource, createLocalDataSource } from './utils/dataSource.ts';
export type { DataSource } from './utils/dataSource.ts';
export { loadProject, loadGrids, loadLayer } from './utils/loader.ts';
export { default as EditorShell } from './components/EditorShell.tsx';
export type { EditorState, EditorAction } from './state/editorTypes.ts';
export { TooltipProvider } from './components/ui/tooltip.tsx';
