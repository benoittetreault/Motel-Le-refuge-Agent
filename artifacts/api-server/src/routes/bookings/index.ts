import { Router } from "express";
import { db } from "@workspace/db";
import { bookings, insertBookingSchema } from "@workspace/db";
import { CreateBookingBody } from "@workspace/api-zod";
import { sendBookingEmail } from "../../lib/mailer";
import { logBookingToSheet } from "../../lib/sheets";

const NOTIFY_EMAIL = process.env.BOOKING_NOTIFY_EMAIL ?? "benoit.tetreault@icloud.com";

const router = Router();

router.get("/bookings", async (req, res) => {
  try {
    const all = await db.select().from(bookings).orderBy(bookings.createdAt);
    res.json(
      all.map((b) => ({
        ...b,
        createdAt: b.createdAt.toISOString(),
      }))
    );
  } catch (err) {
    req.log.error({ err }, "Failed to list bookings");
    res.status(500).json({ error: "Failed to list bookings" });
  }
});

router.post("/bookings", async (req, res) => {
  try {
    const parsed = CreateBookingBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid booking input" });
      return;
    }

    const insertData = insertBookingSchema.parse({
      conversationId: parsed.data.conversationId ?? null,
      fullName: parsed.data.fullName,
      phone: parsed.data.phone,
      email: parsed.data.email,
      checkIn: parsed.data.checkIn,
      checkOut: parsed.data.checkOut,
      guests: parsed.data.guests,
      roomType: parsed.data.roomType,
      hasPet: parsed.data.hasPet,
      language: parsed.data.language,
      status: "pending",
    });

    const [booking] = await db.insert(bookings).values(insertData).returning();
    const bookingOut = { ...booking, createdAt: booking.createdAt.toISOString() };

    const emailData = {
      fullName: booking.fullName,
      phone: booking.phone,
      email: booking.email,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      guests: booking.guests,
      roomType: booking.roomType,
      hasPet: booking.hasPet,
      language: booking.language,
      createdAt: bookingOut.createdAt,
    };

    await Promise.allSettled([
      sendBookingEmail(NOTIFY_EMAIL, emailData).catch((err) =>
        req.log.error({ err }, "Failed to send booking email")
      ),
      logBookingToSheet(emailData).catch((err) =>
        req.log.error({ err }, "Failed to log booking to Sheets")
      ),
    ]);

    res.status(201).json(bookingOut);
  } catch (err) {
    req.log.error({ err }, "Failed to create booking");
    res.status(500).json({ error: "Failed to create booking" });
  }
});

export default router;
