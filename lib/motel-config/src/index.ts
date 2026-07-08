import type { MotelConfig } from "./types";
import { motelLeRefuge } from "./motels/le-refuge";

export type { MotelConfig, Room, RoomPricing, Attraction } from "./types";
export { motelLeRefuge } from "./motels/le-refuge";

/**
 * Returns the active motel's configuration.
 *
 * Single-motel for now: always Le Refuge. When multi-motel support lands,
 * resolution (by hostname, route, or env var) changes HERE and nowhere else —
 * call sites already treat the config as something they receive, not own.
 */
export function getMotelConfig(): MotelConfig {
  return motelLeRefuge;
}
