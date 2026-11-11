/** Worker → server, every 30 seconds while the worker's event loop is free. */
export const ALIVE = "alive"
/** Server → worker, whenever a row was set to waiting: check now, not at the next minute. */
export const NEW_WORK = "new work"
/** Server → worker, on shutdown. */
export const STOP = "stop"
