/**
 * Default response-language rule shared by every Agent runtime seam.
 *
 * Agents may still follow an explicit user request for another language, but
 * must not infer that preference from model/provider defaults or context data.
 */
export const AGENT_RESPONSE_LANGUAGE_POLICY =
  "Respond in English by default. Use another language only when the user explicitly requests it.";
