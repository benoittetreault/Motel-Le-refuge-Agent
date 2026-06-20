import { AlertTriangle } from "lucide-react";

export function BookingWarning() {
  return (
    <div className="bg-amber-100 border-b border-amber-200 text-amber-900 px-4 py-3 shadow-sm flex items-start gap-3 w-full z-50">
      <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
      <div className="text-sm font-medium leading-relaxed">
        <p>⚠️ Cette réservation doit être saisie manuellement dans Reservit immédiatement pour éviter les doubles réservations.</p>
        <p className="mt-1 opacity-90 text-xs uppercase tracking-wider font-bold">English Translation:</p>
        <p className="mt-0.5">⚠️ This booking must be manually entered into Reservit immediately to avoid double-booking.</p>
      </div>
    </div>
  );
}
