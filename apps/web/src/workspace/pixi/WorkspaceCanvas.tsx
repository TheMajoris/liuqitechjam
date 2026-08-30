import { Component, type ErrorInfo, type ReactNode } from "react";
import { Application } from "@pixi/react";
import "./pixi-elements";
import { WorkspaceScene, type WorkspaceSceneProps } from "./WorkspaceScene";
import { SCENE } from "./scene-theme";

/** A renderer failure must cost the workspace its picture, never the app. */
class CanvasBoundary extends Component<
  { onFailure: (reason: unknown) => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onFailure(error);
    console.error("Workspace canvas failed", error, info);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

interface WorkspaceCanvasProps extends WorkspaceSceneProps {
  onFailure: (reason: unknown) => void;
}

/**
 * The single Pixi Application in the product.
 *
 * It is created once for the mounted stage; the scene resizes the renderer
 * from the size React measured, so React re-renders never rebuild the
 * renderer, its textures, or its ticker.
 */
export default function WorkspaceCanvas({ onFailure, ...scene }: WorkspaceCanvasProps) {
  return (
    <CanvasBoundary onFailure={onFailure}>
      <Application
        className="ws-canvas"
        width={scene.transform.width}
        height={scene.transform.height}
        background={SCENE.backdrop}
        antialias={false}
        roundPixels
        autoDensity
        resolution={typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio, 2)}
        preference="webgl"
      >
        <WorkspaceScene {...scene} />
      </Application>
    </CanvasBoundary>
  );
}
