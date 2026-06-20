export interface BookingSheetRow {
  fullName: string;
  phone: string;
  email: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  roomType: string;
  hasPet: boolean;
  language: string;
  createdAt: string;
}

export async function logBookingToSheet(booking: BookingSheetRow): Promise<void> {
  const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("GOOGLE_SHEETS_WEBHOOK_URL not set — skipping Sheets logging");
    return;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timestamp: new Date(booking.createdAt).toLocaleString("fr-CA"),
        fullName: booking.fullName,
        phone: booking.phone,
        email: booking.email,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        guests: booking.guests,
        roomType: booking.roomType,
        hasPet: booking.hasPet ? "Oui" : "Non",
        language: booking.language,
      }),
    });
    if (!response.ok) {
      console.warn("Google Sheets webhook returned non-OK:", response.status);
    }
  } catch (err) {
    console.warn("Failed to log booking to Google Sheets:", err);
  }
}
