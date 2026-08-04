/**
 * The exporter, as a library.
 *
 * It lives outside the editor because an export has to be buildable somewhere other than a browser
 * tab: the Sprint 24 smoke harness builds real exports in Node to test them, and the export worker
 * the API will eventually run is the same job again on a server. Everything here is a pure function
 * from a scene and a manifest to a list of files — no DOM, no JSZip, no `fetch`. The parts that
 * genuinely need a browser (zipping, downloading, fetching assets out of the library) stay in
 * `apps/editor/src/export`.
 */
export {
  buildExport,
  collectUsedAssets,
  slugify,
  formatBytes,
  DEFAULT_EXPORT_OPTIONS,
  SIZE_WARN_BYTES,
  SIZE_DANGER_BYTES,
} from './bundle.js';
export type { ExportOptions, ExportFile, ExportPlan, BuildExportInput } from './bundle.js';
export { mainJs } from './mainJs.js';
export type { ExportMode, CodeStyle, MainJsInput } from './mainJs.js';
