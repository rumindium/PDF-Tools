/**
 * The two things a handler checks about a document *before* it hands it to an engine.
 *
 * They are guards rather than handler code because both answer questions about the file itself — does it carry
 * macros, does it ask the renderer to fetch something — and both are worth having in one place when a second tool
 * needs them. They are exported through the worker-shared barrel like everything else here.
 */

export { findMacroCarrier, describeMacroCarrier, type MacroCarrier } from './macro-carriers';
export {
  findRemoteReferencesInHtml,
  findRemoteReferencesInCss,
  describeRemoteReferences,
  type RemoteReference,
} from './remote-references';
