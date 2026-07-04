import { clamp, lerpAngle } from "@mmo/shared";

function isTyping(): boolean {
  const el = document.activeElement;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
}

/** Keyboard turn rate, rad/sec (WoW-ish). */
const TURN_SPEED = 3.0;
/** Backpedaling is slower than running, like WoW. */
const BACKPEDAL_FACTOR = 0.55;
/** How quickly the camera drifts back behind the character while moving. */
const CAMERA_FOLLOW_RATE = 2.5;
const MOUSE_SENS = 0.006;

export interface MoveSample {
  moveX: number;
  moveZ: number;
  facing: number;
  jump: boolean;
}

/**
 * WoW-style controls:
 *  - W/S run forward / backpedal along the character's facing
 *  - A/D turn the character (strafe while right mouse button is held)
 *  - Q/E always strafe
 *  - left-drag orbits the camera without turning the character
 *  - right-drag steers the character (camera locked behind)
 *  - LMB+RMB together = run forward; wheel zooms
 */
export class Input {
  /** Character facing (world yaw, 0 = +Z). */
  facing = 0;
  /** Camera look-direction yaw; camera sits opposite this around the player. */
  camYaw = 0;
  pitch = 0.5;
  dist = 10;

  onClickAt: ((ndcX: number, ndcY: number) => void) | null = null;
  onTab: (() => void) | null = null;
  onAbility: ((slot: number) => void) | null = null;
  onEscape: (() => void) | null = null;
  onInteract: (() => void) | null = null;
  onQuestLog: (() => void) | null = null;

  private keys = new Set<string>();
  private buttons = new Set<number>();
  /** Latches a Space tap so short presses between ticks aren't lost. */
  private jumpLatch = false;
  private dragDist = 0;
  private lastX = 0;
  private lastY = 0;

  constructor(dom: HTMLElement) {
    window.addEventListener("keydown", (e) => {
      if (isTyping()) return;
      this.keys.add(e.code);
      if (e.code === "Tab") {
        e.preventDefault();
        this.onTab?.();
      } else if (e.code === "Escape") {
        this.onEscape?.();
      } else if (e.code.startsWith("Digit")) {
        const slot = Number(e.code.slice(5)) - 1;
        if (slot >= 0) this.onAbility?.(slot);
      } else if (e.code === "Space") {
        e.preventDefault();
        this.jumpLatch = true;
      } else if (e.code === "KeyF") {
        this.onInteract?.();
      } else if (e.code === "KeyL") {
        this.onQuestLog?.();
      }
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.buttons.clear();
    });

    dom.addEventListener("mousedown", (e) => {
      this.buttons.add(e.button);
      this.dragDist = 0;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    window.addEventListener("mousemove", (e) => {
      if (this.buttons.size === 0) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.dragDist += Math.abs(dx) + Math.abs(dy);
      if (this.buttons.has(2)) {
        // Right drag steers the character; camera stays glued behind.
        this.facing -= dx * MOUSE_SENS;
        this.camYaw = this.facing;
      } else {
        // Left drag orbits the camera only.
        this.camYaw -= dx * MOUSE_SENS;
      }
      this.pitch = clamp(this.pitch + dy * 0.004, 0.12, 1.25);
    });
    window.addEventListener("mouseup", (e) => {
      const wasLeftClick =
        e.button === 0 && this.buttons.has(0) && this.dragDist < 5 && e.target === dom;
      this.buttons.delete(e.button);
      if (wasLeftClick) {
        this.onClickAt?.(
          (e.clientX / window.innerWidth) * 2 - 1,
          -(e.clientY / window.innerHeight) * 2 + 1,
        );
      }
    });
    dom.addEventListener("wheel", (e) => {
      this.dist = clamp(this.dist + e.deltaY * 0.012, 3, 28);
    });
    dom.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  /** One fixed input step: returns the world-space move for this tick. */
  sample(): MoveSample {
    const rmb = this.buttons.has(2);

    let fwd = (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0);
    if (rmb && this.buttons.has(0)) fwd = Math.max(fwd, 1); // both buttons = run

    let strafe = (this.keys.has("KeyE") ? 1 : 0) - (this.keys.has("KeyQ") ? 1 : 0);
    if (rmb) {
      // A/D strafe while steering with the mouse (turning happens per-frame
      // in updateCamera otherwise).
      strafe += (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);
    }
    strafe = clamp(strafe, -1, 1);

    const sinF = Math.sin(this.facing);
    const cosF = Math.cos(this.facing);
    let x = sinF * fwd - cosF * strafe;
    let z = cosF * fwd + sinF * strafe;
    const len = Math.hypot(x, z);
    if (len > 1) {
      x /= len;
      z /= len;
    }
    if (fwd < 0) {
      x *= BACKPEDAL_FACTOR;
      z *= BACKPEDAL_FACTOR;
    }
    const jump = this.jumpLatch || this.keys.has("Space");
    this.jumpLatch = false;
    return { moveX: x, moveZ: z, facing: this.facing, jump };
  }

  /**
   * Per-frame turning and camera behavior. Keyboard turning lives here, not
   * in sample(): the camera reads camYaw every rendered frame, so applying
   * the turn at the 20 Hz input tick makes A/D pan the view in visible steps.
   */
  updateCamera(dtMs: number, moving: boolean): void {
    const dt = dtMs / 1000;
    if (!this.buttons.has(2)) {
      const turn =
        ((this.keys.has("KeyA") ? 1 : 0) - (this.keys.has("KeyD") ? 1 : 0)) * TURN_SPEED * dt;
      if (turn !== 0) {
        this.facing += turn;
        // Keyboard turning carries the camera too, unless the player is
        // free-looking with the left button held.
        if (!this.buttons.has(0)) this.camYaw += turn;
      }
    }
    if (moving && this.buttons.size === 0) {
      const t = Math.min(1, dt * CAMERA_FOLLOW_RATE);
      this.camYaw = lerpAngle(this.camYaw, this.facing, t);
    }
  }
}
