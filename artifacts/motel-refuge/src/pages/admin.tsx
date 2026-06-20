import { format } from "date-fns";
import { Link } from "wouter";
import { ShipWheel } from "lucide-react";
import { useListBookings } from "@workspace/api-client-react";
import { BookingWarning } from "@/components/booking-warning";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export default function AdminPage() {
  const { data: bookings, isLoading } = useListBookings();

  return (
    <div className="min-h-screen bg-slate-50/50 pb-20">
      <BookingWarning />

      <header className="bg-white border-b px-8 py-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ShipWheel className="w-8 h-8 text-primary" />
          <div>
            <h1 className="font-serif text-2xl font-bold text-primary">Le Refuge Admin</h1>
            <p className="text-sm text-muted-foreground">Bookings Management Dashboard</p>
          </div>
        </div>
        <Link href="/" className="text-sm font-medium text-primary hover:underline">
          &larr; Back to Chat
        </Link>
      </header>

      <main className="max-w-7xl mx-auto mt-10 px-6">
        <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
          {isLoading ? (
            <div className="p-10 text-center text-muted-foreground">Loading bookings...</div>
          ) : !bookings || bookings.length === 0 ? (
            <div className="p-16 text-center">
              <ShipWheel className="w-12 h-12 text-muted/30 mx-auto mb-4" />
              <h3 className="text-lg font-serif text-primary">No bookings yet</h3>
              <p className="text-muted-foreground mt-1">When the AI agent completes a booking, it will appear here.</p>
            </div>
          ) : (
            <Table>
              <TableHeader className="bg-slate-50/80">
                <TableRow>
                  <TableHead>Guest</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Dates</TableHead>
                  <TableHead>Room & Details</TableHead>
                  <TableHead>Language</TableHead>
                  <TableHead>Submitted</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bookings.map((booking) => (
                  <TableRow key={booking.id}>
                    <TableCell className="font-medium text-primary align-top">
                      {booking.fullName}
                    </TableCell>
                    <TableCell className="align-top">
                      <div className="flex flex-col gap-1 text-sm">
                        <span>{booking.phone}</span>
                        <span className="text-muted-foreground">{booking.email}</span>
                      </div>
                    </TableCell>
                    <TableCell className="align-top text-sm">
                      <div className="font-medium">{booking.checkIn}</div>
                      <div className="text-muted-foreground">to {booking.checkOut}</div>
                    </TableCell>
                    <TableCell className="align-top">
                      <div className="flex flex-col items-start gap-1.5">
                        <Badge variant="outline" className="font-normal border-primary/20 bg-primary/5">
                          {booking.roomType}
                        </Badge>
                        <div className="text-xs text-muted-foreground flex gap-2">
                          <span>{booking.guests} guest(s)</span>
                          {booking.hasPet && (
                            <span className="text-amber-600 font-medium border border-amber-200 bg-amber-50 px-1 rounded-sm">
                              + Pet
                            </span>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="align-top">
                      <span className="uppercase text-xs font-bold text-muted-foreground tracking-wider">
                        {booking.language}
                      </span>
                    </TableCell>
                    <TableCell className="align-top text-sm text-muted-foreground">
                      {format(new Date(booking.createdAt), "MMM d, yyyy HH:mm")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </main>
    </div>
  );
}
