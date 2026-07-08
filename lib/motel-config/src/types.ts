/**
 * Motel configuration contract — the multi-motel foundation.
 *
 * Layer 1 (pure DATA: identity, hours, rooms, policies, booking-engine IDs,
 * languages, attractions) and Layer 3 (limited personalization: greeting,
 * tagline, tone notes) live here, one config per motel.
 *
 * Layer 2 — behavior and safety rules (conversation flow, availability
 * verification, anti-tool-leak guards, the complete-the-action-in-the-same-turn
 * rule, multi-room logic) — stays in code, shared by every motel, and must
 * never move into this config.
 */

/** Nightly pricing: weekday/weekend (Fri-Sat) split, or one flat price for all days. */
export type RoomPricing =
  | { weekday: number; weekend: number }
  | { flat: number };

export interface Room {
  /** Stable identifier referenced by MotelConfig.roomRoles. */
  id: string;
  /** Display name exactly as shown to guests (e.g. "Queen Room"). */
  name: string;
  pricing: RoomPricing;
  maxGuests: number;
  /** Bed layout, rendered next to the guest count (e.g. "1 queen bed + 1 queen sofa bed"). */
  bedding?: string;
  /** One-line highlight rendered as a "Special:" line in the prompt. */
  special?: string;
  amenities: string[];
}

export interface Attraction {
  name: string;
  /** Short blurb rendered after the name ("{name} — {note}"). */
  note: string;
}

export interface MotelConfig {
  /** Stable identifier for this motel (used for multi-motel resolution later). */
  id: string;

  identity: {
    name: string;
    city: string;
    region: string;
    /** Official guest-facing address (confirmed: prompt-format version). */
    address: string;
    /** Guest-facing phone number, formatted (e.g. "819-564-9005"). */
    phone: string;
    /** Digits-only phone for tel: links (frontend, phase 2). */
    phoneDial: string;
    website: string;
    /** IANA timezone used for the server-injected current date. */
    timezone: string;
    /** Human label for the timezone in the prompt header (e.g. "Eastern Time — Sherbrooke, Quebec"). */
    timezoneLabel: string;
  };

  hours: {
    /** Hours a live person is reachable, as shown in the prompt intro (e.g. "15h00 - 21h00 (3 PM - 9 PM) daily"). */
    receptionLabel: string;
    /** Short hours label used inline after the phone number (e.g. "3 PM - 9 PM"). */
    shortLabel: string;
    /** Hours label used in the post-booking message (e.g. "3:00 PM - 9:00 PM (15h00 - 21h00) daily"). */
    postBookingLabel: string;
    /** Check-in window (e.g. "3:00 PM - 9:00 PM"). */
    checkIn: string;
    /** Check-out time (e.g. "11:00 AM"). */
    checkOut: string;
    /** Cutoff after which arrival requires a phone call earlier that day (e.g. "9 PM"). */
    lateArrivalCutoff: string;
  };

  rooms: Room[];

  /**
   * Which rooms play which role in the recommendation logic (values are
   * Room.id). The logic itself is Layer 2 and stays in the prompt template;
   * only WHICH room fills each slot is per-motel data.
   */
  roomRoles: {
    /** Recommended first to couples (most affordable comfortable option). */
    coupleDefault: string;
    /** Mentioned only as an upgrade when a couple seems open to it. */
    coupleUpgrade: string;
    /** The single-room options offered when a large group insists on one room. */
    groupSingleRoomOptions: string[];
    /** Answer to "What's the cheapest?". */
    cheapest: string;
  };

  policies: {
    pets: {
      /** Which animals are accepted (e.g. "cats & dogs only"). */
      allowed: string;
      /** Refundable damage deposit, in dollars. */
      deposit: number;
      rules: string[];
      forfeitNote: string;
    };
    parking: {
      standard: string;
      /** Case requiring a call ahead; the phone number is appended by the template. */
      special: string;
    };
    /** Accessibility stance; the phone number and hours are appended by the template. */
    accessibility: string;
    extendedStays: {
      /** Nights from which a stay counts as "extended". */
      thresholdNights: number;
      /** Informational: the current template text assumes false (no discounts, same rate). */
      hasDiscount: boolean;
    };
    nonSmoking: string;
    /** Who can handle cancellations/changes; the phone number is appended by the template. */
    cancellations: string;
  };

  booking: {
    engine: "reservit";
    chainId: string;
    hotelId: string;
    /** Base URL of the guest-facing booking link (no query string). */
    linkBase: string;
    /** Base URL of the Best Price availability API (chainId/hotelId are appended). */
    bestPriceBase: string;
    /** Currency requested from the Best Price API. */
    currency: string;
    /** Stays longer than this can't be checked; the guest is redirected to the phone. */
    maxNights: number;
  };

  /** Languages the agent supports (informational; the bilingual rules are Layer 2). */
  languages: string[];

  /** Closed, verified lists — the agent must never invent entries beyond these. */
  attractions: {
    thingsToDo: Attraction[];
    dining: Attraction[];
  };

  /** Layer 3 — the small, bounded personalization surface. */
  personalization: {
    /** Chat greeting shown by the frontend (wired in phase 2). */
    greeting: string;
    /** Header tagline shown by the frontend (wired in phase 2). */
    tagline: string;
    /**
     * Free-text tone notes appended at the end of the prompt's
     * "Tone & Language Rules" section. Max 500 characters (enforced by the
     * prompt builder) so a motel config can never override Layer 2 safety
     * rules. Empty string = nothing injected.
     */
    toneNotes: string;
  };
}
