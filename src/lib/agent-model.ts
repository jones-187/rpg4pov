/** The only model authorized for real agent execution in this project. */
export const REQUIRED_AGENT_MODEL = "deepseek-v4.1-flash";

/**
 * Fail closed when configuration asks for another model.  An omitted setting
 * resolves to the required model; a conflicting setting never falls back.
 */
export function resolveAgentModel(): string {
  const configured = process.env.ANTHROPIC_MODEL?.trim();
  if (configured && configured !== REQUIRED_AGENT_MODEL) {
    throw new Error(
      `agent model policy requires ${REQUIRED_AGENT_MODEL}; received ${configured}`,
    );
  }
  return REQUIRED_AGENT_MODEL;
}
