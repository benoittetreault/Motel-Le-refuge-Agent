import { boolean, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { conversations } from "./conversations";

export const bookings = pgTable("bookings", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").references(() => conversations.id, {
    onDelete: "set null",
  }),
  fullName: text("full_name").notNull(),
  phone: text("phone").notNull(),
  email: text("email").notNull(),
  checkIn: text("check_in").notNull(),
  checkOut: text("check_out").notNull(),
  guests: integer("guests").notNull(),
  roomType: text("room_type").notNull(),
  hasPet: boolean("has_pet").notNull().default(false),
  language: text("language").notNull().default("fr"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertBookingSchema = createInsertSchema(bookings).omit({
  id: true,
  createdAt: true,
});

export type Booking = typeof bookings.$inferSelect;
export type InsertBooking = z.infer<typeof insertBookingSchema>;
