import type { MotelConfig } from "./types";
import { motelLeRefuge } from "./motels/le-refuge";

export type { MotelConfig, Room, RoomPricing, Attraction } from "./types";
export { motelLeRefuge } from "./motels/le-refuge";

/**
 * Returns the active motel's configuration.
 *
 * Single-motel for now: always Le Refuge, regardless of `dialedNumber`. The
 * parameter is accepted today so call sites (e.g. the voice route, which knows
 * the number the guest dialed) can pass it already; when multi-motel support
 * lands, resolution — mapping a dialed number to a motel — is implemented HERE
 * and nowhere else.
 *
 * @param dialedNumber E.164 number the guest called, when known (currently ignored).
 */
export function getMotelConfig(dialedNumber?: string): MotelConfig {
  // TODO(multi-motel): resolve `dialedNumber` to the matching motel config.
  void dialedNumber;
  return motelLeRefuge;
}
