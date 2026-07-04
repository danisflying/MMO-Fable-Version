export const TICK_RATE = 20;
export const TICK_MS = 1000 / TICK_RATE;
/** Snapshots go out every SNAPSHOT_EVERY ticks (20 Hz sim -> 10 Hz net). */
export const SNAPSHOT_EVERY = 2;

/** Interest management: entities within this radius of a player are streamed to them. */
export const AOI_RADIUS = 50;
export const GRID_CELL_SIZE = 25;

export const PLAYER_MOVE_SPEED = 6; // units/sec
export const NPC_MOVE_SPEED = 3.5;
export const PLAYER_MAX_HP = 100;

/** Jump physics — must be integrated identically by server and prediction. */
export const GRAVITY = 20; // units/sec^2
export const JUMP_SPEED = 7.5; // initial vertical velocity (apex ~1.4 units)

/** Collision body radii (XZ circles). */
export const PLAYER_RADIUS = 0.5;
export const NPC_RADIUS = 0.5;

/** Slack added to server range checks (attacks, interactions) to forgive latency. */
export const RANGE_SLACK = 0.75;

export const CHAT_LOCAL_RADIUS = 30;

/** Max distance to interact with a quest NPC (server allows RANGE_SLACK on top). */
export const INTERACT_RANGE = 3.5;

/** How far in the past remote entities are rendered (interpolation buffer). */
export const INTERP_DELAY_MS = 150;

export const SERVER_PORT = 8080;
