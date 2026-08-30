/**
 * Cheap capability probe, kept out of the Pixi bundle so the stage can decide
 * whether to load the renderer at all.
 *
 * The probe releases its context immediately: browsers cap how many live WebGL
 * contexts a page may hold, and a probe that keeps one would eventually cost
 * the renderer the context it actually needs.
 */
export function canvasSupported(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const probe = document.createElement("canvas");
    const context =
      probe.getContext("webgl2") ?? probe.getContext("webgl");
    if (!context) return false;
    context.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}
