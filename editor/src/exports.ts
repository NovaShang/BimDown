// Public API for embedding editor components in other apps (e.g. web SaaS).
// Side-effect import: populates the element-module registry so consumers
// (e.g. the SaaS frontend) get a functional toolbar / renderer without
// having to import registerAll themselves.
import './families/sections/index.ts';
import './elements/registerAll.ts';

export { EditorProvider, useEditorState, useSelectionState, useEditorDispatch } from './state/EditorContext.tsx';
export { DataSourceProvider, useDataSource } from './utils/DataSourceContext.tsx';
export { createLocalDataSource } from './utils/dataSource.ts';
export type { DataSource } from './utils/dataSource.ts';
export { loadProject, loadGrids, loadLayer, loadProjectMetadata, loadMepSystems } from './utils/loader.ts';
export { useLiveProject } from './hooks/useLiveProject.ts';
export { parseLayer } from './model/parse.ts';
export { resolveHostedGeometry } from './geometry/hosted.ts';
export type { LineElement } from './model/elements.ts';
export type { ProjectMetadata, SystemDef } from './types.ts';
export { default as EditorShell } from './components/EditorShell.tsx';
export type { EditorState, EditorAction } from './state/editorTypes.ts';
export { TooltipProvider } from './components/ui/tooltip.tsx';

// Export functions (lazy-loaded internally)
export { exportGltf } from './export/exportGltf.ts';
export { exportIfc } from './export/exportIfc.ts';
export { exportPdf, suggestPlanScale } from './export/exportPdf.ts';
export type { PdfExportOptions } from './export/exportPdf.ts';
export { exportDxf } from './export/exportDxf.ts';
export type { DxfExportOptions } from './export/exportDxf.ts';
export type { DrawingDiscipline } from './export/drawing/types.ts';
export type { PaperSize } from './export/drawing/sheet.ts';
export { DRAWING_SCALES } from './export/drawing/sheet.ts';
export { registerPlanAnnotator } from './export/drawing/annotations.ts';
export type { PlanAnnotator, PlanAnnotationContext } from './export/drawing/annotations.ts';
