import nodemailer from "nodemailer";
import { getMotelConfig } from "@workspace/motel-config";

const motel = getMotelConfig();

export interface BookingEmailData {
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

function createTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
}

export async function sendBookingEmail(
  toEmail: string,
  booking: BookingEmailData
): Promise<void> {
  const transporter = createTransporter();
  if (!transporter) {
    console.warn("GMAIL_USER or GMAIL_APP_PASSWORD not set — skipping email");
    return;
  }

  const petNote = booking.hasPet
    ? `Oui / Yes ($${motel.policies.pets.deposit} dépôt remboursable / refundable deposit)`
    : "Non";
  const html = `
    <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 24px; background: #f8f6f1;">
      <h1 style="color: #1a3a4a; border-bottom: 2px solid #c8a97a; padding-bottom: 12px;">
        ⚓ Nouvelle réservation — ${motel.identity.name}
      </h1>
      <p style="color: #c0392b; font-weight: bold; background: #fef9e7; padding: 12px; border-left: 4px solid #f39c12;">
        ⚠️ Cette réservation doit être saisie manuellement dans Reservit immédiatement.<br/>
        ⚠️ This booking must be manually entered into Reservit immediately.
      </p>
      <table style="width: 100%; border-collapse: collapse; margin-top: 16px;">
        <tr><td style="padding: 8px; font-weight: bold; color: #555;">Nom / Name</td><td style="padding: 8px;">${booking.fullName}</td></tr>
        <tr style="background:#fff;"><td style="padding: 8px; font-weight: bold; color: #555;">Téléphone / Phone</td><td style="padding: 8px;">${booking.phone}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold; color: #555;">Courriel / Email</td><td style="padding: 8px;">${booking.email}</td></tr>
        <tr style="background:#fff;"><td style="padding: 8px; font-weight: bold; color: #555;">Arrivée / Check-in</td><td style="padding: 8px;">${booking.checkIn}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold; color: #555;">Départ / Check-out</td><td style="padding: 8px;">${booking.checkOut}</td></tr>
        <tr style="background:#fff;"><td style="padding: 8px; font-weight: bold; color: #555;">Nombre de guests / Guests</td><td style="padding: 8px;">${booking.guests}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold; color: #555;">Type de chambre / Room type</td><td style="padding: 8px;">${booking.roomType}</td></tr>
        <tr style="background:#fff;"><td style="padding: 8px; font-weight: bold; color: #555;">Animal / Pet</td><td style="padding: 8px;">${petNote}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold; color: #555;">Langue / Language</td><td style="padding: 8px;">${booking.language}</td></tr>
        <tr style="background:#fff;"><td style="padding: 8px; font-weight: bold; color: #555;">Reçu le / Received</td><td style="padding: 8px;">${new Date(booking.createdAt).toLocaleString("fr-CA")}</td></tr>
      </table>
      <p style="margin-top: 24px; font-size: 12px; color: #999;">${motel.identity.name} — ${motel.identity.address} — ${motel.identity.phone}</p>
    </div>
  `;

  await transporter.sendMail({
    from: `"${motel.identity.name} AI" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject: `[Réservation] ${booking.fullName} — ${booking.checkIn} → ${booking.checkOut}`,
    html,
  });
}
