import type { PipelineTaskContext } from "../../contracts";
import type { JsonSourceContext } from "../gates";

/**
 * Narrow context shape for acceptance gate evaluation. Extends
 * {@link JsonSourceContext} with the optional task-context that holds the
 * expected acceptance criteria.
 */
export interface AcceptanceContext extends JsonSourceContext {
  taskContext?: PipelineTaskContext;
}
