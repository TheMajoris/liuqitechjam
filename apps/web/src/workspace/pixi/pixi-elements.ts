import { Container, Graphics, Sprite } from "pixi.js";
import { extend } from "@pixi/react";

/**
 * The scene uses three display objects and no more. Registering them once at
 * module scope keeps every component's JSX valid without each one re-running
 * `extend`, and keeps the Pixi surface area small on purpose.
 */
extend({ Container, Graphics, Sprite });

export const PIXI_ELEMENTS_READY = true;
