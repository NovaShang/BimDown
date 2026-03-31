// Public API for embedding editor components in other apps (e.g. web SaaS)
export { EditorProvider, useEditorState, useSelectionState, useEditorDispatch } from './state/EditorContext.tsx';
export { DataSourceProvider, useDataSource } from './utils/DataSourceContext.tsx';
export { createLocalDataSource } from './utils/dataSource.ts';
export type { DataSource } from './utils/dataSource.ts';
export { loadProject, loadGrids, loadLayer, loadProjectMetadata } from './utils/loader.ts';
export type { ProjectMetadata } from './types.ts';
export { default as EditorShell } from './components/EditorShell.tsx';
export type { EditorState, EditorAction } from './state/editorTypes.ts';
export { TooltipProvider } from './components/ui/tooltip.tsx';

// Export functions (lazy-loaded internally)
export { exportGltf } from './export/exportGltf.ts';
export { exportIfc } from './export/exportIfc.ts';
export { exportPdf } from './export/exportPdf.ts';
export { exportDxf } from './export/exportDxf.ts';
