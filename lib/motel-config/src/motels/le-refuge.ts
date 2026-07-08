import type { MotelConfig } from "../types";

/**
 * Motel Le Refuge — Lennoxville (Sherbrooke), Quebec.
 *
 * Every value here was extracted verbatim from the previously hard-coded
 * system prompt and server code; the prompt builder reproduces the exact same
 * text from this data (guarded by the golden snapshot test in api-server).
 */
export const motelLeRefuge: MotelConfig = {
  id: "le-refuge",

  identity: {
    name: "Motel Le Refuge",
    city: "Lennoxville",
    region: "Quebec",
    address: "43 rue Queen, Sherbrooke, QC J1M 1J2",
    phone: "819-564-9005",
    phoneDial: "8195649005",
    website: "www.motellerefuge.com",
    timezone: "America/Montreal",
    timezoneLabel: "Eastern Time — Sherbrooke, Quebec",
  },

  hours: {
    receptionLabel: "15h00 - 21h00 (3 PM - 9 PM) daily",
    shortLabel: "3 PM - 9 PM",
    postBookingLabel: "3:00 PM - 9:00 PM (15h00 - 21h00) daily",
    checkIn: "3:00 PM - 9:00 PM",
    checkOut: "11:00 AM",
    lateArrivalCutoff: "9 PM",
  },

  rooms: [
    {
      id: "queen",
      name: "Queen Room",
      pricing: { weekday: 100, weekend: 110 },
      maxGuests: 2,
      amenities: ["TV", "AC", "WiFi", "private bathroom", "coffee maker"],
    },
    {
      id: "double",
      name: "Double Room",
      pricing: { weekday: 110, weekend: 120 },
      maxGuests: 4,
      amenities: ["TV", "AC", "WiFi", "private bathroom", "mini-fridge"],
    },
    {
      id: "deluxe",
      name: "Deluxe Room",
      pricing: { weekday: 120, weekend: 130 },
      maxGuests: 2,
      special:
        "Recently renovated, featuring an in-bedroom glass shower (transparent, open design — perfect for couples)",
      amenities: ["TV", "AC", "WiFi", "private bathroom", "glass shower", "mini-fridge"],
    },
    {
      id: "suite",
      name: "Suite",
      pricing: { flat: 225 },
      maxGuests: 4,
      bedding: "1 queen bed + 1 queen sofa bed",
      special: "Full kitchenette with stove, microwave, refrigerator, air fryer",
      amenities: ["TV", "AC", "WiFi", "kitchenette", "air fryer", "pluggable heating element"],
    },
  ],

  roomRoles: {
    coupleDefault: "queen",
    coupleUpgrade: "deluxe",
    groupSingleRoomOptions: ["double", "suite"],
    cheapest: "queen",
  },

  policies: {
    pets: {
      allowed: "cats & dogs only",
      deposit: 100,
      rules: [
        "Never leave pet alone in room",
        "Pets NOT allowed on beds",
        "Guest must clean up after pet",
      ],
      forfeitNote: "Deposit forfeited if rules not followed",
    },
    parking: {
      standard: "Free for standard vehicles",
      special: "RV/trailer or commercial vehicles — call ahead",
    },
    accessibility: "Too many variants to handle via chat — guest must call",
    extendedStays: {
      thresholdNights: 7,
      hasDiscount: false,
    },
    nonSmoking: "Credit card hold applies for violations",
    cancellations: "Live staff only",
  },

  booking: {
    engine: "reservit",
    chainId: "58",
    hotelId: "444801",
    linkBase: "http://softbooker.reservit.com/reservit/reserhotel.php",
    bestPriceBase: "https://secure.reservit.com/api/rs/bestprice",
    currency: "USD",
    maxNights: 14,
  },

  languages: ["fr", "en"],

  attractions: {
    thingsToDo: [
      { name: "Bishop's University campus", note: "a lovely walk, right in Lennoxville" },
      { name: "Golden Lion Pub", note: "local craft beer, lively atmosphere, Lennoxville" },
      { name: "Lennoxville Heritage Museum", note: "small, free, with lovely gardens" },
      { name: "Sherbrooke Murals", note: "outdoor art gallery, downtown Sherbrooke" },
      { name: "Théâtre Granada", note: "Sherbrooke's top live venue" },
      { name: "Mont-Bellevue Park", note: "hiking, biking, or skiing depending on season" },
      {
        name: "Foresta Lumina",
        note: "illuminated night forest walk in the Coaticook Gorge (summer season only)",
      },
    ],
    dining: [
      { name: "Brûlerie FARO", note: "cozy café in Lennoxville, great coffee and pastries" },
      { name: "Les Vraies Richesses", note: "beloved Sherbrooke bakery, known for fresh croissants" },
      {
        name: "Jerry's Pizzéria",
        note: "right on Queen Street, a local institution since 1973, great pizza and Greek food",
      },
      { name: "Golden Lion Pub", note: "also a solid dinner option, local beer + pub food" },
    ],
  },

  personalization: {
    greeting:
      "Bonjour, je suis l'assistant virtuel du Motel Le Refuge. Comment puis-je vous aider aujourd'hui ?\n\nHello, I am the virtual assistant for Motel Le Refuge. How may I help you today?",
    tagline: "Your comfort is our priority · Votre confort, notre priorité",
    toneNotes: "",
  },
};
